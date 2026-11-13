// src/pages/api/tts.js
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { withApiLogger } from "../../lib/apiMiddleware";
import { Readable } from "stream";
import { resolveTenantId } from "../../lib/tenantResolver";
import { recordAuthoritativeAiTrace } from "../../lib/aiTracer";
import {
  validateRequestBodySize,
  acquireConcurrencySlot,
  checkAndReserveBudget,
} from "../../lib/publicEndpointGuard";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '16kb',
    },
  },
};

const polly = new PollyClient({
  region: process.env.CUSTOM_AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.CUSTOM_AWS_ACCESS_KEY_ID || "test_key",
    secretAccessKey: process.env.CUSTOM_AWS_SECRET_ACCESS_KEY || "test_secret",
  },
});

async function handler(req, res, apiLogger) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed", code: "METHOD_NOT_ALLOWED" });
  }

  // 1. Enforce 16KB body size cap (returns 413)
  if (!validateRequestBodySize(req, res, 16384)) return;

  const { text, voiceId = "Joanna" } = req.body || {};

  // 2. Validate payload fields (returns 400)
  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return res.status(400).json({ error: "text required as a non-empty string", code: "INVALID_PAYLOAD" });
  }
  if (text.length > 4096) {
    return res.status(400).json({ error: "text exceeds maximum length of 4096 characters", code: "INVALID_PAYLOAD" });
  }

  const tenantId = resolveTenantId(req) || "default";

  // 3. Concurrency check (returns 429)
  const concurrency = acquireConcurrencySlot(tenantId, 5);
  if (!concurrency.allowed) {
    return res.status(429).json({ error: concurrency.error, code: "CONCURRENCY_LIMIT_EXCEEDED", tenantId });
  }

  // 4. Budget check & reservation (returns 429)
  const budget = checkAndReserveBudget(tenantId, 200);
  if (!budget.allowed) {
    concurrency.release();
    return res.status(429).json({ error: budget.error, code: budget.code, tenantId });
  }

  const startTime = Date.now();

  try {
    let safeVoiceId = voiceId;
    if (String(safeVoiceId).toLowerCase() === "ash") {
      safeVoiceId = "Matthew"; // Safe fallback for the dashboard preview
    }

    const command = new SynthesizeSpeechCommand({
      Engine: "neural",
      LanguageCode: "en-US",
      OutputFormat: "mp3",
      Text: text,
      VoiceId: safeVoiceId,
    });

    const response = await polly.send(command);
    const duration_ms = Date.now() - startTime;

    budget.commit(200);
    concurrency.release();

    // 🚨 REQUIREMENT: TTS returns byte stream without token count. Record tokens explicitly as "unknown" (never 0)
    recordAuthoritativeAiTrace({
      provider: "aws-polly",
      model: safeVoiceId,
      tenantId,
      sessionId: req.body?.session_id || "tts_preview",
      operation: "tts",
      usage: {
        total_tokens: "unknown",
        prompt_tokens: "unknown",
        completion_tokens: "unknown",
        characters: text.length,
      },
      status: "completed",
      estimatedCostUsd: Number((text.length * 0.000016).toFixed(6)), // AWS Polly Neural ~$16 per 1M characters
      duration_ms,
    });

    res.setHeader("Content-Type", "audio/mpeg");

    if (response.AudioStream instanceof Readable) {
      response.AudioStream.pipe(res);
    } else {
      const stream = Readable.from(response.AudioStream);
      stream.pipe(res);
    }
  } catch (error) {
    budget.commit(0);
    concurrency.release();
    apiLogger.error("AWS Polly Error:", error);
    res.status(500).json({ error: "Text-to-Speech failed", details: error.message });
  }
}

export default withApiLogger(handler, "tts-API");
