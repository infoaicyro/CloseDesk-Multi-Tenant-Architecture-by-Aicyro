// src/pages/api/sync-voice.js
import { db } from "../../lib/firebase";
import { withApiLogger } from "../../lib/apiMiddleware";
import { ref, get, update, set, push } from "firebase/database";
import { resolveTenantId, sanitizeTenantId, getTenantConfig } from "../../lib/tenantResolver";
import { validateVoiceEvent } from "../../lib/voiceAuth";
import {
  acquireIdempotencyLock,
  completeIdempotencyLock,
  failIdempotencyLock,
} from "../../lib/idempotencyLocker";
import { sanitizeFirebaseKey, sanitizeUntrustedTelemetry } from "../../lib/sanitizer";
import { authorizeToolAction } from "../../lib/toolAuthorizer";
import { validateVoiceSessionForAction } from "../../lib/voiceLifecycle";
import { validateRequestBodySize } from "../../lib/publicEndpointGuard";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '32kb',
    },
  },
};

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const isValidSessionId = (id) => /^lead_\d+_[a-z0-9]{5,10}$/i.test(id);

async function handler(req, res, apiLogger) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" });

  // 1. Enforce 32KB body size cap (returns 413)
  if (!validateRequestBodySize(req, res, 32768)) return;

  const tenantId = sanitizeTenantId(resolveTenantId(req) || req.body?.tenant_id || "default");

  // 🚨 CD06: Authenticate voice event, validate freshness & replay prevention
  const authCheck = await validateVoiceEvent(req, tenantId, db);
  if (!authCheck.allowed) {
    apiLogger.warn("security", "voice_event_rejected", {
      context: { tenantId, error: authCheck.error, status: authCheck.status },
    });
    return res.status(authCheck.status || 401).json({ error: authCheck.error });
  }

  const {
    session_id,
    tool_name,
    tool_args = {},
    action,
    role,
    text,
    transcript,
    factual_summary,
  } = req.body;

  if (!session_id || !isValidSessionId(session_id)) {
    return res.status(400).json({ error: "A valid session_id format is required." });
  }

  const cleanSessionId = sanitizeFirebaseKey(session_id, "session");
  const getScopedPath = (subPath) => (tenantId && tenantId !== "default" ? `tenants/${tenantId}/${subPath}` : subPath);

  // --- TELEMETRY LOGGING ---
  if (action === "log_telemetry") {
    try {
      await push(ref(db, getScopedPath(`voice_telemetry/${cleanSessionId}`)), {
        timestamp: new Date().toISOString(),
        ...sanitizeUntrustedTelemetry(telemetry_data || {}),
      });

      apiLogger.info("voice_telemetry", "turn_metrics_recorded", {
        context: { session_id: cleanSessionId, turn_id: telemetry_data?.turn_id },
        metadata: {
          recording_duration_ms: telemetry_data?.recording_duration,
          stt_latency_ms: telemetry_data?.stt_latency,
          ai_latency_ms: telemetry_data?.ai_latency,
          first_audio_latency_ms: telemetry_data?.first_audio_latency,
          total_turn_latency_ms: telemetry_data?.total_turn_latency,
          interrupted: telemetry_data?.interrupted
        },
        duration_ms: telemetry_data?.total_turn_latency 
      });

      return res.status(200).json({ success: true });
    } catch (err) {
      apiLogger.error("system_event", "telemetry_save_failed", { error: err });
      return res.status(500).json({ error: "Telemetry logging failed." });
    }
  }

  // --- ERROR LOGGING ---
  if (action === "log_error") {
    try {
      await push(ref(db, getScopedPath(`voice_errors/${cleanSessionId}`)), {
        timestamp: new Date().toISOString(),
        error_stage,
        error_message,
        raw_error: raw_error || null,
      });

      let errorCategory = "voice_network_error";
      const stageUpper = (error_stage || "").toUpperCase();
      
      if (stageUpper.includes("MIC") || stageUpper.includes("PERMISSION")) errorCategory = "voice_mic_error";
      else if (stageUpper.includes("STT") || stageUpper.includes("TRANSCRIPT")) errorCategory = "voice_stt_error";
      else if (stageUpper.includes("AI") || stageUpper.includes("REALTIME") || stageUpper.includes("OPENAI")) errorCategory = "voice_ai_error";
      else if (stageUpper.includes("TTS") || stageUpper.includes("AUDIO") || stageUpper.includes("PLAYBACK")) errorCategory = "voice_tts_error";

      apiLogger.error("voice_lifecycle", errorCategory, {
        error: raw_error ? new Error(String(raw_error)) : new Error(error_message),
        context: { session_id: cleanSessionId, error_stage, error_message }
      });

      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: "Logging failed." });
    }
  }

  // 🚨 CD09: SERVER-SIDE VOICE SESSION & KILL SWITCH VALIDATION
  const sessionCheck = await validateVoiceSessionForAction({
    tenantId,
    sessionId: cleanSessionId,
    dbInstance: db,
  });

  if (!sessionCheck.allowed) {
    apiLogger.warn("security", "voice_action_rejected_by_session_validator", {
      context: { tenantId, sessionId: cleanSessionId, reason: sessionCheck.reason, scope: sessionCheck.scope },
    });
    return res.status(sessionCheck.status || 403).json({
      error: sessionCheck.reason,
      scope: sessionCheck.scope,
    });
  }

  // --- TRANSCRIPT FLUSH AT CALL END ---
  if (action === "flush_transcript") {
    try {
      if (Array.isArray(transcript) && transcript.length > 0) {
        const transcriptRef = ref(db, getScopedPath(`transcripts/${cleanSessionId}`));
        const updates = {};
        transcript.forEach((item, index) => {
          updates[`msg_${Date.now()}_${index}`] = {
            role: item.role,
            text: item.text,
            channel: "voice",
            timestamp: new Date().toISOString(),
          };
        });
        await update(transcriptRef, updates);
      }

      if (factual_summary) {
        await update(ref(db, getScopedPath(`prospects/${cleanSessionId}`)), {
          factual_summary,
          last_updated: new Date().toISOString(),
          tenant_id: tenantId,
        });
      }

      return res.status(200).json({ success: true });
    } catch (error) {
      return res.status(500).json({ error: "Failed to flush transcript." });
    }
  }

  // --- TRANSCRIPT LOGGING ---
  if (action === "log_transcript") {
    try {
      if (!text) return res.status(200).json({ success: true });
      await push(ref(db, getScopedPath(`transcripts/${cleanSessionId}`)), {
        role,
        text,
        channel: "voice",
        timestamp: new Date().toISOString(),
      });
      return res.status(200).json({ success: true });
    } catch (error) {
      return res.status(500).json({ error: "Transcript logging failed." });
    }
  }

  // --- SECURE TOOL ROUTING & VALIDATION ---
  if (!tool_name) return res.status(400).json({ error: "tool_name required for tool sync." });

  // 🚨 CD06: Operation Key & Idempotency State Locking
  const operationKey = req.headers["x-idempotency-key"] || tool_args.operation_key || `op_voice_${cleanSessionId}_${tool_name}`;
  let lockResult = null;
  try {
    lockResult = await acquireIdempotencyLock({
      tenantId,
      conversationId: cleanSessionId,
      operationKey,
      payload: { tool_name, tool_args },
      ttlMs: 60000,
      dbInstance: db,
    });

    if (lockResult.status === "cached") {
      apiLogger.info("voice_lifecycle", "voice_idempotency_cache_hit", {
        context: { session_id: cleanSessionId, tool_name, operationKey },
      });
      return res.status(200).json(lockResult.cachedResponse);
    }

    if (lockResult.status === "payload_mismatch") {
      apiLogger.warn("voice_lifecycle", "voice_idempotency_payload_conflict", {
        context: { session_id: cleanSessionId, tool_name, operationKey },
      });
      return res.status(409).json({ error: lockResult.error });
    }

    if (lockResult.status === "in_progress") {
      return res.status(409).json({ error: lockResult.message, status: "pending" });
    }
  } catch (lockErr) {
    if (lockErr.code === "CROSS_TENANT_IDEMPOTENCY_CONFLICT") {
      return res.status(403).json({ error: lockErr.message });
    }
  }

  try {
    const prospectRef = ref(db, getScopedPath(`prospects/${cleanSessionId}`));
    const snap = await get(prospectRef);
    const currentData = snap.exists() ? snap.val() : {};

    // 🚨 CD08: SERVER-SIDE TOOL AUTHORIZATION GATE
    const tenantConfigResult = await getTenantConfig(tenantId);
    const tenantSettings = {
      ...(tenantConfigResult?.chatbotConfig || {}),
      ...(tenantConfigResult?.businessProfile || {}),
      supportedServices: tenantConfigResult?.businessProfile?.supported_services || tenantConfigResult?.chatbotConfig?.services,
      unsupportedServices: tenantConfigResult?.businessProfile?.unsupported_services || tenantConfigResult?.chatbotConfig?.unsupportedServices,
      serviceArea: tenantConfigResult?.businessProfile?.service_area || tenantConfigResult?.chatbotConfig?.serviceArea,
      enableDirectBooking: tenantConfigResult?.chatbotConfig?.enableDirectBooking,
      calendarActive: tenantConfigResult?.chatbotConfig?.calendarActive,
    };

    const toolAuth = await authorizeToolAction({
      tenantId,
      action: tool_name,
      toolArgs: tool_args,
      tenantConfig: tenantSettings,
      prospectData: currentData,
    });

    if (!toolAuth.allowed) {
      apiLogger.warn("security", "voice_tool_action_unauthorized", {
        context: { tool_name, reason: toolAuth.reason, tenantId },
      });
      await failIdempotencyLock({ tenantId, operationKey, error: toolAuth.reason, dbInstance: db });
      return res.status(200).json({
        success: false,
        error: toolAuth.reason,
        message: toolAuth.reason,
      });
    }

    let mergedContext = currentData.context_patch || { contact_info: {}, business_context: {} };
    let flags = currentData.flags || [];
    let next_action = currentData.next_action || "NONE";
    let privacyPatch = currentData.privacy_patch || [];
    let resultPayload = { success: true };

    const ensureActionIdempotency = async (flagName) => {
      const actionRef = ref(db, getScopedPath(`session_actions/${cleanSessionId}/${flagName}`));
      const actionSnap = await get(actionRef);
      if (actionSnap.exists() && actionSnap.val().status !== "failed") return false;
      await set(actionRef, { triggered_at: new Date().toISOString(), status: "pending" });
      if (!flags.includes(flagName)) flags.push(flagName);
      return true;
    };

    switch (tool_name) {
      case "update_prospect_context":
        if (tool_args.contact_info) {
          if (tool_args.contact_info.email && !isValidEmail(tool_args.contact_info.email)) {
            return res.status(200).json({ success: false, error: "Invalid email format. Please ask the user to verify." });
          }
          mergedContext.contact_info = { ...mergedContext.contact_info, ...tool_args.contact_info };
        }
        if (tool_args.business_context) {
          mergedContext.business_context = { ...mergedContext.business_context, ...tool_args.business_context };
        }
        resultPayload.message = "Context updated successfully.";
        break;

      case "request_website_audit":
        mergedContext.business_context.website = tool_args.website_url;
        const auditIsNew = await ensureActionIdempotency("TRIGGER_AUDIT");
        next_action = "REQUEST_WEBSITE_AUDIT";
        apiLogger.info("booking_lifecycle", "inspection_requested", { context: { session_id: cleanSessionId, tenantId } });
        resultPayload.message = auditIsNew ? "Audit submitted successfully." : "Audit already submitted.";
        break;

      case "request_consultation":
        const consultIsNew = await ensureActionIdempotency("SCHEDULE_CONSULTATION");
        next_action = "SCHEDULE_CONSULTATION";
        apiLogger.info("booking_lifecycle", "booking_requested", { context: { session_id: cleanSessionId, tenantId } });
        resultPayload.message = consultIsNew ? "Consultation requested." : "Consultation already tracked.";
        break;

      case "request_callback":
        mergedContext.contact_info.phone = tool_args.phone_number;
        const cbIsNew = await ensureActionIdempotency("REQUEST_CALLBACK");
        next_action = "REQUEST_CALLBACK";
        apiLogger.info("booking_lifecycle", "callback_requested", { context: { session_id: cleanSessionId, tenantId } });
        resultPayload.message = cbIsNew ? "Callback requested successfully." : "Callback already logged.";
        break;

      case "request_quote":
        const quoteIsNew = await ensureActionIdempotency("REQUEST_QUOTE");
        next_action = "REQUEST_QUOTE";
        apiLogger.info("booking_lifecycle", "quote_requested", { context: { session_id: cleanSessionId, tenantId } });
        resultPayload.message = quoteIsNew ? "Quote requested." : "Quote already requested.";
        break;

      case "create_service_request":
        const srIsNew = await ensureActionIdempotency("CREATE_SERVICE_REQUEST");
        next_action = "SERVICE_REQUEST_CREATED";
        apiLogger.info("booking_lifecycle", "service_request_created", { context: { session_id: cleanSessionId, tenantId } });
        resultPayload.message = srIsNew ? "Service request created." : "Service request already exists.";
        break;

      case "request_human_handoff":
        const handoffIsNew = await ensureActionIdempotency("ESCALATE_HUMAN");
        next_action = "HUMAN_HANDOFF";
        resultPayload.message = handoffIsNew ? "Handoff initiated." : "Handoff already in progress.";
        break;

      case "record_privacy_preference":
        if (Array.isArray(tool_args.refused_fields)) {
          privacyPatch = Array.from(new Set([...privacyPatch, ...tool_args.refused_fields]));
        }
        resultPayload.message = "Privacy preferences recorded.";
        break;

      case "request_data_deletion":
        mergedContext = { contact_info: {}, business_context: {} };
        privacyPatch = [];
        next_action = "NONE";
        await ensureActionIdempotency("TRIGGER_DATA_DELETION");
        await set(ref(db, getScopedPath(`transcripts/${cleanSessionId}`)), null);
        resultPayload.message = "All personal data and conversation transcripts have been successfully and permanently deleted.";
        break;

      default:
        return res.status(200).json({ success: false, error: `Tool ${tool_name} is not recognized.` });
    }

    Object.keys(mergedContext.contact_info).forEach((k) => {
      if (mergedContext.contact_info[k] == null) delete mergedContext.contact_info[k];
    });
    Object.keys(mergedContext.business_context).forEach((k) => {
      if (mergedContext.business_context[k] == null) delete mergedContext.business_context[k];
    });

    await update(prospectRef, {
      context_patch: mergedContext,
      privacy_patch: privacyPatch,
      flags,
      next_action,
      last_updated: new Date().toISOString(),
      tenant_id: tenantId,
      ...(tool_name === "request_data_deletion" ? { factual_summary: null } : {}),
    });

    // 🚨 Complete Idempotency Lock
    await completeIdempotencyLock({ tenantId, operationKey, responseData: resultPayload, dbInstance: db });

    return res.status(200).json(resultPayload);
  } catch (error) {
    await failIdempotencyLock({ tenantId, operationKey, error, dbInstance: db });
    return res.status(200).json({ success: false, error: "Internal backend failure." });
  }
}

export default withApiLogger(handler, "Sync-Voice-API");
