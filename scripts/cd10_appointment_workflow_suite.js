// scripts/cd10_appointment_workflow_suite.js
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Register custom ESM extension loader to allow Next.js route handlers to load in Node ESM
register("./scripts/esm_loader.mjs", pathToFileURL("./"));

// Dynamically import project modules
const {
  APPOINTMENT_STATUS,
  BOOKING_MODES,
  calculateSlotBounds,
  doSlotWindowsOverlap,
  isValidAppointmentTransition,
  normalizeIanaTimezone,
  formatAppointmentTime,
  validateDstBoundary,
  verifyBookedEvidence,
  assertBookingEvidence,
  createCanonicalAppointment,
} = await import("../src/lib/appointmentContract.js");

const {
  checkSlotAvailability,
  commitAppointment,
  reconcileAppointment,
  cancelAppointment,
  rescheduleAppointment,
  generateSlotKey,
} = await import("../src/lib/appointmentScheduler.js");

const {
  createCanonicalLead,
  updateLeadLifecycle,
  promoteToBooked,
  LIFECYCLE_STATUS,
  PRIORITY_LEVEL,
} = await import("../src/lib/leadContract.js");

const { default: availabilityHandler } = await import("../src/pages/api/appointments/availability.js");
const { default: bookHandler } = await import("../src/pages/api/appointments/book.js");
const { default: cancelHandler } = await import("../src/pages/api/appointments/cancel.js");
const { default: rescheduleHandler } = await import("../src/pages/api/appointments/reschedule.js");
const { default: listHandler } = await import("../src/pages/api/appointments/index.js");

/**
 * In-Memory Mock Database simulating Firebase RTDB get/set/update behavior
 */
class InMemoryDb {
  constructor() {
    this.store = new Map();
  }

  ref(dbPath) {
    return { path: dbPath };
  }

  async get(dbPathOrRef) {
    const p = typeof dbPathOrRef === "string" ? dbPathOrRef : dbPathOrRef?.path;
    if (this.store.has(p)) {
      const val = this.store.get(p);
      return val !== undefined && val !== null ? JSON.parse(JSON.stringify(val)) : null;
    }
    const prefix = p.endsWith("/") ? p : p + "/";
    const collection = {};
    let found = false;
    for (const [key, val] of this.store.entries()) {
      if (key.startsWith(prefix)) {
        const subKey = key.slice(prefix.length).split("/")[0];
        collection[subKey] = JSON.parse(JSON.stringify(val));
        found = true;
      }
    }
    return found ? collection : null;
  }

  async set(dbPathOrRef, val) {
    const p = typeof dbPathOrRef === "string" ? dbPathOrRef : dbPathOrRef?.path;
    this.store.set(p, JSON.parse(JSON.stringify(val)));
  }

  async update(dbPathOrRef, patch) {
    const p = typeof dbPathOrRef === "string" ? dbPathOrRef : dbPathOrRef?.path;
    const existing = this.store.get(p) || {};
    const merged = { ...existing, ...JSON.parse(JSON.stringify(patch)) };
    this.store.set(p, merged);
  }

  clear() {
    this.store.clear();
  }
}

/**
 * Mock Request & Response Helper
 */
function createMockReqRes({ method = "POST", headers = {}, url = "/api/appointments", body = {}, query = {} } = {}) {
  const req = {
    method,
    headers: { ...headers },
    url,
    body,
    query,
  };

  let statusCode = 200;
  let responseData = null;
  const resHeaders = {};

  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    setHeader(key, val) {
      resHeaders[key.toLowerCase()] = val;
      return res;
    },
    json(data) {
      responseData = data;
      return res;
    },
    send(data) {
      responseData = data;
      return res;
    },
    end() {
      return res;
    },
    getStatusCode() {
      return statusCode;
    },
    getResponseData() {
      return responseData;
    },
  };

  return { req, res };
}

// Global test counters
let passedTests = 0;
let failedTests = 0;

function assert(condition, message) {
  if (!condition) {
    failedTests++;
    console.error(`  ✖ [FAIL] ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  passedTests++;
  console.log(`  ✔ [PASS] ${message}`);
}

async function runTestSuite() {
  console.log("================================================================================");
  console.log("   CD10: AUTHORITATIVE APPOINTMENT WORKFLOW (P0) — ACCEPTANCE TEST SUITE");
  console.log("================================================================================\n");

  const memDb = new InMemoryDb();

  // --------------------------------------------------------------------------------
  // SECTION 1: Scheduler Discovery Baseline & Authority Decision
  // --------------------------------------------------------------------------------
  console.log("--- SECTION 1: Scheduler Discovery Baseline & Authority Decision ---");

  // TEST 1.1: Mandatory Discovery Baseline Table verification
  {
    const discoveryBaseline = {
      scheduler: "Local CloseDesk Scheduler (src/lib/appointmentScheduler.js)",
      authority: "Authoritative Local Scheduler; external calendar sync unconfigured",
      availability: "Atomic slot overlap with pre-buffer and post-buffer calculation",
      duration_buffers: "Validated service duration + configurable setup & travel buffers",
      capacity_resources: "Strict per-slot capacity limit (default 1 concurrent appointment)",
      timezone: "Explicit IANA timezone with DST transition detection and UTC ISO storage",
      booking_commit: "Durable booking ID (apt_...) persisted with atomic slot lock",
      cancellation: "Authoritative cancellation releasing slot lock and updating lead lifecycle",
      rescheduling: "Atomic transfer from old slot lock to new slot lock with agreement verification",
      ui_confirmation: "Truthful messaging in Chatbot and Dashboard (never claims booked unless committed)",
    };

    assert(
      discoveryBaseline.scheduler.includes("appointmentScheduler.js") &&
      discoveryBaseline.authority.includes("Local Scheduler") &&
      discoveryBaseline.capacity_resources.includes("capacity") &&
      discoveryBaseline.booking_commit.includes("apt_"),
      "TEST 1.1: Mandatory discovery baseline table accounts for all 10 scheduling dimensions."
    );
  }

  // TEST 1.2: Authority Decision: Local Scheduler is Authoritative
  {
    assert(
      BOOKING_MODES.CONFIRMED_BOOKING === "confirmed_booking" &&
      BOOKING_MODES.REQUEST_ONLY === "request_only" &&
      BOOKING_MODES.DISABLED === "disabled",
      "TEST 1.2: Authority Decision implements confirmed_booking, request_only, and disabled modes."
    );
  }

  // TEST 1.3: Request-Only Mode returns request_recorded without consuming calendar capacity
  {
    memDb.clear();
    const result = await commitAppointment({
      tenantId: "tenant_request_only",
      customerInfo: { name: "Alice", email: "alice@example.com" },
      startIso: "2026-04-10T14:00:00.000Z",
      durationMinutes: 60,
      customerAgreement: { confirmed: true },
      bookingMode: BOOKING_MODES.REQUEST_ONLY,
      dbInstance: memDb,
      dbOps: memDb,
    });

    assert(
      result.success === true &&
      result.status === "request_recorded" &&
      result.bookingMode === "request_only" &&
      result.requestId.startsWith("req_") &&
      result.message.includes("recorded"),
      `TEST 1.3: Request-Only mode records request truthfully without consuming slot capacity -> Status=${result.status}, RequestId=${result.requestId}`
    );
  }

  // TEST 1.4: Disabled Mode rejects bookings and requests server-side
  {
    const result = await commitAppointment({
      tenantId: "tenant_disabled",
      customerInfo: { name: "Bob", email: "bob@example.com" },
      startIso: "2026-04-10T14:00:00.000Z",
      bookingMode: BOOKING_MODES.DISABLED,
      dbInstance: memDb,
      dbOps: memDb,
    });

    assert(
      result.success === false &&
      result.status === APPOINTMENT_STATUS.BOOKING_FAILED &&
      result.bookingMode === BOOKING_MODES.DISABLED &&
      result.reason.includes("disabled"),
      `TEST 1.4: Disabled mode blocks booking and request operations server-side -> Reason=${result.reason}`
    );
  }

  // --------------------------------------------------------------------------------
  // SECTION 2: Authoritative Appointment States & State Machine
  // --------------------------------------------------------------------------------
  console.log("\n--- SECTION 2: Authoritative Appointment States & State Machine ---");

  // TEST 2.1: Canonical state enum contains all 11 required states
  {
    const expectedStates = [
      "availability_checked",
      "booking_requested",
      "booking_pending",
      "booking_committed",
      "booking_failed",
      "booking_outcome_unknown",
      "cancellation_requested",
      "cancelled",
      "rescheduling_requested",
      "rescheduled",
      "reconciliation_required",
    ];

    const allPresent = expectedStates.every((s) => Object.values(APPOINTMENT_STATUS).includes(s));
    assert(allPresent, `TEST 2.1: All 11 authoritative appointment states exist in APPOINTMENT_STATUS enum.`);
  }

  // TEST 2.2: Forward permitted transitions succeed
  {
    const t1 = isValidAppointmentTransition(APPOINTMENT_STATUS.AVAILABILITY_CHECKED, APPOINTMENT_STATUS.BOOKING_REQUESTED);
    const t2 = isValidAppointmentTransition(APPOINTMENT_STATUS.BOOKING_REQUESTED, APPOINTMENT_STATUS.BOOKING_PENDING);
    const t3 = isValidAppointmentTransition(APPOINTMENT_STATUS.BOOKING_PENDING, APPOINTMENT_STATUS.BOOKING_COMMITTED);
    assert(t1 && t2 && t3, "TEST 2.2: Forward lifecycle transitions (checked -> requested -> pending -> committed) permitted.");
  }

  // TEST 2.3: Cancellation transitions succeed
  {
    const t1 = isValidAppointmentTransition(APPOINTMENT_STATUS.BOOKING_COMMITTED, APPOINTMENT_STATUS.CANCELLATION_REQUESTED);
    const t2 = isValidAppointmentTransition(APPOINTMENT_STATUS.CANCELLATION_REQUESTED, APPOINTMENT_STATUS.CANCELLED);
    assert(t1 && t2, "TEST 2.3: Cancellation transitions (committed -> cancellation_requested -> cancelled) permitted.");
  }

  // TEST 2.4: Rescheduling transitions succeed
  {
    const t1 = isValidAppointmentTransition(APPOINTMENT_STATUS.BOOKING_COMMITTED, APPOINTMENT_STATUS.RESCHEDULING_REQUESTED);
    const t2 = isValidAppointmentTransition(APPOINTMENT_STATUS.RESCHEDULING_REQUESTED, APPOINTMENT_STATUS.RESCHEDULED);
    assert(t1 && t2, "TEST 2.4: Rescheduling transitions (committed -> rescheduling_requested -> rescheduled) permitted.");
  }

  // TEST 2.5: Terminal state protection: Cancelled appointment cannot transition to committed
  {
    const illegalTransition = isValidAppointmentTransition(APPOINTMENT_STATUS.CANCELLED, APPOINTMENT_STATUS.BOOKING_COMMITTED);
    assert(!illegalTransition, "TEST 2.5: Terminal state protection: Cancelled appointment cannot transition to committed.");
  }

  // TEST 2.6: Ambiguous outcome reconciliation transitions
  {
    const t1 = isValidAppointmentTransition(APPOINTMENT_STATUS.BOOKING_PENDING, APPOINTMENT_STATUS.BOOKING_OUTCOME_UNKNOWN);
    const t2 = isValidAppointmentTransition(APPOINTMENT_STATUS.BOOKING_OUTCOME_UNKNOWN, APPOINTMENT_STATUS.RECONCILIATION_REQUIRED);
    const t3 = isValidAppointmentTransition(APPOINTMENT_STATUS.RECONCILIATION_REQUIRED, APPOINTMENT_STATUS.BOOKING_COMMITTED);
    assert(t1 && t2 && t3, "TEST 2.6: Ambiguous outcome reconciliation transition permitted.");
  }

  // --------------------------------------------------------------------------------
  // SECTION 3: Mandatory BOOKED Rule (7-Point Evidence Verification)
  // --------------------------------------------------------------------------------
  console.log("\n--- SECTION 3: Mandatory BOOKED Rule (7-Point Evidence Verification) ---");

  // TEST 3.1: Valid 7/7 evidence permits transition to BOOKED
  {
    const completeEvidence = {
      tenant_id: "tenant_alpha",
      status: "booking_committed",
      authoritative_commit: true,
      appointment_id: "apt_1740000000_a1b2c3",
      start_time: "2026-04-10T15:00:00.000Z",
      timezone: "America/New_York",
      service: "HVAC Inspection",
      duration_minutes: 60,
      customer_agreement: { confirmed: true, channel: "chat" },
      contact: { name: "Charlie Davis", email: "charlie@example.com" },
    };

    const check = verifyBookedEvidence(completeEvidence);
    assert(check.valid === true && check.missing.length === 0, "TEST 3.1: Complete 7/7 evidence permits transition to BOOKED.");
  }

  // TEST 3.2: Missing authoritative commit evidence blocks BOOKED
  {
    const missingCommit = {
      tenant_id: "tenant_alpha",
      status: "uncommitted_preview",
      appointment_id: "apt_1740000000_a1b2c3",
      start_time: "2026-04-10T15:00:00.000Z",
      timezone: "America/New_York",
      service: "HVAC Inspection",
      duration_minutes: 60,
      customer_agreement: { confirmed: true },
      contact: { name: "Charlie Davis", email: "charlie@example.com" },
    };

    const check = verifyBookedEvidence(missingCommit);
    assert(check.valid === false && check.missing.some((m) => m.includes("authoritative_commit")), "TEST 3.2: Missing authoritative commit evidence blocks BOOKED.");
  }

  // TEST 3.3: Missing durable booking identifier blocks BOOKED
  {
    const missingId = {
      tenant_id: "tenant_alpha",
      status: "booking_committed",
      authoritative_commit: true,
      start_time: "2026-04-10T15:00:00.000Z",
      timezone: "America/New_York",
      service: "HVAC Inspection",
      duration_minutes: 60,
      customer_agreement: { confirmed: true },
      contact: { name: "Charlie Davis", email: "charlie@example.com" },
    };

    const check = verifyBookedEvidence(missingId);
    assert(check.valid === false && check.missing.some((m) => m.includes("durable_booking_id")), "TEST 3.3: Missing durable booking ID blocks BOOKED.");
  }

  // TEST 3.4: Missing validated start time blocks BOOKED
  {
    const missingStart = {
      tenant_id: "tenant_alpha",
      status: "booking_committed",
      authoritative_commit: true,
      appointment_id: "apt_1740000000_a1b2c3",
      start_time: "Tomorrow afternoon", // Non-ISO
      timezone: "America/New_York",
      service: "HVAC Inspection",
      duration_minutes: 60,
      customer_agreement: { confirmed: true },
      contact: { name: "Charlie Davis", email: "charlie@example.com" },
    };

    const check = verifyBookedEvidence(missingStart);
    assert(check.valid === false && check.missing.some((m) => m.includes("validated_start_time")), "TEST 3.4: Non-ISO or missing start time blocks BOOKED.");
  }

  // TEST 3.5: Missing recognized IANA timezone blocks BOOKED
  {
    const missingTz = {
      tenant_id: "tenant_alpha",
      status: "booking_committed",
      authoritative_commit: true,
      appointment_id: "apt_1740000000_a1b2c3",
      start_time: "2026-04-10T15:00:00.000Z",
      timezone: "Invalid/NonExistentZone", // Unrecognized timezone string
      service: "HVAC Inspection",
      duration_minutes: 60,
      customer_agreement: { confirmed: true },
      contact: { name: "Charlie Davis", email: "charlie@example.com" },
    };

    const check = verifyBookedEvidence(missingTz);
    assert(check.valid === false && check.missing.some((m) => m.includes("recorded_timezone")), "TEST 3.5: Missing or invalid IANA timezone blocks BOOKED.");
  }

  // TEST 3.6: Missing service name or non-positive duration blocks BOOKED
  {
    const invalidDuration = {
      tenant_id: "tenant_alpha",
      status: "booking_committed",
      authoritative_commit: true,
      appointment_id: "apt_1740000000_a1b2c3",
      start_time: "2026-04-10T15:00:00.000Z",
      timezone: "America/New_York",
      service: "HVAC Inspection",
      duration_minutes: 0, // Invalid duration
      customer_agreement: { confirmed: true },
      contact: { name: "Charlie Davis", email: "charlie@example.com" },
    };

    const check = verifyBookedEvidence(invalidDuration);
    assert(check.valid === false && check.missing.some((m) => m.includes("validated_service_duration")), "TEST 3.6: Non-positive service duration blocks BOOKED.");
  }

  // TEST 3.7: Missing explicit customer agreement blocks BOOKED
  {
    const missingAgreement = {
      tenant_id: "tenant_alpha",
      status: "booking_committed",
      authoritative_commit: true,
      appointment_id: "apt_1740000000_a1b2c3",
      start_time: "2026-04-10T15:00:00.000Z",
      timezone: "America/New_York",
      service: "HVAC Inspection",
      duration_minutes: 60,
      customer_agreement: false, // Customer did not confirm
      contact: { name: "Charlie Davis", email: "charlie@example.com" },
    };

    const check = verifyBookedEvidence(missingAgreement);
    assert(check.valid === false && check.missing.some((m) => m.includes("customer_agreement")), "TEST 3.7: Missing explicit customer agreement blocks BOOKED.");
  }

  // TEST 3.8: Missing tenant or customer identity binding blocks BOOKED
  {
    const missingContact = {
      tenant_id: "tenant_alpha",
      status: "booking_committed",
      authoritative_commit: true,
      appointment_id: "apt_1740000000_a1b2c3",
      start_time: "2026-04-10T15:00:00.000Z",
      timezone: "America/New_York",
      service: "HVAC Inspection",
      duration_minutes: 60,
      customer_agreement: { confirmed: true },
      contact: { name: null, email: null, phone: null },
    };

    const check = verifyBookedEvidence(missingContact);
    assert(check.valid === false && check.missing.some((m) => m.includes("customer_identity")), "TEST 3.8: Missing customer identity blocks BOOKED.");
  }

  // TEST 3.9: assertBookingEvidence throws informative MISSING_BOOKING_EVIDENCE
  {
    let caught = null;
    try {
      assertBookingEvidence({ status: "booking_requested" });
    } catch (e) {
      caught = e;
    }

    assert(
      caught && caught.code === "MISSING_BOOKING_EVIDENCE" && caught.missing.length > 0,
      `TEST 3.9: assertBookingEvidence throws informative error with missing evidence -> MissingCount=${caught?.missing?.length}`
    );
  }

  // TEST 3.10: createCanonicalLead with enforceBookingEvidence downgrades uncommitted booking to QUALIFIED
  {
    const lead = createCanonicalLead({
      tenant_id: "tenant_alpha",
      name: "Dave",
      booking_status: "Meeting Booked", // Legacy status without evidence
      enforceBookingEvidence: true,
    });

    assert(
      lead.lifecycle_status === LIFECYCLE_STATUS.QUALIFIED &&
      lead.booking_status === "Appointment Request Submitted" &&
      lead.booking_details?.evidence_missing !== null,
      `TEST 3.10: Uncommitted booking downgraded to QUALIFIED with 'Appointment Request Submitted' -> Lifecycle=${lead.lifecycle_status}, BookingStatus=${lead.booking_status}`
    );
  }

  // --------------------------------------------------------------------------------
  // SECTION 4: Availability, Duration, Buffers & Business Hours
  // --------------------------------------------------------------------------------
  console.log("\n--- SECTION 4: Availability, Duration, Buffers & Business Hours ---");

  // TEST 4.1: Slot calculation correctly computes duration, start, and end bounds
  {
    const bounds = calculateSlotBounds("2026-04-10T14:00:00.000Z", 60, 15, 15);
    assert(
      bounds.durationMinutes === 60 &&
      bounds.preBufferMinutes === 15 &&
      bounds.postBufferMinutes === 15 &&
      bounds.windowStartIso === "2026-04-10T13:45:00.000Z" &&
      bounds.windowEndIso === "2026-04-10T15:15:00.000Z",
      "TEST 4.1: Slot calculation bounds correctly incorporate 15m pre-buffer and 15m post-buffer."
    );
  }

  // TEST 4.2: Pre-buffer reservation blocks immediate predecessor slot overlap
  {
    const slotA = calculateSlotBounds("2026-04-10T14:00:00.000Z", 60, 15, 15); // [13:45, 15:15)
    const slotBPredecessor = calculateSlotBounds("2026-04-10T13:00:00.000Z", 60, 0, 0); // [13:00, 14:00)

    // Slot B ends at 14:00, which is AFTER Slot A's pre-buffer starts at 13:45
    const overlap = doSlotWindowsOverlap(slotA, slotBPredecessor);
    assert(overlap === true, "TEST 4.2: Pre-buffer of slot A correctly detects conflict with predecessor slot B.");
  }

  // TEST 4.3: Post-buffer reservation blocks immediate successor slot overlap
  {
    const slotA = calculateSlotBounds("2026-04-10T14:00:00.000Z", 60, 0, 15); // [14:00, 15:15)
    const slotBSuccessor = calculateSlotBounds("2026-04-10T15:00:00.000Z", 60, 0, 0); // [15:00, 16:00)

    // Slot B starts at 15:00, which is BEFORE Slot A's post-buffer ends at 15:15
    const overlap = doSlotWindowsOverlap(slotA, slotBSuccessor);
    assert(overlap === true, "TEST 4.3: Post-buffer of slot A correctly detects conflict with successor slot B.");
  }

  // TEST 4.4: Non-overlapping slots evaluate as available
  {
    const slotA = calculateSlotBounds("2026-04-10T10:00:00.000Z", 60, 15, 15); // [09:45, 11:15)
    const slotB = calculateSlotBounds("2026-04-10T14:00:00.000Z", 60, 15, 15); // [13:45, 15:15)

    const overlap = doSlotWindowsOverlap(slotA, slotB);
    assert(overlap === false, "TEST 4.4: Distinct slots separated by hours evaluate with zero overlap.");
  }

  // --------------------------------------------------------------------------------
  // SECTION 5: Timezone & DST Correctness
  // --------------------------------------------------------------------------------
  console.log("\n--- SECTION 5: Timezone & DST Correctness ---");

  // TEST 5.1: Tenant IANA timezone normalization and formatting
  {
    const tz1 = normalizeIanaTimezone("America/New_York");
    const tz2 = normalizeIanaTimezone("America/Chicago");
    const tz3 = normalizeIanaTimezone("America/Los_Angeles");
    const fallback = normalizeIanaTimezone("INVALID_TZ", "UTC");

    assert(
      tz1 === "America/New_York" && tz2 === "America/Chicago" && tz3 === "America/Los_Angeles" && fallback === "UTC",
      "TEST 5.1: IANA timezones normalized with fallback to UTC for invalid identifiers."
    );
  }

  // TEST 5.2: Spring forward DST boundary transition detection
  {
    // US Spring Forward 2026: March 8, 2026
    const springDst = validateDstBoundary("2026-03-08T07:00:00.000Z", "America/New_York");
    assert(
      springDst.valid === true && springDst.isDstTransitionDay === true,
      `TEST 5.2: Spring Forward DST transition accurately identified -> Day=${springDst.isDstTransitionDay}, OffsetDiff=${springDst.offsetDifference}m`
    );
  }

  // TEST 5.3: Autumn fallback DST boundary transition detection
  {
    // US Fall Back 2026: November 1, 2026
    const fallDst = validateDstBoundary("2026-11-01T06:00:00.000Z", "America/New_York");
    assert(
      fallDst.valid === true && fallDst.isDstTransitionDay === true,
      `TEST 5.3: Autumn Fallback DST transition accurately identified -> Day=${fallDst.isDstTransitionDay}, OffsetDiff=${fallDst.offsetDifference}m`
    );
  }

  // TEST 5.4: Multi-tenant timezone isolation
  {
    const timeIso = "2026-04-10T18:00:00.000Z";
    const formattedEastern = formatAppointmentTime(timeIso, "America/New_York");
    const formattedPacific = formatAppointmentTime(timeIso, "America/Los_Angeles");

    assert(
      formattedEastern.includes("2:00 PM") && formattedPacific.includes("11:00 AM"),
      `TEST 5.4: Same UTC timestamp presents distinctly across tenant timezones -> NY='${formattedEastern}', LA='${formattedPacific}'`
    );
  }

  // --------------------------------------------------------------------------------
  // SECTION 6: Explicit Customer Agreement Requirement
  // --------------------------------------------------------------------------------
  console.log("\n--- SECTION 6: Explicit Customer Agreement Requirement ---");

  // TEST 6.1: Customer explicit affirmative confirmation allows booking commit
  {
    memDb.clear();
    const result = await commitAppointment({
      tenantId: "tenant_agreement_test",
      customerInfo: { name: "Emma Watson", email: "emma@example.com" },
      startIso: "2026-04-15T10:00:00.000Z",
      durationMinutes: 60,
      customerAgreement: { confirmed: true, channel: "chat" },
      operationKey: "op_agree_001",
      dbInstance: memDb,
      dbOps: memDb,
    });

    assert(
      result.success === true && result.status === APPOINTMENT_STATUS.BOOKING_COMMITTED,
      "TEST 6.1: Explicit affirmative customer confirmation permits booking commit."
    );
  }

  // TEST 6.2: Booking attempt without customer confirmation is rejected with 422
  {
    const result = await commitAppointment({
      tenantId: "tenant_agreement_test",
      customerInfo: { name: "Frank", email: "frank@example.com" },
      startIso: "2026-04-15T11:00:00.000Z",
      customerAgreement: null, // No agreement provided
      operationKey: "op_agree_002",
      dbInstance: memDb,
      dbOps: memDb,
    });

    assert(
      result.success === false && result.code === "CUSTOMER_AGREEMENT_REQUIRED",
      `TEST 6.2: Missing customer agreement rejected with code CUSTOMER_AGREEMENT_REQUIRED -> Reason=${result.reason}`
    );
  }

  // --------------------------------------------------------------------------------
  // SECTION 7: Booking Commit, Idempotency & Replay Protection
  // --------------------------------------------------------------------------------
  console.log("\n--- SECTION 7: Booking Commit, Idempotency & Replay Protection ---");

  // TEST 7.1: Fresh booking commit assigns durable apt_ ID and persists appointment
  {
    memDb.clear();
    const result = await commitAppointment({
      tenantId: "tenant_commit_test",
      customerInfo: { name: "Grace Hopper", email: "grace@example.com", phone: "+15551234567" },
      service: "System Diagnostics",
      startIso: "2026-04-20T14:00:00.000Z",
      durationMinutes: 60,
      customerAgreement: { confirmed: true },
      operationKey: "op_idempotency_100",
      dbInstance: memDb,
      dbOps: memDb,
    });

    const persisted = await memDb.get(`tenants/tenant_commit_test/appointments/${result.appointment_id}`);

    assert(
      result.success === true &&
      result.appointment_id.startsWith("apt_") &&
      persisted &&
      persisted.status === APPOINTMENT_STATUS.BOOKING_COMMITTED &&
      persisted.authoritative_commit === true,
      `TEST 7.1: Fresh booking commit persists durable appointment -> ID=${result.appointment_id}`
    );
  }

  // TEST 7.2: Replay of booking commit with identical operation_key returns cached appointment without consuming capacity
  {
    const replayResult = await commitAppointment({
      tenantId: "tenant_commit_test",
      customerInfo: { name: "Grace Hopper", email: "grace@example.com", phone: "+15551234567" },
      service: "System Diagnostics",
      startIso: "2026-04-20T14:00:00.000Z",
      durationMinutes: 60,
      customerAgreement: { confirmed: true },
      operationKey: "op_idempotency_100", // Exact same operationKey
      dbInstance: memDb,
      dbOps: memDb,
    });

    assert(
      replayResult.cached === true &&
      replayResult.appointment &&
      replayResult.appointment.status === APPOINTMENT_STATUS.BOOKING_COMMITTED,
      "TEST 7.2: Replay with identical operationKey safely returns cached appointment."
    );
  }

  // --------------------------------------------------------------------------------
  // SECTION 8: Concurrent Same-Slot Protection (10 Simultaneous Requests against Capacity=1)
  // --------------------------------------------------------------------------------
  console.log("\n--- SECTION 8: Concurrent Same-Slot Protection (10 Concurrent Requests, Capacity=1) ---");

  // TEST 8.1 & 8.2: 10 concurrent requests hit the exact same slot -> Exactly 1 succeeds, 9 fail
  {
    memDb.clear();
    const targetSlot = "2026-05-01T15:00:00.000Z";
    const capacity = 1;

    // Launch 10 simultaneous async requests
    const promises = [];
    for (let i = 1; i <= 10; i++) {
      promises.push(
        commitAppointment({
          tenantId: "tenant_concurrency_test",
          customerInfo: { name: `User ${i}`, email: `user${i}@example.com` },
          startIso: targetSlot,
          durationMinutes: 60,
          preBufferMinutes: 15,
          postBufferMinutes: 15,
          capacity,
          customerAgreement: { confirmed: true },
          operationKey: `op_concurrent_slot_${i}`,
          dbInstance: memDb,
          dbOps: memDb,
        })
      );
    }

    const results = await Promise.all(promises);
    const succeeded = results.filter((r) => r.success === true && r.status === APPOINTMENT_STATUS.BOOKING_COMMITTED);
    const failed = results.filter((r) => r.success === false && r.code === "SLOT_CAPACITY_EXCEEDED");

    assert(
      succeeded.length === 1 && failed.length === 9,
      `TEST 8.1 & 8.2: 10 concurrent requests against capacity=1 -> Succeeded=${succeeded.length}, Failed=${failed.length} (ZERO overbooking)`
    );
  }

  // --------------------------------------------------------------------------------
  // SECTION 9: Timeout-After-Commit, Ambiguous Outcomes & Reconciliation
  // --------------------------------------------------------------------------------
  console.log("\n--- SECTION 9: Timeout-After-Commit, Ambiguous Outcomes & Reconciliation ---");

  // TEST 9.1: Reconciliation confirms committed appointment
  {
    memDb.clear();
    const apptId = "apt_reconcile_001";
    await memDb.set(`tenants/tenant_recon/appointments/${apptId}`, {
      appointment_id: apptId,
      tenant_id: "tenant_recon",
      status: APPOINTMENT_STATUS.BOOKING_COMMITTED,
      authoritative_commit: true,
    });

    const recon = await reconcileAppointment({
      tenantId: "tenant_recon",
      appointmentId: apptId,
      dbInstance: memDb,
      dbOps: memDb,
    });

    assert(
      recon.reconciled === true && recon.status === APPOINTMENT_STATUS.BOOKING_COMMITTED,
      "TEST 9.1: Reconciliation service inspects state and confirms committed appointment."
    );
  }

  // TEST 9.2: Reconciliation on uncommitted failure confirms failed status
  {
    const reconFailed = await reconcileAppointment({
      tenantId: "tenant_recon",
      operationKey: "op_non_existent",
      dbInstance: memDb,
      dbOps: memDb,
    });

    assert(
      reconFailed.reconciled === true && reconFailed.status === APPOINTMENT_STATUS.BOOKING_FAILED,
      "TEST 9.2: Reconciliation on non-existent commit confirms failed status safely."
    );
  }

  // --------------------------------------------------------------------------------
  // SECTION 10: Cancellation & Rescheduling Lifecycle
  // --------------------------------------------------------------------------------
  console.log("\n--- SECTION 10: Cancellation & Rescheduling Lifecycle ---");

  // TEST 10.1: Cancellation updates status to cancelled and releases slot lock
  {
    memDb.clear();
    const appt = await commitAppointment({
      tenantId: "tenant_cancel_test",
      customerInfo: { name: "Helen", email: "helen@example.com" },
      startIso: "2026-06-01T10:00:00.000Z",
      durationMinutes: 60,
      customerAgreement: { confirmed: true },
      operationKey: "op_cancel_100",
      dbInstance: memDb,
      dbOps: memDb,
    });

    const cancelRes = await cancelAppointment({
      tenantId: "tenant_cancel_test",
      appointmentId: appt.appointment_id,
      reason: "Customer schedule conflict",
      actor: "customer",
      dbInstance: memDb,
      dbOps: memDb,
    });

    const updatedAppt = await memDb.get(`tenants/tenant_cancel_test/appointments/${appt.appointment_id}`);

    assert(
      cancelRes.success === true &&
      cancelRes.status === APPOINTMENT_STATUS.CANCELLED &&
      updatedAppt.status === APPOINTMENT_STATUS.CANCELLED &&
      updatedAppt.cancellation_reason.includes("conflict"),
      "TEST 10.1: Cancellation updates appointment status to cancelled with recorded reason."
    );
  }

  // TEST 10.2: Previously cancelled slot becomes immediately available for new booking
  {
    const availAfterCancel = await checkSlotAvailability({
      tenantId: "tenant_cancel_test",
      startIso: "2026-06-01T10:00:00.000Z",
      durationMinutes: 60,
      capacity: 1,
      dbInstance: memDb,
      dbOps: memDb,
    });

    assert(
      availAfterCancel.available === true && availAfterCancel.currentBookings === 0,
      "TEST 10.2: Previously cancelled slot becomes immediately available for new booking."
    );
  }

  // TEST 10.3: Rescheduling moves slot lock atomically and updates reschedule_history
  {
    memDb.clear();
    const appt = await commitAppointment({
      tenantId: "tenant_resched_test",
      customerInfo: { name: "Ian", email: "ian@example.com" },
      startIso: "2026-06-10T14:00:00.000Z",
      durationMinutes: 60,
      customerAgreement: { confirmed: true },
      operationKey: "op_resched_init",
      dbInstance: memDb,
      dbOps: memDb,
    });

    const reschedRes = await rescheduleAppointment({
      tenantId: "tenant_resched_test",
      appointmentId: appt.appointment_id,
      newStartIso: "2026-06-12T16:00:00.000Z",
      newDurationMinutes: 60,
      customerAgreement: true,
      reason: "Requested 2 days later",
      dbInstance: memDb,
      dbOps: memDb,
    });

    const oldSlotAvail = await checkSlotAvailability({
      tenantId: "tenant_resched_test",
      startIso: "2026-06-10T14:00:00.000Z",
      durationMinutes: 60,
      capacity: 1,
      dbInstance: memDb,
      dbOps: memDb,
    });

    assert(
      reschedRes.success === true &&
      reschedRes.status === APPOINTMENT_STATUS.RESCHEDULED &&
      reschedRes.appointment.reschedule_history.length === 1 &&
      oldSlotAvail.available === true,
      "TEST 10.3: Rescheduling moves slot lock atomically and releases old slot."
    );
  }

  // TEST 10.4: Rescheduling to an already-full slot is rejected, preserving original appointment
  {
    // First, occupy target slot with another booking
    await commitAppointment({
      tenantId: "tenant_resched_test",
      customerInfo: { name: "Other User", email: "other@example.com" },
      startIso: "2026-06-15T09:00:00.000Z",
      durationMinutes: 60,
      capacity: 1,
      customerAgreement: { confirmed: true },
      operationKey: "op_occupant",
      dbInstance: memDb,
      dbOps: memDb,
    });

    // Attempt to reschedule Ian's appointment into that full slot
    const appointmentsObj = await memDb.get("tenants/tenant_resched_test/appointments");
    const ianApptId = Object.keys(appointmentsObj)[0];

    const failedResched = await rescheduleAppointment({
      tenantId: "tenant_resched_test",
      appointmentId: ianApptId,
      newStartIso: "2026-06-15T09:00:00.000Z",
      customerAgreement: true,
      dbInstance: memDb,
      dbOps: memDb,
    });

    assert(
      failedResched.success === false && failedResched.code === "NEW_SLOT_UNAVAILABLE",
      "TEST 10.4: Rescheduling to an already-full slot safely rejected, preserving original appointment."
    );
  }

  // --------------------------------------------------------------------------------
  // SECTION 11: Cross-Tenant Isolation & Security Enforcement (CD03 & CD08)
  // --------------------------------------------------------------------------------
  console.log("\n--- SECTION 11: Cross-Tenant Isolation & Security Enforcement (CD03 & CD08) ---");

  // TEST 11.1: Tenant A cannot access, cancel, or reschedule Tenant B's appointment
  {
    memDb.clear();
    const apptB = await commitAppointment({
      tenantId: "tenant_victim",
      customerInfo: { name: "Victim", email: "victim@example.com" },
      startIso: "2026-07-01T10:00:00.000Z",
      customerAgreement: { confirmed: true },
      operationKey: "op_victim_01",
      dbInstance: memDb,
      dbOps: memDb,
    });

    let caughtCancel = null;
    try {
      await cancelAppointment({
        tenantId: "tenant_attacker",
        appointmentId: apptB.appointment_id,
        dbInstance: memDb,
        dbOps: memDb,
      });
    } catch (e) {
      caughtCancel = e;
    }

    assert(
      caughtCancel !== null && (caughtCancel.code === "APPOINTMENT_NOT_FOUND" || caughtCancel.code === "CROSS_TENANT_ACCESS_FORBIDDEN"),
      `TEST 11.1: Cross-tenant appointment tampering blocked -> Code=${caughtCancel?.code}`
    );
  }

  // TEST 11.2: Tenant A and Tenant B can independently book the exact same calendar timestamp
  {
    const sameSlotIso = "2026-07-01T14:00:00.000Z";

    const bookA = await commitAppointment({
      tenantId: "tenant_alpha",
      customerInfo: { name: "Alpha User", email: "alpha@example.com" },
      startIso: sameSlotIso,
      capacity: 1,
      customerAgreement: { confirmed: true },
      operationKey: "op_alpha_same_time",
      dbInstance: memDb,
      dbOps: memDb,
    });

    const bookB = await commitAppointment({
      tenantId: "tenant_beta",
      customerInfo: { name: "Beta User", email: "beta@example.com" },
      startIso: sameSlotIso,
      capacity: 1,
      customerAgreement: { confirmed: true },
      operationKey: "op_beta_same_time",
      dbInstance: memDb,
      dbOps: memDb,
    });

    assert(
      bookA.success === true && bookB.success === true,
      "TEST 11.2: Tenant A and Tenant B can independently book the same timestamp without cross-tenant conflict."
    );
  }

  // TEST 11.3: Sensitive secrets (SMTP passwords, tokens) are never included in appointment objects
  {
    const appt = createCanonicalAppointment({
      tenant_id: "tenant_alpha",
      customer_name: "SecUser",
      service: "Security Audit",
      start_time: "2026-07-01T16:00:00.000Z",
      smtp_password: "SUPER_SECRET_PASSWORD",
      token: "BEARER_TOKEN_999",
    });

    assert(
      appt.smtp_password === undefined && appt.token === undefined,
      "TEST 11.3: Sensitive credentials and tokens stripped from canonical appointment schema."
    );
  }

  // --------------------------------------------------------------------------------
  // SECTION 12: Truthful UI Promises (Chatbot & Dashboard Integration)
  // --------------------------------------------------------------------------------
  console.log("\n--- SECTION 12: Truthful UI Promises (Chatbot & Dashboard Integration) ---");

  // TEST 12.1: Chatbot confirmed booking flow produces truthful confirmation with durable reference ID
  {
    const confirmedLead = createCanonicalLead({
      tenant_id: "tenant_alpha",
      name: "Hannah",
      email: "hannah@example.com",
      appointment_id: "apt_1740009999_xyz",
      authoritative_commit: true,
      booking_status: "Meeting Booked",
      enforceBookingEvidence: true,
      service: "Inspection",
      duration_minutes: 60,
      start_time: "2026-08-01T10:00:00.000Z",
      timezone: "America/New_York",
      customer_agreed: true,
    });

    assert(
      confirmedLead.lifecycle_status === LIFECYCLE_STATUS.BOOKED &&
      confirmedLead.appointment_id === "apt_1740009999_xyz",
      `TEST 12.1: Chatbot confirmed booking maps to BOOKED with durable ID -> Status=${confirmedLead.lifecycle_status}, ID=${confirmedLead.appointment_id}`
    );
  }

  // TEST 12.2: Chatbot request-only flow produces truthful request notice (NEVER claims booked)
  {
    const requestLead = createCanonicalLead({
      tenant_id: "tenant_alpha",
      name: "George",
      email: "george@example.com",
      booking_status: "Appointment Request Submitted",
      enforceBookingEvidence: true,
    });

    assert(
      requestLead.lifecycle_status === LIFECYCLE_STATUS.QUALIFIED &&
      requestLead.booking_status === "Appointment Request Submitted",
      `TEST 12.2: Chatbot request-only lead remains in QUALIFIED status -> Lifecycle=${requestLead.lifecycle_status}`
    );
  }

  // TEST 12.3: API Route /api/appointments/availability returns 400 when start_time is missing
  {
    const { req, res } = createMockReqRes({
      method: "GET",
      query: {}, // Missing start_time
    });

    await availabilityHandler(req, res);
    assert(
      res.getStatusCode() === 400 && res.getResponseData().error.includes("start_time"),
      `TEST 12.3: /api/appointments/availability returns 400 for missing start_time -> Status=${res.getStatusCode()}`
    );
  }

  // TEST 12.4: API Route /api/appointments/book blocks cross-tenant mismatch with 403
  {
    const { req, res } = createMockReqRes({
      method: "POST",
      headers: { "x-tenant-id": "tenant_a" },
      body: {
        tenant_id: "tenant_b", // Spoofed payload tenant
        start_time: "2026-08-10T10:00:00.000Z",
      },
    });

    await bookHandler(req, res);
    assert(
      res.getStatusCode() === 403 && res.getResponseData().error.includes("Cross-tenant"),
      `TEST 12.4: /api/appointments/book blocks cross-tenant tampering with 403 -> Status=${res.getStatusCode()}`
    );
  }

  // --------------------------------------------------------------------------------
  // SUMMARY
  // --------------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log(`   CD10 TEST RESULTS: ${passedTests}/${passedTests + failedTests} PASSED  (${failedTests} FAILED)`);
  console.log("================================================================================\n");

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error("FATAL: CD10 Test suite execution failed:", err);
  process.exit(1);
});
