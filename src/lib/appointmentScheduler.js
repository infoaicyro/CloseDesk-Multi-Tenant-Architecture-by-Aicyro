// src/lib/appointmentScheduler.js
import crypto from "crypto";
import { ref, get, set, update } from "firebase/database";
import { db } from "./firebase";
import { sanitizeFirebaseKey } from "./sanitizer";
import {
  APPOINTMENT_STATUS,
  BOOKING_MODES,
  calculateSlotBounds,
  doSlotWindowsOverlap,
  isValidAppointmentTransition,
  normalizeIanaTimezone,
  verifyBookedEvidence,
  createCanonicalAppointment,
} from "./appointmentContract";
import {
  acquireIdempotencyLock,
  completeIdempotencyLock,
  failIdempotencyLock,
  markIdempotencyLockUnknown,
} from "./idempotencyLocker";
import { updateLeadLifecycle, LIFECYCLE_STATUS } from "./leadContract";

/**
 * In-process promise mutex queue per tenant-slot key to guarantee zero race conditions
 * during concurrent commit attempts (e.g., 10 simultaneous requests against capacity=1).
 */
const slotMutexes = new Map();

async function runWithSlotMutex(mutexKey, fn) {
  const previousPromise = slotMutexes.get(mutexKey) || Promise.resolve();
  let release;
  const currentPromise = new Promise((resolve) => {
    release = resolve;
  });
  slotMutexes.set(mutexKey, currentPromise);

  try {
    await previousPromise;
    return await fn();
  } finally {
    release();
    if (slotMutexes.get(mutexKey) === currentPromise) {
      slotMutexes.delete(mutexKey);
    }
  }
}

/**
 * Resolves standard DB operations with support for mock stores in tests.
 */
function resolveDbOps(dbInstance, dbOps) {
  return {
    get: async (path) => {
      if (dbOps?.get) return await dbOps.get(path);
      if (typeof dbInstance?.get === "function") {
        const res = await dbInstance.get(path);
        return res && typeof res.val === "function" ? res.val() : res;
      }
      const dbRef = ref(dbInstance || db, path);
      const snap = await get(dbRef);
      return snap && snap.exists() ? snap.val() : null;
    },
    set: async (path, val) => {
      if (dbOps?.set) return await dbOps.set(path, val);
      if (typeof dbInstance?.set === "function") return await dbInstance.set(path, val);
      const dbRef = ref(dbInstance || db, path);
      await set(dbRef, val);
    },
    update: async (path, patch) => {
      if (dbOps?.update) return await dbOps.update(path, patch);
      if (typeof dbInstance?.update === "function") return await dbInstance.update(path, patch);
      const dbRef = ref(dbInstance || db, path);
      await update(dbRef, patch);
    },
  };
}

/**
 * Normalizes tenant ID for appointment storage paths.
 */
function getTenantPathPrefix(tenantId) {
  const clean = tenantId ? String(tenantId).toLowerCase().trim().replace(/[^a-z0-9_-]/g, "") : "default";
  return clean && clean !== "default" ? `tenants/${clean}` : "";
}

function getAppointmentsPath(tenantId) {
  const prefix = getTenantPathPrefix(tenantId);
  return prefix ? `${prefix}/appointments` : "appointments";
}

function getSlotLocksPath(tenantId, slotKey) {
  const prefix = getTenantPathPrefix(tenantId);
  const cleanKey = sanitizeFirebaseKey(slotKey, "slot");
  return prefix ? `${prefix}/slot_locks/${cleanKey}` : `slot_locks/${cleanKey}`;
}

/**
 * Generates a deterministic slot key for time intervals.
 */
export function generateSlotKey(startIso, durationMinutes = 60) {
  const date = new Date(startIso);
  const timeMs = Math.floor(date.getTime() / 60000) * 60000; // Round to minute
  return `slot_${timeMs}_d${durationMinutes}`;
}

/**
 * Checks slot availability against existing committed appointments, duration, buffers, and capacity.
 */
export async function checkSlotAvailability({
  tenantId = "default",
  service = "General Consultation",
  startIso,
  durationMinutes = 60,
  preBufferMinutes = 0,
  postBufferMinutes = 0,
  capacity = 1,
  timezone = "UTC",
  dbInstance = db,
  dbOps = null,
}) {
  const ops = resolveDbOps(dbInstance, dbOps);
  const cleanTenant = String(tenantId).toLowerCase().trim();
  const maxCapacity = Math.max(1, Number(capacity) || 1);

  const targetBounds = calculateSlotBounds(
    startIso,
    durationMinutes,
    preBufferMinutes,
    postBufferMinutes
  );

  // Read all existing appointments for this tenant
  const appointmentsPath = getAppointmentsPath(cleanTenant);
  const allAppointmentsObj = (await ops.get(appointmentsPath)) || {};

  // Count active overlapping appointments
  let overlappingCount = 0;
  const overlappingAppointments = [];

  for (const [id, appt] of Object.entries(allAppointmentsObj)) {
    if (!appt || typeof appt !== "object") continue;

    // Ignore cancelled or failed bookings
    if (
      appt.status === APPOINTMENT_STATUS.CANCELLED ||
      appt.status === APPOINTMENT_STATUS.BOOKING_FAILED
    ) {
      continue;
    }

    try {
      const existingBounds = calculateSlotBounds(
        appt.start_time,
        appt.duration_minutes || 60,
        appt.pre_buffer_minutes || 0,
        appt.post_buffer_minutes || 0
      );

      if (doSlotWindowsOverlap(targetBounds, existingBounds)) {
        overlappingCount++;
        overlappingAppointments.push({
          appointment_id: id,
          start_time: appt.start_time,
          end_time: appt.end_time,
        });
      }
    } catch (e) {
      // Ignore malformed appointment dates
    }
  }

  const isAvailable = overlappingCount < maxCapacity;

  return {
    available: isAvailable,
    currentBookings: overlappingCount,
    maxCapacity,
    reason: isAvailable
      ? "Slot is available"
      : `Slot capacity limit reached (${overlappingCount}/${maxCapacity} reserved)`,
    bounds: targetBounds,
    timezone: normalizeIanaTimezone(timezone),
    overlappingAppointments,
  };
}

/**
 * Authoritatively commits an appointment with idempotency, concurrency locking, and policy enforcement.
 */
export async function commitAppointment({
  tenantId = "default",
  leadId = null,
  conversationId = null,
  customerInfo = {},
  service = "General Consultation",
  startIso,
  durationMinutes = 60,
  preBufferMinutes = 0,
  postBufferMinutes = 0,
  capacity = 1,
  timezone = "UTC",
  customerAgreement = null,
  operationKey,
  bookingMode = BOOKING_MODES.CONFIRMED_BOOKING,
  tenantConfig = {},
  dbInstance = db,
  dbOps = null,
}) {
  const ops = resolveDbOps(dbInstance, dbOps);
  const cleanTenant = String(tenantId).toLowerCase().trim();
  const effectiveMode = tenantConfig?.booking_mode || bookingMode || BOOKING_MODES.CONFIRMED_BOOKING;

  // 1. Policy & Mode Check: Disabled Mode
  if (effectiveMode === BOOKING_MODES.DISABLED || tenantConfig?.enableDirectBooking === false && tenantConfig?.allowBookingRequests === false) {
    return {
      success: false,
      status: APPOINTMENT_STATUS.BOOKING_FAILED,
      bookingMode: BOOKING_MODES.DISABLED,
      reason: `Booking is currently disabled by policy for tenant '${cleanTenant}'. Please request a callback.`,
    };
  }

  // 2. Request-Only Mode: Record request truthfully WITHOUT consuming slot capacity
  if (effectiveMode === BOOKING_MODES.REQUEST_ONLY || (tenantConfig?.enableDirectBooking === false && tenantConfig?.allowBookingRequests !== false)) {
    const requestId = `req_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const displayTime = calculateSlotBounds(startIso, durationMinutes, preBufferMinutes, postBufferMinutes).startIso;

    // If lead exists, update lead to QUALIFIED with explicit request status (NEVER BOOKED)
    if (leadId) {
      const leadPath = getTenantPathPrefix(cleanTenant) ? `${getTenantPathPrefix(cleanTenant)}/leads/${leadId}` : `leads/${leadId}`;
      const existingLead = await ops.get(leadPath);
      if (existingLead) {
        await ops.update(leadPath, {
          lifecycle_status: LIFECYCLE_STATUS.QUALIFIED,
          booking_status: "Appointment Request Submitted",
          "booking_details/booking_status": "Appointment Request Submitted",
          "booking_details/request_id": requestId,
          "booking_details/requested_slot": startIso,
          updated_at: new Date().toISOString(),
        });
      }
    }

    return {
      success: true,
      status: "request_recorded",
      bookingMode: BOOKING_MODES.REQUEST_ONLY,
      requestId,
      message: `Your appointment request for ${displayTime} has been recorded. Our team will review availability and confirm your appointment shortly.`,
    };
  }

  // 3. Explicit Customer Agreement Check (Mandatory Rule #6)
  const isAgreed = customerAgreement === true || (customerAgreement && customerAgreement.confirmed === true);
  if (!isAgreed) {
    return {
      success: false,
      status: APPOINTMENT_STATUS.BOOKING_FAILED,
      reason: "Customer explicit affirmative agreement is required prior to booking commit.",
      code: "CUSTOMER_AGREEMENT_REQUIRED",
    };
  }

  // 4. Operation Key & Idempotency Check
  const effectiveOpKey = operationKey || `op_appt_${cleanTenant}_${leadId || conversationId || "anon"}_${Date.now()}`;
  let lockResult = null;

  try {
    lockResult = await acquireIdempotencyLock({
      tenantId: cleanTenant,
      conversationId: conversationId || leadId || "unknown",
      operationKey: effectiveOpKey,
      payload: { startIso, durationMinutes, service, customerInfo },
      ttlMs: 60000,
      dbInstance,
      dbOps,
    });

    if (lockResult.status === "cached") {
      return {
        success: true,
        status: APPOINTMENT_STATUS.BOOKING_COMMITTED,
        cached: true,
        appointment: lockResult.cachedResponse?.appointment || lockResult.cachedResponse || lockResult.cachedResult?.appointment || lockResult.cachedResult,
      };
    }
  } catch (lockErr) {
    if (lockErr.code === "CROSS_TENANT_IDEMPOTENCY_CONFLICT") {
      throw lockErr;
    }
    // If lock fails, proceed with safe caution
  }

  // 5. Concurrency Protection via Slot Mutex Queue
  const slotKey = generateSlotKey(startIso, durationMinutes);
  const mutexKey = `${cleanTenant}_${slotKey}`;

  return await runWithSlotMutex(mutexKey, async () => {
    try {
      // Check availability under slot mutex
      const avail = await checkSlotAvailability({
        tenantId: cleanTenant,
        service,
        startIso,
        durationMinutes,
        preBufferMinutes,
        postBufferMinutes,
        capacity,
        timezone,
        dbInstance,
        dbOps,
      });

      if (!avail.available) {
        if (effectiveOpKey) {
          await failIdempotencyLock({
            tenantId: cleanTenant,
            operationKey: effectiveOpKey,
            error: new Error(avail.reason),
            dbInstance,
            dbOps,
          });
        }
        return {
          success: false,
          status: APPOINTMENT_STATUS.BOOKING_FAILED,
          reason: avail.reason,
          code: "SLOT_CAPACITY_EXCEEDED",
          currentBookings: avail.currentBookings,
          maxCapacity: avail.maxCapacity,
        };
      }

      // Generate durable appointment ID
      const appointmentId = `apt_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
      const canonicalAppt = createCanonicalAppointment({
        appointment_id: appointmentId,
        tenant_id: cleanTenant,
        lead_id: leadId,
        conversation_id: conversationId,
        operation_key: effectiveOpKey,
        status: APPOINTMENT_STATUS.BOOKING_COMMITTED,
        booking_mode: BOOKING_MODES.CONFIRMED_BOOKING,
        service,
        start_time: startIso,
        duration_minutes: durationMinutes,
        pre_buffer_minutes: preBufferMinutes,
        post_buffer_minutes: postBufferMinutes,
        timezone,
        customer_name: customerInfo.name,
        customer_email: customerInfo.email,
        customer_phone: customerInfo.phone,
        customer_agreement: {
          confirmed: true,
          timestamp: new Date().toISOString(),
          channel: customerAgreement?.channel || "chat",
        },
        authoritative_commit: true,
        capacity,
      });

      // Persist appointment record
      const apptPath = `${getAppointmentsPath(cleanTenant)}/${appointmentId}`;
      await ops.set(apptPath, canonicalAppt);

      // Persist slot lock
      const lockPath = getSlotLocksPath(cleanTenant, slotKey);
      const existingSlotLock = (await ops.get(lockPath)) || { active_bookings: [] };
      const updatedBookings = Array.isArray(existingSlotLock.active_bookings)
        ? [...existingSlotLock.active_bookings, appointmentId]
        : [appointmentId];

      await ops.set(lockPath, {
        slot_key: slotKey,
        tenant_id: cleanTenant,
        active_bookings: updatedBookings,
        max_capacity: capacity,
        updated_at: new Date().toISOString(),
      });

      // Update lead if leadId is linked
      if (leadId) {
        const leadPath = getTenantPathPrefix(cleanTenant) ? `${getTenantPathPrefix(cleanTenant)}/leads/${leadId}` : `leads/${leadId}`;
        const existingLead = await ops.get(leadPath);
        if (existingLead) {
          const updatedLead = {
            ...existingLead,
            lifecycle_status: LIFECYCLE_STATUS.BOOKED,
            booking_status: "Meeting Booked",
            booking_details: {
              ...(existingLead.booking_details || {}),
              appointment_id: appointmentId,
              booking_status: "Meeting Booked",
              booked_slot: startIso,
              display_time: canonicalAppt.display_time,
              timezone: canonicalAppt.timezone,
              service,
              authoritative_commit: true,
            },
            updated_at: new Date().toISOString(),
          };
          await ops.update(leadPath, updatedLead);
        }
      }

      // Complete idempotency lock
      if (effectiveOpKey) {
        await completeIdempotencyLock({
          tenantId: cleanTenant,
          operationKey: effectiveOpKey,
          responseData: { appointment: canonicalAppt },
          dbInstance,
          dbOps,
        });
      }

      return {
        success: true,
        status: APPOINTMENT_STATUS.BOOKING_COMMITTED,
        appointment_id: appointmentId,
        appointment: canonicalAppt,
      };
    } catch (err) {
      // Mark unknown for ambiguous timeouts
      if (effectiveOpKey) {
        try {
          await markIdempotencyLockUnknown({
            tenantId: cleanTenant,
            operationKey: effectiveOpKey,
            externalRef: `pending_appt_${Date.now()}`,
            dbInstance,
            dbOps,
          });
        } catch (e) {
          // Ignore secondary logging error
        }
      }

      return {
        success: false,
        status: APPOINTMENT_STATUS.BOOKING_OUTCOME_UNKNOWN,
        pending_reconciliation: true,
        reason: err.message,
      };
    }
  });
}

/**
 * Reconciles an ambiguous or pending appointment commit.
 */
export async function reconcileAppointment({
  tenantId = "default",
  operationKey,
  appointmentId = null,
  dbInstance = db,
  dbOps = null,
}) {
  const ops = resolveDbOps(dbInstance, dbOps);
  const cleanTenant = String(tenantId).toLowerCase().trim();

  // If appointment ID is known, inspect appointment record
  if (appointmentId) {
    const apptPath = `${getAppointmentsPath(cleanTenant)}/${appointmentId}`;
    const appt = await ops.get(apptPath);
    if (appt && appt.authoritative_commit && appt.status === APPOINTMENT_STATUS.BOOKING_COMMITTED) {
      return {
        reconciled: true,
        status: APPOINTMENT_STATUS.BOOKING_COMMITTED,
        appointment: appt,
      };
    }
  }

  // Inspect idempotency lock
  if (operationKey) {
    const prefix = getTenantPathPrefix(cleanTenant);
    const lockPath = prefix ? `${prefix}/idempotency_locks/${operationKey}` : `idempotency_locks/${operationKey}`;
    const lock = await ops.get(lockPath);

    if (lock && lock.status === "completed" && lock.lead_id) {
      const apptPath = `${getAppointmentsPath(cleanTenant)}/${lock.lead_id}`;
      const appt = await ops.get(apptPath);
      if (appt) {
        return {
          reconciled: true,
          status: APPOINTMENT_STATUS.BOOKING_COMMITTED,
          appointment: appt,
        };
      }
    }
  }

  return {
    reconciled: true,
    status: APPOINTMENT_STATUS.BOOKING_FAILED,
    reason: "No committed appointment record found during reconciliation",
  };
}

/**
 * Cancels an appointment, releases slot lock, and updates lifecycle.
 */
export async function cancelAppointment({
  tenantId = "default",
  appointmentId,
  reason = "Customer requested cancellation",
  actor = "customer",
  dbInstance = db,
  dbOps = null,
}) {
  const ops = resolveDbOps(dbInstance, dbOps);
  const cleanTenant = String(tenantId).toLowerCase().trim();

  if (!appointmentId) {
    throw new Error("appointmentId is required to cancel an appointment.");
  }

  const apptPath = `${getAppointmentsPath(cleanTenant)}/${appointmentId}`;
  const appt = await ops.get(apptPath);

  if (!appt) {
    const err = new Error(`Appointment '${appointmentId}' not found for tenant '${cleanTenant}'.`);
    err.code = "APPOINTMENT_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  // Cross-tenant isolation verification
  if (appt.tenant_id && String(appt.tenant_id).toLowerCase().trim() !== cleanTenant) {
    const err = new Error(`Cross-tenant appointment access forbidden. Tenant '${cleanTenant}' cannot access appointment owned by '${appt.tenant_id}'.`);
    err.code = "CROSS_TENANT_ACCESS_FORBIDDEN";
    err.statusCode = 403;
    throw err;
  }

  // Validate state transition
  if (!isValidAppointmentTransition(appt.status, APPOINTMENT_STATUS.CANCELLED)) {
    const err = new Error(`Cannot cancel appointment in '${appt.status}' state.`);
    err.code = "INVALID_APPOINTMENT_TRANSITION";
    err.statusCode = 400;
    throw err;
  }

  const nowIso = new Date().toISOString();

  // 1. Update appointment record
  await ops.update(apptPath, {
    status: APPOINTMENT_STATUS.CANCELLED,
    cancellation_reason: reason,
    cancelled_by: actor,
    cancelled_at: nowIso,
    updated_at: nowIso,
  });

  // 2. Release slot lock
  if (appt.start_time) {
    const slotKey = generateSlotKey(appt.start_time, appt.duration_minutes || 60);
    const lockPath = getSlotLocksPath(cleanTenant, slotKey);
    const lock = await ops.get(lockPath);
    if (lock && Array.isArray(lock.active_bookings)) {
      const remaining = lock.active_bookings.filter((id) => id !== appointmentId);
      await ops.update(lockPath, {
        active_bookings: remaining,
        updated_at: nowIso,
      });
    }
  }

  // 3. Update linked lead if applicable
  if (appt.lead_id) {
    const leadPath = getTenantPathPrefix(cleanTenant) ? `${getTenantPathPrefix(cleanTenant)}/leads/${appt.lead_id}` : `leads/${appt.lead_id}`;
    const lead = await ops.get(leadPath);
    if (lead) {
      await ops.update(leadPath, {
        booking_status: "Cancelled",
        "booking_details/booking_status": "Cancelled",
        updated_at: nowIso,
      });
    }
  }

  return {
    success: true,
    status: APPOINTMENT_STATUS.CANCELLED,
    appointment_id: appointmentId,
    cancelled_at: nowIso,
  };
}

/**
 * Reschedules an appointment to a new slot with atomic capacity validation and lock transfer.
 */
export async function rescheduleAppointment({
  tenantId = "default",
  appointmentId,
  newStartIso,
  newDurationMinutes = null,
  customerAgreement = true,
  reason = "Customer requested reschedule",
  dbInstance = db,
  dbOps = null,
}) {
  const ops = resolveDbOps(dbInstance, dbOps);
  const cleanTenant = String(tenantId).toLowerCase().trim();

  if (!appointmentId) {
    throw new Error("appointmentId is required to reschedule an appointment.");
  }

  const apptPath = `${getAppointmentsPath(cleanTenant)}/${appointmentId}`;
  const appt = await ops.get(apptPath);

  if (!appt) {
    const err = new Error(`Appointment '${appointmentId}' not found for tenant '${cleanTenant}'.`);
    err.code = "APPOINTMENT_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  // Cross-tenant isolation verification
  if (appt.tenant_id && String(appt.tenant_id).toLowerCase().trim() !== cleanTenant) {
    const err = new Error(`Cross-tenant appointment access forbidden. Tenant '${cleanTenant}' cannot access appointment owned by '${appt.tenant_id}'.`);
    err.code = "CROSS_TENANT_ACCESS_FORBIDDEN";
    err.statusCode = 403;
    throw err;
  }

  // Must have customer agreement
  if (!customerAgreement) {
    throw new Error("Customer agreement is required to reschedule.");
  }

  // Validate state transition
  if (!isValidAppointmentTransition(appt.status, APPOINTMENT_STATUS.RESCHEDULED)) {
    const err = new Error(`Cannot reschedule appointment in '${appt.status}' state.`);
    err.code = "INVALID_APPOINTMENT_TRANSITION";
    err.statusCode = 400;
    throw err;
  }

  const duration = newDurationMinutes || appt.duration_minutes || 60;
  const targetBounds = calculateSlotBounds(
    newStartIso,
    duration,
    appt.pre_buffer_minutes || 0,
    appt.post_buffer_minutes || 0
  );

  // Check new slot availability
  const avail = await checkSlotAvailability({
    tenantId: cleanTenant,
    service: appt.service,
    startIso: newStartIso,
    durationMinutes: duration,
    preBufferMinutes: appt.pre_buffer_minutes || 0,
    postBufferMinutes: appt.post_buffer_minutes || 0,
    capacity: appt.capacity || 1,
    timezone: appt.timezone || "UTC",
    dbInstance,
    dbOps,
  });

  if (!avail.available) {
    return {
      success: false,
      status: APPOINTMENT_STATUS.RESCHEDULING_REQUESTED,
      reason: avail.reason,
      code: "NEW_SLOT_UNAVAILABLE",
    };
  }

  const nowIso = new Date().toISOString();

  // Atomic lock transfer
  // 1. Release old slot lock
  if (appt.start_time) {
    const oldSlotKey = generateSlotKey(appt.start_time, appt.duration_minutes || 60);
    const oldLockPath = getSlotLocksPath(cleanTenant, oldSlotKey);
    const oldLock = await ops.get(oldLockPath);
    if (oldLock && Array.isArray(oldLock.active_bookings)) {
      await ops.update(oldLockPath, {
        active_bookings: oldLock.active_bookings.filter((id) => id !== appointmentId),
        updated_at: nowIso,
      });
    }
  }

  // 2. Acquire new slot lock
  const newSlotKey = generateSlotKey(newStartIso, duration);
  const newLockPath = getSlotLocksPath(cleanTenant, newSlotKey);
  const existingNewLock = (await ops.get(newLockPath)) || { active_bookings: [] };
  const updatedBookings = Array.isArray(existingNewLock.active_bookings)
    ? [...existingNewLock.active_bookings, appointmentId]
    : [appointmentId];

  await ops.set(newLockPath, {
    slot_key: newSlotKey,
    tenant_id: cleanTenant,
    active_bookings: updatedBookings,
    max_capacity: appt.capacity || 1,
    updated_at: nowIso,
  });

  // 3. Update appointment record with history
  const history = Array.isArray(appt.reschedule_history) ? [...appt.reschedule_history] : [];
  history.push({
    previous_start_time: appt.start_time,
    new_start_time: targetBounds.startIso,
    rescheduled_at: nowIso,
    reason,
  });

  const updatedAppt = {
    ...appt,
    status: APPOINTMENT_STATUS.RESCHEDULED,
    start_time: targetBounds.startIso,
    end_time: targetBounds.endIso,
    window_start: targetBounds.windowStartIso,
    window_end: targetBounds.windowEndIso,
    duration_minutes: duration,
    reschedule_history: history,
    updated_at: nowIso,
  };

  await ops.update(apptPath, updatedAppt);

  // 4. Update linked lead if applicable
  if (appt.lead_id) {
    const leadPath = getTenantPathPrefix(cleanTenant) ? `${getTenantPathPrefix(cleanTenant)}/leads/${appt.lead_id}` : `leads/${appt.lead_id}`;
    const lead = await ops.get(leadPath);
    if (lead) {
      await ops.update(leadPath, {
        booking_status: "Rescheduled",
        "booking_details/booked_slot": targetBounds.startIso,
        "booking_details/booking_status": "Rescheduled",
        updated_at: nowIso,
      });
    }
  }

  return {
    success: true,
    status: APPOINTMENT_STATUS.RESCHEDULED,
    appointment: updatedAppt,
  };
}
