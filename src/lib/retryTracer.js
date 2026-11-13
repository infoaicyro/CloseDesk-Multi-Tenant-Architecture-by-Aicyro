// src/lib/retryTracer.js
import { checkAndReserveBudget } from "./publicEndpointGuard.js";

/**
 * Enhanced Retry Tracer (CD05 / CD06 Unified)
 * 
 * Supports:
 * - Tracking operation state (pending, retrying, recovered, failed, unknown)
 * - Capturing operation keys and payload hashes for audit tracing
 * - Automatic redaction of sensitive credentials (OAuth tokens, SMTP passwords)
 * - Tenant AI budget exhaustion protection during backoff
 * - Optional reconciliation hook before retrying external ambiguous operations
 * 
 * @param {Object} apiLogger - Scoped logger from API middleware
 * @param {string} operationName - Name of the process
 * @param {Object} options - { maxAttempts, delayMs, operationKey, payloadHash, tenantId, reconcileFn, estimatedRetryTokens }
 * @param {Function} operationFn - Async function (attempt, retryCount) => Promise
 */
export async function withRetryTrace(apiLogger, operationName, options = {}, operationFn) {
  const maxAttempts = options.maxAttempts || 3;
  const baseDelayMs = options.delayMs || 1000;
  const operationKey = options.operationKey || null;
  const payloadHash = options.payloadHash || null;
  const tenantId = options.tenantId || null;
  const reconcileFn = typeof options.reconcileFn === "function" ? options.reconcileFn : null;
  const estimatedRetryTokens = options.estimatedRetryTokens || 500;
  let attempt = 1;

  while (attempt <= maxAttempts) {
    const startTime = Date.now();
    const retryCount = attempt - 1;

    // Before attempting a retry, verify tenant budget has not been exhausted
    if (attempt > 1 && tenantId && typeof checkAndReserveBudget === "function") {
      try {
        const budgetCheck = checkAndReserveBudget(tenantId, estimatedRetryTokens);
        if (budgetCheck && !budgetCheck.allowed) {
          apiLogger.error("retry_lifecycle", "retry_aborted_budget_exhausted", {
            context: {
              operation_name: operationName,
              attempt_number: attempt,
              tenantId,
              reason: "Tenant AI budget exhausted during retry backoff.",
            },
          });
          const err = new Error(`Retry aborted: AI budget exhausted for tenant '${tenantId}'`);
          err.code = "BUDGET_EXCEEDED";
          throw err;
        }
        if (budgetCheck?.commit) {
          budgetCheck.commit(0);
        }
      } catch (budgetErr) {
        if (budgetErr.code === "BUDGET_EXCEEDED") throw budgetErr;
      }
    }

    try {
      // If retrying, check if reconciliation is required before repeating side-effect
      if (attempt > 1 && reconcileFn) {
        try {
          const reconciliation = await reconcileFn(attempt);
          if (reconciliation && reconciliation.alreadyExecuted) {
            apiLogger.info("retry_lifecycle", "operation_reconciled_early", {
              context: {
                operation_name: operationName,
                operation_key: operationKey,
                tenant_id: tenantId,
                attempt_number: attempt,
                message: "Reconciliation detected external action already completed; skipping duplicate execution.",
              },
            });
            return reconciliation.cachedResult;
          }
        } catch (reconcileErr) {
          apiLogger.warn("retry_lifecycle", "reconciliation_failed", {
            error: redactError(reconcileErr),
            context: { operation_name: operationName, operation_key: operationKey },
          });
        }
      }

      const result = await operationFn(attempt, retryCount);

      // Log recovery if it required multiple attempts
      if (attempt > 1) {
        apiLogger.info("retry_lifecycle", "operation_retry_success", {
          context: {
            operation_name: operationName,
            operation_key: operationKey,
            payload_hash: payloadHash,
            tenant_id: tenantId,
            attempt_number: attempt,
            retry_count: retryCount,
            max_attempts: maxAttempts,
            final_status: "recovered",
          },
          duration_ms: Date.now() - startTime,
        });
      }

      return result;

    } catch (error) {
      const isFinal = attempt === maxAttempts;
      const cleanError = redactError(error);
      const duration_ms = Date.now() - startTime;

      if (isFinal) {
        const isAmbiguousTimeout = isTimeoutOrNetworkError(error);
        const finalStatus = isAmbiguousTimeout ? "unknown" : "failed";

        apiLogger.critical("retry_lifecycle", "operation_final_failure", {
          error: cleanError,
          context: {
            operation_name: operationName,
            operation_key: operationKey,
            payload_hash: payloadHash,
            tenant_id: tenantId,
            attempt_number: attempt,
            retry_count: retryCount,
            max_attempts: maxAttempts,
            failure_reason: cleanError.message,
            final_status: finalStatus,
            is_ambiguous_external_state: isAmbiguousTimeout,
          },
          duration_ms,
        });

        error.isAmbiguousTimeout = isAmbiguousTimeout;
        error.finalStatus = finalStatus;
        throw error;

      } else {
        const nextRetryMs = baseDelayMs * Math.pow(2, attempt - 1);

        apiLogger.warn("retry_lifecycle", "operation_failed_retrying", {
          error: cleanError,
          context: {
            operation_name: operationName,
            operation_key: operationKey,
            payload_hash: payloadHash,
            tenant_id: tenantId,
            attempt_number: attempt,
            retry_count: retryCount,
            max_attempts: maxAttempts,
            failure_reason: cleanError.message,
            next_retry: `${nextRetryMs}ms`,
            final_status: "retrying",
          },
          duration_ms,
        });

        await new Promise((res) => setTimeout(res, nextRetryMs));
        attempt++;
      }
    }
  }
}

/**
 * Strips secrets, tokens, and authorization credentials from error objects.
 */
function redactError(err) {
  if (!err) return new Error("Unknown error");
  let message = typeof err.message === "string" ? err.message : String(err);

  // Redact credentials pattern
  message = message
    .replace(/(bearer\s+)[a-zA-Z0-9_\-\.]+/gi, "$1[REDACTED]")
    .replace(/(password["':\s=]+)[^&\s",]+/gi, "$1[REDACTED]")
    .replace(/(secret["':\s=]+)[^&\s",]+/gi, "$1[REDACTED]")
    .replace(/(key["':\s=]+)[a-zA-Z0-9_\-\.]{15,}/gi, "$1[REDACTED]");

  const clean = new Error(message);
  clean.name = err.name || "Error";
  clean.code = err.code;
  return clean;
}

/**
 * Determines whether an error indicates an ambiguous timeout or network partition.
 */
function isTimeoutOrNetworkError(err) {
  const msg = (err?.message || "").toLowerCase();
  const code = (err?.code || "").toLowerCase();
  return (
    code.includes("timeout") ||
    code.includes("timedout") ||
    code.includes("etimedout") ||
    code.includes("esockettimedout") ||
    code.includes("econnreset") ||
    code.includes("econnaborted") ||
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("timedout") ||
    msg.includes("network error") ||
    msg.includes("socket hang up")
  );
}
