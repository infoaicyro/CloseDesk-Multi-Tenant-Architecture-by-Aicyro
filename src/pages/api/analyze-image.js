// src/pages/api/analyze-image.js
import OpenAI from "openai";
import { db } from "../../lib/firebase";
import { ref, update, get } from "firebase/database";
import { withApiLogger } from "../../lib/apiMiddleware";
import { createAiLogger } from "../../lib/loggerPresets";
import { getVisionSystemPrompt, VISION_DEFAULT_MODEL, VISION_POLICY_VERSION } from "../../lib/visionRuleBook";
import { resolveTenantId } from "../../lib/tenantResolver";
import { traceAiExecution } from "../../lib/aiTracer";
import {
  validateRequestBodySize,
  acquireConcurrencySlot,
  checkAndReserveBudget,
} from "../../lib/publicEndpointGuard";

// Bounded cap (4mb) for Vision AI diagnostic payloads
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '4mb', 
    },
  },
};

const aiLogger = createAiLogger("VisionDiagnosticAPI");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "sk-placeholder-env-key" });

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB

function isValidImagePayload(urlOrBase64) {
  if (typeof urlOrBase64 !== "string" || !urlOrBase64.trim()) return false;
  const trimmed = urlOrBase64.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return true;
  if (/^data:image\/(png|jpeg|jpg|webp|gif|bmp);base64,/i.test(trimmed)) return true;
  return false;
}

async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" });
  }

  // 1. Enforce 4MB body size cap (returns 413)
  if (!validateRequestBodySize(req, res, MAX_IMAGE_BYTES)) return;

  const { session_id, image_url, user_prompt } = req.body || {};

  // 2. Validate field presence and types (returns 400)
  if (!session_id || typeof session_id !== "string") {
    return res.status(400).json({ error: "session_id required as a string", code: "INVALID_PAYLOAD" });
  }
  if (!image_url || typeof image_url !== "string") {
    return res.status(400).json({ error: "image_url required as a string", code: "INVALID_PAYLOAD" });
  }

  // 3. Validate image payload format (must be valid image Data URI or HTTP/HTTPS URL)
  if (!isValidImagePayload(image_url)) {
    return res.status(400).json({
      error: "Invalid image format. Expected an HTTP/HTTPS URL or base64 data URI (data:image/...;base64,...).",
      code: "INVALID_IMAGE_PAYLOAD",
    });
  }

  if (image_url.length > MAX_IMAGE_BYTES) {
    return res.status(413).json({
      error: "Image payload exceeds maximum limit of 4MB.",
      code: "PAYLOAD_TOO_LARGE",
    });
  }

  const tenantId = resolveTenantId(req) || "default";

  // 4. In-flight Concurrency Check (returns 429)
  const concurrency = acquireConcurrencySlot(tenantId, 5);
  if (!concurrency.allowed) {
    return res.status(429).json({ error: concurrency.error, code: "CONCURRENCY_LIMIT_EXCEEDED", tenantId });
  }

  // 5. Budget Check & Reservation (returns 429)
  const budget = checkAndReserveBudget(tenantId, 1000);
  if (!budget.allowed) {
    concurrency.release();
    return res.status(429).json({ error: budget.error, code: budget.code, tenantId });
  }

  const startTime = Date.now();
  let actualTokens = null;

  try {
    const prospectSnap = await get(ref(db, `prospects/${session_id}`));
    const prospectData = prospectSnap.exists() ? prospectSnap.val() : {};
    const businessContext = prospectData.context_patch?.business_context || {};

    const systemPrompt = getVisionSystemPrompt(businessContext);

    const visionPromise = openai.chat.completions.create({
      model: VISION_DEFAULT_MODEL,
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 300,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: user_prompt || "Please inspect this issue and let me know what needs to be done." },
            { type: "image_url", image_url: { url: image_url, detail: "low" } }
          ]
        }
      ]
    });

    const visionResponse = await traceAiExecution(aiLogger, visionPromise, {
      ai_model: VISION_DEFAULT_MODEL,
      prompt_version: VISION_POLICY_VERSION,
      provider: "openai",
      tenantId,
      sessionId: session_id,
      operation: "vision",
    });

    actualTokens = visionResponse?.usage?.total_tokens;
    const parsedResult = JSON.parse(visionResponse.choices[0]?.message?.content || "{}");
    const duration_ms = Date.now() - startTime;

    budget.commit(actualTokens);
    concurrency.release();

    // If irrelevant, do not persist to CRM database as defect
    if (parsedResult.is_irrelevant) {
      aiLogger.warn("ai_vision", "irrelevant_image_rejected", {
        context: { session_id, model: VISION_DEFAULT_MODEL },
        duration_ms
      });
      
      return res.status(200).json({
        success: true,
        model: VISION_DEFAULT_MODEL,
        data: parsedResult
      });
    }

    // Only save valid business problems to Firebase
    const imagePayload = {
      image_url,
      identified_issue: parsedResult.identified_issue || "Defect inspected",
      urgency_level: parsedResult.urgency_level || "Medium",
      model_used: VISION_DEFAULT_MODEL,
      vision_policy_version: VISION_POLICY_VERSION,
      analyzed_at: new Date().toISOString()
    };

    await update(ref(db, `prospects/${session_id}/last_vision_inspection`), imagePayload);

    await update(ref(db, `leads/${session_id}`), {
      last_inspected_image: image_url,
      identified_issue: parsedResult.identified_issue || "",
      urgency_level: parsedResult.urgency_level || "Medium"
    }).catch(() => {});

    aiLogger.info("ai_vision", "image_analysis_success", {
      context: { session_id, model: VISION_DEFAULT_MODEL, issue: parsedResult.identified_issue, urgency: parsedResult.urgency_level },
      duration_ms
    });

    return res.status(200).json({
      success: true,
      model: VISION_DEFAULT_MODEL,
      data: parsedResult
    });

  } catch (error) {
    budget.commit(0);
    concurrency.release();
    aiLogger.error("ai_vision", "image_analysis_failed", { error, context: { session_id } });
    return res.status(500).json({ error: "Failed to analyze image", details: error.message });
  }
}

export default withApiLogger(handler, "VisionDiagnosticAPI");
