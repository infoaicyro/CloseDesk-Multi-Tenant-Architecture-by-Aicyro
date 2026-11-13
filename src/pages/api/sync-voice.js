// src/pages/api/sync-voice.js
import { db } from "../../lib/firebase";
import { withApiLogger } from "../../lib/apiMiddleware";
import { ref, get, update, set, push } from "firebase/database";
import { validateRequestBodySize } from "../../lib/publicEndpointGuard";
import { sanitizeUntrustedTelemetry } from "../../lib/sanitizer";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '32kb',
    },
  },
};

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const isValidWebsite = (url) => /^[^\s]+\.[^\s]+$/.test(url);

const isValidSessionId = (id) => /^lead_\d+_[a-z0-9]{5,10}$/i.test(id);

async function handler(req, res, apiLogger) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" });

  // 1. Enforce 32KB body size cap (returns 413)
  if (!validateRequestBodySize(req, res, 32768)) return;

  const {
    session_id,
    tool_name,
    tool_args = {},
    action,
    role,
    text,
    error_stage,
    error_message,
    raw_error,
    telemetry_data,
  } = req.body;

  if (!session_id || !isValidSessionId(session_id)) {
    return res.status(400).json({ error: "A valid session_id is required." });
  }

  // --- TELEMETRY LOGGING ---
  if (action === "log_telemetry") {
    try {
      await push(ref(db, `voice_telemetry/${session_id}`), {
        timestamp: new Date().toISOString(),
        ...sanitizeUntrustedTelemetry(telemetry_data || {}),
      });

      apiLogger.info("voice_telemetry", "turn_metrics_recorded", {
        context: { session_id, turn_id: telemetry_data.turn_id },
        metadata: {
          recording_duration_ms: telemetry_data.recording_duration,
          stt_latency_ms: telemetry_data.stt_latency,
          ai_latency_ms: telemetry_data.ai_latency,
          first_audio_latency_ms: telemetry_data.first_audio_latency,
          total_turn_latency_ms: telemetry_data.total_turn_latency,
          interrupted: telemetry_data.interrupted
        },
        duration_ms: telemetry_data.total_turn_latency 
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
      await push(ref(db, `voice_errors/${session_id}`), {
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
        context: { session_id, error_stage, error_message }
      });

      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: "Logging failed." });
    }
  }

  // --- TRANSCRIPT LOGGING ---
  if (action === "log_transcript") {
    try {
      if (!text) return res.status(200).json({ success: true });
      await push(ref(db, `transcripts/${session_id}`), {
        role, text, channel: "voice", timestamp: new Date().toISOString(),
      });
      return res.status(200).json({ success: true });
    } catch (error) {
      return res.status(500).json({ error: "Transcript logging failed." });
    }
  }

  // --- SECURE TOOL ROUTING & VALIDATION ---
  if (!tool_name) return res.status(400).json({ error: "tool_name required for tool sync." });

  try {
    const prospectRef = ref(db, `prospects/${session_id}`);
    const snap = await get(prospectRef);
    const currentData = snap.exists() ? snap.val() : {};

    let mergedContext = currentData.context_patch || { contact_info: {}, business_context: {} };
    let flags = currentData.flags || [];
    let next_action = currentData.next_action || "NONE";
    let privacyPatch = currentData.privacy_patch || [];
    let resultPayload = { success: true };

    const ensureActionIdempotency = async (flagName) => {
      const actionRef = ref(db, `session_actions/${session_id}/${flagName}`);
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
        apiLogger.info("booking_lifecycle", "inspection_requested", { context: { session_id }}); // 🚨 TICKET 10
        resultPayload.message = auditIsNew ? "Audit submitted successfully." : "Audit already submitted.";
        break;

      case "request_consultation":
        const consultIsNew = await ensureActionIdempotency("SCHEDULE_CONSULTATION");
        next_action = "SCHEDULE_CONSULTATION";
        apiLogger.info("booking_lifecycle", "booking_requested", { context: { session_id }}); // 🚨 TICKET 10
        resultPayload.message = consultIsNew ? "Consultation requested." : "Consultation already tracked.";
        break;

      case "request_callback":
        mergedContext.contact_info.phone = tool_args.phone_number;
        const cbIsNew = await ensureActionIdempotency("REQUEST_CALLBACK");
        next_action = "REQUEST_CALLBACK";
        apiLogger.info("booking_lifecycle", "callback_requested", { context: { session_id }}); // 🚨 TICKET 10
        resultPayload.message = cbIsNew ? "Callback requested successfully." : "Callback already logged.";
        break;

      // 🚨 TICKET 10: New Tools tracked for Quotes & Service Requests
      case "request_quote":
        const quoteIsNew = await ensureActionIdempotency("REQUEST_QUOTE");
        next_action = "REQUEST_QUOTE";
        apiLogger.info("booking_lifecycle", "quote_requested", { context: { session_id }});
        resultPayload.message = quoteIsNew ? "Quote requested." : "Quote already requested.";
        break;

      case "create_service_request":
        const srIsNew = await ensureActionIdempotency("CREATE_SERVICE_REQUEST");
        next_action = "SERVICE_REQUEST_CREATED";
        apiLogger.info("booking_lifecycle", "service_request_created", { context: { session_id }});
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
        await set(ref(db, `transcripts/${session_id}`), null);
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
      ...(tool_name === "request_data_deletion" ? { factual_summary: null } : {}),
    });

    return res.status(200).json(resultPayload);
  } catch (error) {
    return res.status(200).json({ success: false, error: "Internal backend failure." });
  }
}
export default withApiLogger(handler, "Sync-Voice-API");