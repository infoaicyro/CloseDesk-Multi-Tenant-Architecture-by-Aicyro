// src/lib/dbTracer.js

/**
 * Wraps Firebase Realtime Database operations to measure latency, 
 * capture paths, and categorize failures (Ticket 13).
 * 
 * @param {Object} apiLogger - The scoped logger from the API middleware
 * @param {string} operation - "read", "write", "update", "delete", "transaction"
 * @param {string} path - The DB path (e.g., "leads/12345")
 * @param {Promise} dbPromise - The actual Firebase operation (e.g., get(ref(...)))
 */
export async function executeDbWithTrace(apiLogger, operation, path, dbPromise) {
    const startTime = Date.now();
  
    try {
      const result = await dbPromise;
      const duration_ms = Date.now() - startTime;
  
      // 🚨 TICKET 13: Duration, operation, and path are successfully recorded
      apiLogger.info("database", "db_operation_success", {
        context: { operation, path },
        duration_ms
      });
  
      return result;
  
    } catch (error) {
      const duration_ms = Date.now() - startTime;
      
      // 🚨 TICKET 13: Permission failures are distinguishable from network/timeout failures
      let errorCategory = "db_operation_failed";
      const errCode = error.code || "";
      const errMessage = error.message?.toLowerCase() || "";
  
      if (errCode === "PERMISSION_DENIED" || errMessage.includes("permission")) {
        errorCategory = "db_permission_denied";
      } else if (errCode.includes("NETWORK_ERROR") || errMessage.includes("offline")) {
        errorCategory = "db_network_failure";
      } else if (errMessage.includes("timeout")) {
        errorCategory = "db_timeout";
      }
  
      // 🚨 TICKET 13: Path is referenced, but data payload is safely omitted
      apiLogger.error("database", errorCategory, {
        error,
        context: { operation, path },
        duration_ms
      });
  
      throw error;
    }
  }