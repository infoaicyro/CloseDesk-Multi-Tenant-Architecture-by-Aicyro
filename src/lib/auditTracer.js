// src/lib/auditTracer.js

/**
 * Standardizes Audit and Security logging to satisfy Jira Ticket 14.
 * Enforces the "who, what, target, previous, new" schema.
 * 
 * @param {Object} logger - The scoped logger (from API or UI logger)
 * @param {string} eventName - e.g., "login_success", "configuration_changed", "client_created"
 * @param {Object} auditData - Contains who, target, previousState, newState, status, reason
 */
export function recordAuditTrail(logger, eventName, {
    who = "unknown_user",
    target = "system",
    previousState = null,
    newState = null,
    status = "success",
    reason = null
  }) {
    // Automatically categorize as Security or Admin based on the event name
    const isSecurity = eventName.includes("login") || 
                       eventName.includes("security") || 
                       eventName.includes("unauthorized") || 
                       eventName.includes("denied");
                       
    const category = isSecurity ? "security_audit" : "admin_audit";
    const logLevel = status === "failed" ? "warn" : "info";
  
    // Ship to the central logger
    logger[logLevel](category, eventName, {
      context: {
        action_by: who,
        target_id: target,
        status,
        ...(reason && { reason })
      },
      metadata: {
        previous_version: previousState,
        new_version: newState
      }
    });
  }