// src/pages/api/leads.js
import OpenAI from "openai";
import { withApiLogger } from "../../lib/apiMiddleware";
import { db } from "../../lib/firebase";
import { ref, update, get } from "firebase/database";
import { traceAiExecution } from "../../lib/aiTracer"; // 🔥 Integrates Ticket 5 Tracer for the abandoned summaries
import { executeDbWithTrace } from "../../lib/dbTracer";
import { resolveTenantId, resolveAuthenticatedTenantId } from "../../lib/tenantResolver";
import { sanitizeFirebaseKey, sanitizeFirebasePayload, redactSensitiveSecrets, stripCrlf, escapeHtml } from "../../lib/sanitizer";
import { safeDbGet, safeDbUpdate } from "../../lib/safeDb";
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
        context: { error: authResult.error, status: authResult.status }
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
        context: { message: "Fetched leads for dashboard", tenantId } 
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
        context: { reason: "Payload is empty or malformed" }
      });
      return res.status(400).json({ error: "Invalid payload format", code: "INVALID_PAYLOAD" });
    }

    const tenantId = resolveTenantId(req) || req.body?.tenant_id || "default";

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

    // 🚨 SECURITY: Deep sanitize payload and keys to prevent NoSQL path traversal injection
    const data = sanitizeFirebasePayload(req.body);
    const rawLeadId = data.firebaseId || `lead_${Date.now()}`;
    const lead_id = sanitizeFirebaseKey(rawLeadId, "lead");
    const rawSessionId = data.anonId || data.session_id || lead_id;
    const session_id = sanitizeFirebaseKey(rawSessionId, "session");

    const hasContactInfo = Boolean(data.name || data.email || data.phone);

    try {
      // 1. Check existing state in the database
      const tenantId = resolveTenantId(req) || data.tenant_id || "default";
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

      // 🚨 TICKET 9: lead_capture_started
      // If the database has never seen this lead AND they haven't provided an email yet
      if (!exists && !hasContactInfo) {
        apiLogger.info("lead_lifecycle", "lead_capture_started", {
          context: { lead_id, session_id, message: "Anonymous visitor started interacting" }
        });
      }

      // 🚨 TICKET 9: lead_duplicate_detected
      // Prevent rapid double-submissions from the frontend from skewing analytics
      if (exists && existingData.last_interaction_at === data.last_interaction_at && !data.is_abandoned) {
        apiLogger.warn("lead_lifecycle", "lead_duplicate_detected", {
          context: { lead_id, session_id, message: "Exact duplicate payload skipped" }
        });
        return res.status(200).json({ id: lead_id, success: true, message: "Duplicate ignored" });
      }

      // 🚨 TICKET 9: lead_status_changed
      // Track when a lead moves from "In Progress" to "Meeting Booked" or "Callback Requested"
      if (exists && existingData.booking_status && data.booking_status && existingData.booking_status !== data.booking_status) {
        apiLogger.info("lead_lifecycle", "lead_status_changed", {
          context: { 
            lead_id, 
            session_id, 
            old_status: existingData.booking_status,
            new_status: data.booking_status
          }
        });
      }

      // 🚨 TICKET 9: lead_created vs lead_updated
      if (!exists && hasContactInfo) {
        apiLogger.info("lead_lifecycle", "lead_created", {
          context: { lead_id, session_id, message: "New lead officially created with contact info" }
        });
      } else if (exists && hasContactInfo) {
        apiLogger.info("lead_lifecycle", "lead_updated", {
          context: { lead_id, session_id, message: "Existing lead profile updated with new context" }
        });
      }

      // 2. Abandoned chat AI summary logic
      if (data.is_abandoned && (!data.conversation_summary || data.conversation_summary === "In progress...")) {
        try {
          const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
          
          const llmPromise = openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content: "You are summarizing an abandoned lead-capture chat between a user and an AI. Summarize the conversation in 1-2 concise sentences based strictly on the provided transcript. Focus on the user's intent or any details they shared. If the user provided no meaningful info, output: 'User abandoned the chat early without providing specific details.'",
              },
              {
                role: "user",
                content: data.full_conversation_transcript || "No transcript available.",
              },
            ],
            temperature: 0.3,
            max_tokens: 100,
          });

          // 🔥 BONUS: Wrap the abandoned summary inside our AI Tracer from Ticket 5!
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

          data.conversation_summary = completion.choices[0].message.content.trim();
        } catch (aiError) {
          // Because `traceAiExecution` already logs the failure securely, we just handle the fallback here
          data.conversation_summary = "Chat abandoned early (Failed to generate summary).";
        }
      }

      delete data.is_abandoned;

      // 🚨 TICKET 9: lead_routing_started
      apiLogger.info("lead_lifecycle", "lead_routing_started", {
        context: { lead_id, session_id, destination: "firebase_db" }
      });

     // 3. Save to Firebase
      // 🔥 Wrapped the Update operation
      try {
        await executeDbWithTrace(apiLogger, "update", `leads/${lead_id}`, safeDbUpdate(leadRef, data, 600));
      } catch (e) {
        // offline fallback
      }

      // 🚨 TICKET 9: lead_routing_success
      apiLogger.info("lead_lifecycle", "lead_routing_success", {
        context: { lead_id, session_id, destination: "firebase_db", status: "saved" }
      });

      return res.status(200).json({ id: lead_id, success: true });

    } catch (error) {
      // 🚨 TICKET 9: lead_routing_failed 
      // A lead will NEVER silently disappear because this catches the exact failure point.
      apiLogger.critical("lead_lifecycle", "lead_routing_failed", {
        error,
        context: { lead_id, session_id, destination: "firebase_db" }
      });
      
      return res.status(500).json({ error: "Failed to route/save lead data" });
    }
  }

  // Reject anything that isn't a GET or POST
  return res.status(405).json({ error: "Method not allowed." });
}

export default withApiLogger(handler, "Lead-Terminal-API");
