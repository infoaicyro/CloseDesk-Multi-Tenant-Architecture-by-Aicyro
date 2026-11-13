# CD02: Privileged Access and Sessions Architecture & Implementation Report

**Document Status:** Complete & Verified  
**Ticket Reference:** P0 Ticket CD02 (Privileged Access and Sessions)  
**Repository:** `Testing-closedesk-Multi-Tenant-Architecture`  
**Target Environment:** Netlify Serverless Functions & Firebase Realtime Database  
**Author:** Principal Backend Security Engineer  
**Date:** November 2026  

---

## 1. Executive Summary

This engineering report documents the comprehensive security hardening executed under **P0 Ticket CD02: Privileged Access and Sessions**.

Prior to this ticket, the application exhibited several critical security gaps:
1. **Unauthenticated Database Bypass:** Firebase Realtime Database rules (`database.rules.json`) contained root `.read: true` and `.write: true`, allowing any anonymous client with the database URL to read and overwrite `superAdmin`, `login`, and `tenants` trees directly.
2. **Plaintext Credential Storage:** Super Admin passwords, PINs, and tenant user credentials were saved in plaintext and verified using naive string comparisons (`===`), exposing passwords to memory inspection and timing side-channel attacks.
3. **Stateless / Missing Server-Side Sessions:** Super Admin and operator logins returned no signed tokens or HttpOnly cookies. Frontend access was gated exclusively by browser `localStorage` flags (`currentSuperAdmin`, `currentUser`), easily forged via DevTools.
4. **Lack of Step-Up Authorization:** The platform lacked server-side role-based access control (RBAC) and step-up verification. Frontend components executed destructive mutations (tenant creation, user password updates, email protocol reconfiguration) directly from the client.
5. **Cold-Start Vulnerable Rate Limiting:** Rate limiting on the Secondary PIN verification route relied entirely on an in-memory `Map`, which reset upon every serverless cold start or across concurrent Netlify function replicas.

Under CD02, these vulnerabilities have been remediated through a production-grade, zero-external-npm-dependency security architecture leveraging Node.js native cryptographic primitives (`crypto.scryptSync`, `crypto.timingSafeEqual`, `crypto.createHmac`), server-side RBAC, signed HttpOnly sessions, persistent rate limiting, and locked-down Realtime Database rules.

---

## 2. Threat Model & Vulnerabilities Remediated

| Vulnerability ID | Description | Pre-Patch State | Remediated State |
| :--- | :--- | :--- | :--- |
| **VULN-CD02-01** | Direct RTDB Client Mutation Bypass | `database.rules.json` had `.read: true, .write: true` at root. Client SDK called `set(ref(db, "tenants/" + id), ...)` directly. | Root `.read`/`.write` removed. Super Admin, login, and tenant configuration nodes locked to server-side or authenticated Super Admin tokens only. |
| **VULN-CD02-02** | Plaintext Password Storage | Plaintext passwords stored in RTDB and compared with `===`. | Salted scrypt hashing (`scrypt:<salt>:<hash>`) with timing-safe comparison (`crypto.timingSafeEqual`). Auto-upgrades legacy plaintext passwords upon login. |
| **VULN-CD02-03** | In-Memory Rate Limiting on Cold Starts | `pinAttemptsMap = new Map()` in `verify-pin.js` reset on function cold starts / replicas. | Replica-safe persistent rate limiter backed by Firebase RTDB (`system_security/rate_limits/*`) with resilient local fallback. |
| **VULN-CD02-04** | Missing Server-Side Session & Identity Gating | Client stored identity in `localStorage` without cryptographically signed session tokens or HttpOnly cookies. | Cryptographically signed HMAC-SHA256 session tokens with claims (`sub`, `role`, `tenantId`, `stepUpVerified`, `sessionVersion`, `iat`, `exp`) delivered via `HttpOnly`, `SameSite=Strict` cookies. |
| **VULN-CD02-05** | Missing Step-Up Authorization on Privileged Routes | Password-authenticated Super Admin sessions had immediate access to mutate platform settings without second factor verification. | `stepUpVerified: false` tokens strictly rejected (403 Forbidden) on all platform mutation routes until secondary factor (TOTP / Secondary PIN) succeeds. |
| **VULN-CD02-06** | Lack of Session Revocation on Logout / Password Rotation | Logging out only cleared `localStorage`. No server-side session invalidation or credential rotation mechanism existed. | Dedicated logout routes (`/api/superadmin/logout`, `/api/logout`) and password change route (`/api/user/password`) increment `sessionVersion` and record `revokedBefore` timestamps, immediately invalidating older tokens. |
| **VULN-CD02-07** | Cross-Site Request Forgery (CSRF) Exposure | State-changing API routes lacked Origin/Referer verification or anti-forgery headers. | Strict CSRF guard validating Origin/Referer against host and enforcing custom anti-forgery headers (`x-requested-with`, `x-cd-session`). |
| **VULN-CD02-08** | Misleading Static Factor Labelling | Potential confusion between static 4-digit PINs and multi-factor authentication (MFA). | Audited zero "2FA"/"MFA" labels on static PINs; labelled explicitly as "Secondary PIN Verification", alongside RFC 6238 TOTP independent factor support. |

---

## 3. Architecture & Cryptographic Specifications

```
                              ┌─────────────────────────────────────────┐
                              │          Client Browser / UI            │
                              └────────────────────┬────────────────────┘
                                                   │
                  1. POST /api/superadmin/login    │  2. Returns cd_session cookie
                     (username, password)          │     with stepUpVerified: false
                                                   ▼
                              ┌─────────────────────────────────────────┐
                              │     Step-Up Gate (verify-pin.js)        │
                              │     - RFC 6238 TOTP (6 digits)          │
                              │     - Emergency Recovery Code (8 chars) │
                              │     - Secondary PIN Fallback (4 digits) │
                              └────────────────────┬────────────────────┘
                                                   │
                  3. POST /api/superadmin/verify-pin│ 4. Returns upgraded cd_session
                     (code / PIN)                  │    with stepUpVerified: true
                                                   ▼
                              ┌─────────────────────────────────────────┐
                              │       Protected Platform Mutation       │
                              │  - /api/superadmin/tenants              │
                              │  - /api/superadmin/settings             │
                              │  - /api/user/password                   │
                              └────────────────────┬────────────────────┘
                                                   │
                  Server-side read/write via Node  │ Rejects direct client writes
                                                   ▼
                              ┌─────────────────────────────────────────┐
                              │       Firebase Realtime Database        │
                              │       (database.rules.json Locked)      │
                              └─────────────────────────────────────────┘
```

### 3.1 Session Token Format & Claims
Session tokens are generated using standard HMAC-SHA256 signatures with compact three-segment encoding:
`<header_base64url>.<payload_base64url>.<signature_base64url>`

#### Token Header
```json
{
  "alg": "HS256",
  "typ": "JWT"
}
```

#### Token Claims (Payload)
- `sub`: Subject identifier (username, e.g. `"admin"` or operator name).
- `role`: Role of the subject (`"superadmin"` or `"tenant_operator"`).
- `tenantId`: Scoped tenant identifier (`"superadmin"`, `"default"`, or specific tenant ID).
- `stepUpVerified`: Boolean indicating whether secondary factor verification has occurred (`true` or `false`).
- `sessionVersion`: Monotonically increasing version counter. Bumping this version invalidates all older tokens issued prior to credential rotation.
- `iat`: Unix timestamp (in seconds) of token issuance.
- `exp`: Unix timestamp (in seconds) of expiration (15 minutes for pre-step-up tokens; 24 hours for verified tokens).

### 3.2 Salted Scrypt Hashing Algorithm
All passwords and PINs are protected using Node's native `crypto.scryptSync`:
- **Salt:** 16 cryptographically random bytes generated via `crypto.randomBytes(16).toString("hex")`.
- **Key Length:** 64 bytes (512 bits) derived key.
- **Cost Parameters:** $N=16384$, $r=8$, $p=1$, `maxmem` = 32 MB.
- **Storage Format:** `scrypt:<saltHex>:<derivedKeyHex>` (e.g. `scrypt:a1b2...32chars:c3d4...128chars`).
- **Timing Safety:** Derived hashes are compared against stored hashes using `crypto.timingSafeEqual` over fixed-length buffers.

### 3.3 Independent Second Factor: RFC 6238 TOTP
- **Implementation:** Standard Time-Based One-Time Password algorithm implemented natively in `src/lib/totp.js` with zero npm dependencies.
- **Base32 Decoder:** Native RFC 4648 Base32 implementation.
- **Time Step:** 30 seconds ($T_0=0$).
- **HMAC Hash Function:** HMAC-SHA1 on 8-byte big-endian timestep counter.
- **Drift Tolerance:** Validates candidate tokens at timesteps $T-1$, $T$, and $T+1$ (allowing $\pm 30$ seconds clock drift).
- **Emergency Recovery Codes:** 8-character single-use recovery codes hashed with SHA-256 for emergency platform recovery.

### 3.4 Persistent Rate Limiter
- **Storage:** Realtime Database at `system_security/rate_limits/{sanitizedKey}`.
- **Key Derivation:** `action_${clientIp}_${username}`.
- **Thresholds:**
  - Login attempts: 5 failed attempts per 15 minutes.
  - Secondary PIN / TOTP attempts: 5 failed attempts per 15 minutes.
- **Lockout Duration:** 15 minutes ($900,000\text{ ms}$).
- **Fault-Tolerance:** Uses `safeDbGet` / `safeDbSet` with 600ms timeouts and seamless memory fallback to ensure uninterrupted operation even when Firebase RTDB is temporarily unreachable.

---

## 4. Modified & Created Files Summary

### 4.1 Backend Libraries & Utilities
- `src/lib/authCrypto.js`: Salted scrypt password hashing, timing-safe string comparison, and legacy plaintext migration helper.
- `src/lib/authSession.js`: HMAC-SHA256 session token generation, verification, cookie serialization, session revocation checks, CSRF validation, and `withSessionGuard` higher-order middleware.
- `src/lib/totp.js`: RFC 6238 TOTP engine, Base32 encoder/decoder, drift tolerance validator, and emergency recovery code hasher.
- `src/lib/persistentRateLimiter.js`: Firebase-backed persistent rate limiter surviving serverless cold starts.
- `src/lib/safeDb.js`: Resilient timeout-wrapped Firebase RTDB operations (`safeDbGet`, `safeDbSet`, `safeDbUpdate`, `safeDbRemove`).

### 4.2 API Routes
- `src/pages/api/superadmin/login.js`: Hardened Super Admin login with scrypt verification, persistent rate limiting, audit logging, and issuance of pre-step-up session (`stepUpVerified: false`).
- `src/pages/api/superadmin/verify-pin.js`: Secondary factor verification supporting RFC 6238 TOTP, emergency recovery codes, and secondary PIN. Upgrades session to `stepUpVerified: true`.
- `src/pages/api/superadmin/logout.js`: Explicit Super Admin session revocation and cookie clearing.
- `src/pages/api/login.js`: Hardened tenant operator login with scrypt verification, persistent rate limiting, and signed tenant operator session issuance.
- `src/pages/api/logout.js`: Explicit tenant operator session revocation and cookie clearing.
- `src/pages/api/superadmin/tenants.js`: Protected server-side route for tenant listing, creation, modification, and deletion. Strictly requires `role: "superadmin"` AND `stepUpVerified: true`.
- `src/pages/api/superadmin/settings.js`: Protected server-side route for platform settings (email protocol, appearance). Strictly requires `role: "superadmin"` AND `stepUpVerified: true`.
- `src/pages/api/user/password.js`: Protected server-side password rotation endpoint with current password verification, scrypt hashing, and automatic session version incrementation.

### 4.3 Database Security Rules
- `database.rules.json`: Removed root `.read: true, .write: true`. Locked down `superAdmin`, `login`, `settings`, `tenants`, and `system_security` nodes to authenticated Super Admin or server SDK writes only.

### 4.4 Frontend Components Updated
- `src/Closedesk/Dashboard/superadmin/ClientManagement.jsx`: Updated to invoke `/api/superadmin/tenants` for tenant creation, user updates, and profile edits. Integrated session headers, cookies, and Secondary PIN Verification labelling.
- `src/Closedesk/Dashboard/superadmin/Settings/SuperAdminEmailProtocol.jsx`: Updated to invoke `/api/superadmin/settings` instead of direct Firebase client writes.
- `src/Closedesk/Dashboard/Settings/PasswordChange.jsx`: Updated to call `/api/user/password` with session rotation.
- `src/Closedesk/Dashboard/superadmin/superadminlogin.jsx`: Updated to include credentials and store session token.
- `src/Closedesk/Dashboard/LoginScreen.jsx`: Updated to include credentials and store session token.
- `src/pages/lg.jsx`: Updated logout handler to notify `/api/superadmin/logout` or `/api/logout`.

---

## 5. Verification & Acceptance Evidence

All 8 acceptance criteria defined in ticket CD02 are deterministically verified by the test suite `scripts/cd02_security_acceptance_suite.js` (`npm run test:cd02`):

| Test ID | Acceptance Criterion | Verified Result | Exit Code |
| :--- | :--- | :--- | :---: |
| **AC1.1** | `GET /api/superadmin/tenants` without session | **401 Unauthorized** | PASS |
| **AC1.2** | `GET /api/superadmin/settings` without session | **401 Unauthorized** | PASS |
| **AC2.1** | Request with expired session token | **401 Unauthorized** | PASS |
| **AC2.2** | Request with revoked session token | **401 Unauthorized** | PASS |
| **AC3.1** | Tenant Operator accessing `/api/superadmin/tenants` | **403 Forbidden** | PASS |
| **AC3.2** | Tenant Operator accessing `/api/superadmin/settings` | **403 Forbidden** | PASS |
| **AC4.1** | Pre-step-up Super Admin (`stepUpVerified: false`) accessing tenants API | **403 Forbidden** (`stepUpRequired: true`) | PASS |
| **AC4.2** | Verified Super Admin (`stepUpVerified: true`) accessing tenants API | **200 OK** | PASS |
| **AC5.1** | Salted scrypt hashing format (`scrypt:<salt>:<hash>`) | **PASS** (16-byte salt, 64-byte key) | PASS |
| **AC5.2** | Timing-safe verification of correct and incorrect passwords | **PASS** (`match: true` / `match: false`) | PASS |
| **AC5.3** | Legacy plaintext verification and auto-upgrade flagging | **PASS** (`needsUpgrade: true`) | PASS |
| **AC5.4** | Length-leak immune `timingSafeStringEqual` comparison | **PASS** | PASS |
| **AC6.1** | Cookie security flags (`HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure`) | **PASS** | PASS |
| **AC6.2** | Session termination cookie header (`Max-Age=0`, epoch expires) | **PASS** | PASS |
| **AC6.3** | CSRF rejection on state-changing request from unauthorized foreign origin | **PASS** (`valid: false`) | PASS |
| **AC6.4** | CSRF acceptance on request with anti-forgery custom header | **PASS** (`valid: true`) | PASS |
| **AC7.1** | 5th failed attempt triggers 15-minute sliding lockout | **PASS** (`allowed: false`, `retryAfter > 0`) | PASS |
| **AC7.2** | Rate limit persistence across simulated serverless cold starts | **PASS** (Client remains locked) | PASS |
| **AC7.3** | Lockout release upon successful authentication reset | **PASS** (`remainingAttempts: 5`) | PASS |
| **AC8.1** | RFC 6238 6-digit TOTP code generation & validation | **PASS** | PASS |
| **AC8.2** | TOTP drift tolerance ($\pm 1$ timestep) and out-of-window rejection | **PASS** | PASS |
| **AC8.3** | Emergency recovery code verification against hashed store | **PASS** (Case/hyphen insensitive) | PASS |
| **AC8.4** | Zero misleading "2FA" or "MFA" labels applied to static PINs | **PASS** (0 violations) | PASS |

Evidence output has been recorded to `evaluations/cd02_security_evidence.json`.  
Baseline compliance was verified by running `npm run audit:cd01` (Exit Code 0).
