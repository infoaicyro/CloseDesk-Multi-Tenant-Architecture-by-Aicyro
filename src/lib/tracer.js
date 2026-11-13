// src/lib/tracer.js
import { getOrCreateAnonId } from "./cookiePersonalization";
import { createWebsiteLogger } from "./loggerPresets";

const tracerLogger = createWebsiteLogger("NetworkTracer");

export function generateCorrelationId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID)
    return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function getTraceHeaders(correlationId, sessionId = null) {
  const activeSessionId = sessionId || getOrCreateAnonId();
  return {
    "x-correlation-id": correlationId,
    "x-session-id": activeSessionId || "unknown",
  };
}

// 🚨 TICKET 3: Capture Network Errors and API Timeouts
export async function fetchWithTrace(url, options = {}, correlationId) {
  const txId = correlationId || generateCorrelationId();
  const traceHeaders = getTraceHeaders(txId);
  const endpoint = url.split("?")[0]; // Don't log query params in endpoint field

  const updatedOptions = {
    ...options,
    headers: { ...options.headers, ...traceHeaders },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    options.timeout || 15000,
  ); // 15s default timeout
  updatedOptions.signal = controller.signal;

  try {
    const startTime = Date.now();
    const response = await fetch(url, updatedOptions);
    clearTimeout(timeoutId);

    const duration_ms = Date.now() - startTime;

    if (!response.ok) {
      tracerLogger.error("network_request", "api_failure", {
        correlation: { correlation_id: txId },
        context: {
          endpoint,
          status_code: response.status,
          http_method: options.method || "GET",
        },
        duration_ms,
      });
    }

    return response;
  } catch (error) {
    clearTimeout(timeoutId);

    // Check if it was an aborted request due to timeout
    if (error.name === "AbortError") {
      tracerLogger.error("network_request", "api_timeout", {
        correlation: { correlation_id: txId },
        context: {
          endpoint,
          http_method: options.method || "GET",
          error_message: "Request timed out after 15s",
        },
      });
    } else {
      tracerLogger.error("network_request", "network_error", {
        correlation: { correlation_id: txId },
        error,
        context: { endpoint, http_method: options.method || "GET" },
      });
    }
    throw error;
  }
}
