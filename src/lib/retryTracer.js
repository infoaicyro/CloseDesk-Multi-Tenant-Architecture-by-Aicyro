// src/lib/retryTracer.js
import { checkAndReserveBudget } from "./publicEndpointGuard.js";

/**
 * Wraps any promise/async function to automatically retry on transient failure 
 * and log the exact attempt lifecycle, bounding retry spend and aborting if tenant budget is exhausted.
 * 
 * @param {Object} apiLogger - The scoped logger from the API middleware
 * @param {string} operationName - Name of the process (e.g., "LLM_Execution_And_Parsing")
 * @param {Object} options - { maxAttempts: 2, delayMs: 1000, tenantId: "default", estimatedRetryTokens: 500 }
 * @param {Function} operationFn - The async function to execute. Receives (attempt, retryCount).
 */
export async function withRetryTrace(apiLogger, operationName, options = {}, operationFn) {
  // Cap retry attempts strictly to 2 to eliminate runaway spend
  const maxAttempts = Math.min(options.maxAttempts || 2, 2);
  const baseDelayMs = options.delayMs || 1000;
  const tenantId = options.tenantId || null;
  const estimatedRetryTokens = options.estimatedRetryTokens || 500;
  let attempt = 1;

  while (attempt <= maxAttempts) {
    const startTime = Date.now();
    const retryCount = attempt - 1;

    // Before attempting a retry, verify tenant budget has not been exhausted
    if (attempt > 1 && tenantId) {
      const budgetCheck = checkAndReserveBudget(tenantId, estimatedRetryTokens);
      if (!budgetCheck.allowed) {
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
      // Release reservation once checked
      budgetCheck.commit(0);
    }

    try {
      const result = await operationFn(attempt, retryCount);

      // If it succeeded but required retries, log the recovery
      if (attempt > 1) {
        apiLogger.info("retry_lifecycle", "operation_retry_success", {
          context: { 
            operation_name: operationName, 
            attempt_number: attempt,
            retry_count: retryCount,
            max_attempts: maxAttempts,
            final_status: "recovered"
          },
          duration_ms: Date.now() - startTime
        });
      }

      return result;

    } catch (error) {
      const isFinal = attempt === maxAttempts;
      const failureReason = error.message || "Unknown error";
      const duration_ms = Date.now() - startTime;

      if (isFinal) {
        // Final failure produces CRITICAL event
        apiLogger.critical("retry_lifecycle", "operation_final_failure", {
          error,
          context: { 
            operation_name: operationName, 
            attempt_number: attempt,
            retry_count: retryCount,
            max_attempts: maxAttempts, 
            failure_reason: failureReason,
            final_status: "failed" 
          },
          duration_ms
        });
        throw error;

      } else {
        // Exponential backoff
        const nextRetryMs = baseDelayMs * Math.pow(2, attempt - 1);

        apiLogger.warn("retry_lifecycle", "operation_failed_retrying", {
          error,
          context: { 
            operation_name: operationName, 
            attempt_number: attempt,
            retry_count: retryCount,
            max_attempts: maxAttempts, 
            failure_reason: failureReason,
            next_retry: `${nextRetryMs}ms`,
            final_status: "retrying" 
          },
          duration_ms
        });

        await new Promise(res => setTimeout(res, nextRetryMs));
        attempt++;
      }
    }
  }
}
