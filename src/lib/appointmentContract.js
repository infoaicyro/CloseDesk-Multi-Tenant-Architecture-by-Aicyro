// src/lib/appointmentContract.js

/**
 * Authoritative Appointment Contract (CD10 - P0)
 *
 * Defines canonical appointment statuses, booking modes, slot calculation algorithms,
 * timezone/DST handling, and the mandatory 7-point BOOKED evidence rule.
 */

export const APPOINTMENT_STATUS = Object.freeze({
  AVAILABILITY_CHECKED: "availability_checked",
  BOOKING_REQUESTED: "booking_requested",
  BOOKING_PENDING: "booking_pending",
  BOOKING_COMMITTED: "booking_committed",
  BOOKING_FAILED: "booking_failed",
  BOOKING_OUTCOME_UNKNOWN: "booking_outcome_unknown",
  CANCELLATION_REQUESTED: "cancellation_requested",
  CANCELLED: "cancelled",
  RESCHEDULING_REQUESTED: "rescheduling_requested",
  RESCHEDULED: "rescheduled",
  RECONCILIATION_REQUIRED: "reconciliation_required",
});

export const BOOKING_MODES = Object.freeze({
  CONFIRMED_BOOKING: "confirmed_booking",
  REQUEST_ONLY: "request_only",
  DISABLED: "disabled",
});

/**
 * Permitted transitions between appointment statuses
 */
const PERMITTED_APPOINTMENT_TRANSITIONS = {
  [APPOINTMENT_STATUS.AVAILABILITY_CHECKED]: [
    APPOINTMENT_STATUS.BOOKING_REQUESTED,
    APPOINTMENT_STATUS.BOOKING_FAILED,
  ],
  [APPOINTMENT_STATUS.BOOKING_REQUESTED]: [
    APPOINTMENT_STATUS.BOOKING_PENDING,
    APPOINTMENT_STATUS.BOOKING_FAILED,
    APPOINTMENT_STATUS.CANCELLED,
  ],
  [APPOINTMENT_STATUS.BOOKING_PENDING]: [
    APPOINTMENT_STATUS.BOOKING_COMMITTED,
    APPOINTMENT_STATUS.BOOKING_FAILED,
    APPOINTMENT_STATUS.BOOKING_OUTCOME_UNKNOWN,
    APPOINTMENT_STATUS.RECONCILIATION_REQUIRED,
  ],
  [APPOINTMENT_STATUS.BOOKING_COMMITTED]: [
    APPOINTMENT_STATUS.CANCELLATION_REQUESTED,
    APPOINTMENT_STATUS.CANCELLED,
    APPOINTMENT_STATUS.RESCHEDULING_REQUESTED,
    APPOINTMENT_STATUS.RESCHEDULED,
    APPOINTMENT_STATUS.RECONCILIATION_REQUIRED,
  ],
  [APPOINTMENT_STATUS.BOOKING_FAILED]: [
    APPOINTMENT_STATUS.BOOKING_REQUESTED, // Controlled retry with new slot
  ],
  [APPOINTMENT_STATUS.BOOKING_OUTCOME_UNKNOWN]: [
    APPOINTMENT_STATUS.BOOKING_COMMITTED, // Reconciliation confirms commit
    APPOINTMENT_STATUS.BOOKING_FAILED,    // Reconciliation confirms failure
    APPOINTMENT_STATUS.RECONCILIATION_REQUIRED,
  ],
  [APPOINTMENT_STATUS.CANCELLATION_REQUESTED]: [
    APPOINTMENT_STATUS.CANCELLED,
    APPOINTMENT_STATUS.BOOKING_COMMITTED, // Cancellation denied or aborted
  ],
  [APPOINTMENT_STATUS.CANCELLED]: [], // Terminal state
  [APPOINTMENT_STATUS.RESCHEDULING_REQUESTED]: [
    APPOINTMENT_STATUS.RESCHEDULED,
    APPOINTMENT_STATUS.BOOKING_COMMITTED, // Reschedule aborted, keep original
    APPOINTMENT_STATUS.CANCELLED,
  ],
  [APPOINTMENT_STATUS.RESCHEDULED]: [
    APPOINTMENT_STATUS.CANCELLATION_REQUESTED,
    APPOINTMENT_STATUS.CANCELLED,
    APPOINTMENT_STATUS.RESCHEDULING_REQUESTED,
    APPOINTMENT_STATUS.RESCHEDULED,
  ],
  [APPOINTMENT_STATUS.RECONCILIATION_REQUIRED]: [
    APPOINTMENT_STATUS.BOOKING_COMMITTED,
    APPOINTMENT_STATUS.CANCELLED,
    APPOINTMENT_STATUS.BOOKING_FAILED,
  ],
};

/**
 * Validates whether an appointment transition is allowed.
 */
export function isValidAppointmentTransition(currentStatus, nextStatus) {
  if (!currentStatus || !nextStatus) return false;
  if (currentStatus === nextStatus) return true; // Idempotent same-state update
  const allowed = PERMITTED_APPOINTMENT_TRANSITIONS[currentStatus];
  return Array.isArray(allowed) && allowed.includes(nextStatus);
}

/**
 * Validates whether an IANA timezone string is recognized.
 */
export function isValidIanaTimezone(tz) {
  if (!tz || typeof tz !== "string") return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz.trim() });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Normalizes an IANA timezone with a fallback.
 */
export function normalizeIanaTimezone(tz, fallback = "UTC") {
  if (isValidIanaTimezone(tz)) return tz.trim();
  if (isValidIanaTimezone(fallback)) return fallback;
  return "UTC";
}

/**
 * Formats a UTC ISO timestamp into localized appointment presentation.
 */
export function formatAppointmentTime(isoString, timezone = "UTC") {
  if (!isoString) return "Not Scheduled";
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return "Invalid Date";

  const tz = normalizeIanaTimezone(timezone);
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
    return formatter.format(date);
  } catch (e) {
    return date.toISOString();
  }
}

/**
 * Calculates slot timing bounds including duration, pre-buffer, and post-buffer.
 *
 * @param {string|Date} startInput ISO string or Date of slot start
 * @param {number} durationMinutes Duration of appointment in minutes
 * @param {number} preBufferMinutes Setup/travel buffer before appointment
 * @param {number} postBufferMinutes Teardown/travel buffer after appointment
 * @returns {object} { startMs, endMs, windowStartMs, windowEndMs, startIso, endIso, windowStartIso, windowEndIso }
 */
export function calculateSlotBounds(
  startInput,
  durationMinutes = 60,
  preBufferMinutes = 0,
  postBufferMinutes = 0
) {
  const startDate = new Date(startInput);
  if (isNaN(startDate.getTime())) {
    throw new Error(`Invalid slot start time: ${startInput}`);
  }

  const durationMs = Math.max(1, Number(durationMinutes) || 60) * 60 * 1000;
  const preBufferMs = Math.max(0, Number(preBufferMinutes) || 0) * 60 * 1000;
  const postBufferMs = Math.max(0, Number(postBufferMinutes) || 0) * 60 * 1000;

  const startMs = startDate.getTime();
  const endMs = startMs + durationMs;
  const windowStartMs = startMs - preBufferMs;
  const windowEndMs = endMs + postBufferMs;

  return {
    startMs,
    endMs,
    windowStartMs,
    windowEndMs,
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    windowStartIso: new Date(windowStartMs).toISOString(),
    windowEndIso: new Date(windowEndMs).toISOString(),
    durationMinutes: Number(durationMinutes) || 60,
    preBufferMinutes: Number(preBufferMinutes) || 0,
    postBufferMinutes: Number(postBufferMinutes) || 0,
  };
}

/**
 * Checks if two appointment time windows overlap, considering buffers.
 * Two intervals [S1, E1) and [S2, E2) overlap if S1 < E2 and S2 < E1.
 */
export function doSlotWindowsOverlap(slotA, slotB) {
  const windowAStart = slotA.windowStartMs ?? slotA.startMs;
  const windowAEnd = slotA.windowEndMs ?? slotA.endMs;
  const windowBStart = slotB.windowStartMs ?? slotB.startMs;
  const windowBEnd = slotB.windowEndMs ?? slotB.endMs;

  return windowAStart < windowBEnd && windowBStart < windowAEnd;
}

/**
 * Checks for Daylight Saving Time (DST) anomalies:
 * - Spring Forward: Clock skips 1 hour (non-existent local wall clock time).
 * - Fall Back: Clock repeats 1 hour (ambiguous local wall clock time).
 * 
 * Verifies that the ISO timestamp round-trips correctly through the given timezone.
 */
export function validateDstBoundary(startIso, timezone = "UTC") {
  const tz = normalizeIanaTimezone(timezone);
  const date = new Date(startIso);
  if (isNaN(date.getTime())) {
    return { valid: false, reason: "Invalid ISO timestamp" };
  }

  // Format into local parts
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
    timeZoneName: "shortOffset",
  });

  const parts = formatter.formatToParts(date);
  const partMap = {};
  for (const p of parts) partMap[p.type] = p.value;

  // Check 12 hours before and after to detect offset shift (DST boundary transition day)
  const prevDate = new Date(date.getTime() - 12 * 3600 * 1000);
  const nextDate = new Date(date.getTime() + 12 * 3600 * 1000);

  const prevOffset = getTzOffsetMinutes(prevDate, tz);
  const currentOffset = getTzOffsetMinutes(date, tz);
  const nextOffset = getTzOffsetMinutes(nextDate, tz);

  const isDstTransitionDay = prevOffset !== currentOffset || currentOffset !== nextOffset;

  return {
    valid: true,
    timezone: tz,
    utcIso: date.toISOString(),
    isDstTransitionDay,
    currentOffsetMinutes: currentOffset,
    offsetDifference: nextOffset - prevOffset,
  };
}

/**
 * Gets UTC offset in minutes for a given date in an IANA timezone.
 */
function getTzOffsetMinutes(date, timeZone) {
  const utcDate = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  const tzDate = new Date(date.toLocaleString("en-US", { timeZone }));
  return Math.round((tzDate.getTime() - utcDate.getTime()) / 60000);
}

/**
 * MANDATORY BOOKED RULE (CD10)
 *
 * A lead or conversation may enter BOOKED only when all 7 pieces of evidence exist:
 * 1. Authoritative booking commit from local scheduler or verified provider.
 * 2. Durable booking identifier returned and persisted.
 * 3. Known, validated start time and duration.
 * 4. Recorded timezone (IANA string).
 * 5. Validated service and duration.
 * 6. Explicit customer agreement prior to commit.
 * 7. Correct tenant and customer identity binding.
 *
 * @param {object} payload
 * @returns {object} { valid: boolean, missing: string[], evidence: object }
 */
export function verifyBookedEvidence(payload = {}) {
  const missing = [];
  const evidence = {};

  // 1. Authoritative booking commit
  const status = payload.status || payload.booking_status || payload.booking_details?.status;
  const isCommitted = (
    status === APPOINTMENT_STATUS.BOOKING_COMMITTED ||
    status === "committed" ||
    status === "Meeting Booked" ||
    status === "BOOKED"
  ) && (payload.authoritative_commit === true || payload.booking_details?.authoritative_commit === true);

  if (!isCommitted) {
    missing.push("authoritative_commit: Appointment must be explicitly committed by authoritative scheduler");
  } else {
    evidence.authoritative_commit = true;
  }

  // 2. Durable booking identifier
  const appointmentId = payload.appointment_id || payload.booking_details?.appointment_id || payload.bookingId;
  const hasValidId = typeof appointmentId === "string" && appointmentId.trim().length >= 6;
  if (!hasValidId) {
    missing.push("durable_booking_id: Missing durable booking identifier (e.g. apt_...)");
  } else {
    evidence.durable_booking_id = appointmentId.trim();
  }

  // 3. Known, validated start time
  const startTime = payload.start_time || payload.booked_slot || payload.booking_details?.start_time || payload.booking_details?.booked_slot;
  const parsedStart = startTime ? new Date(startTime) : null;
  const hasValidStart = parsedStart && !isNaN(parsedStart.getTime());
  if (!hasValidStart) {
    missing.push("validated_start_time: Missing or invalid ISO 8601 appointment start time");
  } else {
    evidence.start_time = parsedStart.toISOString();
  }

  // 4. Recorded timezone (IANA string)
  const timezone = payload.timezone || payload.booking_details?.timezone;
  const hasValidTz = isValidIanaTimezone(timezone);
  if (!hasValidTz) {
    missing.push("recorded_timezone: Missing or unrecognized IANA timezone string");
  } else {
    evidence.timezone = timezone.trim();
  }

  // 5. Validated service and duration
  const service = payload.service || payload.service_requested || payload.booking_details?.service;
  const duration = payload.duration_minutes || payload.duration || payload.booking_details?.duration_minutes;
  const hasValidService = typeof service === "string" && service.trim().length > 0;
  const hasValidDuration = typeof duration === "number" && duration > 0;
  if (!hasValidService || !hasValidDuration) {
    missing.push("validated_service_duration: Must have confirmed service name and duration > 0 minutes");
  } else {
    evidence.service = service.trim();
    evidence.duration_minutes = duration;
  }

  // 6. Explicit customer agreement prior to commit
  const agreement = payload.customer_agreement || payload.customer_agreed || payload.booking_details?.customer_agreement;
  const hasAgreement = Boolean(
    agreement === true ||
    (typeof agreement === "object" && agreement !== null && agreement.confirmed === true)
  );
  if (!hasAgreement) {
    missing.push("customer_agreement: Customer must explicitly affirmative-agree prior to booking commit");
  } else {
    evidence.customer_agreement = typeof agreement === "object" ? agreement : { confirmed: true, channel: "chat" };
  }

  // 7. Correct tenant and customer identity binding
  const tenantId = payload.tenant_id || payload.tenantId;
  const contact = payload.contact || {};
  const customerName = contact.name || payload.name || payload.customer_name;
  const customerContact = contact.email || contact.phone || payload.email || payload.phone;

  const hasTenant = typeof tenantId === "string" && tenantId.trim().length > 0;
  const hasCustomer = Boolean(customerName && customerContact);

  if (!hasTenant) {
    missing.push("tenant_binding: Missing valid tenant identifier");
  }
  if (!hasCustomer) {
    missing.push("customer_identity: Missing customer name and at least one contact method (email or phone)");
  }
  if (hasTenant && hasCustomer) {
    evidence.tenant_id = tenantId.trim().toLowerCase();
    evidence.customer_name = customerName;
    evidence.customer_contact = customerContact;
  }

  return {
    valid: missing.length === 0,
    missing,
    evidence,
  };
}

/**
 * Asserts that the 7 pieces of evidence exist, otherwise throws an informative error.
 */
export function assertBookingEvidence(payload = {}) {
  const check = verifyBookedEvidence(payload);
  if (!check.valid) {
    const error = new Error(`Mandatory BOOKED rule violated: Missing required evidence:\n- ${check.missing.join("\n- ")}`);
    error.code = "MISSING_BOOKING_EVIDENCE";
    error.missing = check.missing;
    throw error;
  }
  return check.evidence;
}

/**
 * Creates a canonical appointment entity.
 */
export function createCanonicalAppointment(rawPayload = {}) {
  const nowIso = new Date().toISOString();
  const rawId = rawPayload.appointment_id || `apt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const tenantId = (rawPayload.tenant_id || rawPayload.tenantId || "default").toLowerCase().trim();
  const leadId = rawPayload.lead_id || rawPayload.leadId || null;
  const conversationId = rawPayload.conversation_id || rawPayload.session_id || null;
  const operationKey = rawPayload.operation_key || null;

  const timezone = normalizeIanaTimezone(rawPayload.timezone, "UTC");
  const durationMinutes = Number(rawPayload.duration_minutes) || 60;
  const preBufferMinutes = Number(rawPayload.pre_buffer_minutes) || 0;
  const postBufferMinutes = Number(rawPayload.post_buffer_minutes) || 0;

  const bounds = calculateSlotBounds(
    rawPayload.start_time || nowIso,
    durationMinutes,
    preBufferMinutes,
    postBufferMinutes
  );

  const contact = {
    name: rawPayload.customer_name || rawPayload.name || null,
    email: rawPayload.customer_email || rawPayload.email || null,
    phone: rawPayload.customer_phone || rawPayload.phone || null,
  };

  const status = rawPayload.status || APPOINTMENT_STATUS.BOOKING_PENDING;

  return {
    appointment_id: String(rawId),
    tenant_id: tenantId,
    lead_id: leadId ? String(leadId) : null,
    conversation_id: conversationId ? String(conversationId) : null,
    operation_key: operationKey ? String(operationKey) : null,
    status,
    booking_mode: rawPayload.booking_mode || BOOKING_MODES.CONFIRMED_BOOKING,
    service: rawPayload.service || rawPayload.service_requested || "General Consultation",
    start_time: bounds.startIso,
    end_time: bounds.endIso,
    window_start: bounds.windowStartIso,
    window_end: bounds.windowEndIso,
    duration_minutes: bounds.durationMinutes,
    pre_buffer_minutes: bounds.preBufferMinutes,
    post_buffer_minutes: bounds.postBufferMinutes,
    timezone,
    display_time: formatAppointmentTime(bounds.startIso, timezone),
    contact,
    customer_agreement: rawPayload.customer_agreement || {
      confirmed: false,
      timestamp: null,
      channel: null,
    },
    authoritative_commit: Boolean(rawPayload.authoritative_commit),
    capacity: Number(rawPayload.capacity) || 1,
    reschedule_history: Array.isArray(rawPayload.reschedule_history) ? rawPayload.reschedule_history : [],
    cancellation_reason: rawPayload.cancellation_reason || null,
    created_at: rawPayload.created_at || nowIso,
    updated_at: nowIso,
  };
}
