// src/pages/api/leads.js
import OpenAI from "openai";
import { withApiLogger } from "../../lib/apiMiddleware";
import { db } from "../../lib/firebase";
import { ref } from "firebase/database";
import { traceAiExecution } from "../../lib/aiTracer";
import { executeDbWithTrace } from "../../lib/dbTracer";
import { resolveTenantId, resolveAuthenticatedTenantId, sanitizeTenantId } from "../../lib/tenantResolver";
import { sanitizeFirebaseKey, sanitizeFirebasePayload, redactSensitiveSecrets, stripCrlf, escapeHtml } from "../../lib/sanitizer";
import { safeDbGet, safeDbUpdate } from "../../lib/safeDb";
import {
  createCanonicalLead,
  updateLeadLifecycle,
  updateLeadPriority,
  assertNotStaleUpdate,
  mapToCanonicalLifecycle,
} from "../../lib/leadContract";
import {
  acquireIdempotencyLock,
  completeIdempotencyLock,
  failIdempotencyLock,
  markIdempotencyLockUnknown,
} from "../../lib/idempotencyLocker";
import { enqueueNotificationJob } from "../../lib/handoffManager";
import {
  validateRequestBodySize,
  checkLeadSubmissionIdempotency,
} from "../../lib/publicEndpointGuard";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '32kb',
    },
  },
};

async function handler(req, res, apiLogger) {
  // ==========================================
  // GET REQUEST: FETCH ALL LEADS FOR DASHBOARD
  // ==========================================
  if (req.method === "GET") {
    // 🚨 SECURITY: Operator session verification & cross-tenant spoofing prevention
    const authResult = await resolveAuthenticatedTenantId(req);
    if (!authResult.allowed) {
      apiLogger.warn("security", "unauthorized_leads_fetch_blocked", {
        context: { error: authResult.error, status: authResult.status },
      });
      return res.status(authResult.status || 401).json({ error: authResult.error });
    }

    try {
      const tenantId = authResult.tenantId;
      const leadsPath = tenantId && tenantId !== "default" ? `tenants/${tenantId}/leads` : "leads";

      let snapshot = null;
      try {
        snapshot = await safeDbGet(ref(db, leadsPath), 600);
      } catch (e) {
        // Database offline / network fallback
      }

      apiLogger.info("lead_lifecycle", "bulk_fetch_success", {
        context: { message: "Fetched leads for dashboard", tenantId },
      });

      if (snapshot && snapshot.exists()) {
        const val = redactSensitiveSecrets(snapshot.val());
        return res.status(200).json(val); // Returns tenant-isolated, redacted leads
      } else {
        return res.status(200).json({}); // Returns empty object if no leads exist for this tenant
      }
    } catch (error) {
      apiLogger.error("lead_lifecycle", "bulk_fetch_failed", { error });
      return res.status(500).json({ error: "Failed to fetch leads." });
    }
  }

  // ==========================================
  // POST REQUEST: SAVE LEAD FROM CHATBOT
  // ==========================================
  if (req.method === "POST") {
    // 1. Enforce 32KB request body size cap (returns 413)
    if (!validateRequestBodySize(req, res, 32768)) return;

    if (!req.body || typeof req.body !== "object" || Object.keys(req.body).length === 0) {
      apiLogger.warn("lead_lifecycle", "lead_validation_failed", {
        context: { reason: "Payload is empty or malformed" },
      });
      return res.status(400).json({ error: "Invalid payload format", code: "INVALID_PAYLOAD" });
    }

    const tenantId = sanitizeTenantId(resolveTenantId(req) || req.body?.tenant_id || "default");

    // 2. Anti-Spam Lead Idempotency & Rate Cap Check
    const clientIp = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
    const sessionOrIp = req.body.anonId || req.body.session_id || clientIp;
    const idempotency = checkLeadSubmissionIdempotency(req.body, tenantId, sessionOrIp, 60000);
    if (!idempotency.allowed) {
      if (idempotency.isDuplicate) {
        apiLogger.info("lead_lifecycle", "lead_idempotent_duplicate_deduplicated", {
          context: { tenantId, leadHash: idempotency.leadHash }
        });
        return res.status(200).json({
          id: req.body.firebaseId || `lead_${Date.now()}`,
          success: true,
          message: "Duplicate lead submission deduplicated",
          deduplicated: true,
        });
      }
      if (idempotency.isRateLimited) {
        return res.status(429).json({
          error: idempotency.reason || "Lead submission rate limit exceeded.",
          code: "RATE_LIMIT_EXCEEDED",
        });
      }
    }

    // 3. Strip any hostile arbitrary email recipient fields
    const FORBIDDEN_RECIPIENT_KEYS = ["to", "cc", "bcc", "recipient", "receiverEmail", "receiver_email", "mail_to"];
    for (const k of FORBIDDEN_RECIPIENT_KEYS) {
      delete req.body[k];
    }

    // Deep sanitize payload and keys
    const data = sanitizeFirebasePayload(req.body);
    const rawLeadId = data.firebaseId || data.lead_id || `lead_${Date.now()}`;
    const lead_id = sanitizeFirebaseKey(rawLeadId, "lead");
    const rawSessionId = data.anonId || data.session_id || lead_id;
    const session_id = sanitizeFirebaseKey(rawSessionId, "session");

    // tenantId resolved and sanitized above
    const operationKey = req.headers["x-idempotency-key"] || data.operation_key || `op_${session_id}_${data.booking_status || "update"}`;

    let lockResult = null;
    try {
      // 🚨 CD06: Idempotency State Locking
      lockResult = await acquireIdempotencyLock({
        tenantId,
        conversationId: session_id,
        operationKey,
        payload: data,
        ttlMs: 60000,
        dbInstance: db,
      });

      if (lockResult.status === "cached") {
        apiLogger.info("lead_lifecycle", "lead_idempotency_cache_hit", {
          context: { lead_id, session_id, operationKey },
        });
        return res.status(200).json(lockResult.cachedResponse);
      }

      if (lockResult.status === "payload_mismatch") {
        apiLogger.warn("lead_lifecycle", "lead_idempotency_payload_conflict", {
          context: { lead_id, session_id, operationKey },
        });
        return res.status(409).json({ error: lockResult.error });
      }

      if (lockResult.status === "in_progress") {
        apiLogger.warn("lead_lifecycle", "lead_idempotency_concurrent_in_progress", {
          context: { lead_id, session_id, operationKey },
        });
        return res.status(409).json({ error: lockResult.message, status: "pending" });
      }

      if (lockResult.status === "unknown_external") {
        apiLogger.warn("lead_lifecycle", "lead_idempotency_unknown_state", {
          context: { lead_id, session_id, operationKey },
        });
        return res.status(409).json({ error: lockResult.message, status: "unknown" });
      }
    } catch (lockError) {
      if (lockError.code === "CROSS_TENANT_IDEMPOTENCY_CONFLICT") {
        apiLogger.warn("security", "cross_tenant_lock_attempt_blocked", {
          context: { error: lockError.message, tenantId, operationKey },
        });
        return res.status(403).json({ error: "Access denied: Cross-tenant lock manipulation detected." });
      }
      apiLogger.warn("lead_lifecycle", "idempotency_lock_warning", { error: lockError });
    }

    try {
      // 1. Check existing state in the database
      const leadPath = tenantId && tenantId !== "default" ? `tenants/${tenantId}/leads/${lead_id}` : `leads/${lead_id}`;
      const leadRef = ref(db, leadPath);
      let snapshot = null;
      try {
        snapshot = await executeDbWithTrace(apiLogger, "read", `leads/${lead_id}`, safeDbGet(leadRef, 600));
      } catch (e) {
        // offline fallback
      }
      const exists = snapshot ? snapshot.exists() : false;
      const existingData = exists ? snapshot.val() : {};

      // 🚨 CD06: Stale update protection
      if (exists) {
        try {
          assertNotStaleUpdate(existingData, data);
        } catch (staleErr) {
          apiLogger.warn("lead_lifecycle", "stale_update_rejected", {
            error: staleErr,
            context: { lead_id, existingVersion: existingData.version, incomingVersion: data.version },
          });
          return res.status(409).json({ error: staleErr.message });
        }
      }

      // Canonical Lead Construction
      let canonicalLead = createCanonicalLead({
        ...existingData,
        ...data,
        lead_id,
        tenant_id: tenantId,
        conversation_id: session_id,
        operation_key: operationKey,
        version: exists ? (existingData.version || 1) + 1 : 1,
      });

      // Strict Priority vs Lifecycle Separation:
      if (exists) {
        // If lifecycle changed, update lifecycle strictly preserving priority
        if (data.lifecycle_status || (data.booking_status && data.booking_status !== existingData.booking_status)) {
          const targetLifecycle = data.lifecycle_status || mapToCanonicalLifecycle(data.booking_status);
          try {
            canonicalLead = updateLeadLifecycle(existingData, targetLifecycle);
          } catch (lifecycleErr) {
            apiLogger.warn("lead_lifecycle", "invalid_lifecycle_transition", {
              error: lifecycleErr,
              context: { current: existingData.lifecycle_status, target: targetLifecycle },
            });
            return res.status(400).json({ error: lifecycleErr.message });
          }
        }
        // If priority changed, update priority strictly preserving lifecycle
        if (data.priority || (data.lead_score && data.lead_score !== existingData.lead_score)) {
          const targetPriority = data.priority || data.lead_score;
          canonicalLead = updateLeadPriority(canonicalLead, targetPriority);
        }
      }

      const hasContactInfo = Boolean(canonicalLead.name || canonicalLead.email || canonicalLead.phone);

      // Lifecycle logging events
      if (!exists && !hasContactInfo) {
        apiLogger.info("lead_lifecycle", "lead_capture_started", {
          context: { lead_id, session_id, message: "Anonymous visitor started interacting" },
        });
      }

      if (exists && existingData.last_interaction_at === data.last_interaction_at && !data.is_abandoned) {
        apiLogger.warn("lead_lifecycle", "lead_duplicate_detected", {
          context: { lead_id, session_id, message: "Exact duplicate payload skipped" },
        });
        const resData = { id: lead_id, success: true, message: "Duplicate ignored", version: existingData.version || 1 };
        await completeIdempotencyLock({ tenantId, operationKey, responseData: resData });
        return res.status(200).json(resData);
      }

      if (exists && existingData.booking_status && data.booking_status && existingData.booking_status !== data.booking_status) {
        apiLogger.info("lead_lifecycle", "lead_status_changed", {
          context: {
            lead_id,
            session_id,
            old_status: existingData.booking_status,
            new_status: data.booking_status,
          },
        });
      }

      if (!exists && hasContactInfo) {
        apiLogger.info("lead_lifecycle", "lead_created", {
          context: { lead_id, session_id, message: "New lead officially created with contact info" },
        });
      } else if (exists && hasContactInfo) {
        apiLogger.info("lead_lifecycle", "lead_updated", {
          context: { lead_id, session_id, message: "Existing lead profile updated with new context" },
        });
      }

      // Abandoned chat AI summary logic
      if (data.is_abandoned && (!canonicalLead.conversation_summary || canonicalLead.conversation_summary === "In progress...")) {
        try {
          const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
          const llmPromise = openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content:
                  "You are summarizing an abandoned lead-capture chat between a user and an AI. Summarize the conversation in 1-2 concise sentences based strictly on the provided transcript. Focus on the user's intent or any details they shared. If the user provided no meaningful info, output: 'User abandoned the chat early without providing specific details.'",
              },
              {
                role: "user",
                content: data.full_conversation_transcript || "No transcript available.",
              },
            ],
            temperature: 0.3,
            max_tokens: 100,
          });

          const completion = await traceAiExecution(apiLogger, llmPromise, {
            ai_model: "gpt-4o-mini",
            prompt_version: "abandoned_summary_v1",
            conversation_state: "abandoned_chat",
            detected_intent: "summarize",
            provider: "openai",
            tenantId,
            sessionId: session_id,
            operation: "abandoned_summary",
          });

          canonicalLead.conversation_summary = completion.choices[0].message.content.trim();
        } catch (aiError) {
          canonicalLead.conversation_summary = "Chat abandoned early (Failed to generate summary).";
        }
      }

      apiLogger.info("lead_lifecycle", "lead_routing_started", {
        context: { lead_id, session_id, destination: "firebase_db" },
      });

      // Save to Firebase
      try {
        await executeDbWithTrace(apiLogger, "update", `leads/${lead_id}`, safeDbUpdate(leadRef, canonicalLead, 600));
      } catch (e) {
        // offline fallback
      }

      apiLogger.info("lead_lifecycle", "lead_routing_success", {
        context: { lead_id, session_id, destination: "firebase_db", status: "saved" },
      });

      // 🚨 CD07: Create durable notification handoff job linked to the lead
      if (hasContactInfo || canonicalLead.lifecycle_status === "BOOKED" || data.booking_status === "Meeting Booked") {
        try {
          const eventTitle = canonicalLead.lifecycle_status === "BOOKED" || data.booking_status === "Meeting Booked"
            ? "Meeting Booked! 📅"
            : "Lead Contact Info Captured 🎯";
          const eventMessage = `${canonicalLead.name || "A prospect"} submitted lead information (${canonicalLead.email || canonicalLead.phone || "Contact captured"}).`;

          await enqueueNotificationJob({
            tenantId,
            leadId: lead_id,
            title: eventTitle,
            message: eventMessage,
            leadData: canonicalLead,
            eventType: "lead_captured",
            visitorEmailConfig: data.visitor_email_config || null,
            dbInstance: db,
          });
        } catch (handoffErr) {
          apiLogger.warn("notification_lifecycle", "handoff_enqueue_warning", { error: handoffErr });
        }
      }

      const responsePayload = {
        id: lead_id,
        success: true,
        version: canonicalLead.version,
        lifecycle_status: canonicalLead.lifecycle_status,
        priority: canonicalLead.priority,
      };

      // 🚨 Complete Idempotency Lock
      await completeIdempotencyLock({ tenantId, operationKey, responseData: responsePayload });

      return res.status(200).json(responsePayload);
    } catch (error) {
      apiLogger.critical("lead_lifecycle", "lead_routing_failed", {
        error,
        context: { lead_id, session_id, destination: "firebase_db" },
      });

      if (error?.message?.includes("timed out")) {
        await markIdempotencyLockUnknown({
          tenantId,
          operationKey,
          reason: "Database operation timed out",
        });
      } else {
        await failIdempotencyLock({ tenantId, operationKey, error });
      }

      return res.status(500).json({ error: "Failed to route/save lead data" });
    }
  }

  return res.status(405).json({ error: "Method not allowed." });
}

export default withApiLogger(handler, "Lead-Terminal-API");
