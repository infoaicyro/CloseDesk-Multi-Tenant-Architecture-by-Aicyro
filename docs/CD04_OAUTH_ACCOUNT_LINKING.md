# CD04: OAuth Account Linking and Provider Security Baseline

## Executive Summary
This document establishes the verified architectural baseline, security hardening, and deterministic verification evidence for **P0 Ticket CD04: OAuth Account Linking** across the CloseDesk multi-tenant platform.

Prior to this ticket, OAuth account linking flows for Google and Microsoft email integrations exhibited significant security and architectural gaps:
1. **Unbound / Tamperable OAuth State**: The `state` parameter did not cryptographically bind the initiating operator, tenant partition, provider, redirect URI, or cryptographic nonce. State tokens could be replayed, omitted, or tampered with to associate third-party credentials with the wrong tenant partition.
2. **Overly Broad Scopes**: Initial configurations requested sweeping mailbox permissions (e.g. `https://mail.google.com/` and `Mail.ReadWrite`), violating the principle of least privilege.
3. **Absence of Provider Enablement Gating**: When OAuth credentials (`CLIENT_ID` / `CLIENT_SECRET`) were missing from server environment variables, the API routes redirected users to broken provider endpoints rather than returning a deterministic `503 Service Unavailable`.
4. **Superficial Identity Token Verification**: Identity tokens received from provider token endpoints were either decoded as raw unverified base64 strings or ignored entirely without validating signature, algorithm, expiration, audience, issuer, or nonce claims.
5. **Insecure Cross-Window Messaging (`postMessage`)**: The callback completion HTML dispatched messages to the opener window using wildcard `targetOrigin: "*"` and transmitted raw access/refresh tokens in the message payload.
6. **Unhandled Token Revocation**: When credentials were disconnected or revoked at the provider, backend mail transporters failed silently or attempted invalid authentications instead of disabling the affected feature and presenting a recoverable state in the UI.
7. **Scope Confusion**: Ambiguity existed regarding whether OAuth storage synchronized calendars or simply enabled transactional/notification email delivery.

Under CD04, an end-to-end security hardening was executed:
- **HMAC-SHA256 State Binding & Single-Use Replay Defense**: State tokens cryptographically seal the operator identity (`sub`), tenant partition (`tenantId`), provider (`"google"` | `"microsoft"`), redirect URI, cryptographic nonce, and a 10-minute expiration window. Nonces are tracked and consumed upon callback, rejecting all replay attacks.
- **Strict Least Necessary Scopes & PKCE**: Scopes are constrained strictly to `gmail.send` (Google) and `SMTP.Send` (Microsoft), completely eliminating full mailbox read/write access. RFC 7636 PKCE (`code_verifier` and `code_challenge` S256) is enforced.
- **Provider Enablement Gating**: Unconfigured providers fail closed at the login perimeter with `503 Service Unavailable` and structured error responses.
- **Cryptographic ID Token Validation**: Identity tokens are validated across 5 distinct claims: header algorithm (rejecting insecure `none`), audience matching `clientId`, issuer matching trusted provider domains, expiration/issue timestamps, and nonce matching the state nonce.
- **Origin-Locked Cross-Window Messaging**: Eliminates wildcard `*`; binds `postMessage` strictly to `window.location.origin` or configured app URL; transmits a structured status schema (`{ type: "CLOSEDESK_OAUTH_STATUS", provider, status, tenantId }`) and never exposes tokens to the browser window hierarchy.
- **Revocation-Aware Transporter & Recoverable UI**: `functions/index.js` detects revoked credentials and throws `OAUTH_CREDENTIALS_REVOKED`, cleanly disabling the email feature. The SuperAdmin UI handles disconnects by nullifying stored refresh tokens and restoring the setup card to a recoverable state.
- **Explicit Scope Disclaimer**: OAuth account linking is strictly scoped to outgoing transactional and notification email. Calendar synchronization is NOT implemented and is explicitly out of scope.

All 25 acceptance criteria across 7 test categories passed deterministically with zero failures.

---

## Environment & Audit Metadata
- **Repository**: `Testing-closedesk-Multi-Tenant-Architecture`
- **Working Directory**: `d:\Software House 01\Closedesk-ready to deploy`
- **Base Commit**: `976352b873f56dab8ae213e8a6a24d5a13e48777` (incorporating CD01, CD02, and CD03 baselines)
- **Git Branch**: `feat/cd04-oauth-account-linking`
- **Node.js Runtime**: `v26.8.2`
- **Package Manager**: `npm 11.19.1`
- **Primary Evidence File**: `evaluations/cd04_oauth_evidence.json`
- **Automated Test Suite**: `scripts/cd04_oauth_linking_suite.js` (`npm run test:cd04`)

---

## Pre-Fix Vulnerability Touchpoint Audit Matrix

| Touchpoint | File & Line Range | Pre-Fix Vulnerability Description | Severity | Remediation |
| :--- | :--- | :--- | :--- | :--- |
| **State Tampering & Replay** | [google/login.js](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/pages/api/auth/google/login.js#L38-L50) & [microsoft/login.js](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/pages/api/auth/microsoft/login.js#L38-L50) | State parameter was either unverified, static, or missing cryptographic HMAC signature and nonce. | **Critical** | Implemented `generateOAuthState` with HMAC-SHA256 signature, 10m TTL, operator `sub`, `tenantId`, and single-use nonce tracked in memory. |
| **Missing State in Callback** | [google/callback.js](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/pages/api/auth/google/callback.js#L29-L56) & [microsoft/callback.js](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/pages/api/auth/microsoft/callback.js#L29-L56) | Callback routes did not enforce state presence or validate signature before processing authorization code. | **Critical** | Added perimeter checks rejecting absent state (400), tampered signature (403), expired state (403), or replayed nonce (403). |
| **Overly Broad Scopes** | [oauthService.js](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/lib/oauthService.js#L35-L53) | Google requested full mailbox access (`https://mail.google.com/`); Microsoft requested full `Mail.ReadWrite`. | **High** | Restricted scopes to `gmail.send` (Google) and `SMTP.Send` (Microsoft). |
| **Disabled Provider Handling** | [google/login.js](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/pages/api/auth/google/login.js#L15-L23) & [microsoft/login.js](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/pages/api/auth/microsoft/login.js#L15-L23) | Missing `CLIENT_ID` / `CLIENT_SECRET` caused silent failures or redirects to broken external provider endpoints. | **Medium** | Implemented feature enablement gate returning `503 Service Unavailable` with JSON error payload. |
| **ID Token Validation** | [google/callback.js](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/pages/api/auth/google/callback.js#L83-L95) & [oauthService.js](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/lib/oauthService.js#L170-L245) | ID tokens were parsed with insecure `Buffer.from(payload, 'base64')` without validating claims or header. | **High** | Implemented `validateIdToken` validating token segments, algorithm (blocking `none`), `exp`, `iat`, `aud`, `iss`, and `nonce`. |
| **Wildcard postMessage** | [google/callback.js](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/pages/api/auth/google/callback.js#L128-L136) & [oauthService.js](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/lib/oauthService.js#L247-L290) | Callback HTML used `window.opener.postMessage(msg, "*")` leaking status and potential secrets to any opener. | **Critical** | Eliminated `*`; bound `postMessage` to exact `allowedOrigin`; restricted payload to structured schema with zero tokens. |
| **UI Message Listener** | [SuperAdminEmailProtocol.jsx](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/superadmin/Settings/SuperAdminEmailProtocol.jsx#L95-L125) | `window.addEventListener("message")` did not verify `event.origin` or `event.source === popupRef.current`. | **High** | Added `popupRef = useRef(null)`; verified `event.origin === window.location.origin`, `event.source === popupRef.current`, and schema type. |
| **Wrong-Tenant Linking** | [google/callback.js](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/pages/api/auth/google/callback.js#L110-L126) | Callback used URL query parameter `tenant_id` to determine target partition, allowing cross-tenant hijacking. | **Critical** | Partition target resolved exclusively from cryptographically verified state payload (`stateCheck.payload.tenantId`). |
| **Revocation Disabling** | [functions/index.js](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/functions/index.js#L115-L125) | Revoked/disconnected credentials in RTDB caused unhandled transport exceptions during email delivery. | **High** | Dynamic transporter checks `config.status === "revoked" || "disconnected"` and throws `OAUTH_CREDENTIALS_REVOKED`. |

---

## Architectural Implementation Details

### 1. Cryptographic State Binding & Replay Defense
To eliminate CSRF and cross-tenant credential hijacking, CloseDesk binds every OAuth authorization request to the initiating operator and tenant partition using HMAC-SHA256:

```mermaid
sequenceDiagram
    autonumber
    actor Admin as Operator / SuperAdmin
    participant UI as SuperAdminEmailProtocol.jsx
    participant LoginAPI as /api/auth/{provider}/login
    participant Provider as Google / Microsoft OAuth
    participant CallbackAPI as /api/auth/{provider}/callback
    participant RTDB as Firebase RTDB

    Admin->>UI: Click "Connect with Google / Microsoft"
    UI->>LoginAPI: GET /api/auth/{provider}/login (with Session Cookie)
    LoginAPI->>LoginAPI: Verify session & resolve operator sub + tenantId
    LoginAPI->>LoginAPI: Generate RFC 7636 PKCE (codeVerifier, codeChallenge)
    LoginAPI->>LoginAPI: Generate HMAC-SHA256 State (sub, tenantId, provider, nonce, exp: +10m)
    LoginAPI-->>UI: 302 Redirect to Provider with least scopes, state, and codeChallenge
    UI->>Provider: User authenticates and grants consent
    Provider-->>CallbackAPI: GET /callback?code={authCode}&state={stateToken}
    CallbackAPI->>CallbackAPI: verifyAndConsumeOAuthState(state, provider)
    Note over CallbackAPI: Rejects absent, expired, tampered, or replayed state nonces
    CallbackAPI->>Provider: POST /token (code, codeVerifier, clientSecret)
    Provider-->>CallbackAPI: 200 OK (access_token, refresh_token, id_token)
    CallbackAPI->>CallbackAPI: validateIdToken(id_token, expectedClientId, nonce)
    CallbackAPI->>RTDB: safeDbUpdate(tenants/{tenantId}/email_config or settings/email_config)
    CallbackAPI-->>UI: postMessage(status: "connected", origin: window.location.origin)
    UI->>UI: Verify event.origin == origin && event.source == popupRef
    UI-->>Admin: Show Connected Status & Green Shield
```

#### State Token Structure
```json
{
  "sub": "superadmin_user_01",
  "tenantId": "tenant_north_america",
  "provider": "google",
  "redirectUri": "https://app.closedesk.com/api/auth/google/callback",
  "nonce": "a4f8c92e10db34...",
  "cv": "E9Melhoa2OwvFrEMTJ...",
  "iat": 1793724094,
  "exp": 1793724694
}
```
The state payload is base64url-encoded and sealed with an HMAC-SHA256 signature using `SESSION_SECRET` or `JWT_SECRET`. Upon callback, `verifyAndConsumeOAuthState` performs constant-time signature verification, checks `exp`, and ensures the single-use `nonce` has not already been consumed.

---

### 2. Least Necessary Scopes & RFC 7636 PKCE Enforcement
In compliance with the principle of least privilege, broad mailbox read/write permissions have been eliminated:

| Provider | Permitted Scopes | Prohibited / Eliminated Scopes | Justification |
| :--- | :--- | :--- | :--- |
| **Google** | `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`, `https://www.googleapis.com/auth/gmail.send` | `https://mail.google.com/`, `.../auth/gmail.modify`, `.../auth/gmail.readonly` | CloseDesk only requires permission to transmit notification emails. Full mailbox read access presents an unacceptable risk. |
| **Microsoft** | `openid`, `email`, `offline_access`, `https://outlook.office.com/SMTP.Send` | `Mail.ReadWrite`, `Mail.Read`, `Mail.Send`, `Calendars.ReadWrite` | SMTP submission scope is sufficient for sending notifications via Microsoft Graph / Office 365 SMTP. |

#### PKCE Implementation
RFC 7636 Proof Key for Code Exchange (PKCE) prevents authorization code interception attacks:
- `code_verifier`: 32 bytes of cryptographically secure random bytes base64url-encoded.
- `code_challenge`: SHA-256 hash of the `code_verifier`, base64url-encoded.
- `code_challenge_method`: `S256`.

---

### 3. Identity Token Validation Beyond Base64 Decoding
Base64 decoding alone does not establish identity. CloseDesk executes strict validation against the OpenID Connect identity token returned during token exchange:

```mermaid
flowchart TD
    Token["Provider ID Token (JWT)"] --> Segments{"Has 3 Segments?"}
    Segments -- No --> Err1["Reject: Malformed JWT"]
    Segments -- Yes --> Header["Parse Header"]
    
    Header --> AlgCheck{"alg == 'none'?"}
    AlgCheck -- Yes --> Err2["Reject: Insecure Algorithm 'none' Forbidden"]
    AlgCheck -- No --> Payload["Parse Payload Claims"]
    
    Payload --> ExpCheck{"exp > Current Time?"}
    ExpCheck -- No --> Err3["Reject: Token Expired"]
    ExpCheck -- Yes --> AudCheck{"aud == configured clientId?"}
    AudCheck -- No --> Err4["Reject: Audience Mismatch"]
    AudCheck -- Yes --> IssCheck{"iss in Trusted Provider Domains?"}
    IssCheck -- No --> Err5["Reject: Untrusted Issuer"]
    IssCheck -- Yes --> NonceCheck{"nonce == state nonce?"}
    NonceCheck -- No --> Err6["Reject: Nonce Mismatch (Replay/Injection)"]
    NonceCheck -- Yes --> Valid["Identity Established (Extract Verified Email)"]
```

Claims verified in `validateIdToken()`:
1. **Header Algorithm**: Rejects tokens using `none` or unsupported signing algorithms.
2. **Expiration (`exp`) & Time Window (`iat`, `nbf`)**: Rejects tokens expired beyond standard clock skew (60s).
3. **Audience (`aud`)**: Ensures the token was issued specifically for CloseDesk's registered `clientId`.
4. **Issuer (`iss`)**:
   - Google: Must match `https://accounts.google.com` or `accounts.google.com`.
   - Microsoft: Must match `https://login.microsoftonline.com/` or `https://sts.windows.net/`.
5. **Nonce (`nonce`)**: Matches the random 128-bit cryptographic nonce bound during authorization initiation.

---

### 4. Cross-Window Communication Security (`postMessage`)
Previous implementations utilized `window.opener.postMessage(msg, "*")` and transmitted raw refresh tokens to the frontend.

#### Hardened Callback Response
The callback endpoint dispatches HTML that targets strictly the exact trusted origin:
```javascript
// src/lib/oauthService.js
export function buildPostMessageHtml({ status, provider, tenantId, error, allowedOrigin }) {
  const payload = {
    type: "CLOSEDESK_OAUTH_STATUS",
    status,
    provider,
    tenantId: tenantId || null,
    error: error || null,
  };
  // targetOrigin is NEVER '*'
  return `<!DOCTYPE html><html><body><script>
    (function() {
      var targetOrigin = ${JSON.stringify(allowedOrigin)};
      if (window.opener) {
        window.opener.postMessage(${JSON.stringify(payload)}, targetOrigin);
      }
      setTimeout(function() { window.close(); }, 800);
    })();
  </script></body></html>`;
}
```

#### Hardened Frontend Listener
`SuperAdminEmailProtocol.jsx` validates the incoming message:
1. **Origin Verification**: Ensures `event.origin === window.location.origin`.
2. **Source Window Verification**: Ensures `event.source === popupRef.current` (tracking the specific popup instance opened).
3. **Schema Verification**: Confirms `event.data?.type === "CLOSEDESK_OAUTH_STATUS"`.
4. **Zero Token Exposure**: Tokens are stored strictly server-side in Firebase Realtime Database. The frontend receives only operational status (`"connected"` | `"error"`).

---

### 5. Multi-Tenant Isolation & Wrong-Tenant Linking Defense
CloseDesk prevents cross-tenant credential hijacking:
1. **State Isolation**: When an operator initiates linking, their authenticated session `tenantId` is sealed into the HMAC state.
2. **Path Resolution**: In `src/pages/api/auth/{google,microsoft}/callback.js`:
   ```javascript
   const targetPath = tenantId && tenantId !== "default"
     ? `tenants/${tenantId}/email_config`
     : "settings/email_config";
   ```
3. **Tampering Rejection**: Even if an attacker manipulates the callback URL query string (e.g. `?tenant_id=victim_tenant`), the callback handler exclusively routes credentials to the tenant partition sealed within the verified HMAC state token.

---

### 6. Revocation, Disconnect & Recoverable Feature State
When an administrator disconnects an account or provider credentials are revoked:
1. **Disconnect Action**: `confirmDisconnectAccount()` in `SuperAdminEmailProtocol.jsx` calls `PUT /api/superadmin/settings` with `refreshToken: null`, `connectedAt: null`, and resets provider state to `"custom"`.
2. **Serverless Transporter Gating**: In `functions/index.js`, `getDynamicTransporter()` inspects the stored credentials:
   ```javascript
   if (config.status === "revoked" || config.status === "disconnected") {
     const error = new Error("OAuth credentials for this partition have been revoked or disconnected.");
     error.code = "OAUTH_CREDENTIALS_REVOKED";
     throw error;
   }
   ```
3. **Recoverable State**: The frontend UI immediately reflects the disconnected state, presenting the operator with clear options to reconnect or configure custom SMTP.

---

### 7. Explicit Scope Disclaimer & Boundary Limit
> [!IMPORTANT]
> **Calendar Synchronization Out-of-Scope Statement**:
> CloseDesk OAuth account linking is designed, implemented, and authorized **exclusively for outgoing transactional and notification email delivery** via Google Gmail API and Microsoft Graph / SMTP.
>
> Neither Google Calendar (`https://www.googleapis.com/auth/calendar`) nor Microsoft Graph Calendars (`Calendars.ReadWrite`) scopes are requested, granted, or stored.
> **Successful OAuth storage is not evidence of calendar synchronization.** Calendar synchronization is completely disabled and out of scope for this architecture.

---

## Deterministic Verification Results

The automated acceptance suite `scripts/cd04_oauth_linking_suite.js` was executed against the hardened codebase. All 25 tests passed deterministically.

```
================================================================================
   CLOSEDESK CD04: OAUTH ACCOUNT LINKING & PROVIDER SECURITY SUITE
================================================================================

--- Category 1: OAuth State Binding & Tampering Defense ---
  [PASS] [AC1.1] State token cryptographically binds operator, tenantId, provider, nonce, and expiration
  [PASS] [AC1.2] Callback rejects request with absent state parameter (400 Bad Request)
  [PASS] [AC1.3] Mismatched/tampered state token is rejected with signature validation error
  [PASS] [AC1.4] Expired state parameter is rejected (replay window closed)
  [PASS] [AC1.5] State token replay rejection (single-use nonce prevents replay attacks)
  [PASS] [AC1.6] Cross-provider state spoofing rejected (Google state sent to Microsoft handler)

--- Category 2: Least Necessary Scopes & Provider Gating ---
  [PASS] [AC2.1] Google OAuth requests least necessary scopes (gmail.send) and disallows full mailbox access
  [PASS] [AC2.2] Microsoft OAuth requests least necessary scopes (SMTP.Send) and disallows broad Mail.ReadWrite
  [PASS] [AC2.3] Disabled/unconfigured OAuth provider returns 503 status without redirecting to broken endpoint
  [PASS] [AC2.4] PKCE RFC 7636 code_verifier and SHA-256 code_challenge generated

--- Category 3: Identity Token Cryptographic Claims Validation ---
  [PASS] [AC3.1] Valid ID token claims (signature, issuer, audience, time, nonce) successfully validated
  [PASS] [AC3.2] Expired ID token rejected ('exp' claim validation)
  [PASS] [AC3.3] ID token with mismatched audience rejected ('aud' claim validation)
  [PASS] [AC3.4] ID token with invalid issuer rejected ('iss' claim validation)
  [PASS] [AC3.5] ID token with mismatched nonce rejected (replay/cross-session injection defense)
  [PASS] [AC3.6] ID token with insecure algorithm 'none' rejected

--- Category 4: Cross-Window Communication (postMessage) & UI Security ---
  [PASS] [AC4.1] PostMessage response eliminates wildcard targetOrigin ('*') and enforces exact trusted origin
  [PASS] [AC4.2] PostMessage transmits connection status schema and strictly omits access/refresh tokens
  [PASS] [AC4.3] SuperAdminEmailProtocol.jsx verifies exact event.origin, popup source window, and message schema

--- Category 5: Multi-Tenant Partitioning & Wrong-Tenant Linking Defense ---
  [PASS] [AC5.1] OAuth state generation binds initiating operator's verified session tenant (ignoring URL tampering)
  [PASS] [AC5.2] Callback routes tenant operator credentials to tenant partition (tenants/{tenantId}/email_config)

--- Category 6: Token Revocation, Disconnect & Recoverable Feature State ---
  [PASS] [AC6.1] revokeOAuthToken dispatches revocation to provider endpoint
  [PASS] [AC6.2] functions/index.js dynamic transporter disables feature on revoked/disconnected OAuth credentials
  [PASS] [AC6.3] SuperAdminEmailProtocol disconnect flow clears stored refresh token and triggers recoverable state

--- Category 7: Scope Disclaimer & Calendar Synchronization Limit ---
  [PASS] [AC7.1] Ticket boundary verified: OAuth storage is scoped to outgoing mail and is NOT calendar synchronization

================================================================================
   EXECUTION SUMMARY: 25 PASSED | 0 FAILED | 25 TOTAL
================================================================================
```

---

## Acceptance Criteria Traceability Matrix

| ID | Category | Requirement | Verified Behavior | Status |
| :--- | :--- | :--- | :--- | :--- |
| **AC1.1** | State Binding | Cryptographically bind operator, tenant, provider, redirect, nonce, exp | Verified HMAC-SHA256 signature containing `sub`, `tenantId`, `provider`, `nonce`, and `exp`. | **PASS** |
| **AC1.2** | State Defense | Reject absent state parameter | Returns `400 Bad Request` with CSRF protection failure notification. | **PASS** |
| **AC1.3** | State Defense | Reject tampered/mismatched state token | Returns `403 Forbidden` on signature verification failure. | **PASS** |
| **AC1.4** | State Defense | Reject expired state token | Rejects tokens older than 10 minutes (`exp` claim exceeded). | **PASS** |
| **AC1.5** | State Defense | Single-use nonce replay defense | Second invocation with identical nonce rejected as replayed token. | **PASS** |
| **AC1.6** | State Defense | Reject cross-provider state spoofing | Google state token sent to Microsoft handler rejected with provider mismatch. | **PASS** |
| **AC2.1** | Scopes | Google least privilege scopes | Configured with `gmail.send`; full mailbox access `mail.google.com` prohibited. | **PASS** |
| **AC2.2** | Scopes | Microsoft least privilege scopes | Configured with `SMTP.Send`; broad `Mail.ReadWrite` prohibited. | **PASS** |
| **AC2.3** | Gating | Disabled provider handling | Returns `503 Service Unavailable` without redirecting when client credentials missing. | **PASS** |
| **AC2.4** | PKCE | RFC 7636 PKCE parameters | Generates 32-byte `code_verifier` and SHA-256 `code_challenge` (S256). | **PASS** |
| **AC3.1** | ID Token | Valid claims verification | Validates signature, issuer, audience, timestamps, and nonce. | **PASS** |
| **AC3.2** | ID Token | Expired token rejection | Rejects expired `exp` timestamp beyond clock skew. | **PASS** |
| **AC3.3** | ID Token | Audience mismatch rejection | Rejects token where `aud` does not match configured `clientId`. | **PASS** |
| **AC3.4** | ID Token | Issuer validation | Rejects token where `iss` is not an official Google or Microsoft authority domain. | **PASS** |
| **AC3.5** | ID Token | Nonce mismatch rejection | Rejects token where `nonce` does not match state nonce. | **PASS** |
| **AC3.6** | ID Token | Insecure algorithm rejection | Rejects token with `alg: "none"`. | **PASS** |
| **AC4.1** | postMessage | Trusted origin lockdown | Eliminates wildcard `*`; uses exact `allowedOrigin`. | **PASS** |
| **AC4.2** | postMessage | Token omission | Message payload transmits status schema only; access/refresh tokens strictly excluded. | **PASS** |
| **AC4.3** | postMessage | UI listener verification | UI listener verifies `event.origin`, `event.source === popupRef`, and message schema. | **PASS** |
| **AC5.1** | Isolation | Operator session binding | State generation uses verified session `tenantId`, ignoring client URL query overrides. | **PASS** |
| **AC5.2** | Isolation | Partitioned storage | Routes tenant credentials to `tenants/${tenantId}/email_config` and SuperAdmin to `settings/email_config`. | **PASS** |
| **AC6.1** | Revocation | Revocation dispatch | `revokeOAuthToken` dispatches HTTP POST revocation to Google/Microsoft endpoints. | **PASS** |
| **AC6.2** | Revocation | Transporter disabling | `functions/index.js` throws `OAUTH_CREDENTIALS_REVOKED` when credentials revoked. | **PASS** |
| **AC6.3** | Revocation | UI disconnect flow | `confirmDisconnectAccount` sets `refreshToken: null` and restores setup state. | **PASS** |
| **AC7.1** | Boundary | Scope disclaimer | Verifies OAuth storage is strictly for outgoing email and NOT calendar sync. | **PASS** |

---

## Verification Runbook

To independently run and verify the test suites for CD04 and all prior tickets:

```bash
# 1. Run CD04 OAuth Account Linking Acceptance Suite
npm run test:cd04

# 2. Run CD03 Tenant Isolation & Secret Protection Suite
npm run test:cd03

# 3. Run CD02 Privileged Access & Sessions Suite
npm run test:cd02

# 4. Run CD01 Capability & Evidence Baseline Audit
npm run audit:cd01
```

All commands output human-readable test summaries and generate verifiable JSON evidence artifacts in the `evaluations/` directory.
