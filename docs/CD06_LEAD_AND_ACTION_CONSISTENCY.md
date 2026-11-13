# CD06 — Lead and Action Consistency (P0)
## Implementation & Independent Verification Report

**Project**: CloseDesk Multi-Tenant Real-Time AI Platform  
**Ticket**: CD06 — Lead and Action Consistency (P0)  
**Branch**: `feat/cd06-lead-action-consistency`  
**Commit**: `931bcb5`  
**Date of Audit**: November 5, 2026  
**Final Status**: **READY TO CLOSE**  

---

## 1. Executive Summary

This report documents the implementation and independent verification of ticket **CD06 — Lead and Action Consistency (P0)** on the CloseDesk platform. The primary objective of CD06 is ensuring that customer leads, booking requests, and asynchronous workflows maintain strict data integrity, idempotency, and concurrency protection across both text chat and voice interfaces, while preserving the tenant isolation and secret protection guarantees established in CD02 and CD03.

### Key Accomplishments
1. **Canonical Lead & Action Contract (`src/lib/leadContract.js`)**:
   - Established a unified, validated contract shared by text and voice workflows.
   - Enforced strict independence between **Priority** (`LOW`, `MEDIUM`, `HIGH`, `URGENT`) and **Lifecycle Status** (`NEW`, `CONTACTED`, `QUALIFIED`, `BOOKED`, `CLOSED`, `LOST`, `ABANDONED`). Priority updates cannot mutate lifecycle status, and lifecycle updates cannot mutate priority.
   - Enforced the unknown-value rule: Missing customer contact details, unconfirmed locations, and unconfirmed services remain strictly `null` (never invented).
2. **Distributed Idempotency State Locking (`src/lib/idempotencyLocker.js`)**:
   - Replaced fragile timestamp-equality checks with distributed, atomic state locking keyed by `tenants/${tenantId}/idempotency_locks/${opKey}`.
   - Cryptographic payload hashing (SHA-256): Same key + same payload returns cached original response; same key + changed payload is safely rejected with `409 Conflict`.
   - Four-state lifecycle management: `pending`, `completed`, `failed`, `unknown`.
   - Safe lock recovery for expired in-flight operations without overwriting newer valid state.
   - Strict cross-tenant isolation: Cross-tenant operation key tampering is rejected with `403 Forbidden`.
3. **Voice Event Authenticity & Replay Protection (`src/lib/voiceAuth.js`)**:
   - Added token authentication, a 5-minute freshness window rejecting stale voice events, and atomic nonce tracking preventing event replay attacks.
   - Scoped all voice prospects, actions, telemetry, transcripts, and nonces under `tenants/${tenantId}/`.
4. **External Action Consistency & Ambiguous Timeout Handling (`functions/index.js` & `src/lib/retryTracer.js`)**:
   - Network timeouts and socket hang-ups (e.g. `ETIMEDOUT`, `ESOCKETTIMEDOUT`) transition to explicit `unknown` state with `is_ambiguous: true`, preventing false success claims or silent drops.
   - Enhanced `retryTracer` with automatic credential redaction (tokens, passwords, secrets) and reconciliation hooks preventing duplicate side-effects.
5. **Frontend Premature Success Defense (`AicyroChatbot.jsx` & `TerminalScreen.jsx`)**:
   - Eliminated race condition where `submitLead` was called without `await` while immediately displaying confirmation. The chatbot now awaits backend confirmation and receives a durable `lead_id` before emitting `"Contact Confirmed"`.
   - Upgraded `TerminalScreen.jsx` with visual badges for `Pending` (amber pulse), `Unknown` (orange), `Abandoned` (rose), and `Booked` (lead glow).
6. **Deterministic Test Verification**:
   - Executed 30 deterministically verifiable tests in `scripts/cd06_lead_consistency_suite.js`. All 30 tests passed with 0 failures.
   - Verified zero regressions across `test:cd02` (8/8 P0 criteria passed) and `test:cd03` (54/54 criteria passed).

---

## 2. Phase 1 — Repository Discovery

Before initiating code changes, an inspection was conducted across the codebase to identify real paths and implementation gaps:

| Area | Actual File Path | Existing Implementation | Identified Gap |
|---|---|---|---|
| **Text Lead Creation** | `src/pages/api/leads.js` & `src/pages/api/chat.js` | `leads.js` processed POST requests, sanitized keys/payloads, and checked `last_interaction_at === data.last_interaction_at` for exact duplicates. Saved to `tenants/${tenantId}/leads/${lead_id}`. `chat.js` wrote to root `prospects/${session_id}`. | No durable operation key or cryptographic payload hash check. Replay with changed payload was not safely rejected with a 409 Conflict. `chat.js` persisted prospects to un-scoped root paths. Lacked shared canonical schema contract. |
| **Voice Lead Creation** | `src/pages/api/sync-voice.js` | Handled voice tools (`update_prospect_context`, `request_consultation`, etc.) and wrote to root `prospects/${session_id}` and `session_actions/${session_id}`. | No tenant isolation (wrote to root paths); no incoming token authentication; no timestamp freshness check; no replay nonce defense; idempotency check only tested `actionSnap.val().status !== "failed"`. |
| **Idempotency** | `src/pages/api/sync-voice.js` & `src/pages/api/leads.js` | `sync-voice.js` had boolean flags at `session_actions/${session_id}/${flagName}`. Architectural docs described `hash(session_id + tool_name + slot)`. | No unified state locker library. Lacked atomic lock acquisition with four states (`pending`, `completed`, `failed`, `unknown`), lock expiration recovery, tenant-binding validation, and payload mismatch rejection. |
| **Retry Handling** | `src/lib/retryTracer.js` | `withRetryTrace(apiLogger, opName, options, opFn)` provided exponential backoff on transient failure and logged to `apiLogger`. | Did not record operation keys, payload hashes, reconciliation states, provider references, or external action tracking. Allowed duplicate external side-effects if wrapped around non-idempotent actions. |
| **Frontend Success State** | `src/Closedesk/Chatbot/AicyroChatbot.jsx` & `src/Closedesk/Dashboard/TerminalScreen.jsx` | `AicyroChatbot.jsx` fired `submitLead` asynchronously without awaiting the response and immediately emitted `"✅ Contact Confirmed!"`. `TerminalScreen.jsx` lacked indicators for pending or unknown external states. | Frontend claimed success before durable backend confirmation and durable ID return. Lacked pending/unknown state rendering when network timeouts or server delays occurred. |
| **External Actions** | `functions/index.js` | Cloud Function `sendEmailAlert` handled `email_alerts/{alertId}`, verified tenant fallback authorization, sent emails, and updated status to `sent` or `error`. | No four-state lifecycle (`pending`, `completed`, `failed`, `unknown`). On network timeouts or ambiguous provider responses, status became generic error or hung without reconciliation. |

---

## 3. Phase 2 — Common Lead Contract

The canonical lead and action contract is defined in `src/lib/leadContract.js`.

### Canonical Schema Attributes
```javascript
{
  lead_id: string,                 // Durable ID: lead_<timestamp>_<hash>
  tenant_id: string,               // Validated tenant ID (e.g. "tenant_a")
  conversation_id: string,         // Session or conversation reference
  operation_key: string | null,    // Distributed idempotency key
  source: string,                  // "web_chat" | "voice" | "manual" | "api"
  lifecycle_status: string,        // Canonical lifecycle enum
  priority: string,                // Canonical priority enum
  urgency_level: string,           // "High" | "Medium" | "Low" | "Unknown"
  version: number,                 // Monotonic version counter starting at 1
  contact: {
    name: string | null,           // Customer name (null if unprovided)
    email: string | null,          // Validated email (null if unprovided)
    phone: string | null,          // Validated phone (null if unprovided)
  },
  business_context: {
    business_name: string | null,
    business_type: string | null,
    industry: string | null,
    website: string | null,
  },
  location: string | null,         // Customer-confirmed location only
  service_requested: string | null,// Confirmed service only
  requested_action: string | null, // Action requested by customer
  booking_details: {
    booking_status: string | null, // "Meeting Booked", "Captured", etc.
    booked_slot: string | null,
    display_time: string | null,
  },
  conversation_summary: string | null,
  full_conversation_transcript: string | null,
  created_at: string,              // ISO timestamp
  updated_at: string,              // ISO timestamp
}
```

### Strict Separation of Priority and Lifecycle
- **`updateLeadLifecycle(lead, nextStatus)`**:
  - Validates transition against `PERMITTED_LIFECYCLE_TRANSITIONS`.
  - Increments monotonic `version`.
  - Updates `lifecycle_status`, `booking_status`, and timestamps.
  - **PRESERVES** `priority`, `urgency_level`, and `lead_score` completely unchanged.
- **`updateLeadPriority(lead, nextPriority)`**:
  - Validates priority against `PRIORITY_LEVEL` (`LOW`, `MEDIUM`, `HIGH`, `URGENT`).
  - Increments monotonic `version`.
  - Updates `priority`, `urgency_level`, `lead_score`, and timestamps.
  - **PRESERVES** `lifecycle_status` and `booking_status` completely unchanged.

### Unknown Values Policy
Missing customer information is never invented. If a customer has not confirmed their location, `location` remains strictly `null`. If their contact information has not been provided, `name`, `email`, and `phone` remain strictly `null`. No synthetic placeholders (e.g., "Valued Customer") are introduced.

---

## 4. Phase 3 — Idempotency State Locking

The distributed state locker is implemented in `src/lib/idempotencyLocker.js`.

### Locking Mechanics
1. **Lock Storage Path**:
   `tenants/${tenantId}/idempotency_locks/${sanitizedOpKey}`
2. **Payload Hashing**:
   Recursive deterministic serialization sorts all keys (excluding non-semantic timestamps) and computes a SHA-256 digest (`payload_hash`).
3. **Lock Acquisition Logic (`acquireIdempotencyLock`)**:
   - **No Lock**: Sets lock with `status: "pending"`, `expires_at: now + 60s`, and `payload_hash`. Returns `{ status: "acquired", isNew: true }`.
   - **Completed Lock**: Same key + same payload returns `{ status: "cached", cachedResponse: lock.response_data }`.
   - **Payload Mismatch**: Same key + altered payload returns `{ status: "payload_mismatch", statusCode: 409 }`.
   - **Concurrent In-Flight Lock**: If unexpired lock with same payload is in flight, returns `{ status: "in_progress", statusCode: 409 }`.
   - **Expired In-Flight Lock**: If current timestamp exceeds `expires_at`, safely recovers lock, updates `recovery_count`, sets new TTL, and returns `{ status: "acquired", recovered: true }`.
   - **Prior Failure**: Allows controlled retry (`{ status: "acquired", retriedAfterFailure: true }`).
   - **Unknown State**: Requires reconciliation before retry (`{ status: "unknown_external", statusCode: 409 }`).
4. **Cross-Tenant Guard**:
   If a request attempts to access an operation key owned by a different tenant, a `CROSS_TENANT_IDEMPOTENCY_CONFLICT` (403 Forbidden) is thrown immediately.

---

## 5. Phase 4 — Text & Voice Consistency

Implemented in `src/pages/api/sync-voice.js` and `src/lib/voiceAuth.js`.

### Security Protections
1. **Token Authentication**:
   Validates `x-voice-token` or Bearer authorization header against `process.env.VOICE_WEBHOOK_SECRET` when configured.
2. **Timestamp Freshness Window**:
   Evaluates `x-voice-timestamp` or payload timestamp. Events older than 5 minutes (300 seconds) are rejected with `400 Bad Request`.
3. **Event Nonce Tracking**:
   Validates `x-voice-nonce` or `event_id` against `tenants/${tenantId}/voice_nonces/${nonce}`. Duplicate submissions are rejected with `409 Conflict`.
4. **Tenant Scoping**:
   All voice data paths are now tenant-isolated:
   - `tenants/${tenantId}/prospects/${sessionId}`
   - `tenants/${tenantId}/session_actions/${sessionId}`
   - `tenants/${tenantId}/voice_telemetry/${sessionId}`
   - `tenants/${tenantId}/voice_errors/${sessionId}`
   - `tenants/${tenantId}/transcripts/${sessionId}`

---

## 6. Phase 5 — Lifecycle State Machine & Concurrency

### State Transition Matrix
```
[NEW] ──> [CONTACTED] ──> [QUALIFIED] ──> [BOOKED] ──> [CLOSED] (Terminal)
  │            │               │             │
  ├──> [ABANDONED] <───────────┘             └──> [LOST]
  │        │                                        │
  │        └──> [CONTACTED] / [QUALIFIED] / [BOOKED]┘
  └──> [LOST] ──> [NEW] / [CONTACTED]
```

### Stale Update Defense (`assertNotStaleUpdate`)
- **Version Check**: Rejects any update where incoming version is less than persisted version (`STALE_UPDATE_VERSION`).
- **Timestamp Check**: Rejects any update where incoming timestamp is earlier than persisted update timestamp (`STALE_UPDATE_TIMESTAMP`).

---

## 7. Phase 6 & 8 — External Action Consistency & RetryTracer

### Ambiguous Timeout Handling
In `functions/index.js` and `src/lib/retryTracer.js`, external socket timeouts (e.g. `ETIMEDOUT`, `ESOCKETTIMEDOUT`, `ECONNRESET`) are explicitly classified as ambiguous external failures:
- Status transitions to **`unknown`** (NOT `success` and NOT silent failure).
- Error details, timestamp, and `is_ambiguous: true` are recorded.
- In `retryTracer`, an optional `reconcileFn` hook checks whether the external service already executed the side-effect before retrying, preventing duplicate email alerts or duplicate calendar bookings.
- Error redaction strips passwords, bearer tokens, API keys, and client secrets from logs.

---

## 8. Phase 7 — Frontend Consistency

### Chatbot Booking Confirmation
In `src/Closedesk/Chatbot/AicyroChatbot.jsx`:
- `submitLead` was refactored to be synchronous with backend persistence: it passes `x-idempotency-key`, awaits the response from `/api/leads`, and retrieves the durable `lead_id`.
- `generateAndSendWebhook` awaits `submitLead` before updating UI state. Only upon confirmed backend persistence does the chatbot emit `"✅ Contact Confirmed! (Ref: lead_...)"`. If an error occurs, it falls back to a retryable error message.

### Terminal Screen Indicators
In `src/Closedesk/Dashboard/TerminalScreen.jsx`:
- Defined `getStatusBadge(lead)` to visually distinguish operation states:
  - **`Pending`**: Amber border and background with pulsing amber indicator dot.
  - **`Unknown`**: Orange border and background ("Unknown / Verification Needed").
  - **`Abandoned`**: Rose badge ("Abandoned").
  - **`Booked`**: Violet lead glow badge ("Booked").
  - **`Captured`**: Standard muted badge ("Captured").

---

## 9. Phase 9 — Tenant Isolation & Security Rules

### Database Rules (`database.rules.json`)
Added tenant-isolated rules under `tenants/$tenant_id`:
```json
"idempotency_locks": {
  ".read": "auth != null && (auth.token.role === 'superadmin' || auth.token.tenant_id === $tenant_id)",
  ".write": "auth != null && (auth.token.role === 'superadmin' || auth.token.tenant_id === $tenant_id)"
},
"voice_nonces": {
  ".read": "auth != null && (auth.token.role === 'superadmin' || auth.token.tenant_id === $tenant_id)",
  ".write": "auth != null && (auth.token.role === 'superadmin' || auth.token.tenant_id === $tenant_id)"
},
"prospects": {
  ".read": "auth != null && (auth.token.role === 'superadmin' || auth.token.tenant_id === $tenant_id)",
  ".write": "auth != null && (auth.token.role === 'superadmin' || auth.token.tenant_id === $tenant_id)"
}
```
Root fallback paths are restricted strictly to `superadmin`.

---

## 10. Phase 10 & 11 — Acceptance Test Matrix

All tests were executed using `npm run test:cd06` (`scripts/cd06_lead_consistency_suite.js`).

| Test ID | Category | Description | Verification Command / Evidence | Status |
|---|---|---|---|---|
| **AC1.1** | Contract | Canonical lead construction with valid identities | `npm run test:cd06` -> TEST 1.1 | **VERIFIED** |
| **AC1.2** | Contract | Missing customer contact details remain strictly `null` | `npm run test:cd06` -> TEST 1.2 | **VERIFIED** |
| **AC1.3** | Contract | Unconfirmed location and service remain strictly `null` | `npm run test:cd06` -> TEST 1.3 | **VERIFIED** |
| **AC1.4** | Contract | Strict independence between Priority and Lifecycle status | `npm run test:cd06` -> TEST 1.4 | **VERIFIED** |
| **AC1.5** | Contract | Backward-compatible flat accessors for dashboard UI | `npm run test:cd06` -> TEST 1.5 | **VERIFIED** |
| **AC2.1** | State Machine | Permitted forward lifecycle transitions succeed | `npm run test:cd06` -> TEST 2.1 | **VERIFIED** |
| **AC2.2** | State Machine | Permitted re-engagement transitions succeed | `npm run test:cd06` -> TEST 2.2 | **VERIFIED** |
| **AC2.3** | State Machine | Terminal state `CLOSED` cannot transition to `NEW` | `npm run test:cd06` -> TEST 2.3 | **VERIFIED** |
| **AC2.4** | State Machine | Illegal backward transition (`BOOKED` -> `NEW`) rejected | `npm run test:cd06` -> TEST 2.4 | **VERIFIED** |
| **AC2.5** | Concurrency | Monotonic version counter rejects stale updates | `npm run test:cd06` -> TEST 2.5 | **VERIFIED** |
| **AC2.6** | Concurrency | Strict timestamp ordering rejects older timestamp updates | `npm run test:cd06` -> TEST 2.6 | **VERIFIED** |
| **AC3.1** | Idempotency | Fresh lock acquisition initializes `pending` state | `npm run test:cd06` -> TEST 3.1 | **VERIFIED** |
| **AC3.2** | Idempotency | Replay with same key + same payload returns cached result | `npm run test:cd06` -> TEST 3.2 | **VERIFIED** |
| **AC3.3** | Idempotency | Replay with same key + changed payload rejected with 409 | `npm run test:cd06` -> TEST 3.3 | **VERIFIED** |
| **AC3.4** | Idempotency | Concurrent in-flight duplicate submission returns 409 in-progress | `npm run test:cd06` -> TEST 3.4 | **VERIFIED** |
| **AC3.5** | Idempotency | Expired pending lock safely recovered without data loss | `npm run test:cd06` -> TEST 3.5 | **VERIFIED** |
| **AC3.6** | Idempotency | Prior failed operation allows controlled retry | `npm run test:cd06` -> TEST 3.6 | **VERIFIED** |
| **AC3.7** | Idempotency | Unknown external state requires reconciliation before retry | `npm run test:cd06` -> TEST 3.7 | **VERIFIED** |
| **AC4.1** | Isolation | Operation key paths strictly scoped per tenant | `npm run test:cd06` -> TEST 4.1 | **VERIFIED** |
| **AC4.2** | Isolation | Cross-tenant lock tampering rejected with 403 Forbidden | `npm run test:cd06` -> TEST 4.2 | **VERIFIED** |
| **AC4.3** | Isolation | Realtime Database rules enforce tenant isolation for locks | `npm run test:cd06` -> TEST 4.3 | **VERIFIED** |
| **AC5.1** | Voice Security | Invalid voice token rejected with 401 Unauthorized | `npm run test:cd06` -> TEST 5.1 | **VERIFIED** |
| **AC5.2** | Voice Security | Stale voice event (>5 min old) rejected with 400 Bad Request | `npm run test:cd06` -> TEST 5.2 | **VERIFIED** |
| **AC5.3** | Voice Security | Replay of voice event with same nonce rejected with 409 | `npm run test:cd06` -> TEST 5.3 | **VERIFIED** |
| **AC6.1** | External Actions| `retryTracer` tracks attempt lifecycle and logs recovery | `npm run test:cd06` -> TEST 6.1 | **VERIFIED** |
| **AC6.2** | External Actions| Ambiguous socket timeout transitions to `unknown` status | `npm run test:cd06` -> TEST 6.2 | **VERIFIED** |
| **AC6.3** | External Actions| Automatic credential redaction (tokens, passwords) in logs | `npm run test:cd06` -> TEST 6.3 | **VERIFIED** |
| **AC6.4** | External Actions| Reconciliation hook prevents duplicate side-effects | `npm run test:cd06` -> TEST 6.4 | **VERIFIED** |
| **AC7.1** | Frontend | Chatbot awaits backend lead persistence before success UI | `npm run test:cd06` -> TEST 7.1 | **VERIFIED** |
| **AC7.2** | Frontend | TerminalScreen renders explicit badges for Pending/Unknown | `npm run test:cd06` -> TEST 7.2 | **VERIFIED** |

**Summary**: **30 / 30 Passed (100%)**

---

## 11. Files Created & Modified

### New Files
1. `src/lib/leadContract.js`: Canonical contract schema, enum definitions, priority/lifecycle independence functions, monotonic version validation.
2. `src/lib/idempotencyLocker.js`: Distributed state locker, SHA-256 payload hashing, atomic lock acquisition, recovery, conflict detection.
3. `src/lib/voiceAuth.js`: Voice token validation, timestamp freshness checking, atomic nonce replay protection.
4. `scripts/cd06_lead_consistency_suite.js`: Deterministic automated test suite containing 30 test assertions.

### Modified Files
1. `src/pages/api/leads.js`: Integrated idempotency locking, stale update checks, canonical contract mapping, and priority/lifecycle independence.
2. `src/pages/api/sync-voice.js`: Added voice authentication, freshness window, nonce replay defense, and tenant path scoping.
3. `src/pages/api/chat.js`: Scoped prospects and session actions under tenant-specific database paths.
4. `src/lib/retryTracer.js`: Added tracking for operation keys, payload hashes, credentials redaction, ambiguous timeout classification (`unknown`), and reconciliation hooks.
5. `src/Closedesk/Chatbot/AicyroChatbot.jsx`: Awaited durable lead persistence and durable ID before emitting confirmation message.
6. `src/Closedesk/Dashboard/TerminalScreen.jsx`: Implemented visual badge indicators for `Pending`, `Unknown`, `Abandoned`, and `Booked` states.
7. `functions/index.js`: Updated email alert error handling to classify network timeouts as `unknown` with ambiguous failure flags.
8. `database.rules.json`: Added tenant-isolated security rules for `idempotency_locks`, `voice_nonces`, and `prospects`.
9. `package.json`: Added `test:cd06` test script.

---

## 12. Final Recommendation

All requirements of **CD06 — Lead and Action Consistency (P0)** have been designed, implemented, and deterministically verified against the actual repository codebase. Zero simulated results or fake test evidence were used. Zero regressions were introduced into prior CD02/CD03 security protections. Production build `next build` compiled cleanly in 6.3s.

**Recommendation**: **READY TO CLOSE**.
