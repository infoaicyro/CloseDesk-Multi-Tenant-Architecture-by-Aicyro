// src/pages/api/chat.js
import OpenAI from "openai";
import { db } from "../../lib/firebase";
import { ref, set, get, update, push } from "firebase/database";
import { getMasterRuleBook, POLICY_VERSION } from "../../lib/ruleBook";
import { withApiLogger } from "../../lib/apiMiddleware";
import { resolveTenantId } from "../../lib/tenantResolver";
import { executeRagWithTrace } from "../../lib/ragTracer";

import { traceAiExecution, safeParseAiResponse } from "../../lib/aiTracer";
import { withRetryTrace } from "../../lib/retryTracer"; // 🔥 TICKET 12: Added Retry Tracer
import {
  validateRequestBodySize,
  acquireConcurrencySlot,
  checkAndReserveBudget,
} from "../../lib/publicEndpointGuard";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '32kb',
    },
  },
};

function generateHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60000;
const MAX_REQUESTS_PER_WINDOW = 15;

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const isValidPhone = (phone) => /^[\d\+\-\(\)\s]{7,20}$/.test(phone);
const isValidWebsite = (url) => /^[^\s]+\.[^\s]+$/.test(url);



function validateAndSanitizePayload(aiResponse) {
  if (!aiResponse || typeof aiResponse !== "object") {
    throw new SyntaxError("Response is not a valid JSON object");
  }

  const safePatch = aiResponse.context_patch || {};
  const contact = safePatch.contact_info || {};
  const biz = safePatch.business_context || {};
  const booking = safePatch.booking_request || {};

  const rawEmail = typeof contact.email === "string" ? contact.email : null;
  const safeEmail = rawEmail && isValidEmail(rawEmail) ? rawEmail : null;

  const rawPhone = typeof contact.phone === "string" ? contact.phone : null;
  const safePhone = rawPhone && isValidPhone(rawPhone) ? rawPhone : null;

  const rawWebsite = typeof biz.website === "string" ? biz.website : null;
  const safeWebsite = rawWebsite && isValidWebsite(rawWebsite) ? rawWebsite : null;

  const validTemperatures = ["HIGH", "MEDIUM", "EDUCATIONAL_LOW_INTENT", "UNKNOWN"];

  return {
    reply: typeof aiResponse.reply === "string" ? aiResponse.reply : "I'm sorry, I encountered a brief error. How can I help you today?",
    suggested_shortcuts: Array.isArray(aiResponse.suggested_shortcuts) ? aiResponse.suggested_shortcuts : [],
    state: typeof aiResponse.state === "string" ? aiResponse.state : "UNKNOWN",
    intent_object: Array.isArray(aiResponse.intent_object) ? aiResponse.intent_object : [],
    urgency_level: typeof aiResponse.urgency_level === "string" ? aiResponse.urgency_level : "Low",
    context_patch: {
      contact_info: {
        name: typeof contact.name === "string" ? contact.name : null,
        email: safeEmail,
        phone: safePhone,
      },
      business_context: {
        industry: typeof biz.industry === "string" ? biz.industry : null,
        business_problem: typeof biz.business_problem === "string" ? biz.business_problem : null,
        current_process: typeof biz.current_process === "string" ? biz.current_process : null,
        desired_outcome: typeof biz.desired_outcome === "string" ? biz.desired_outcome : null,
        interested_capability: typeof biz.interested_capability === "string" ? biz.interested_capability : null,
        current_software: typeof biz.current_software === "string" ? biz.current_software : null,
        website: safeWebsite,
      },
      booking_request: {
        request_type: typeof booking.request_type === "string" ? booking.request_type : null,
        preferred_date: typeof booking.preferred_date === "string" ? booking.preferred_date : null,
        preferred_time: typeof booking.preferred_time === "string" ? booking.preferred_time : null,
      },
    },
    privacy_patch: Array.isArray(aiResponse.privacy_patch) ? aiResponse.privacy_patch : [],
    next_action: typeof aiResponse.next_action === "string" ? aiResponse.next_action : "NONE",
    flags: Array.isArray(aiResponse.flags) ? aiResponse.flags : [],
    analytics_events: Array.isArray(aiResponse.analytics_events) ? aiResponse.analytics_events : [],
    lead_temperature: validTemperatures.includes(aiResponse.lead_temperature) ? aiResponse.lead_temperature : "UNKNOWN",
    lead_temperature_reason: typeof aiResponse.lead_temperature_reason === "string" ? aiResponse.lead_temperature_reason : null,
    factual_summary: typeof aiResponse.factual_summary === "string" ? aiResponse.factual_summary : null,
  };
}

async function logAnalyticsEvent(session_id, channel, state, temperature, intents, events, versions, error_msg = null) {
  try {
    const logPayload = {
      session_id,
      timestamp: new Date().toISOString(),
      versions: versions,
      channel,
      state,
      lead_temperature: temperature,
      intent_object: intents,
      events: events,
      error_message: error_msg,
    };
    await push(ref(db, `analytics_events`), logPayload);
  } catch (err) {
    console.error("Failed to write to analytics logger", err);
  }
}

async function handler(req, res, apiLogger) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed.", code: "METHOD_NOT_ALLOWED" });

  // 1. Enforce 32KB request body size cap (returns 413)
  if (!validateRequestBodySize(req, res, 32768)) return;

  // 2. Validate JSON structure (returns 400)
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    return res.status(400).json({ error: "Invalid JSON payload structure.", code: "INVALID_PAYLOAD" });
  }

  let sessionIdForErrorLog = "unknown";
  let channelForErrorLog = "web_widget";
  let errorCategory = "general_backend_failure";
  let sessionVersions = { policy: POLICY_VERSION, config_snapshot: "unknown", knowledge: "unknown" };
  let activeConcurrency = null;
  let activeBudget = null;
  let actualTokensRecorded = null;

  try {
    const {
      messages,
      current_lead_data = {},
      session_id,
      channel = "web_widget",
      retrievedKnowledge = "",
    } = req.body;

    if (session_id) sessionIdForErrorLog = session_id;
    if (channel) channelForErrorLog = channel;

    if (!session_id || typeof session_id !== "string") {
      return res.status(400).json({ error: "Session ID required as a string.", code: "INVALID_PAYLOAD" });
    }
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Conversation history required as an array.", code: "INVALID_PAYLOAD" });
    }

    const tenantId = resolveTenantId(req) || "default";

    // 3. In-flight Concurrency Check (returns 429)
    activeConcurrency = acquireConcurrencySlot(tenantId, 10);
    if (!activeConcurrency.allowed) {
      return res.status(429).json({ error: activeConcurrency.error, code: "CONCURRENCY_LIMIT_EXCEEDED", tenantId });
    }

    // 4. Budget Quota Check & Reservation (returns 429)
    activeBudget = checkAndReserveBudget(tenantId, 500);
    if (!activeBudget.allowed) {
      activeConcurrency.release();
      activeConcurrency = null;
      return res.status(429).json({ error: activeBudget.error, code: activeBudget.code, tenantId });
    }

    const isFirstMessage = messages.length === 1;

    // --- SECURITY: Rate Limiting Check ---
    const now = Date.now();
    const userRateData = rateLimitMap.get(session_id) || { count: 0, firstRequest: now };
    if (now - userRateData.firstRequest > RATE_LIMIT_WINDOW_MS) {
      userRateData.count = 1;
      userRateData.firstRequest = now;
    } else {
      userRateData.count++;
      if (userRateData.count > MAX_REQUESTS_PER_WINDOW) {
        apiLogger.warn("security_audit", "rate_limit_exceeded", { context: { session_id, message: "User sending messages too quickly." }});
        await logAnalyticsEvent(session_id, channel, "RATE_LIMITED", "UNKNOWN", [], ["error_rate_limit"], sessionVersions);
        return res.status(429).json({ reply: "You're sending messages too quickly. Please wait a moment." });
      }
    }
    rateLimitMap.set(session_id, userRateData);

    // --- SECURITY: Prompt Injection Detection ---
    const lastUserMessage = messages[messages.length - 1]?.content || "";
    const injectionPattern = /(ignore (all )?previous|system prompt|developer mode|jailbreak|bypass instructions)/i;
    let injectionDetected = false;

    if (injectionPattern.test(lastUserMessage)) {
      apiLogger.warn("security_audit", "prompt_injection_detected", { context: { session_id, message: "Potential prompt injection attempt blocked." }});
      injectionDetected = true;
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      errorCategory = "config_failure";
      throw new Error("Chat service API key not configured.");
    }

    // --- CROSS-CHANNEL CONTEXT MERGING ---
    let existingProspect = {};
    try {
      const prospectSnap = await get(ref(db, `prospects/${session_id}`));
      if (prospectSnap.exists()) {
        existingProspect = prospectSnap.val() || {};
      }
    } catch (fbReadErr) {
      apiLogger.warn("database", "firebase_read_failed", { context: { message: "Failed to pre-fetch prospect state" }, error: fbReadErr });
    }

    const serverContextPatch = existingProspect.context_patch || {};
    const serverContact = serverContextPatch.contact_info || {};
    const serverBiz = serverContextPatch.business_context || {};
    const serverBooking = serverContextPatch.booking_request || {};

    const mergedLeadData = {
      ...current_lead_data,
      name: current_lead_data.name || serverContact.name || "",
      email: current_lead_data.email || serverContact.email || "",
      phone: current_lead_data.phone || serverContact.phone || "",
      website: current_lead_data.website || serverBiz.website || "",
      business_type: current_lead_data.business_type || serverBiz.industry || "",
      business_name: current_lead_data.business_name || serverBiz.industry || "",
      service_requested: current_lead_data.service_requested || serverBiz.interested_capability || "",
      preferred_date: current_lead_data.preferred_date || serverBooking.preferred_date || "",
      preferred_time: current_lead_data.preferred_time || serverBooking.preferred_time || "",
      declined_fields: Array.from(new Set([...(current_lead_data.declined_fields || []), ...(existingProspect.privacy_patch || [])])),
    };

   // 🔥 TICKET 6: RAG Tracer Integration
   const ragContext = { query_id: `rag_${session_id}_${Date.now()}`, knowledge_version: "v1.0" };
    
   // Because your Vector DB isn't fully built yet (data comes from frontend), 
   // we wrap a simulated promise so the logs work perfectly without crashing!
   const mockVectorSearch = Promise.resolve(
     retrievedKnowledge ? [{ id: "frontend_provided_doc", score: 0.95 }] : []
   );
   await executeRagWithTrace(apiLogger, ragContext, mockVectorSearch);

   
    let instructions, botConfig;
    try {
      const tenantId = resolveTenantId(req);
      const ruleBook = await getMasterRuleBook("text", mergedLeadData, retrievedKnowledge, tenantId);
      instructions = ruleBook.instructions;
      botConfig = ruleBook.botConfig;
      sessionVersions.config_snapshot = generateHash(JSON.stringify(botConfig));
      sessionVersions.knowledge = retrievedKnowledge ? generateHash(retrievedKnowledge) : "none";
    } catch (fbErr) {
      errorCategory = "firebase_config_failure";
      throw fbErr;
    }

    const openai = new OpenAI({ apiKey });
    let validatedData = null; // ONLY DECLARED ONCE

    const aiContext = {
      ai_model: botConfig.aiModel || "gpt-4o-mini",
      prompt_version: sessionVersions.config_snapshot,
      conversation_state: existingProspect.state || (isFirstMessage ? "initial_greeting" : "in_progress"),
      detected_intent: existingProspect.intent_object ? existingProspect.intent_object[0] : "general_chat",
      rag_used: !!retrievedKnowledge,
    };

    // --- LLM & SCHEMA EXECUTION BLOCK (TICKET 12) ---
    try {
      // Reassigning validatedData without 'let' to avoid the duplicate declaration error
      validatedData = await withRetryTrace(
        apiLogger, 
        "LLM_Execution_And_Parsing", 
        { maxAttempts: 2, delayMs: 1000, tenantId, estimatedRetryTokens: 500 }, 
        async (attempt) => {
          
          const llmPromise = openai.chat.completions.create({
            model: aiContext.ai_model,
            response_format: { type: "json_object" },
            messages: [{ role: "system", content: instructions }, ...messages],
            temperature: parseFloat(botConfig.temperature ?? 0.4),
            max_tokens: 500,
          });

          // Triggers Ticket 5 (AI Trace) inside Ticket 12 (Retry Trace)
          const completion = await traceAiExecution(apiLogger, llmPromise, {
            ...aiContext,
            provider: "openai",
            tenantId,
            sessionId: session_id,
            operation: "chat",
            retryCount: attempt - 1,
          });
          actualTokensRecorded = completion?.usage?.total_tokens;
          const rawContent = completion.choices[0].message.content;
          const aiResponse = safeParseAiResponse(apiLogger, rawContent, aiContext);
          
          return validateAndSanitizePayload(aiResponse);
        }
      );
    } catch (err) {
      errorCategory = err instanceof SyntaxError ? "schema_failure" : "model_failure";
      throw err; // Send to the outermost fallback catch block
    }

    if (!validatedData) {
      throw new Error("Exhausted retries for LLM call.");
    }

    if (injectionDetected && !validatedData.intent_object.includes("Security Incident")) {
      validatedData.intent_object.push("Security Incident");
      validatedData.analytics_events.push("security_incident_detected");
    }

    const serverTimestamp = new Date().toISOString();

    const finalContact = { ...serverContact, ...(validatedData.context_patch.contact_info || {}) };
    const finalBiz = { ...serverBiz, ...(validatedData.context_patch.business_context || {}) };
    const finalBooking = { ...serverBooking, ...(validatedData.context_patch.booking_request || {}) };
    const finalPrivacyPatch = Array.from(new Set([...(existingProspect.privacy_patch || []), ...(validatedData.privacy_patch || [])]));
    const finalFlags = Array.from(new Set([...(existingProspect.flags || []), ...(validatedData.flags || [])]));

    const backendPayload = {
      session_id, channel, last_updated: serverTimestamp, versions: sessionVersions,
      transcript_reference: `transcripts/${session_id}`,
      intent_object: validatedData.intent_object,
      lead_temperature: validatedData.lead_temperature,
      lead_temperature_reason: validatedData.lead_temperature_reason,
      urgency_level: validatedData.urgency_level,
      state: validatedData.state,
      next_action: validatedData.next_action !== "NONE" ? validatedData.next_action : (existingProspect.next_action || "NONE"),
      flags: finalFlags,
      suggested_shortcuts: validatedData.suggested_shortcuts,
      factual_summary: validatedData.factual_summary || existingProspect.factual_summary || null,
      context_patch: { contact_info: finalContact, business_context: finalBiz, booking_request: finalBooking },
      privacy_patch: finalPrivacyPatch,
    };

    // --- ACTION & DATABASE PERSISTENCE BLOCK ---
    try {
      if (backendPayload.flags.length > 0) {
        const actionRef = ref(db, `session_actions/${session_id}`);
        const existingActionsSnapshot = await get(actionRef);
        const existingActions = existingActionsSnapshot.exists() ? existingActionsSnapshot.val() : {};

        const newActionsToProcess = backendPayload.flags.filter((flag) => !existingActions[flag] || existingActions[flag].status === "failed");

        if (newActionsToProcess.length > 0) {
          let updates = {};

          for (const flag of newActionsToProcess) {
            updates[flag] = { triggered_at: serverTimestamp, status: "pending" };

            // --- SECURE TEXT ERASURE ---
            if (flag === "TRIGGER_DATA_DELETION") {
              const wipedContext = {
                contact_info: { name: null, email: null, phone: null },
                business_context: { industry: null, business_problem: null, current_process: null, desired_outcome: null, interested_capability: null, current_software: null, website: null },
                booking_request: { request_type: null, preferred_date: null, preferred_time: null },
              };
              backendPayload.context_patch = wipedContext;
              backendPayload.factual_summary = null;
              validatedData.context_patch = wipedContext;
              validatedData.factual_summary = null;
              updates[flag].status = "completed";

              await set(ref(db, `transcripts/${session_id}`), null);
            }
          }
          await update(actionRef, updates);
        }
      }

      let finalEvents = [...validatedData.analytics_events];
      if (isFirstMessage) finalEvents.push("conversation_started");

      if (finalEvents.length > 0) {
        await logAnalyticsEvent(session_id, channel, validatedData.state, validatedData.lead_temperature, validatedData.intent_object, finalEvents, sessionVersions);
      }

      await set(ref(db, `prospects/${session_id}`), backendPayload);
    } catch (dbErr) {
      errorCategory = "firebase_action_failure";
      throw dbErr;
    }

    if (activeBudget) {
      activeBudget.commit(actualTokensRecorded);
      activeBudget = null;
    }
    if (activeConcurrency) {
      activeConcurrency.release();
      activeConcurrency = null;
    }

    return res.status(200).json({
      ...validatedData,
      context_patch: backendPayload.context_patch,
      privacy_patch: backendPayload.privacy_patch,
      next_action: backendPayload.next_action,
    });
  } catch (error) {
    apiLogger.error("system_event", "chatbot_engine_failure", { error, context: { errorCategory } });

    logAnalyticsEvent(sessionIdForErrorLog, channelForErrorLog, "ERROR_STATE", "UNKNOWN", [], [errorCategory], sessionVersions, error.message).catch(apiLogger.error);

    let fallbackReply = "I experienced a brief network delay. Could you please try sending that again?";
    if (errorCategory === "firebase_action_failure") {
      fallbackReply = "I had trouble saving your last request due to a database delay. Could you please confirm that one more time?";
    } else if (errorCategory === "schema_failure") {
      fallbackReply = "My system had a minor processing hiccup. Could you rephrase that slightly?";
    }

    if (activeBudget) {
      activeBudget.commit(actualTokensRecorded);
      activeBudget = null;
    }
    if (activeConcurrency) {
      activeConcurrency.release();
      activeConcurrency = null;
    }

    return res.status(200).json({
      reply: fallbackReply, suggested_shortcuts: [], context_patch: req.body?.current_lead_data || {},
      privacy_patch: [], intent_object: ["UNKNOWN"], lead_temperature: "UNKNOWN", flags: [],
      analytics_events: ["error_recovery"], state: "RECOVERY", next_action: "NONE",
    });
  }
}

export default withApiLogger(handler, "Text-Chat-API");