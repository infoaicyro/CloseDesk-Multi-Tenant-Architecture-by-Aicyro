// src/lib/leadContract.js
import { verifyBookedEvidence, assertBookingEvidence } from "./appointmentContract";

export { verifyBookedEvidence, assertBookingEvidence };

/**
 * CloseDesk Canonical Lead & Action Contract (CD06)
 * 
 * Shared contract for text and voice workflows.
 * Enforces strict separation between Lifecycle Status and Priority.
 * Preserves unknown customer values without inventing data.
 */

export const LIFECYCLE_STATUS = Object.freeze({
  NEW: "NEW",
  CONTACTED: "CONTACTED",
  QUALIFIED: "QUALIFIED",
  BOOKED: "BOOKED",
  CLOSED: "CLOSED",
  LOST: "LOST",
  ABANDONED: "ABANDONED",
});

export const PRIORITY_LEVEL = Object.freeze({
  LOW: "LOW",
  MEDIUM: "MEDIUM",
  HIGH: "HIGH",
  URGENT: "URGENT",
});

export const ACTION_STATUS = Object.freeze({
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  FAILED: "failed",
  UNKNOWN: "unknown",
});

// Explicit state machine transitions
const PERMITTED_LIFECYCLE_TRANSITIONS = {
  [LIFECYCLE_STATUS.NEW]: [
    LIFECYCLE_STATUS.CONTACTED,
    LIFECYCLE_STATUS.QUALIFIED,
    LIFECYCLE_STATUS.BOOKED,
    LIFECYCLE_STATUS.ABANDONED,
    LIFECYCLE_STATUS.LOST,
  ],
  [LIFECYCLE_STATUS.CONTACTED]: [
    LIFECYCLE_STATUS.QUALIFIED,
    LIFECYCLE_STATUS.BOOKED,
    LIFECYCLE_STATUS.ABANDONED,
    LIFECYCLE_STATUS.LOST,
  ],
  [LIFECYCLE_STATUS.QUALIFIED]: [
    LIFECYCLE_STATUS.BOOKED,
    LIFECYCLE_STATUS.ABANDONED,
    LIFECYCLE_STATUS.LOST,
  ],
  [LIFECYCLE_STATUS.BOOKED]: [
    LIFECYCLE_STATUS.CLOSED,
    LIFECYCLE_STATUS.LOST,
  ],
  [LIFECYCLE_STATUS.ABANDONED]: [
    LIFECYCLE_STATUS.CONTACTED,
    LIFECYCLE_STATUS.QUALIFIED,
    LIFECYCLE_STATUS.BOOKED,
    LIFECYCLE_STATUS.LOST,
  ],
  [LIFECYCLE_STATUS.LOST]: [
    LIFECYCLE_STATUS.NEW,
    LIFECYCLE_STATUS.CONTACTED,
  ],
  [LIFECYCLE_STATUS.CLOSED]: [], // Terminal state
};

/**
 * Validates whether a lifecycle transition is allowed.
 */
export function isValidLifecycleTransition(currentStatus, nextStatus) {
  if (!currentStatus || !nextStatus) return false;
  if (currentStatus === nextStatus) return true; // Idempotent same-state update
  const allowed = PERMITTED_LIFECYCLE_TRANSITIONS[currentStatus];
  return Array.isArray(allowed) && allowed.includes(nextStatus);
}

/**
 * Normalizes and validates priority level.
 */
export function normalizePriority(val) {
  if (!val || typeof val !== "string") return PRIORITY_LEVEL.LOW;
  const upper = val.trim().toUpperCase();
  if (upper in PRIORITY_LEVEL) return PRIORITY_LEVEL[upper];
  if (upper === "URGENT") return PRIORITY_LEVEL.URGENT;
  return PRIORITY_LEVEL.LOW;
}

/**
 * Normalizes and maps legacy booking_status or raw status to canonical lifecycle status.
 */
export function mapToCanonicalLifecycle(rawStatus, hasContact = false) {
  if (!rawStatus || typeof rawStatus !== "string") {
    return hasContact ? LIFECYCLE_STATUS.CONTACTED : LIFECYCLE_STATUS.NEW;
  }
  const clean = rawStatus.trim().toUpperCase();
  if (clean in LIFECYCLE_STATUS) return LIFECYCLE_STATUS[clean];

  if (clean.includes("BOOK") || clean.includes("MEETING BOOKED")) return LIFECYCLE_STATUS.BOOKED;
  if (clean.includes("ABANDON")) return LIFECYCLE_STATUS.ABANDONED;
  if (clean.includes("QUALIF") || clean.includes("REQUEST")) return LIFECYCLE_STATUS.QUALIFIED;
  if (clean.includes("CLOSE") || clean.includes("WON")) return LIFECYCLE_STATUS.CLOSED;
  if (clean.includes("LOST") || clean.includes("DISQUALIF")) return LIFECYCLE_STATUS.LOST;
  if (clean.includes("CALLBACK") || clean.includes("CONTACT")) return LIFECYCLE_STATUS.CONTACTED;
  if (clean.includes("IN PROGRESS") || clean.includes("CAPTURED")) {
    return hasContact ? LIFECYCLE_STATUS.CONTACTED : LIFECYCLE_STATUS.NEW;
  }

  return hasContact ? LIFECYCLE_STATUS.CONTACTED : LIFECYCLE_STATUS.NEW;
}

/**
 * Creates or normalizes a canonical lead object.
 * Missing customer details remain strictly null (NEVER invented).
 */
export function createCanonicalLead(rawPayload = {}) {
  const nowIso = new Date().toISOString();
  
  const rawId = rawPayload.lead_id || rawPayload.firebaseId || rawPayload.id || `lead_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const tenantId = rawPayload.tenant_id || rawPayload.tenantId || "default";
  const conversationId = rawPayload.conversation_id || rawPayload.session_id || rawPayload.anonId || rawId;

  // Contact details: strictly null if empty/unknown
  const contact = {
    name: (typeof rawPayload.name === "string" && rawPayload.name.trim()) ? rawPayload.name.trim() : null,
    email: (typeof rawPayload.email === "string" && rawPayload.email.trim()) ? rawPayload.email.trim() : null,
    phone: (typeof rawPayload.phone === "string" && rawPayload.phone.trim()) ? rawPayload.phone.trim() : null,
  };

  const hasContact = Boolean(contact.name || contact.email || contact.phone);

  // Business Context: strictly null if empty
  const businessContext = {
    business_name: (typeof rawPayload.business_name === "string" && rawPayload.business_name.trim()) ? rawPayload.business_name.trim() : null,
    business_type: (typeof rawPayload.business_type === "string" && rawPayload.business_type.trim()) ? rawPayload.business_type.trim() : null,
    industry: (typeof rawPayload.industry === "string" && rawPayload.industry.trim()) ? rawPayload.industry.trim() : null,
    website: (typeof rawPayload.website === "string" && rawPayload.website.trim()) ? rawPayload.website.trim() : null,
  };

  // Location: strictly confirmed customer location only
  const confirmedLocation = (typeof rawPayload.location === "string" && rawPayload.location.trim()) ? rawPayload.location.trim() : null;

  // Service: strictly confirmed service only
  const confirmedService = (typeof rawPayload.service_requested === "string" && rawPayload.service_requested.trim())
    ? rawPayload.service_requested.trim()
    : (typeof rawPayload.service === "string" && rawPayload.service.trim()) ? rawPayload.service.trim() : null;

  // Urgency & Priority: independent from lifecycle
  const priority = normalizePriority(rawPayload.priority || rawPayload.lead_score || "LOW");
  const urgencyLevel = (typeof rawPayload.urgency_level === "string" && rawPayload.urgency_level.trim())
    ? rawPayload.urgency_level.trim()
    : priority === PRIORITY_LEVEL.HIGH || priority === PRIORITY_LEVEL.URGENT ? "High" : "Low";

  // Requested Action
  const requestedAction = (typeof rawPayload.requested_action === "string" && rawPayload.requested_action.trim())
    ? rawPayload.requested_action.trim()
    : null;

  // Lifecycle status
  let lifecycleStatus = rawPayload.lifecycle_status
    ? normalizeLifecycleStatus(rawPayload.lifecycle_status)
    : mapToCanonicalLifecycle(rawPayload.booking_status, hasContact);

  let evidenceMissing = null;
  // CD10 Mandatory BOOKED Rule: If enforceBookingEvidence is enabled and status is BOOKED, verify evidence
  if (lifecycleStatus === LIFECYCLE_STATUS.BOOKED && rawPayload.enforceBookingEvidence) {
    const evidenceCheck = verifyBookedEvidence({
      ...rawPayload,
      contact,
      tenant_id: tenantId,
    });
    if (!evidenceCheck.valid) {
      lifecycleStatus = hasContact ? LIFECYCLE_STATUS.QUALIFIED : LIFECYCLE_STATUS.CONTACTED;
      evidenceMissing = evidenceCheck.missing;
    }
  }

  // Version counter for concurrency & monotonic ordering
  const currentVersion = typeof rawPayload.version === "number" && rawPayload.version >= 1
    ? Math.floor(rawPayload.version)
    : 1;

  const rawBookingStatus = rawPayload.booking_status || (lifecycleStatus === LIFECYCLE_STATUS.BOOKED ? "Meeting Booked" : "Captured");
  const effectiveBookingStatus = evidenceMissing
    ? "Appointment Request Submitted"
    : rawBookingStatus;

  return {
    lead_id: String(rawId),
    tenant_id: String(tenantId).toLowerCase().trim(),
    conversation_id: String(conversationId),
    operation_key: rawPayload.operation_key ? String(rawPayload.operation_key) : null,
    source: rawPayload.source || "web_chat",
    source_page: rawPayload.source_page || null,
    device_name: rawPayload.deviceName || rawPayload.device_name || "Unknown Device",
    lifecycle_status: lifecycleStatus,
    priority: priority,
    urgency_level: urgencyLevel,
    version: currentVersion,
    contact: contact,
    business_context: businessContext,
    location: confirmedLocation,
    service_requested: confirmedService,
    requested_action: requestedAction,
    booking_details: {
      booking_status: effectiveBookingStatus,
      booked_slot: rawPayload.booked_slot || null,
      display_time: rawPayload.display_time || null,
      selected_date: rawPayload.selected_date || null,
      appointment_id: rawPayload.appointment_id || rawPayload.booking_details?.appointment_id || null,
      evidence_missing: evidenceMissing,
    },
    conversation_summary: rawPayload.conversation_summary || null,
    full_conversation_transcript: rawPayload.full_conversation_transcript || null,
    last_inspected_image: rawPayload.last_inspected_image || null,
    generated_subject: rawPayload.generated_subject || null,
    generated_body: rawPayload.generated_body || null,
    created_at: rawPayload.created_at || rawPayload.timestamp || rawPayload.conversation_started_at || nowIso,
    updated_at: nowIso,
    // Flat accessors for backward compatibility with existing Dashboard and endpoints
    firebaseId: String(rawId),
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    business_name: businessContext.business_name,
    business_type: businessContext.business_type,
    lead_score: priority === PRIORITY_LEVEL.HIGH || priority === PRIORITY_LEVEL.URGENT ? "High" : priority === PRIORITY_LEVEL.MEDIUM ? "Medium" : "Low",
    booking_status: effectiveBookingStatus,
    appointment_id: rawPayload.appointment_id || rawPayload.booking_details?.appointment_id || null,
    last_interaction_at: nowIso,
  };
}

function normalizeLifecycleStatus(status) {
  if (!status || typeof status !== "string") return LIFECYCLE_STATUS.NEW;
  const upper = status.trim().toUpperCase();
  return upper in LIFECYCLE_STATUS ? LIFECYCLE_STATUS[upper] : LIFECYCLE_STATUS.NEW;
}

/**
 * Safely updates lifecycle status while guaranteeing Priority is NEVER overwritten.
 */
export function updateLeadLifecycle(existingLead, newLifecycle, metadata = {}) {
  const currentStatus = existingLead.lifecycle_status || mapToCanonicalLifecycle(existingLead.booking_status);
  const targetStatus = normalizeLifecycleStatus(newLifecycle);

  if (!isValidLifecycleTransition(currentStatus, targetStatus)) {
    const error = new Error(`Invalid lifecycle transition from '${currentStatus}' to '${targetStatus}'.`);
    error.code = "INVALID_LIFECYCLE_TRANSITION";
    error.currentStatus = currentStatus;
    error.targetStatus = targetStatus;
    throw error;
  }

  // CD10 Mandatory BOOKED Rule Assertion
  if (targetStatus === LIFECYCLE_STATUS.BOOKED && (metadata.strictEvidence || metadata.enforceBookingEvidence)) {
    assertBookingEvidence({
      ...existingLead,
      ...metadata,
    });
  }

  const newVersion = (existingLead.version || 1) + 1;
  const nowIso = new Date().toISOString();

  // Return new lead with lifecycle updated, priority strictly preserved
  return {
    ...existingLead,
    lifecycle_status: targetStatus,
    booking_status: targetStatus === LIFECYCLE_STATUS.BOOKED ? "Meeting Booked" : (existingLead.booking_status || "Captured"),
    booking_details: {
      ...(existingLead.booking_details || {}),
      ...(metadata.booking_details || {}),
      appointment_id: metadata.appointment_id || existingLead.booking_details?.appointment_id || null,
      booking_status: targetStatus === LIFECYCLE_STATUS.BOOKED ? "Meeting Booked" : (existingLead.booking_status || "Captured"),
    },
    version: newVersion,
    updated_at: nowIso,
    last_interaction_at: nowIso,
    // Preserve existing priority untouched
    priority: existingLead.priority || PRIORITY_LEVEL.LOW,
    urgency_level: existingLead.urgency_level || "Low",
    lead_score: existingLead.lead_score || "Low",
  };
}

/**
 * Promotes a lead to BOOKED only when all 7 pieces of evidence are verified.
 */
export function promoteToBooked(existingLead, bookingEvidence = {}) {
  const payloadToVerify = {
    ...existingLead,
    ...bookingEvidence,
    authoritative_commit: true,
  };
  assertBookingEvidence(payloadToVerify);

  return updateLeadLifecycle(existingLead, LIFECYCLE_STATUS.BOOKED, {
    ...bookingEvidence,
    authoritative_commit: true,
    strictEvidence: true,
  });
}

/**
 * Safely updates priority while guaranteeing Lifecycle Status is NEVER overwritten.
 */
export function updateLeadPriority(existingLead, newPriority, metadata = {}) {
  const targetPriority = normalizePriority(newPriority);
  const newVersion = (existingLead.version || 1) + 1;
  const nowIso = new Date().toISOString();

  const formattedScore = targetPriority === PRIORITY_LEVEL.HIGH || targetPriority === PRIORITY_LEVEL.URGENT
    ? "High"
    : targetPriority === PRIORITY_LEVEL.MEDIUM ? "Medium" : "Low";

  // Return new lead with priority updated, lifecycle status strictly preserved
  return {
    ...existingLead,
    priority: targetPriority,
    urgency_level: targetPriority === PRIORITY_LEVEL.HIGH || targetPriority === PRIORITY_LEVEL.URGENT ? "High" : "Low",
    lead_score: formattedScore,
    version: newVersion,
    updated_at: nowIso,
    last_interaction_at: nowIso,
    // Preserve existing lifecycle untouched
    lifecycle_status: existingLead.lifecycle_status || LIFECYCLE_STATUS.NEW,
    booking_status: existingLead.booking_status || "Captured",
  };
}

/**
 * Validates against stale updates using monotonic version counter and timestamps.
 */
export function assertNotStaleUpdate(existingLead, incomingPayload) {
  if (!existingLead || !existingLead.version) return true;

  if (incomingPayload.version !== undefined && incomingPayload.version !== null) {
    if (incomingPayload.version < existingLead.version) {
      const err = new Error(`Stale update rejected: Incoming version (${incomingPayload.version}) is older than persisted version (${existingLead.version}).`);
      err.code = "STALE_UPDATE_VERSION";
      throw err;
    }
  }

  // Strict timestamp ordering fallback
  if (incomingPayload.updated_at && existingLead.updated_at) {
    const incomingTime = new Date(incomingPayload.updated_at).getTime();
    const existingTime = new Date(existingLead.updated_at).getTime();
    if (!isNaN(incomingTime) && !isNaN(existingTime) && incomingTime < existingTime) {
      const err = new Error(`Stale update rejected: Incoming timestamp (${incomingPayload.updated_at}) is older than persisted timestamp (${existingLead.updated_at}).`);
      err.code = "STALE_UPDATE_TIMESTAMP";
      throw err;
    }
  }

  return true;
}
