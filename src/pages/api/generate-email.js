// src/pages/api/generate-email.js
import { withApiLogger } from "../../lib/apiMiddleware";
import { executeIntegrationWithTrace } from "../../lib/integrationTracer";
import { stripCrlf } from "../../lib/sanitizer";
import {
  validateRequestBodySize,
} from "../../lib/publicEndpointGuard";
import { checkRateLimit } from "../../lib/persistentRateLimiter";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '16kb',
    },
  },
};

async function handler(req, res, apiLogger) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" });
  }

  // 1. Enforce 16KB body size cap (returns 413)
  if (!validateRequestBodySize(req, res, 16384)) return;

  const clientIp = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
  const sessionId = req.body?.session_id || clientIp;

  // 2. Rate limiting check (max 10 email triggers per 10 minutes)
  const rateKey = `gen_email_${sessionId}`;
  const rateCheck = await checkRateLimit(rateKey, { maxAttempts: 10, windowMs: 10 * 60 * 1000, lockoutMs: 10 * 60 * 1000 });
  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: "Email dispatch rate limit exceeded. Please wait a moment.",
      code: "RATE_LIMIT_EXCEEDED",
      retryAfter: rateCheck.retryAfter || 60,
    });
  }

  const { name, business_type, time } = req.body || {};

  // 3. Prevent arbitrary recipients & sanitize against CRLF header injection
  const safeName = stripCrlf(name || "");
  const safeBizType = stripCrlf(business_type || "");
  const safeTime = stripCrlf(time || "");
  
  const WEBHOOK_URL = process.env.MAKE_COM_EMAIL_WEBHOOK_URL;
  const SECRET_TOKEN = process.env.WEBHOOK_SECRET;

  if (!WEBHOOK_URL) {
    return res.status(500).json({ error: "Email Integration not configured" });
  }

  // 4. Define Integration parameters
  const integrationConfig = {
    integration_name: "Make.com_Email_Automation",
    operation: "Trigger_Confirmation_Email",
    retryOptions: { maxAttempts: 2, delayMs: 2000 }
  };

  const fetchOptions = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SECRET_TOKEN}`
    },
    // Strictly transmit sanitized fields without arbitrary client recipient overrides
    body: JSON.stringify({
      name: safeName,
      business_type: safeBizType,
      time: safeTime,
    })
  };

  try {
    const result = await executeIntegrationWithTrace(
      apiLogger, 
      integrationConfig, 
      WEBHOOK_URL, 
      fetchOptions
    );

    return res.status(200).json({ 
      success: true, 
      messageId: result.id || "webhook_accepted",
      subject: result.generated_subject,
      body: result.generated_body
    });

  } catch (error) {
    return res.status(502).json({ error: "Failed to dispatch email via external provider." });
  }
}

export default withApiLogger(handler, "Generate-Email-API");
