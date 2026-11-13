// src/lib/apiMiddleware.js
import { createApiLogger } from "./loggerPresets";
import { generateCorrelationId } from "./tracer";

/**
 * Universal Next.js API Wrapper to satisfy Jira Ticket #004.
 * Wraps any API handler to automatically log lifecycles, latency, and status codes.
 *
 * @param {Function} handler - The Next.js API handler function
 * @param {string} apiName - The name of the Component/API (e.g., "ChatAPI", "LeadAPI")
 */
export function withApiLogger(handler, apiName = "GenericAPI") {
  return async (req, res) => {
    // 1. Establish strict tracing identities
    const requestId = generateCorrelationId();
    const correlationId = req.headers["x-correlation-id"] || requestId;
    const sessionId = req.headers["x-session-id"] || "unknown";
    const endpoint = req.url ? req.url.split("?")[0] : "unknown_endpoint";

    // 2. Create an isolated logger exactly for this specific request
    const apiLogger = createApiLogger(apiName).child({
      correlation: {
        request_id: requestId,
        correlation_id: correlationId,
        session_id: sessionId,
      },
      context: {
        endpoint: endpoint,
        http_method: req.method,
      },
    });

    const endTimer = apiLogger.startTimer();

    // 🚨 TICKET 4: Log request start (without dumping the raw body to protect PII)
    apiLogger.info("api_lifecycle", "request_received");

    // 3. Monkey-patch the response to automatically catch the status code when the API finishes
    const originalSend = res.send;
    const originalJson = res.json;
    const originalEnd = res.end;
    let isFinished = false;

    const finishLog = (statusCode) => {
      if (isFinished) return;
      isFinished = true;
      const duration_ms = endTimer();

      // 🚨 TICKET 4: Log completion/failure with HTTP status and latency
      if (statusCode >= 400) {
        apiLogger.error("api_lifecycle", "request_failed", {
          context: { status_code: statusCode },
          duration_ms,
        });
      } else {
        apiLogger.info("api_lifecycle", "request_completed", {
          context: { status_code: statusCode },
          duration_ms,
        });
      }
    };

    // Intercept standard Next.js response methods
    res.send = function (body) {
      finishLog(res.statusCode);
      return originalSend.call(this, body);
    };
    res.json = function (body) {
      finishLog(res.statusCode);
      return originalJson.call(this, body);
    };
    res.end = function (chunk, encoding, callback) {
      finishLog(res.statusCode);
      return originalEnd.call(this, chunk, encoding, callback);
    };

    try {
      // Execute the actual API route logic, passing the scoped logger down to it
      await handler(req, res, apiLogger);
    } catch (error) {
      finishLog(500);

      // 🚨 TICKET 4: Unhandled server errors produce a stack trace via the logger
      apiLogger.critical("api_lifecycle", "unhandled_exception", { error });

      if (!res.headersSent) {
        res.status(500).json({ error: "Internal Server Error" });
      }
    }
  };
}
