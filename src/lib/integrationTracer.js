// src/lib/integrationTracer.js
import { withRetryTrace } from "./retryTracer";

/**
 * Safely executes third-party integrations (CRMs, Webhooks, Emails) 
 * satisfying Jira Ticket #11.
 * 
 * @param {Object} apiLogger - The scoped logger from the API middleware
 * @param {Object} integrationConfig - Config containing name, operation, and retry limits
 * @param {string} fetchUrl - The external URL being called
 * @param {Object} fetchOptions - Standard fetch options (method, headers, body)
 */
export async function executeIntegrationWithTrace(
  apiLogger, 
  integrationConfig, 
  fetchUrl, 
  fetchOptions = {}
) {
  const {
    integration_name = "Unknown_Provider",
    operation = "POST",
    retryOptions = { maxAttempts: 2, delayMs: 1500 } // Give external APIs slightly longer to recover
  } = integrationConfig;

  // 🚨 TICKET 11: Tokens/API credentials NEVER appear in logs.
  // We sanitize the URL to remove `?api_key=123` and mask sensitive headers
  const safeUrl = fetchUrl.split("?")[0]; 
  const safeHeaders = { ...fetchOptions.headers };
  if (safeHeaders["Authorization"]) safeHeaders["Authorization"] = "[REDACTED_TOKEN]";
  if (safeHeaders["x-api-key"]) safeHeaders["x-api-key"] = "[REDACTED_API_KEY]";
  if (safeHeaders["Bearer"]) safeHeaders["Bearer"] = "[REDACTED_BEARER]";

  const startTime = Date.now();

  // 🚨 TICKET 11: integration_request_started
  apiLogger.info("integration_lifecycle", "integration_request_started", {
    context: { integration_name, operation, endpoint: safeUrl }
  });

  // 🚨 TICKET 11: Retries are visible by injecting the operation into our Ticket 12 tracer
  return await withRetryTrace(apiLogger, `Integration_${integration_name}`, retryOptions, async (attempt) => {
    try {
      const response = await fetch(fetchUrl, fetchOptions);
      const duration_ms = Date.now() - startTime;

      // 🚨 TICKET 11: Failure response is recorded safely without blowing up the JSON parser
      let responseBody = {};
      const rawText = await response.text();
      try {
        responseBody = rawText ? JSON.parse(rawText) : {};
      } catch (e) {
        responseBody = { raw_text: rawText.substring(0, 150) + "..." }; // Truncate huge HTML crash pages
      }

      if (!response.ok) {
        // Throwing sends it to the catch block to log the failure and trigger the retry
        throw new Error(JSON.stringify({ status: response.status, body: responseBody }));
      }

      // 🚨 TICKET 11: External reference ID is recorded
      // We look for common ID patterns returned by Resend, SendGrid, n8n, Stripe, etc.
      const external_reference_id = 
        responseBody.id || 
        responseBody.messageId || 
        responseBody.ref_id || 
        responseBody.transaction_id || 
        "none_provided";

      // 🚨 TICKET 11: integration_request_success
      apiLogger.info("integration_lifecycle", "integration_request_success", {
        context: { 
          integration_name, 
          operation, 
          http_status: response.status,
          external_reference_id,
          retry_count: attempt - 1
        },
        duration_ms
      });

      return responseBody;

    } catch (error) {
      const duration_ms = Date.now() - startTime;
      
      let parsedBody = error.message;
      let http_status = 500;
      
      try {
        const errData = JSON.parse(error.message);
        http_status = errData.status;
        parsedBody = errData.body;
      } catch (e) {}

      // 🚨 TICKET 11: Integration failure identifies provider
      apiLogger.error("integration_lifecycle", "integration_request_failed", {
        error: new Error(typeof parsedBody === "string" ? parsedBody : JSON.stringify(parsedBody)),
        context: { 
          integration_name, 
          operation, 
          http_status,
          retry_count: attempt - 1
        },
        duration_ms
      });

      throw error; // Re-throw to allow withRetryTrace to handle the actual retry logic
    }
  });
}