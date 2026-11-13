# CD10: Authoritative Appointment Workflow (P0)
## Implementation Verification, Architectural Authority Decision, and Security Audit Report

---

### Executive Summary

| Project | CloseDesk Engine SaaS |
| :--- | :--- |
| **Ticket Reference** | **P0 Ticket CD10 — Authoritative Appointment Workflow** |
| **Branch** | `feat/cd10-authoritative-appointment-workflow` |
| **Audit Status** | **PASSED (Production-Ready, Evidence-Verified)** |
| **Test Suite Coverage** | **46/46 Tests Passing Deterministically (0 Failures)** |
| **Full Regression Status** | **100% Pass Across CD02, CD03, CD06, CD07, CD08, CD09 & Build** |
| **Verified Date** | November 5, 2026 |

CloseDesk previously generated client-side synthetic booking identifiers (`bk_${txId.substring(0,8)}`) and untruthfully displayed messages stating: *"Your demo is officially booked for ... sent a calendar invite to your email"* without an authoritative scheduling system committing the slot, verifying calendar capacity, or accounting for duration and travel buffers.

Under **CD10 (P0)**, this architecture was completely redesigned and hardened with strict evidence-driven guarantees:
1. CloseDesk only confirms an appointment when an **authoritative scheduling engine** has successfully committed it with a durable booking identifier (`apt_${timestamp}_${hex}`), validated duration, pre/post-buffers, and explicit customer agreement.
2. In the absence of an authoritative commit or for tenants configured without direct calendar booking, the platform operates strictly in **Request-Only Mode** (`request_only`). The assistant truthfully informs customers: *"Your appointment request has been recorded. Our team will review availability and confirm your booking shortly"*, and the lead enters `QUALIFIED` (or `CONTACTED`), **NEVER** `BOOKED`.
3. Under heavy concurrency (at least 10 simultaneous requests against `capacity = 1`), an in-process promise-chain mutex guarantees that exactly 1 booking succeeds and 9 fail with `SLOT_CAPACITY_EXCEEDED` (zero overbooking).

---

### 1. Mandatory Scheduler Discovery Baseline

A complete audit of the repository prior to CD10 changes revealed the baseline state across all 10 scheduling dimensions:

| Dimension | Discovered Repository Implementation State | Finding & Gap Analysis |
| :--- | :--- | :--- |
| **Scheduler** | No dedicated scheduling module existed. Only a simulated webhook endpoint `src/pages/api/generate-email.js` hitting Make.com for email templating. | **Defect**: No authoritative scheduling engine existed in the codebase. Webhook generates email text, not calendar bookings. |
| **Scheduling Authority** | None. Chatbot UI in `src/Closedesk/Chatbot/AicyroChatbot.jsx` simply generated a client-side synthetic ID `let bookingId = 'bk_' + txId.substring(0,8)`. | **Defect**: Chatbot UI fabricated booking confirmation without any backend or provider validation. |
| **Availability** | Hardcoded slot buttons in chatbot UI (`10:00 AM`, `2:00 PM`, etc.) with zero calendar inspection or conflict check. | **Defect**: Any slot could be chosen regardless of technician availability or existing bookings. |
| **Duration / Buffers** | None. Appointments had arbitrary text like "Tomorrow at 2:00 PM" with no duration calculation, pre-buffer, or post-buffer. | **Defect**: Overlapping jobs and back-to-back travel times were completely ignored. |
| **Capacity / Resources** | None. No slot capacity counters or limits existed. | **Defect**: Unbounded concurrent bookings could claim the exact same time slot (overbooking). |
| **Timezone** | Generic local machine time; no IANA timezone storage or DST calculations. | **Defect**: Ambiguous timestamps across timezones and DST boundaries (e.g. spring forward / autumn fallback). |
| **Booking Commit** | Synthetic `bk_...` generated in React state. | **Defect**: No durable booking record, no atomic database write, no rollback on failure. |
| **Cancellation** | UI in `Booking.jsx` simply updated `booking_status: "Cancelled"` on the lead in RTDB. | **Defect**: Did not release any slot lock or sync with any calendar system. |
| **Rescheduling** | UI in `Booking.jsx` simply updated `booking_status: "Rescheduled"`. | **Defect**: Did not validate new slot availability, did not shift slot locks, did not re-verify capacity. |
| **UI Confirmation** | Chatbot claimed: *"Your demo is officially booked for ... sent a calendar invite to ..."* | **Defect**: Violates truthful service promises (CD08). Misleads customer that a calendar invite was sent. |

---

### 2. Explicit Authority Decision

Based on this baseline discovery, the CloseDesk platform implements an explicit, documented **Authority Decision**:

```
                         ┌────────────────────────────────────────┐
                         │   Incoming Appointment Selection /     │
                         │   Booking Tool Action Request          │
                         └───────────────────┬────────────────────┘
                                             │
                                             ▼
                                ┌───────────────────────────┐
                                │ Tenant Policy & Mode Check│
                                └────────────┬──────────────┘
                                             │
                  ┌──────────────────────────┼──────────────────────────┐
                  ▼                          ▼                          ▼
       [disabled / false]            [request_only]            [confirmed_booking]
  ┌─────────────────────────┐  ┌─────────────────────────┐  ┌─────────────────────────┐
  │ 403 Forbidden           │  │ Truthful Request Mode   │  │ CloseDesk Authoritative │
  │ "Direct booking is      │  │ Lead -> QUALIFIED       │  │ Local Scheduler Engine  │
  │ disabled by policy for  │  │ "Appointment Request    │  │ - Atomic slot mutex     │
  │ this tenant. Request a  │  │  Submitted"             │  │ - Buffer & capacity lock│
  │ callback instead."      │  │ Truthful notice to user │  │ - Durable ID (apt_...)  │
  └─────────────────────────┘  └─────────────────────────┘  └────────────┬────────────┘
                                                                         │
                                         ┌───────────────────────────────┴───────────────────────────────┐
                                         ▼                                                               ▼
                               [Slot Conflict / Full]                                           [Available & Agreed]
                            ┌──────────────────────────┐                                     ┌─────────────────────────┐
                            │ 409 Conflict             │                                     │ 200 OK                  │
                            │ SLOT_CAPACITY_EXCEEDED   │                                     │ Status: BOOKING_COMMITTED│
                            │ Offer alternative slots  │                                     │ Lead enters BOOKED (7/7)│
                            └──────────────────────────┘                                     └─────────────────────────┘
```

1. **Option A — Local CloseDesk Scheduler (Active Authority)**:
   - File: `src/lib/appointmentScheduler.js` and `src/lib/appointmentContract.js`.
   - Maintains durable appointment records at `tenants/${tenantId}/appointments/${appointmentId}`.
   - Maintains atomic slot capacity locks at `tenants/${tenantId}/slot_locks/${slotKey}`.
   - Enforces pre-buffers (setup/travel), post-buffers (teardown/travel), and slot capacity.
   - Emits cryptographically random durable booking IDs: `apt_${Date.now()}_${randomHex}`.
   - Supports atomic cancellation and rescheduling with lock migration.
2. **Option B — Connected Scheduling Provider (Future / Unconfigured Integration)**:
   - Two-way sync with Google Calendar, Cal.com, Jobber, or ServiceTitan is currently unconfigured (no provider OAuth tokens or live calendar accounts configured).
   - If an external integration is connected in the future, it must implement the same 7-point evidence contract before claiming a booking is confirmed.
3. **Option C — Request-Only Mode (`request_only`)**:
   - For tenants with `enableDirectBooking: false` or `booking_mode: "request_only"`.
   - Truthfully records the customer's preferred appointment time without consuming slot locks.
   - Updates lead to `booking_status: "Appointment Request Submitted"` and canonical `lifecycle_status: "QUALIFIED"`.
   - **Strict Guarantee**: The lead is **NEVER** marked `BOOKED`.
   - Chatbot truthfully informs customer: *"Your appointment request for [time] has been recorded. Our team will review availability and confirm your booking shortly."*

---

### 3. Authoritative Appointment States & State Machine

The canonical state machine in `src/lib/appointmentContract.js` defines 11 explicit states and strict transition rules:

| State | Semantic Description | Allowed Next States |
| :--- | :--- | :--- |
| `availability_checked` | Slot verified as open, within business hours, and respecting buffers. | `booking_requested`, `booking_failed` |
| `booking_requested` | Customer selected slot; awaiting explicit customer agreement. | `booking_pending`, `booking_failed`, `cancelled` |
| `booking_pending` | Customer agreed; commit in-flight under idempotency lock. | `booking_committed`, `booking_failed`, `booking_outcome_unknown`, `reconciliation_required` |
| `booking_committed` | Authoritative commit succeeded; durable booking ID issued. | `cancellation_requested`, `cancelled`, `rescheduling_requested`, `rescheduled`, `reconciliation_required` |
| `booking_failed` | Commit rejected (capacity exceeded, slot taken, policy violation). | `booking_requested` (controlled retry) |
| `booking_outcome_unknown` | Network/socket timeout occurred after dispatch; outcome pending reconciliation. | `booking_committed`, `booking_failed`, `reconciliation_required` |
| `cancellation_requested` | Customer or operator requested cancellation. | `cancelled`, `booking_committed` |
| `cancelled` | Terminal state: Appointment cancelled and slot lock released. | *None (Terminal)* |
| `rescheduling_requested` | Slot change requested; awaiting new slot validation and agreement. | `rescheduled`, `booking_committed`, `cancelled` |
| `rescheduled` | Appointment moved to new slot; prior slot released, new slot locked. | `cancellation_requested`, `cancelled`, `rescheduling_requested`, `rescheduled` |
| `reconciliation_required` | Inconsistent or ambiguous state flagged for operator intervention. | `booking_committed`, `cancelled`, `booking_failed` |

---

### 4. The Mandatory BOOKED Rule (7-Point Evidence Verification)

A lead or conversation may enter canonical `LIFECYCLE_STATUS.BOOKED` **ONLY** when all 7 pieces of evidence are verified by `verifyBookedEvidence()`:

1. **Authoritative Booking Commit**: Explicit return of `booking_committed` or `committed` with `authoritative_commit: true`.
2. **Durable Booking Identifier**: Non-empty booking ID matching format `apt_...` persisted in appointment and lead records.
3. **Known, Validated Start Time**: ISO 8601 UTC timestamp (`YYYY-MM-DDTHH:mm:ss.sssZ`).
4. **Recorded Timezone**: Valid IANA timezone string (e.g. `America/New_York`, `America/Chicago`, `America/Los_Angeles`, `UTC`).
5. **Validated Service & Duration**: Supported service name and duration in minutes ($> 0$).
6. **Explicit Customer Agreement**: Customer explicit affirmative agreement (`customer_agreement: { confirmed: true }`) prior to commit.
7. **Tenant & Customer Identity Binding**: Tenant ID, customer name, and at least one contact channel (email or phone).

> [!IMPORTANT]
> If any of the 7 pieces of evidence is missing, `createCanonicalLead` with `enforceBookingEvidence` automatically downgrades the lead to `QUALIFIED` (or `CONTACTED`) with `booking_status: "Appointment Request Submitted"` and records the missing criteria in `booking_details.evidence_missing`. It **NEVER** enters `BOOKED`.

---

### 5. Availability, Duration, Buffers & Business Hours

Slot intervals are evaluated with setup and teardown buffer protection:
- Given an appointment starting at $T_{start}$ with duration $D$, setup buffer $B_{pre}$, and teardown buffer $B_{post}$:
$$\text{Window} = [T_{start} - B_{pre},\; T_{start} + D + B_{post})$$
- Two slots $A$ and $B$ overlap if and only if:
$$\text{Window}_A.\text{start} < \text{Window}_B.\text{end} \quad \land \quad \text{Window}_B.\text{start} < \text{Window}_A.\text{end}$$
- When checking availability:
  - If overlapping active appointments $\ge \text{Capacity}$ (default 1): slot is marked **UNAVAILABLE** (`available: false`).
  - Pre-buffer blocks immediately preceding bookings that would extend into travel/setup time.
  - Post-buffer blocks immediately succeeding bookings that would clash with teardown/travel time.

---

### 6. Timezone & DST Correctness

1. **IANA Standard Compliance**:
   - All timezones are stored and verified against the IANA database via `Intl.DateTimeFormat`.
   - Generic 3-letter abbreviations (e.g., "EST", "PST") are rejected in favor of explicit canonical regions (`America/New_York`, `America/Los_Angeles`).
2. **Daylight Saving Time (DST) Transitions**:
   - **Spring Forward**: In March, clocks skip forward by 1 hour (e.g., 2:00 AM becomes 3:00 AM). `validateDstBoundary` detects the 60-minute offset shift and ensures appointments are represented in unambiguous UTC ISO format.
   - **Autumn Fallback**: In November, clocks repeat 1 hour (e.g., 1:00 AM to 2:00 AM occurs twice). Unambiguous UTC timestamps prevent duplicate or ambiguous slot assignments.
3. **Multi-Tenant Timezone Isolation**:
   - Tenant A (`America/New_York`) and Tenant B (`America/Los_Angeles`) evaluate operating hours and local display times independently from the same underlying UTC ISO appointment timestamp.

---

### 7. Explicit Customer Agreement

- Before committing an appointment, CloseDesk presents an explicit confirmation card:
  - Customer Name, Email, Phone
  - Requested Service
  - Appointment Date, Time, and Local Timezone
- The customer must explicitly affirmative-agree (clicking *"Yes, Confirm Booking"* or stating consent).
- Attempting to commit without customer agreement immediately halts the operation with HTTP 422 (`CUSTOMER_AGREEMENT_REQUIRED`).
- If the customer declines or edits details (*"No, Edit Details"*), no appointment is committed and no slot capacity is consumed.

---

### 8. Concurrency Protection & 10 Simultaneous Requests Test

To prevent race conditions and overbooking:
- An in-process promise-chain mutex queue (`runWithSlotMutex`) indexes locks by `${tenantId}_${slotKey}`.
- **Verification Evidence (TEST 8.1 & 8.2)**:
  - 10 simultaneous asynchronous requests attempted to book the exact same slot (`2026-05-01T15:00:00.000Z`) against `capacity = 1`.
  - **Outcome**: Exactly **1** request succeeded (`booking_committed`) with durable ID.
  - **Outcome**: Exactly **9** requests failed (`SLOT_CAPACITY_EXCEEDED`) with status 409.
  - **Overbooking Count**: **0**.

---

### 9. Timeout-After-Commit, Ambiguous Outcomes & Reconciliation

- If a network or database timeout occurs during commit execution, the operation transitions to `booking_outcome_unknown` with `pending_reconciliation: true`.
- The lead remains in `QUALIFIED` or `CONTACTED` rather than falsely entering `BOOKED`.
- The `reconcileAppointment()` service safely inspects the idempotency lock and appointment store:
  - If the commit completed prior to the timeout, the appointment is reconciled to `booking_committed`.
  - If the commit failed or was never written, the state is resolved to `booking_failed` and the pending lock is released.

---

### 10. Cancellation & Rescheduling Lifecycle

1. **Cancellation**:
   - Validates appointment existence and ownership.
   - Transitions status to `cancelled`.
   - Immediately removes the appointment ID from `tenants/${tenantId}/slot_locks/${slotKey}`, releasing slot capacity.
   - Tested: A previously occupied slot becomes available immediately upon cancellation.
2. **Rescheduling**:
   - Verifies the appointment is in a reschedulable state (`booking_committed` or `rescheduled`).
   - Validates customer agreement for the new time.
   - Verifies new slot availability, duration, buffers, and capacity.
   - **Atomic Lock Transfer**: Releases the old slot lock and acquires the new slot lock in a single transaction.
   - Appends audit entry to `reschedule_history` with `previous_start_time`, `new_start_time`, and timestamp.
   - If the new slot is unavailable, the reschedule fails with `NEW_SLOT_UNAVAILABLE` and the original appointment remains intact.

---

### 11. Cross-Tenant Isolation & Security Enforcement (CD03 & CD08)

1. **Cross-Tenant Booking Tampering (HTTP 403 / 404)**:
   - Tenant A cannot view, cancel, or reschedule Tenant B's appointment.
   - Attempting to pass a spoofed `tenant_id` in `/api/appointments/book` is blocked with HTTP 403 Forbidden.
2. **Independent Tenant Calendars**:
   - Tenant A and Tenant B can book the exact same calendar timestamp without interference, as slot locks are partitioned under `tenants/${tenantId}/slot_locks`.
3. **Secret Protection**:
   - SMTP credentials, OAuth tokens, and internal bearer tokens are strictly omitted from canonical appointment records and API responses.

---

### 12. Verification & Acceptance Test Suite Results

The dedicated acceptance test suite `scripts/cd10_appointment_workflow_suite.js` was executed and verified:

```
================================================================================
   CD10: AUTHORITATIVE APPOINTMENT WORKFLOW (P0) — ACCEPTANCE TEST SUITE
================================================================================

--- SECTION 1: Scheduler Discovery Baseline & Authority Decision ---
  ✔ [PASS] TEST 1.1: Mandatory discovery baseline table accounts for all 10 scheduling dimensions.
  ✔ [PASS] TEST 1.2: Authority Decision implements confirmed_booking, request_only, and disabled modes.
  ✔ [PASS] TEST 1.3: Request-Only mode records request truthfully without consuming slot capacity
  ✔ [PASS] TEST 1.4: Disabled mode blocks booking and request operations server-side

--- SECTION 2: Authoritative Appointment States & State Machine ---
  ✔ [PASS] TEST 2.1: All 11 authoritative appointment states exist in APPOINTMENT_STATUS enum.
  ✔ [PASS] TEST 2.2: Forward lifecycle transitions (checked -> requested -> pending -> committed) permitted.
  ✔ [PASS] TEST 2.3: Cancellation transitions (committed -> cancellation_requested -> cancelled) permitted.
  ✔ [PASS] TEST 2.4: Rescheduling transitions (committed -> rescheduling_requested -> rescheduled) permitted.
  ✔ [PASS] TEST 2.5: Terminal state protection: Cancelled appointment cannot transition to committed.
  ✔ [PASS] TEST 2.6: Ambiguous outcome reconciliation transition permitted.

--- SECTION 3: Mandatory BOOKED Rule (7-Point Evidence Verification) ---
  ✔ [PASS] TEST 3.1: Complete 7/7 evidence permits transition to BOOKED.
  ✔ [PASS] TEST 3.2: Missing authoritative commit evidence blocks BOOKED.
  ✔ [PASS] TEST 3.3: Missing durable booking ID blocks BOOKED.
  ✔ [PASS] TEST 3.4: Non-ISO or missing start time blocks BOOKED.
  ✔ [PASS] TEST 3.5: Missing or invalid IANA timezone blocks BOOKED.
  ✔ [PASS] TEST 3.6: Non-positive service duration blocks BOOKED.
  ✔ [PASS] TEST 3.7: Missing explicit customer agreement blocks BOOKED.
  ✔ [PASS] TEST 3.8: Missing customer identity blocks BOOKED.
  ✔ [PASS] TEST 3.9: assertBookingEvidence throws informative error with missing evidence
  ✔ [PASS] TEST 3.10: Uncommitted booking downgraded to QUALIFIED with 'Appointment Request Submitted'

--- SECTION 4: Availability, Duration, Buffers & Business Hours ---
  ✔ [PASS] TEST 4.1: Slot calculation bounds correctly incorporate 15m pre-buffer and 15m post-buffer.
  ✔ [PASS] TEST 4.2: Pre-buffer of slot A correctly detects conflict with predecessor slot B.
  ✔ [PASS] TEST 4.3: Post-buffer of slot A correctly detects conflict with successor slot B.
  ✔ [PASS] TEST 4.4: Distinct slots separated by hours evaluate with zero overlap.

--- SECTION 5: Timezone & DST Correctness ---
  ✔ [PASS] TEST 5.1: IANA timezones normalized with fallback to UTC for invalid identifiers.
  ✔ [PASS] TEST 5.2: Spring Forward DST transition accurately identified (Day=true, OffsetDiff=60m)
  ✔ [PASS] TEST 5.3: Autumn Fallback DST transition accurately identified (Day=true, OffsetDiff=-60m)
  ✔ [PASS] TEST 5.4: Same UTC timestamp presents distinctly across tenant timezones

--- SECTION 6: Explicit Customer Agreement Requirement ---
  ✔ [PASS] TEST 6.1: Explicit affirmative customer confirmation permits booking commit.
  ✔ [PASS] TEST 6.2: Missing customer agreement rejected with code CUSTOMER_AGREEMENT_REQUIRED

--- SECTION 7: Booking Commit, Idempotency & Replay Protection ---
  ✔ [PASS] TEST 7.1: Fresh booking commit persists durable appointment
  ✔ [PASS] TEST 7.2: Replay with identical operationKey safely returns cached appointment.

--- SECTION 8: Concurrent Same-Slot Protection (10 Concurrent Requests, Capacity=1) ---
  ✔ [PASS] TEST 8.1 & 8.2: 10 concurrent requests against capacity=1 -> Succeeded=1, Failed=9 (ZERO overbooking)

--- SECTION 9: Timeout-After-Commit, Ambiguous Outcomes & Reconciliation ---
  ✔ [PASS] TEST 9.1: Reconciliation service inspects state and confirms committed appointment.
  ✔ [PASS] TEST 9.2: Reconciliation on non-existent commit confirms failed status safely.

--- SECTION 10: Cancellation & Rescheduling Lifecycle ---
  ✔ [PASS] TEST 10.1: Cancellation updates appointment status to cancelled with recorded reason.
  ✔ [PASS] TEST 10.2: Previously cancelled slot becomes immediately available for new booking.
  ✔ [PASS] TEST 10.3: Rescheduling moves slot lock atomically and releases old slot.
  ✔ [PASS] TEST 10.4: Rescheduling to an already-full slot safely rejected, preserving original appointment.

--- SECTION 11: Cross-Tenant Isolation & Security Enforcement (CD03 & CD08) ---
  ✔ [PASS] TEST 11.1: Cross-tenant appointment tampering blocked -> Code=APPOINTMENT_NOT_FOUND
  ✔ [PASS] TEST 11.2: Tenant A and Tenant B can independently book the same timestamp without cross-tenant conflict.
  ✔ [PASS] TEST 11.3: Sensitive credentials and tokens stripped from canonical appointment schema.

--- SECTION 12: Truthful UI Promises (Chatbot & Dashboard Integration) ---
  ✔ [PASS] TEST 12.1: Chatbot confirmed booking maps to BOOKED with durable ID
  ✔ [PASS] TEST 12.2: Chatbot request-only lead remains in QUALIFIED status
  ✔ [PASS] TEST 12.3: /api/appointments/availability returns 400 for missing start_time
  ✔ [PASS] TEST 12.4: /api/appointments/book blocks cross-tenant tampering with 403

================================================================================
   CD10 TEST RESULTS: 46/46 PASSED  (0 FAILED)
================================================================================
```

---

### 13. Full Regression Suite Results

| Test Script | Status | Passed / Total | Notes |
| :--- | :---: | :---: | :--- |
| `npm run test:cd02` | **PASS** | **8 / 8 criteria** | Privileged access & session management |
| `npm run test:cd03` | **PASS** | **54 / 54 tests** | Tenant isolation & secret protection |
| `npm run test:cd06` | **PASS** | **30 / 30 tests** | Canonical lead & action consistency |
| `npm run test:cd07` | **PASS** | **22 / 22 tests** | Reliable business handoff & notifications |
| `npm run test:cd08` | **PASS** | **26 / 26 tests** | Policy & truthful promises |
| `npm run test:cd09` | **PASS** | **28 / 28 tests** | Voice lifecycle & kill switch |
| `npm run test:cd10` | **PASS** | **46 / 46 tests** | Authoritative appointment workflow |
| `npm run build` | **PASS** | **Zero errors** | Production Next.js Turbopack build |

---

### 14. Artifact Deliverables Summary

1. `src/lib/appointmentContract.js`: Canonical statuses, booking modes, slot calculation, timezone normalization, DST validation, 7-point evidence verification.
2. `src/lib/appointmentScheduler.js`: Local authoritative scheduling engine, slot mutex queue, availability checking, commit, reconciliation, cancellation, rescheduling.
3. `src/lib/leadContract.js`: Integrated 7-point evidence rule, fallback to `QUALIFIED`, `promoteToBooked()`.
4. `src/pages/api/appointments/`:
   - `availability.js`: Availability checking with buffers and duration.
   - `book.js`: Authoritative appointment commit with tenant isolation.
   - `cancel.js`: Authoritative cancellation with slot lock release.
   - `reschedule.js`: Authoritative rescheduling with atomic lock migration.
   - `index.js`: Tenant-isolated appointments listing.
5. `src/Closedesk/Chatbot/AicyroChatbot.jsx`: Updated booking flow supporting `confirmed_booking` with durable booking IDs and truthful `request_only` notifications.
6. `src/Closedesk/Dashboard/Booking.jsx`: Dashboard support for authoritative appointment IDs, timezones, and automated slot cancellation.
7. `scripts/cd10_appointment_workflow_suite.js`: Deterministic 46-test acceptance suite.
8. `docs/CD10_AUTHORITATIVE_APPOINTMENT_WORKFLOW.md`: Technical markdown verification report.
9. `Drive docs/CD10_AUTHORITATIVE_APPOINTMENT_WORKFLOW.pdf` & `Drive docs/CD/CD10 AUTHORITATIVE APPOINTMENT WORKFLOW.pdf`: Formal PDF documentation reports.
