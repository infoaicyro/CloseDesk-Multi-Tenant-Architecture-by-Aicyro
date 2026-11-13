# P0 Ticket CD05: Public Endpoint Controls and Budgets
**Repository:** `Testing-closedesk-Multi-Tenant-Architecture`  
**Engineer:** Lead Full-Stack & Security Engineer (Antigravity)  
**Status:** COMPLETE (30/30 Acceptance Tests Passing, Build Clean)  
**Date:** 2026-11-03  

---

## Executive Summary

Publicly accessible and semi-public API endpoints in multi-tenant architectures are prime targets for resource exhaustion, denial-of-wallet attacks, replay spam, telemetry spoofing, and formula injection. Prior to CD05, several public endpoints lacked explicit Next.js request body caps, depended strictly on browser CORS for origin isolation (which direct scripts like `curl` bypass completely), lacked atomic concurrency ceilings and tenant-isolated budget enforcement, and suffered from CSV formula injection vulnerabilities during lead report exports.

Ticket **CD05** establishes a unified, deterministic defense-in-depth perimeter across all public and semi-public surfaces:
1. **Direct Script & Spoofed Origin Defense:** Strict HTTP method checks and Next.js body size limits (`export const config = { api: { bodyParser: { sizeLimit: ... } } }`) enforce rate limits, concurrency controls, and budget caps irrespective of client `Origin` or `Referer` headers.
2. **Atomic Budgeting & In-Flight Concurrency Controls:** In-memory atomic token budget tracking with an explicit bounded in-flight burst allowance (`1,500` tokens) prevents race-condition overspending. Tenant quota exhaustion is strictly isolated—Tenant A reaching 100% budget exhaustion does not degrade Tenant B.
3. **Authoritative AI Cost & "Unknown" Usage Tracing:** Extends `src/lib/aiTracer.js` and `src/lib/retryTracer.js` to log `provider`, `model`, `tenantId`, `sessionId`, `operation`, `usage`, `estimatedCostUsd`, and `retryCount`. Crucially, when an upstream provider or protocol does not supply token usage (e.g., WebRTC ephemeral session minting, Polly neural TTS audio streaming), usage is explicitly recorded as `"unknown"` (NEVER `0`).
4. **Lead Replay & Recipient Abuse Protection:** Deterministic SHA-256 lead content deduplication enforces a 60-second replay window and per-session rate limits. Public lead submissions route strictly to verified tenant destinations; arbitrary client-supplied recipient fields (`to`, `cc`, `bcc`) and CRLF header injection vectors are stripped.
5. **Untrusted Telemetry Isolation:** Public ingestion endpoints (`/api/analytics`, `/api/cookie-consent`, `/api/app-state`, `/api/sync-voice`) strip and quarantine client-supplied privilege claims (`actor`, `role`, `isSuperAdmin`, `auditOutcome`), stamping records as `anonymous_visitor` with role `public`.
6. **Hostile Output Sanitization & CSV Formula Defense:** `src/lib/sanitizer.js` and `src/Closedesk/Dashboard/Report.jsx` neutralize formula injection by prefixing command characters (`=`, `+`, `-`, `@`, `\t`, `\r`) with single quotes (`'`) and enclosing values in RFC 4180 double quotes.

---

## 1. Enabled Public Endpoint Protection Matrix

| Route | HTTP Methods | Payload Cap | Rate Limit (Window) | Concurrency Cap | Budget Policy | Validation & Input Sanitation Rules |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`/api/chat`** | `POST` | 32 KB | 20 req / 60s per session/IP | 5 concurrent / tenant | 1,000 token res / req + 1,500 burst allowance | Requires valid `messages` array, string content, bounded tenantId. Strips untrusted metadata. |
| **`/api/analyze-image`**| `POST` | 4 MB | 10 req / 60s per session/IP | 2 concurrent / tenant | 1,500 token res / req | Validates image URI (`data:image/*;base64,...` or safe `http/https`), payload size, prompt. |
| **`/api/openai-token`** | `POST` | 16 KB | 10 req / 60s per session/IP | 3 concurrent / tenant | 500 token res / req | Ephemeral WebRTC session token minting. Logs `"unknown"` usage (never `0`). |
| **`/api/tts`** | `POST` | 16 KB | 30 req / 60s per session/IP | 5 concurrent / tenant | 200 token res / req | Max text length capped at 4,096 chars. Voice ID whitelist. Logs `"unknown"` usage. |
| **`/api/leads`** | `POST` | 32 KB | 5 req / 60s per session/IP | 5 concurrent / tenant | Abandoned summary AI traced | SHA-256 content deduplication (60s replay window). Drops untrusted `to`/`cc`/`bcc`. |
| **`/api/generate-email`**| `POST`| 16 KB | 5 req / 60s per session/IP | 2 concurrent / tenant | 500 token res / req | Recipient restricted to verified tenant email. Strips CRLF injection characters. |
| **`/api/cookie-consent`**| `POST`| 16 KB | 30 req / 60s per session/IP | N/A | Non-AI telemetry | Strips privilege claims (`actor`, `role`, `isSuperAdmin`). `safeDbSet` 400ms timeout. |
| **`/api/analytics`** | `POST` | 16 KB | 60 req / 60s per session/IP | N/A | Non-AI telemetry | Sanitizes untrusted telemetry claims. Stamps as `anonymous_visitor`. |
| **`/api/app-state`** | `POST` | 16 KB | 30 req / 60s per session/IP | N/A | Non-AI telemetry | Sanitizes untrusted telemetry claims. `safeDbSet` 400ms timeout. |
| **`/api/sync-voice`** | `POST` | 32 KB | 20 req / 60s per session/IP | N/A | Non-AI telemetry | Isolates untrusted telemetry. Rejects client-supplied authority/audit stamps. |

---

## 2. Budget & In-Flight Concurrency Model

### 2.1 Atomic Budget Reservation
Direct script requests and high-traffic bursts can overwhelm token allocations before upstream provider API calls complete. To prevent budget overrun:
- **`checkAndReserveBudget(tenantId, estimatedTokens)`** atomically evaluates current spend + active reservations against `maxTokenBudget + IN_FLIGHT_BURST_ALLOWANCE`.
- If accepted, the estimated tokens are reserved in-flight.
- Upon completion, `recordAuthoritativeAiTrace` commits the actual token usage and frees the reservation.
- If the reservation pushes total usage past the hard allowance ceiling, the request is immediately aborted with `429 Too Many Requests` (`BUDGET_EXCEEDED`).

### 2.2 Bounded In-Flight Burst Allowance
- A hard ceiling can cause false-positive rejections when multiple legitimate calls arrive within milliseconds.
- An explicit in-flight burst allowance (`IN_FLIGHT_BURST_ALLOWANCE = 1500 tokens`) is permitted strictly for pending concurrent requests.
- Once completed calls push committed tokens to the budget limit, subsequent reservations are rejected without exceptions.

### 2.3 Multi-Tenant Isolation (Noisy-Neighbor Immunity)
- Budgets and active concurrency slots are partitioned strictly by `tenantId`.
- **Deterministic Proof:** In Category 3 of the acceptance suite (`scripts/cd05_public_controls_and_budgets_suite.js`), Tenant A's budget was driven to 100% exhaustion (5,000/5,000 tokens used), causing all subsequent Tenant A calls to fail with 429 `BUDGET_EXCEEDED`. Concurrently, Tenant B executed identical requests without delay, receiving 200 OK responses with full token allowances intact.

---

## 3. Authoritative AI Cost Tracing & "Unknown" Usage Specification

### 3.1 Trace Schema
Every AI and speech execution tracked via `src/lib/aiTracer.js` records the following authoritative fields:
```json
{
  "traceId": "trace_1730663972000_abc123",
  "provider": "openai",
  "model": "gpt-4o-mini",
  "tenantId": "tenant_alpha",
  "sessionId": "sess_xyz789",
  "operation": "chat_completion",
  "usage": {
    "prompt_tokens": 120,
    "completion_tokens": 45,
    "total_tokens": 165
  },
  "estimatedCostUsd": 0.000045,
  "retryCount": 0,
  "timestamp": "2026-11-03T18:39:32.000Z"
}
```

### 3.2 "Unknown" Usage Protocol
When an operation does not report token counts (e.g., WebRTC session creation in `/api/openai-token` or AWS Polly character streaming in `/api/tts`), the usage property MUST NOT be recorded as `0`:
```json
{
  "traceId": "trace_1730663972100_def456",
  "provider": "openai-realtime",
  "model": "gpt-4o-realtime-preview",
  "tenantId": "tenant_alpha",
  "operation": "session_minting",
  "usage": {
    "total_tokens": "unknown",
    "unmetered_reason": "ephemeral_webrtc_session"
  },
  "estimatedCostUsd": 0.005,
  "retryCount": 0
}
```
Setting `total_tokens: 0` would falsely skew financial models and hide untracked operational costs. The `"unknown"` flag ensures audit integrity.

### 3.3 Financial Reconciliation Helper (`reconcileAiCharges`)
`src/lib/aiTracer.js` provides `reconcileAiCharges(traceRecords, providerInvoice)` to compare logged telemetry against provider invoices:
- Tallies total traced spend across known tokens.
- Counts operations flagged with `"unknown"` usage.
- Computes variance against the provider invoice total.
- Flags `status: "reconciled"` when within tolerance (0.01 USD), or `status: "variance_detected"` when unaccounted discrepancies occur.

---

## 4. Abuse Prevention & Hostile Output Sanitization

### 4.1 Lead Replay Idempotency & Recipient Defense
- **SHA-256 Deduplication:** `src/lib/publicEndpointGuard.js` computes `SHA256(tenantId + email + phone + message)`. Duplicate submissions within 60 seconds are intercepted with HTTP 409 `DUPLICATE_LEAD_SUBMISSION`.
- **Recipient Lock-Down:** In `/api/leads` and `/api/generate-email`, incoming payloads attempting to supply arbitrary `to`, `cc`, or `bcc` email addresses are stripped. Outgoing notifications route strictly to pre-configured tenant recipient settings.
- **CRLF Injection Prevention:** `src/lib/sanitizer.js` strips `\r` and `\n` characters from email subjects and recipient headers, preventing header injection attacks (`functions/index.js`, `generate-email.js`).

### 4.2 Untrusted Telemetry Quarantine
Public telemetry routes (`analytics.js`, `cookie-consent.js`, `app-state.js`, `sync-voice.js`) sanitize incoming payloads via `sanitizeUntrustedTelemetry`:
- Discards client-provided fields: `actor`, `role`, `isSuperAdmin`, `auditOutcome`, `permissions`, `claims`.
- Replaces with server-authoritative stamps: `actor: "anonymous_visitor"`, `role: "public"`, `source: "untrusted_client"`.

### 4.3 CSV Formula Injection Defense (RFC 4180 Compliant)
In `src/Closedesk/Dashboard/Report.jsx` (`executeCSVExport`) and `src/lib/sanitizer.js` (`sanitizeCsvCell`, `formatCsvRow`):
- Any cell value beginning with executable formula prefix characters (`=`, `+`, `-`, `@`, `\t`, `\r`) is prepended with a single quote (`'`).
- Cell values containing commas, quotes, or newlines are wrapped in double quotes, with internal quotes escaped as `""` per RFC 4180.
- Prevents Dynamic Data Exchange (DDE) and command execution vulnerabilities when CSV reports are opened in Excel or Google Sheets.

---

## 5. Verification & Acceptance Test Suite

The test suite `scripts/cd05_public_controls_and_budgets_suite.js` executes 30 deterministic assertions across 8 distinct categories.

### Command Execution:
```bash
npm run test:cd05
```

### Verbatim Output:
```
================================================================================
   CLOSEDESK CD05: PUBLIC ENDPOINT CONTROLS & BUDGETS ACCEPTANCE SUITE
================================================================================

--- Category 1: Direct Script & Spoofed Origin Policy (CORS != Auth) ---
  [PASS] [AC1.1] Direct script without Origin header is governed by strict validation controls
  [PASS] [AC1.2] Request with spoofed Origin is governed by identical 32KB payload size caps (returns 413)
  [PASS] [AC1.3] Unsupported HTTP method (GET on POST-only route) rejected with 405 Method Not Allowed

--- Category 2: Concurrent Burst & Bounded In-Flight Allowance ---
  [PASS] [AC2.1] Concurrent burst obeys explicit in-flight ceiling (accepted exactly within budget + allowance)
  [PASS] [AC2.2] Subsequent requests after budget exhaustion return 429 BUDGET_EXCEEDED
  [PASS] [AC2.3] In-flight concurrency ceiling rejects requests exceeding max concurrency with 429

--- Category 3: Noisy-Neighbor Isolation (Tenant A vs Tenant B) ---
  [PASS] [AC3.1] Tenant A budget is completely exhausted and returns BUDGET_EXCEEDED (429)
  [PASS] [AC3.2] Tenant B remains 100% healthy, accessible, and unhindered by Tenant A exhaustion
  [PASS] [AC3.3] Cross-tenant concurrency slots are strictly partitioned

--- Category 4: Lead Replay Idempotency & Recipient Abuse Defense ---
  [PASS] [AC4.1] First lead submission succeeds (200 OK)
  [PASS] [AC4.2] Immediate identical lead replay within 60s window rejected with 409 DUPLICATE_LEAD_SUBMISSION
  [PASS] [AC4.3] Lead with different content accepted (200 OK)
  [PASS] [AC4.4] Rapid repeated requests from same session exceed rate limit and receive 429
  [PASS] [AC4.5] Arbitrary recipient tampering (to, cc, bcc) stripped; notification sent strictly to verified destination
  [PASS] [AC4.6] CRLF injection in subject or recipient stripped to single line

--- Category 5: Request Body Caps & Malformed Payload Rejection ---
  [PASS] [AC5.1] Payload exceeding 32KB on /api/chat rejected with 413 PAYLOAD_TOO_LARGE
  [PASS] [AC5.2] Non-JSON malformed string body on /api/chat rejected with 400 MALFORMED_JSON_PAYLOAD
  [PASS] [AC5.3] Malformed field types (messages: number) return safe 400 without stack-trace leakage
  [PASS] [AC5.4] Invalid image URI format in /api/analyze-image rejected with 400 INVALID_IMAGE_PAYLOAD

--- Category 6: Telemetry Forgery Rejection ---
  [PASS] [AC6.1] sanitizeUntrustedTelemetry strips client-supplied privilege claims (actor, role, isSuperAdmin, auditOutcome)
  [PASS] [AC6.2] POST /api/app-state ingests log after quarantining client privilege claims into anonymous visitor scope
  [PASS] [AC6.3] POST /api/cookie-consent isolates untrusted client telemetry and ignores spoofed authority fields

--- Category 7: Hostile Content Safety (UI, Email, CSV) ---
  [PASS] [AC7.1] escapeHtml neutralizes HTML/script tags into safe entities (&lt;script&gt;)
  [PASS] [AC7.2] sanitizeCsvCell prefixes formula cells (=HYPERLINK...) with single quote (') and escapes inner quotes per RFC 4180
  [PASS] [AC7.3] All formula command execution triggers (=, +, -, @, \t, \r) are neutralized with single quote prefix
  [PASS] [AC7.4] formatCsvRow builds RFC 4180 row with uniform formula injection protection
  [PASS] [AC7.5] Report.jsx executeCSVExport source audit confirms formula injection protection ([=+-@\t\r])

--- Category 8: AI Tracer & Unknown Usage Accounting + Reconciliation ---
  [PASS] [AC8.1] Authoritative AI trace record contains provider, model, tenantId, sessionId, operation, usage, cost, and retryCount
  [PASS] [AC8.2] Missing provider usage is explicitly recorded as 'unknown' (NEVER 0!) for WebRTC / audio operations
  [PASS] [AC8.3] reconcileAiCharges aggregates known token costs, tallies unknown operations, and confirms reconciled status
  [PASS] [AC8.4] reconcileAiCharges flags variance_detected when traced spend deviates from provider invoice

================================================================================
   EXECUTION SUMMARY: 30 PASSED | 0 FAILED | 30 TOTAL
================================================================================
Evidence report saved to: evaluations/cd05_public_controls_evidence.json
```

---

## 6. Regression Testing Sweep

Across all prior milestones, zero regressions were introduced:
- **CD01 Baseline Audit (`npm run audit:cd01`):** All 41 baseline files verified; zero telephony violations; policy hashes verified.
- **CD02 Privileged Access Suite (`npm run test:cd02`):** 8/8 test suites passing.
- **CD03 Tenant Isolation Suite (`npm run test:cd03`):** 32/32 assertions passing.
- **CD04 OAuth Account Linking (`npm run test:cd04`):** 25/25 assertions passing.
- **Next.js Production Build (`npm run build`):** Clean compile with zero build errors or broken dependencies.

---

## 7. Modified & Created Files

1. **`src/lib/publicEndpointGuard.js`** (Created): Core public perimeter guard providing request method validation, body size caps, JSON structure checks, concurrency slot reservation, in-flight budget reservation with burst allowance, and lead deduplication.
2. **`src/lib/sanitizer.js`** (Modified): Added `escapeHtml`, `sanitizeEmailHeader`, `stripCrlf`, `sanitizeCsvCell`, `formatCsvRow`, and `sanitizeUntrustedTelemetry`.
3. **`src/lib/aiTracer.js`** (Modified): Added `recordAuthoritativeAiTrace`, cost estimation, explicit `"unknown"` usage handling, and `reconcileAiCharges`.
4. **`src/lib/retryTracer.js`** (Modified): Added 2-attempt retry cap, pre-retry budget check, and `retryCount` tracking.
5. **`src/Closedesk/Dashboard/Report.jsx`** (Modified): Hardened `executeCSVExport` with formula injection prevention (`=`, `+`, `-`, `@`, `\t`, `\r`) and RFC 4180 double-quoting.
6. **`src/pages/api/chat.js`** (Modified): Hardened with 32KB body cap, concurrency guard, budget reservation, and AI tracing.
7. **`src/pages/api/analyze-image.js`** (Modified): Hardened with 4MB body cap, image URI validation, concurrency guard, and budget reservation.
8. **`src/pages/api/openai-token.js`** (Modified): Hardened with 16KB body cap, concurrency guard, budget reservation, and `"unknown"` usage tracing.
9. **`src/pages/api/tts.js`** (Modified): Hardened with 16KB body cap, 4096 text limit, concurrency guard, budget reservation, and `"unknown"` usage tracing.
10. **`src/pages/api/leads.js`** (Modified): Hardened with 32KB body cap, SHA-256 deduplication, session rate limiting, and arbitrary recipient stripping.
11. **`src/pages/api/generate-email.js`** (Modified): Hardened with 16KB body cap, recipient stripping, and CRLF sanitization.
12. **`src/pages/api/cookie-consent.js`** (Modified): Hardened with 16KB body cap, `safeDbSet`, and untrusted telemetry sanitization.
13. **`src/pages/api/analytics.js`** (Modified): Hardened with 16KB body cap and untrusted telemetry sanitization.
14. **`src/pages/api/app-state.js`** (Modified): Hardened with 16KB body cap, `safeDbSet`, and untrusted telemetry sanitization.
15. **`src/pages/api/sync-voice.js`** (Modified): Hardened with 32KB body cap and untrusted telemetry sanitization.
16. **`functions/index.js`** (Modified): Added CRLF sanitization to email subjects.
17. **`package.json`** (Modified): Added `"test:cd05": "node scripts/cd05_public_controls_and_budgets_suite.js"`.
18. **`scripts/cd05_public_controls_and_budgets_suite.js`** (Created): 30-assertion deterministic acceptance suite.
19. **`evaluations/cd05_public_controls_evidence.json`** (Created): Machine-readable verification evidence.
