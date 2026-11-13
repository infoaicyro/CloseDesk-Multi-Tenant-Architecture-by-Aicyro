// src/lib/handoffContract.js

/**
 * CloseDesk Business Handoff Contract (CD07)
 * 
 * Strict separation of:
 * - Delivery States (provider-level delivery lifecycle)
 * - Acknowledgement States (human recipient-level accountability)
 */

export const DELIVERY_STATUS = Object.freeze({
  QUEUED: "queued",
  CLAIMED: "claimed",
  PROVIDER_ACCEPTED: "provider_accepted",
  FAILED: "failed",
  UNKNOWN: "unknown",
});

export const ACKNOWLEDGEMENT_STATUS = Object.freeze({
  UNACKNOWLEDGED: "unacknowledged",
  ACKNOWLEDGED: "acknowledged",
});

export const FOLLOW_UP_STATUS = Object.freeze({
  NONE: "none",
  CONTACTED: "contacted",
  SCHEDULED: "scheduled",
  COMPLETED: "completed",
});

// Permitted Delivery Transitions
const PERMITTED_DELIVERY_TRANSITIONS = {
  [DELIVERY_STATUS.QUEUED]: [
    DELIVERY_STATUS.CLAIMED,
    DELIVERY_STATUS.FAILED, // Direct failure if recipient is invalid
  ],
  [DELIVERY_STATUS.CLAIMED]: [
    DELIVERY_STATUS.PROVIDER_ACCEPTED,
    DELIVERY_STATUS.FAILED,
    DELIVERY_STATUS.UNKNOWN,
    DELIVERY_STATUS.QUEUED, // Backoff / lease expiration recovery
  ],
  [DELIVERY_STATUS.PROVIDER_ACCEPTED]: [], // Terminal delivery state
  [DELIVERY_STATUS.FAILED]: [
    DELIVERY_STATUS.QUEUED, // Manual authorized replay
  ],
  [DELIVERY_STATUS.UNKNOWN]: [
    DELIVERY_STATUS.PROVIDER_ACCEPTED, // Reconciled as delivered
    DELIVERY_STATUS.FAILED, // Reconciled as rejected/undelivered
    DELIVERY_STATUS.QUEUED, // Controlled manual replay after human review
  ],
};

/**
 * Validates whether a delivery state transition is permitted.
 */
export function isValidDeliveryTransition(currentStatus, nextStatus) {
  if (!currentStatus || !nextStatus) return false;
  if (currentStatus === nextStatus) return true; // Idempotent same-state
  const allowed = PERMITTED_DELIVERY_TRANSITIONS[currentStatus];
  return Array.isArray(allowed) && allowed.includes(nextStatus);
}

/**
 * Validates recipient email syntax according to RFC 5322.
 */
export function isValidRecipientEmail(email) {
  if (!email || typeof email !== "string") return false;
  const trimmed = email.trim();
  if (trimmed.length < 5 || trimmed.length > 254) return false;
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  return emailRegex.test(trimmed);
}

/**
 * Creates a normalized Notification Job object with strict separation of delivery and acknowledgement.
 */
export function createNotificationJob({
  jobId,
  leadId,
  tenantId,
  eventType = "end",
  title = "New Lead Notification",
  message = "",
  leadData = {},
  visitorEmailConfig = null,
  assignedRecipient = null,
  recipientSource = "tenant_configuration",
}) {
  const nowIso = new Date().toISOString();
  const cleanTenant = String(tenantId || "default").toLowerCase().trim();
  const stableJobId = jobId || `job_${leadId || Date.now()}_${eventType}`;

  return {
    job_id: stableJobId,
    lead_id: String(leadId || "unknown"),
    tenant_id: cleanTenant,
    event_type: eventType,
    title: String(title),
    message: String(message),
    lead_data: { ...leadData },
    visitor_email_config: visitorEmailConfig || null,

    // --- DELIVERY STATE (Provider Lifecycle) ---
    delivery_status: DELIVERY_STATUS.QUEUED,
    attempt_count: 0,
    max_attempts: 5,
    last_attempt_at: null,
    next_retry_at: nowIso,
    claimed_by: null,
    lease_expires_at: null,
    provider_id: null,
    provider_message_id: null,
    failure_reason: null,
    is_ambiguous: false,

    // --- RECIPIENT RESOLUTION ---
    assigned_recipient: assignedRecipient ? String(assignedRecipient).trim().toLowerCase() : null,
    recipient_source: recipientSource,
    recipient_validated: Boolean(assignedRecipient && isValidRecipientEmail(assignedRecipient)),

    // --- HUMAN ACKNOWLEDGEMENT STATE ---
    acknowledgement_status: ACKNOWLEDGEMENT_STATUS.UNACKNOWLEDGED,
    acknowledgement_actor: null,
    acknowledgement_timestamp: null,
    acknowledgement_notes: null,

    // --- FOLLOW-UP STATE ---
    follow_up_status: FOLLOW_UP_STATUS.NONE,
    follow_up_notes: null,
    follow_up_updated_at: null,

    // --- MONOTONIC VERSIONING & AUDIT ---
    version: 1,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

/**
 * Calculates exponential backoff with bounded jitter.
 */
export function calculateExponentialBackoffMs(attemptNumber, baseDelayMs = 1000, maxDelayMs = 30000) {
  const attempt = Math.max(1, Number(attemptNumber) || 1);
  const exponential = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
  const jitterFactor = 0.95 + Math.random() * 0.1;
  return Math.round(Math.min(maxDelayMs, exponential * jitterFactor));
}

/**
 * Creates an immutable Delivery Attempt record.
 */
export function createDeliveryAttemptRecord({
  jobId,
  leadId,
  tenantId,
  attemptNumber,
  selectedRecipient,
  providerId,
  attemptStartedAt,
  attemptCompletedAt,
  providerMessageId = null,
  responseCategory = null,
  result, // "provider_accepted" | "rejected" | "failed" | "unknown"
  sanitizedError = null,
  retryEligible = false,
  nextRetryAt = null,
}) {
  return {
    attempt_id: `att_${jobId}_${attemptNumber}_${Date.now()}`,
    job_id: String(jobId),
    lead_id: String(leadId),
    tenant_id: String(tenantId).toLowerCase().trim(),
    attempt_number: Number(attemptNumber),
    selected_recipient: selectedRecipient ? String(selectedRecipient).trim().toLowerCase() : "none",
    provider_id: String(providerId || "smtp"),
    attempt_started_at: attemptStartedAt || new Date().toISOString(),
    attempt_completed_at: attemptCompletedAt || new Date().toISOString(),
    provider_message_id: providerMessageId ? String(providerMessageId) : null,
    response_category: responseCategory ? String(responseCategory) : null,
    result: String(result),
    sanitized_error: sanitizedError ? String(sanitizedError).replace(/(password|token|secret|key)=[^&\s]+/gi, "$1=[REDACTED]") : null,
    retry_eligible: Boolean(retryEligible),
    next_retry_at: nextRetryAt || null,
  };
}
