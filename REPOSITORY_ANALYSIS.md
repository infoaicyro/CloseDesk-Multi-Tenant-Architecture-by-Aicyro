# CloseDesk / AicyroNext — Repository Analysis & System Architecture

> **Sync Snapshot:** November 2026 | Production Version: `v2.1.0`  
> **Repository:** `closedesk-engine` (formerly `CloseDesk-Aicyro-GIT`)  
> **Runtime Environment:** Next.js 16.1.6 (Pages Router, Turbopack), React 19.2.4, Node.js >= 20.x, Tailwind CSS 3.4.18, Firebase Realtime Database & Storage, Firebase Cloud Functions (Node 20).

This document serves as the comprehensive, authoritative technical map of the CloseDesk codebase. It details every architectural tier, directory structure, module responsibility, API endpoint, UI component hierarchy under [`src/Closedesk`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk), and security protocol (including CD01 verified capability evidence and CD02 privileged access & session enforcement).

---

## 1. System Topography & How It Fits Together

```text
Visitor / Customer Host Website (WordPress, Webflow, Shopify, or Custom HTML)
  ├── Universal Embed Loader: <script src="https://domain.com/widget.js" data-tenant="tenant_id"></script>
  ├── Screen-Lock Consent Banner: src/Closedesk/Essential/CookieConsentBanner.jsx (GDPR/CCPA Gate)
  └── Sandboxed Transparent Iframe (/embed/chatbot?tenant={id}&anonId={uuid})
       └── AicyroChatbot: src/Closedesk/Chatbot/AicyroChatbot.jsx
            ├── POST /api/chat          → GPT-4o-mini structured JSON dialog + RTDB prospects/{session}
            ├── Storage Upload          → Firebase Storage chat_images/{session}/{ts}.jpg
            ├── POST /api/analyze-image → Multimodal GPT-4o-mini Vision + RTDB last_vision_inspection
            ├── POST /api/openai-token  → Ephemeral WebRTC token minting with client policy injection
            ├── Direct WebRTC Peer      → OpenAI Realtime Gateway (sub-100ms 24kHz bidirectional audio)
            ├── POST /api/sync-voice    → Voice telemetry, transcripts, and audio performance metrics
            ├── POST /api/leads         → RTDB /tenants/{tenantId}/leads/{leadId}
            └── queueEmailAlert()       → RTDB /email_alerts/{id} ── Firebase Cloud Function ── SMTP

Contractor & Tenant Operations Portal (/lg)
  ├── POST /api/login                   → Scrypt verification, persistent rate limiting, session cookie
  ├── Tenant Cockpit (CSR SPA):
  │    ├── HomeScreen                   → Real-time KPI velocity, visitor counts, conversion metrics
  │    ├── TerminalScreen               → Live inbound triage monitor, emergency chimes, one-click dial
  │    ├── Booking                      → Field service calendar, manual status overrides (Reschedule/Cancel)
  │    ├── Conversations                → Full text transcripts and WebRTC telemetry logs
  │    ├── CookieDataDisplay & Map      → Google Maps visitor cluster telemetry & device fingerprinting
  │    ├── Insight                      → Conversational sentiment trends and lead analytics (Recharts)
  │    ├── LiveNotifications            → Persistent audio chime alert feed
  │    ├── Report                       → Daily/weekly summaries with client-side CSV & PDF export
  │    └── Settings                     → Business profile, AI persona, brand theming, and password rotation
  └── POST /api/logout                  → Server-side session revocation in RTDB /sessions/{sessionId}

Master SuperAdmin Control Plane (/lg SuperAdmin Mode)
  ├── POST /api/superadmin/login        → Scrypt authentication, session issuance (stepUpVerified: false)
  ├── POST /api/superadmin/verify-pin   → Step-Up Authorization (RFC 6238 TOTP / PIN / Emergency Recovery)
  │                                       Elevates session in RTDB to (stepUpVerified: true)
  ├── Client Management                 → POST/GET /api/superadmin/tenants (Tenant CRUD, tier assignment)
  ├── Email Protocols                   → POST/GET /api/superadmin/settings (Global SMTP/OAuth relays)
  └── Global Theming                    → SuperAdminAppearance & cross-tenant configuration

Observability & Compliance Operations
  ├── /logs                             → POST /api/app-query (RBAC log queries across /system_logs)
  ├── Telemetry Pipeline                → POST /api/app-state (PII-scrubbed distributed trace receiver)
  ├── Daily Maintenance Cron            → /api/cron/retention-cleanup (Ephemeral transcripts & log pruning)
  ├── Security Acceptance Suite         → npm run test:cd02 (scripts/cd02_security_acceptance_suite.js)
  └── Capability Baseline Audit         → npm run audit:cd01 (scripts/cd01_baseline_audit.js)
```

---

## 2. Active Physical File Inventory

The active repository contains **84 source files** in [`src/`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src), organized cleanly across 4 core subdirectories plus styles, with 100% of historical dead files, duplicate endpoints, and plaintext credential dumps fully purged.

| Directory | File Count | Primary Function |
|---|---|---|
| [`src/Closedesk/`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk) | **25 files** | Modular React component hierarchy (Chatbot, Dashboard, Settings, SuperAdmin, Essential, Providers) |
| [`src/lib/`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/lib) | **24 modules** | Security primitives (Scrypt, TOTP, Sessions, Rate Limiting), AI policy engines, logging & distributed tracers |
| [`src/pages/api/`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/pages/api) | **25 endpoints** | Next.js serverless microservices (Auth, AI completions, WebRTC tokens, Vision, Leads, SuperAdmin CRUD) |
| [`src/pages/`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/pages) (root) | **9 pages** | Next.js Pages Router views (`_app.jsx`, `_document.jsx`, `layout.jsx`, `index.jsx`, `404.jsx`, `lg.jsx`, `logs.jsx`, `e2e-report.jsx`, `embed/chatbot.jsx`) |
| [`src/styles/`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/styles) | **1 file** | Canonical Tailwind CSS directives and CSS variable token definitions (`globals.css`) |
| [`scripts/`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/scripts) | **11 scripts** | Deterministic CD01/CD02 test suites, E2E harnesses, VAD calibrators, voice QA generators |
| [`docs/`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/docs) | **7 documents** | CD01 capability matrix, CD02 privileged access specs, superadmin recovery runbooks, voice privacy policies |
| [`evaluations/`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/evaluations) | **3 files** | Machine-readable evidence: `cd01_audit_evidence.json`, `cd02_security_evidence.json`, `report_v2.1.0.json` |
| [`functions/`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/functions) | **1 function** | Firebase Cloud Function `sendEmailAlert` (v1, Node 20 runtime) with dynamic SMTP dispatch |

---

## 3. UI Component Registry: `src/Closedesk/` (25 Components)

All UI components reside under [`src/Closedesk/`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk). Internal relative imports and external alias imports (`@/Closedesk/...`) resolve deterministically.

### 3.1 Multimodal Front-Desk AI
* **[`src/Closedesk/Chatbot/AicyroChatbot.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Chatbot/AicyroChatbot.jsx)**:  
  Flagship conversational component supporting 3 interaction modes:
  1. *Realtime Voice WebRTC:* Establishes direct peer connection to OpenAI Realtime via ephemeral secret from `/api/openai-token`. Renders animated sound visualizer, manages VAD interruption handling (`response.cancelled`), and streams 24kHz audio.
  2. *Text Chat:* GPT-4o-mini completions with piped chunk streaming (`|` delimiter), lead qualification triggers, and business hour validation.
  3. *Vision Diagnostics:* Webcam capture and file upload, compressing customer defect photos to Base64, uploading to Firebase Storage (`chat_images/{session}/{ts}.jpg`), and invoking `/api/analyze-image`.

### 3.2 Operational CRM Dashboard (`src/Closedesk/Dashboard/`)
* **[`HomeScreen.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/HomeScreen.jsx)**: Executive KPI velocity cockpit. Binds to `/tenants/{tenantId}/analytics` and `/leads` to calculate conversion rates, live active website visitors, and estimated closed pipeline.
* **[`TerminalScreen.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/TerminalScreen.jsx)**: High-density inbound lead triage. Renders live lead cards with urgent priority indicators, audio chimes, customer contact info, and one-click phone dial links.
* **[`Booking.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/Booking.jsx)**: Service appointment calendar and dispatch list. Features triage status filtering (`All`, `Upcoming`, `Completed`, `Rescheduled`, `Cancelled`) and manual status dropdown overrides updating RTDB `{ booking_status }`.
* **[`Conversations.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/Conversations.jsx)**: Complete conversation browser. Renders plain-text conversational transcripts (`full_conversation_transcript`), sentiment tags, and associated defect images.
* **[`CookieDataDisplay.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/CookieDataDisplay.jsx)**: Visitor telemetry manager. Displays hardware details (OS, browser, screen resolution) and consent state, with clear-all actions.
* **[`Report.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/Report.jsx)**: Operations reporting module. Formats lead metrics into daily and weekly breakdowns with client-side CSV export (Data URI) and print/PDF generation (`window.print`).
* **[`Insight.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/Insight.jsx)**: AI intelligence visualizer. Renders conversational sentiment trends, peak inquiry hours, and service categories using Recharts.
* **[`LiveNotifications.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/LiveNotifications.jsx)**: Reactive notification banner. Listens to RTDB `notifications/` with auto-pruning of entries older than 30 days.
* **[`LoginScreen.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/LoginScreen.jsx)**: Tenant operator authentication interface. Posts credentials to `/api/login` and receives signed session cookies.

### 3.3 Dashboard Mapping & Visualizations (`src/Closedesk/Dashboard/cookie/`)
* **[`CookieGrid.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/cookie/CookieGrid.jsx)**: Tabular telemetry grid listing IP-resolved geographic data and session durations.
* **[`CookieMap.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/cookie/CookieMap.jsx)**: Interactive Google Maps widget (`@vis.gl/react-google-maps`) rendering live visitor geolocation clusters.

### 3.4 Tenant Settings Suite (`src/Closedesk/Dashboard/Settings/`)
* **[`BusinessProfile.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/Settings/BusinessProfile.jsx)**: Manages operating hours, dispatch email, emergency phone, service zip codes, and base pricing.
* **[`Chatbotsetting.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/Settings/Chatbotsetting.jsx)**: Configures AI persona tone, greeting messages, OpenAI Realtime voice IDs (`alloy`, `echo`, `shimmer`, `ash`, `coral`), qualification questions, and master voice enable/disable killswitches.
* **[`apearance.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/Settings/apearance.jsx)**: Custom brand theming. Manages primary accent color, dark/light modes, chat widget positioning, launcher icons, and custom CSS injection.
* **[`notification-settings.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/Settings/notification-settings.jsx)**: Configures lead alert thresholds, sound notifications, and tenant outbound email notifications.
* **[`PasswordChange.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/Settings/PasswordChange.jsx)**: Secure credential rotation. Invokes `/api/user/password` with scrypt verification, password upgrade, and session rotation.

### 3.5 SuperAdmin Suite (`src/Closedesk/Dashboard/superadmin/`)
* **[`superadminlogin.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/superadmin/superadminlogin.jsx)**: Two-tier administrative authentication form (username/password + Step-Up PIN modal). Posts to `/api/superadmin/login` and `/api/superadmin/verify-pin`.
* **[`SuperAdminDashboard.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/superadmin/SuperAdminDashboard.jsx)**: Master control plane navigation bar and container.
* **[`ClientManagement.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/superadmin/ClientManagement.jsx)**: Multi-tenant client onboarding wizard and tenant manager. Dispatches to `/api/superadmin/tenants` with step-up verification headers.
* **[`SuperAdminAppearance.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/superadmin/Settings/SuperAdminAppearance.jsx)**: Platform-wide default theming controls.
* **[`SuperAdminEmailProtocol.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Dashboard/superadmin/Settings/SuperAdminEmailProtocol.jsx)**: Centralized SMTP/OAuth relay configuration. Calls `/api/superadmin/settings` with step-up verification.

### 3.6 Essential Wrappers & Providers
* **[`CookieConsentBanner.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/Essential/CookieConsentBanner.jsx)**: Regulatory consent gate enforcing GDPR/CCPA compliance before enabling telemetry or voice capture.
* **[`GlobalActivityTracker.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/GlobalActivityTracker.jsx)**: Client-side unhandled exception listener and route navigation telemetry transmitter.
* **[`ThemeProvider.jsx`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/Closedesk/ThemeProvider.jsx)**: Dynamic theme context that synchronizes Firebase RTDB appearance values directly to document CSS root variables (`--primary`, `--background`, etc.).

---

## 4. Serverless API Architecture: `src/pages/api/` (25 Endpoints)

Every API route is wrapped with `withApiLogger` from [`src/lib/apiMiddleware.js`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/lib/apiMiddleware.js) for end-to-end distributed transaction tracing (`x-correlation-id`, `x-session-id`, `x-tenant-id`), input sanitization, and PII masking.

```text
src/pages/api/
├── analytics.js                      # POST: Ingests pageviews, clicks, and visitor hardware details
├── analyze-image.js                  # POST: Evaluates customer defect photos using GPT-4o-mini Vision
├── app-query.js                      # POST: RBAC log query engine over system_logs
├── app-state.js                      # POST: Ingests client error events and structured logs
├── chat.js                           # POST: GPT-4o-mini conversational completions with JSON tool calling
├── cookie-consent.js                 # POST: Stores visitor privacy preferences in RTDB
├── generate-email.js                 # POST: Dispatches customer webhook alerts to Make.com / CRM
├── insights.js                       # GET/POST: Aggregates conversion metrics and conversation sentiment
├── leads.js                          # POST: Validates, deduplicates, and saves incoming customer leads
├── login.js                          # POST: Tenant operator scrypt authentication & session minting
├── logout.js                         # POST: Revokes tenant session in RTDB and clears cookie
├── openai-token.js                   # POST: Generates ephemeral OpenAI Realtime WebRTC client secrets
├── sync-voice.js                     # POST: Ingests WebRTC call telemetry, text transcripts, and latency
├── tts.js                            # POST: AWS Polly neural speech synthesis fallback
│
├── auth/
│   ├── google/
│   │   ├── login.js                  # GET: Google OAuth2 consent URL generator for calendar sync
│   │   └── callback.js               # GET: Exchanges Google auth code for refresh tokens
│   └── microsoft/
│       ├── login.js                  # GET: Microsoft 365 OAuth2 consent URL generator
│       └── callback.js               # GET: Exchanges Microsoft auth code for Graph API tokens
│
├── cron/
│   └── retention-cleanup.js          # POST/GET: Enforces privacy policies by pruning ephemeral logs
│
├── superadmin/
│   ├── login.js                      # POST: SuperAdmin scrypt login, issuing unverified session cookie
│   ├── logout.js                     # POST: Invalidates superadmin session in RTDB
│   ├── settings.js                   # GET/POST: Step-up protected global email relay configuration
│   ├── tenants.js                    # GET/POST/PATCH/DELETE: Step-up protected tenant CRUD operations
│   └── verify-pin.js                 # POST: Step-up verification (RFC 6238 TOTP, PIN, Recovery Code)
│
└── user/
    └── password.js                   # POST: Scrypt password update with re-authentication & session rotation
```

---

## 5. Security & Core Libraries: `src/lib/` (24 Modules)

```text
src/lib/
├── activityTracker.js                # Records client page views and widget interactions
├── aiTracer.js                       # OpenAI completion telemetry and safe JSON response parser
├── alertManager.js                   # Incident escalation engine pushing alerts to system_alerts/
├── apiMiddleware.js                  # withApiLogger HOC: correlation IDs, timing, and error boundaries
├── auditTracer.js                    # SOC2-style administrative audit logger (recordAuditTrail)
├── authCrypto.js                     # Salted scrypt hashing (N=16384, r=8, p=1), timingSafeStringEqual
├── authSession.js                    # HMAC-SHA256 signed session cookies, CSRF defense, withSessionGuard
├── cookiePersonalization.js          # UUID v4 generator for anonymous visitor tracking & consent checks
├── dbTracer.js                       # Realtime Database latency profiler
├── firebase.js                       # Singleton Firebase Client SDK (RTDB & Storage initialization)
├── integrationTracer.js              # Resilient external HTTP caller with exponential backoff
├── logger.js                         # CloseDeskLogger engine with level thresholds & PII redaction
├── loggerPresets.js                  # Logger factory (Website, API, AI, Voice, Pulse)
├── notificationHelper.js             # Formats and enqueues email alerts to /email_alerts
├── persistentRateLimiter.js          # Cold-start resilient sliding-window throttling in RTDB
├── ragTracer.js                      # Knowledge retrieval and document embedding tracer
├── retryTracer.js                    # Wrapper for retrying transient third-party API failures
├── ruleBook.js                       # Master prompt and conversation policies (v2.14.0)
├── safeDb.js                         # Safe database wrappers with timeout fallback (safeDbGet/Set)
├── sanitizer.js                      # Centralized NoSQL key sanitizer (sanitizeFirebaseKey)
├── tenantResolver.js                 # Resolves tenant slug from headers, query params, or subdomain
├── totp.js                           # RFC 6238 TOTP generation, ±1 window verification & recovery codes
├── tracer.js                         # Distributed tracing utilities (generateCorrelationId, fetchWithTrace)
└── visionRuleBook.js                 # Policy book and classification categories for GPT-4o-mini Vision
```

---

## 6. Privileged Access & Session Architecture (CD02)

CloseDesk enforces a zero-trust privileged access model preventing client-side privilege escalation:

```text
+---------------------------------------------------------------------------------------------------+
|                                 CD02 PRIVILEGED ACCESS ENFORCEMENT                                |
|                                                                                                   |
|  1. Primary Factor Authentication (/api/superadmin/login):                                        |
|     * Verifies username & password using salted scrypt (format 'scrypt:<salt>:<hash>')            |
|     * Enforces persistent rate limiting (5 attempts per 15 minutes, stored in RTDB /rate_limits)   |
|     * Upon success: Issues signed HMAC-SHA256 cookie:                                             |
|       { sessionId, userId, role: "superadmin", stepUpVerified: false, expiresAt }                |
|                                                                                                   |
|  2. Pre-Step-Up Gating:                                                                           |
|     * Access to destructive routes (/api/superadmin/tenants, /api/superadmin/settings) is         |
|       BLOCKED (403 Forbidden) while stepUpVerified is false.                                      |
|                                                                                                   |
|  3. Secondary Factor Verification (/api/superadmin/verify-pin):                                   |
|     * Accepts either:                                                                             |
|         a) 6-digit RFC 6238 TOTP code (validated with ±1 timestep window drift)                   |
|         b) Scrypt-hashed secondary PIN                                                            |
|         c) Scrypt-hashed Emergency Recovery Code (from docs/SUPERADMIN_RECOVERY_RUNBOOK.md)        |
|     * Upon verification: RTDB /sessions/{sessionId} is updated to { stepUpVerified: true }        |
|                                                                                                   |
|  4. Privileged Action Execution:                                                                  |
|     * withSessionGuard({ requiredRole: "superadmin", requireStepUp: true }) validates session    |
|       authenticity against RTDB and confirms step-up status before executing tenant mutations.    |
|                                                                                                   |
|  5. Revocation & Invalidation (/api/superadmin/logout or password change):                       |
|     * Deletes session record from RTDB /sessions/{sessionId}                                      |
|     * Overwrites cookie with Max-Age=0 (immediate browser termination)                            |
+---------------------------------------------------------------------------------------------------+
```

---

## 7. Verified Capability Matrix (CD01)

The codebase implements and verifies the 9 core pilot capabilities defined in [`docs/CD01_CAPABILITY_AND_EVIDENCE_BASELINE.md`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/docs/CD01_CAPABILITY_AND_EVIDENCE_BASELINE.md):

| # | Capability | Code Implementation | Status & Evidence |
|---|---|---|---|
| **1** | **Website Text Chat** | `public/widget.js`, `src/Closedesk/Chatbot/AicyroChatbot.jsx`, `src/pages/api/chat.js` | `Implemented`, `Tested`, `Deployed` |
| **2** | **Browser Voice (WebRTC)** | `src/Closedesk/Chatbot/AicyroChatbot.jsx`, `src/pages/api/openai-token.js`, `src/pages/api/sync-voice.js` | `Implemented`, `Tested`, `Deployed` (Browser-based WebRTC only) |
| **3** | **Booking (Appointment Intake)** | `src/Closedesk/Dashboard/Booking.jsx`, `src/pages/api/leads.js` | `Implemented`, `Tested`, `Deployed` |
| **4** | **Rescheduling** | `src/Closedesk/Dashboard/Booking.jsx` (`handleStatusUpdate` writing `booking_status: "Reschedule"`) | `Unsupported` (Manual status dropdown only; no automated scheduler) |
| **5** | **Cancellation** | `src/Closedesk/Dashboard/Booking.jsx` (`handleStatusUpdate` writing `booking_status: "Cancel"`) | `Unsupported` (Manual status dropdown only; no automated cancel API) |
| **6** | **Audio Recordings** | Ephemeral memory destroyed on WebRTC close (`src/pages/api/cron/retention-cleanup.js`) | `Disabled` by policy (`docs/VOICE_PRIVACY_POLICY.md`); text transcripts retained |
| **7** | **Visual Image Diagnostics** | `src/Closedesk/Chatbot/AicyroChatbot.jsx`, `src/pages/api/analyze-image.js`, `src/lib/visionRuleBook.js` | `Implemented`, `Tested`, `Deployed` (9 trade defect categories) |
| **8** | **Data Exports** | `src/Closedesk/Dashboard/Report.jsx` (Client-side Data URI CSV and `window.print` PDF) | `Implemented` in client UI; backend API unsupported |
| **9** | **Notifications & Alerts** | `src/Closedesk/Dashboard/LiveNotifications.jsx`, `src/lib/notificationHelper.js`, `functions/index.js` | `Implemented`, `Tested`, `Deployed` (RTDB feed + Cloud Function SMTP) |

---

## 8. Verification Commands

* **Deterministic CD01 Audit:**
  ```bash
  npm run audit:cd01
  ```
  *Verifies existence of all 41 baseline files, hashes critical policy rules, validates benchmark reports, and scans `src/` and `public/` for unverified telephony phrasing.*

* **Deterministic CD02 Security Suite:**
  ```bash
  npm run test:cd02
  ```
  *Executes all 8 P0 security criteria: unauthenticated access rejection, expired session invalidation, RBAC enforcement, step-up gating, scrypt password verification, cookie security flags, persistent rate limiting, and RFC 6238 TOTP verification.*

* **Next.js Production Build:**
  ```bash
  npm run build
  ```
  *Compiles all pages and `src/Closedesk` components with Turbopack in < 10 seconds.*
