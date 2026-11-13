# CloseDesk Engine

> **Multi-Tenant Headless Multimodal AI Front-Desk & Real-Time Operational Dispatch Control Plane**  
> *Production Version: v2.1.0 | Runtime: Next.js 16 (Pages Router) & Node.js >= 20.x*

CloseDesk (branded publicly as **Aicyro**) is a high-performance, decoupled multi-tenant platform designed for field service and enterprise organizations. It bridges conversational client acquisition with real-time operational CRM triage, live dispatch scheduling, and multi-tenant management.

---

## Architecture Overview

CloseDesk decouples conversational client acquisition from backend intelligence, database persistence, and CRM dispatch operations:

```text
+---------------------------------------------------------------------------------------------------+
|                                  CLIENT CONSUMPTION LAYER (ANY HOST)                              |
|                                                                                                   |
|  [WordPress / Webflow / Shopify / Custom Next.js / Static HTML]                                   |
|   └── Universal Embed SDK: <script src="https://domain.com/widget.js" data-tenant="id"></script>  |
|         ├── Host DOM Telemetry & Geolocation Resolution (IPInfo / Navigator)                      |
|         ├── Screen-Lock Cookie & Geolocation Consent Banner (GDPR/CCPA Gate)                      |
|         └── Sandboxed Transparent Iframe (/embed/chatbot?tenant={id}&anonId={uuid})               |
+---------------------------------------------------------------------------------------------------+
                                         │ postMessage (Resize / State)
                                         │ HTTPS REST / WSS WebRTC
                                         ▼
+---------------------------------------------------------------------------------------------------+
|                                APPLICATION GATEWAY & API RUNTIME LAYER                            |
|                                                                                                   |
|  [Next.js 16.1.6 Pages Router Serverless Edge / Node.js Engine]                                   |
|   ├── CORS & Security Headers Middleware (next.config.js / netlify.toml)                         |
|   ├── Universal Tracing Pipeline: withApiLogger(handler, componentName)                           |
|   │     ├── Transaction Propagation (x-correlation-id, x-session-id, x-tenant-id)                |
|   │     └── Unhandled Exception Trapping & PII / Secret Sanitization                              |
|   ├── Privileged Access & Session Security Gate (CD02):                                           |
|   │     ├── Server-Side RBAC & Signed HMAC-SHA256 Sessions (/lib/authSession.js)                |
|   │     ├── Step-Up Secondary Factor Authorization (/lib/totp.js: RFC 6238, PIN, Recovery)     |
|   │     ├── Cold-Start Persistent Sliding-Window Throttling (/lib/persistentRateLimiter.js)       |
|   │     └── Salted Scrypt Cryptographic Password Verification & Upgrades (/lib/authCrypto.js)    |
|   ├── Security Middleware & Key Sanitizer: sanitizeFirebaseKey() against NoSQL traversal          |
|   └── Multimodal Endpoints:                                                                       |
|         ├── Voice Session Ephemeral Minting: /api/openai-token                                    |
|         ├── Text Conversational Engine: /api/chat (GPT-4o-mini JSON mode)                         |
|         ├── Vision Ingestion & Diagnosis: /api/analyze-image (Multimodal GPT-4o-mini)             |
|         ├── Calendar OAuth Sync: /api/auth/google & /api/auth/microsoft                           |
|         └── Fallback Neural Speech Synthesis: /api/tts (AWS Polly)                                |
+---------------------------------------------------------------------------------------------------+
                                         │
                                         ▼
+---------------------------------------------------------------------------------------------------+
|                                PERSISTENCE & ASYNCHRONOUS WORKER LAYER                            |
|                                                                                                   |
|  [Firebase Realtime Database (us-central1) & Cloud Functions (Node 20)]                           |
|   ├── Isolated Tenant Tree: /tenants/{tenantId}/                                                  |
|   │     ├── /settings           (Branding, System Prompts, Business Hours, Tiers)                 |
|   │     ├── /conversations      (Live Sessions, Transcripts, Customer Payloads)                   |
|   │     ├── /bookings           (Appointments, Service Types, Status Overrides)                   |
|   │     ├── /cookies            (Consent Tokens, Geolocation, Device Fingerprints)                |
|   │     └── /leads              (Inbound Qualified Leads, Urgent Emergency Flags)                 |
|   ├── Global Infrastructure Roots:                                                                |
|   │     ├── /superadmins        (Platform Administrator Credentials & Secondary Factors)          |
|   │     ├── /sessions           (Server-Side Revocable Active Sessions)                          |
|   │     ├── /rate_limits        (Cold-Start Persistent Brute-Force Windows)                       |
|   │     └── /system_logs        (Distributed Structured Observability Stream)                     |
|   └── Cloud Functions (functions/index.js): Dynamic SMTP Mailer & Appointment Cron Dispatch       |
+---------------------------------------------------------------------------------------------------+
```

---

## Key Features

### 1. Multimodal Front-Desk AI (`/embed/chatbot`)
* **Realtime WebRTC Voice AI:** Sub-second conversational voice powered by OpenAI Realtime WebRTC with dynamic system instructions, Voice Activity Detection (VAD), and live interruptions.
* **Text Chat with Guardrails:** GPT-4o-mini structured JSON completions enforcing domain rulebooks (`src/lib/ruleBook.js`), business hours, and automated handoffs.
* **Multimodal Vision Diagnostics:** Users can capture or upload photos of issues (e.g., plumbing leaks, electrical panels, HVAC tags); the AI analyzes damage severity and repair scope before quoting (`src/lib/visionRuleBook.js`).
* **Neural Speech Fallback:** High-fidelity speech generation with AWS Polly Neural voices.
* **Privacy & Compliance Gate:** Explicit screen-lock consent modal enforcing GDPR/CCPA compliance before tracking or voice interaction (`src/Closedesk/Essential/CookieConsentBanner.jsx`).
* **Integrated Scheduling:** Frictionless booking flow with calendar sync via Google Calendar and Microsoft Outlook OAuth.

### 2. Operational Dispatch CRM Cockpit (`/lg`)
* **Live Cockpit & KPI Velocity:** Real-time metrics on incoming inquiries, conversion rate, booked pipeline value, and response latency.
* **Terminal Screen:** Real-time triage monitor displaying active incoming inquiries, urgent issues, and one-click operator takeover.
* **Conversations Browser:** Full chat histories, voice session recordings/transcripts, sentiment indicators, and lead metadata.
* **Booking Manager:** Calendar and list view for customer appointments with manual status override controls (`Confirmed`, `Completed`, `Reschedule`, `Cancel`).
* **Visitor Intelligence & Cookie Map:** Interactive Google Maps visualization showing geographic distribution of site visitors, device details, and consent statuses.
* **AI Business Insights:** Automated analytics and trend visualization powered by Recharts.
* **Automated Daily & Weekly Reports:** Operational performance summaries and lead acquisition reports with CSV and PDF export.
* **Granular Tenant Configuration:**
  * Business Profile (name, phone, address, operating hours, emergency rates).
  * Chatbot Settings (voice persona, temperature, auto-open delays, lead scoring thresholds).
  * Appearance & Custom Theming (light/dark modes, custom accent colors, CSS variable sync).
  * Notification Settings & Password Security with scrypt verification.

### 3. SuperAdmin Control Plane & Privileged Security (CD02)
* **Server-Side RBAC & Step-Up Auth:** Multi-factor gating requiring RFC 6238 TOTP, hashed secondary PIN, or emergency recovery codes before privileged platform mutations.
* **Multi-Tenant Provisioning:** Instant tenant creation, password provisioning, suspension, and license tier assignment (`/api/superadmin/tenants`).
* **Session Lifecycle:** Signed HMAC-SHA256 session cookies (`closedesk_session`) with server-side revocation in RTDB `/sessions/{sessionId}`.
* **Persistent Rate Limiting:** Cold-start resilient sliding-window lockout in `/rate_limits/{clientKey}` (5 failed attempts, 15m window).
* **Cryptographic Hardening:** Salted scrypt hashing (`scrypt:<salt>:<hash>`) with automatic legacy password upgrade detection.

### 4. Verified Capability Baseline (CD01)
* Zero unverified telephony claims across `src/` and `public/`.
* Complete capability matrix mapping 9 core pilot capabilities to source code, APIs, database paths, and deterministic tests.

---

## Tech Stack

| Layer | Technologies |
|---|---|
| **Framework & UI** | [Next.js 16.1.6](https://nextjs.org/) (Pages Router, Turbopack), [React 19](https://react.dev/), [Tailwind CSS 3.4](https://tailwindcss.com/), [Lucide React](https://lucide.dev/) |
| **Component Architecture** | Modular UI components organized under `src/Closedesk/` (`Chatbot`, `Dashboard`, `Settings`, `superadmin`, `Essential`) |
| **Data & Backend** | [Firebase Realtime Database](https://firebase.google.com/), [Firebase Cloud Functions](https://firebase.google.com/docs/functions) (Node 20), [Firebase Storage](https://firebase.google.com/) |
| **Artificial Intelligence** | [OpenAI Realtime API](https://platform.openai.com/) (WebRTC Voice), GPT-4o-mini (Chat & Vision), [AWS Polly](https://aws.amazon.com/polly/) (Neural TTS) |
| **Security & Auth** | Node.js `crypto` (Scrypt & HMAC-SHA256), RFC 6238 TOTP, CSRF Protection, SameSite Strict HttpOnly Cookies |
| **Mapping & Charts** | [@vis.gl/react-google-maps](https://visgl.github.io/react-google-maps/), [Recharts 3](https://recharts.org/) |
| **Calendar Integrations** | Google Calendar API OAuth 2.0, Microsoft Graph API OAuth 2.0 |
| **Testing & Auditing** | Deterministic CD01 Baseline Audit, CD02 Security Acceptance Suite, synthetic AI evaluation harnesses |

---

## Directory Structure

```text
├── docs/                                  # Canonical specifications, security audits & runbooks
│   ├── CD01_CAPABILITY_AND_EVIDENCE_BASELINE.md # Verified 9-capability matrix & scheduler audit
│   ├── CD02_PRIVILEGED_ACCESS_AND_SESSIONS.md   # Server-side RBAC, Step-Up auth & session architecture
│   ├── SUPERADMIN_RECOVERY_RUNBOOK.md     # Emergency break-glass & secret recovery procedures
│   ├── LOGGING_SCHEMA.md                  # Canonical structured logging schema and PII redaction rules
│   ├── VOICE_PRIVACY_POLICY.md            # Raw audio privacy & ephemeral memory retention policy
│   ├── VOICE_PRODUCTION_READINESS_SIGNOFF.md # Voice latency thresholds & readiness sign-off
│   └── VOICE_QA_TEST_SUITE.md             # Realtime voice tool calling test procedures
│
├── evaluations/                           # Audit evidence & benchmark execution results
│   ├── cd01_audit_evidence.json           # Machine-readable CD01 capability evidence
│   ├── cd02_security_evidence.json        # Deterministic CD02 security acceptance evidence
│   └── report_v2.1.0.json                 # Synthetic dialogue benchmarks
│
├── functions/                             # Firebase Cloud Functions (v1, Node 20 runtime)
│   ├── index.js                           # Dynamic SMTP mailer & appointment reminder crons
│   └── package.json                       # Function runtime dependencies
│
├── public/                                # Static assets & universal client SDK
│   ├── avatars/                           # Vector avatar icons
│   ├── widget.js                          # Universal embeddable client loader
│   ├── e2e-report.html                    # Static E2E test report
│   └── robots.txt                         # Search crawler indexing directives
│
├── scripts/                               # Testing, tuning, and evaluation harnesses
│   ├── cd01_baseline_audit.js             # CD01 deterministic capability audit runner (npm run audit:cd01)
│   ├── cd02_security_acceptance_suite.js  # CD02 security acceptance test runner (npm run test:cd02)
│   ├── e2e_master_suite.js                # Full platform end-to-end integration suite
│   ├── esm_loader.mjs                     # Custom ESM loader for node test execution
│   ├── generate_e2e_page.js               # E2E report HTML generation script
│   ├── generate_visual_dashboard.js       # Visual audit dashboard builder
│   ├── industry_regression_suite.js       # Multi-vertical prompt regression suite
│   ├── qa-simulator.js                    # End-to-end chat and voice session simulator
│   ├── run_evaluations.js                 # Synthetic dialogue benchmark runner (npm run test:ai)
│   ├── vad_tuning_harness.js              # Voice Activity Detection calibration
│   └── voice_qa_harness.js                # Voice audio generation and pronunciation checks
│
├── src/
│   ├── Closedesk/                         # Modular UI component hierarchy (formerly src/components)
│   │   ├── Chatbot/                       # Embeddable multimodal AI front-desk
│   │   │   └── AicyroChatbot.jsx          # Voice WebRTC, Chat, and Vision upload interface
│   │   ├── Dashboard/                     # Pulse CRM Cockpit views (/lg)
│   │   │   ├── Booking.jsx                # Appointments management & status overrides
│   │   │   ├── Conversations.jsx          # Chat and voice transcript viewer
│   │   │   ├── CookieDataDisplay.jsx      # Visitor hardware profile & telemetry viewer
│   │   │   ├── HomeScreen.jsx             # Executive KPI cockpit & lead velocity
│   │   │   ├── Insight.jsx                # Recharts lead intelligence & conversion analytics
│   │   │   ├── LiveNotifications.jsx      # Real-time lead alert feed with audio chime
│   │   │   ├── LoginScreen.jsx            # Tenant operator authentication screen
│   │   │   ├── Report.jsx                 # Operations reporting and data export (CSV/PDF)
│   │   │   ├── TerminalScreen.jsx         # Live lead triage terminal & emergency response
│   │   │   ├── cookie/                    # Visitor mapping widgets
│   │   │   │   ├── CookieGrid.jsx         # Telemetry data grid
│   │   │   │   └── CookieMap.jsx          # Google Maps visitor cluster map
│   │   │   ├── Settings/                  # Tenant settings
│   │   │   │   ├── apearance.jsx          # Brand colors, dark mode, CSS variable bindings
│   │   │   │   ├── BusinessProfile.jsx    # Hours, emergency phone numbers, business info
│   │   │   │   ├── Chatbotsetting.jsx     # Persona prompt, voice selection, qualification
│   │   │   │   ├── notification-settings.jsx # Alert routing & SMTP preferences
│   │   │   │   └── PasswordChange.jsx     # Scrypt credential rotation with session re-auth
│   │   │   └── superadmin/                # SuperAdmin control plane
│   │   │       ├── ClientManagement.jsx   # Multi-tenant onboarding & license management
│   │   │       ├── SuperAdminDashboard.jsx # Superadmin navigation shell
│   │   │       ├── superadminlogin.jsx    # Superadmin authentication portal
│   │   │       └── Settings/              # Global superadmin protocols
│   │   │           ├── SuperAdminAppearance.jsx    # Global theming controls
│   │   │           └── SuperAdminEmailProtocol.jsx # Global SMTP/OAuth relays
│   │   ├── Essential/                     # Core consent & compliance components
│   │   │   └── CookieConsentBanner.jsx    # GDPR/CCPA cookie & telemetry consent gate
│   │   ├── GlobalActivityTracker.jsx      # Global client error & navigation telemetry
│   │   └── ThemeProvider.jsx              # Theme context binding RTDB branding to CSS vars
│   │
│   ├── lib/                               # Core backend libraries & security utilities (24 modules)
│   │   ├── activityTracker.js             # Client telemetry logger
│   │   ├── aiTracer.js                    # OpenAI completion tracer and safe JSON parser
│   │   ├── alertManager.js                # Incident alert dispatcher
│   │   ├── apiMiddleware.js               # Universal API wrapper (withApiLogger) with correlation IDs
│   │   ├── auditTracer.js                 # Security audit trail recorder
│   │   ├── authCrypto.js                  # Salted scrypt hashing & timingSafeStringEqual
│   │   ├── authSession.js                 # Signed HMAC-SHA256 sessions & CSRF defense
│   │   ├── cookiePersonalization.js       # Lead personalization and anonymous ID engine
│   │   ├── dbTracer.js                    # Firebase RTDB query latency profiler
│   │   ├── firebase.js                    # Firebase SDK singleton initialization
│   │   ├── integrationTracer.js           # Resilient HTTP client with retry logic
│   │   ├── logger.js                      # Structured logger with PII scrubbing
│   │   ├── loggerPresets.js               # Component loggers (API, Website, AI, Voice, Pulse)
│   │   ├── notificationHelper.js          # Email alert queue helper
│   │   ├── persistentRateLimiter.js       # Cold-start persistent rate limiting in RTDB
│   │   ├── ragTracer.js                   # RAG execution telemetry tracer
│   │   ├── retryTracer.js                 # Exponential backoff retry tracer
│   │   ├── ruleBook.js                    # Master conversational rules (v2.14.0)
│   │   ├── safeDb.js                      # Safe database operations with timeout fallback
│   │   ├── sanitizer.js                   # NoSQL key sanitizer
│   │   ├── tenantResolver.js              # Tenant hostname & query resolver
│   │   ├── totp.js                        # RFC 6238 TOTP & recovery code engine
│   │   ├── tracer.js                      # Distributed transaction tracer (UUID v4)
│   │   └── visionRuleBook.js              # Multimodal image defect rules (v1.1.0)
│   │
│   ├── pages/                             # Next.js Pages Router entries (9 pages + 25 APIs)
│   │   ├── 404.jsx                        # Custom branded 404 page
│   │   ├── e2e-report.jsx                 # Interactive QA test results page
│   │   ├── index.jsx                      # Public marketing landing portal
│   │   ├── layout.jsx                     # Persistent layout wrapper
│   │   ├── lg.jsx                         # Pulse Tenant & SuperAdmin operational portal
│   │   ├── logs.jsx                       # Observability & audit log viewer
│   │   ├── _app.jsx                       # Application shell & global providers
│   │   ├── _document.jsx                  # Custom HTML document with theme injection
│   │   ├── embed/
│   │   │   └── chatbot.jsx                # Standalone iframe embed route
│   │   └── api/                           # Serverless backend microservice routes (25 endpoints)
│   │       ├── analytics.js               # Traffic & visitor event ingestion
│   │       ├── analyze-image.js           # GPT-4o-mini Vision defect analysis
│   │       ├── app-query.js               # RBAC-gated system log queries
│   │       ├── app-state.js               # Log event transmission receiver
│   │       ├── chat.js                    # Conversational AI completions
│   │       ├── cookie-consent.js          # Visitor consent token persistence
│   │       ├── generate-email.js          # Outbound email webhook dispatcher
│   │       ├── insights.js                # Conversational analytics aggregation
│   │       ├── leads.js                   # Lead qualification & deduplication
│   │       ├── login.js                   # Scrypt-authenticated tenant login
│   │       ├── logout.js                  # Server-side session invalidation
│   │       ├── openai-token.js            # Ephemeral WebRTC token minting
│   │       ├── sync-voice.js              # Voice telemetry, tools & transcripts
│   │       ├── tts.js                     # AWS Polly Neural TTS fallback
│   │       ├── auth/
│   │       │   ├── google/                # Google Calendar OAuth (login & callback)
│   │       │   └── microsoft/             # Microsoft 365 OAuth (login & callback)
│   │       ├── cron/
│   │       │   └── retention-cleanup.js   # Ephemeral transcript & log retention pruning
│   │       ├── superadmin/
│   │       │   ├── login.js               # SuperAdmin authentication gate
│   │       │   ├── logout.js              # SuperAdmin session termination
│   │       │   ├── settings.js            # Step-up protected global email settings
│   │       │   ├── tenants.js             # Step-up protected tenant CRUD operations
│   │       │   └── verify-pin.js          # Step-up secondary factor verification (TOTP/PIN)
│   │       └── user/
│   │           └── password.js            # Scrypt password change with session rotation
│   │
│   └── styles/
│       └── globals.css                    # Tailwind design tokens, layers, and theme vars
│
├── database.rules.json                    # Firebase RTDB security rules, indexes & permissions
├── jsconfig.json                          # Path aliases: @/* -> ./src/*, @/components/* -> ./src/Closedesk/*
├── netlify.toml                           # Edge CORS headers, build settings, Node 20 runtime
├── next.config.js                         # Next.js compiler settings & API CORS configuration
├── package.json                           # Root dependencies and operational scripts
└── tailwind.config.js                     # Tailwind CSS content scan paths (pages + Closedesk)
```

---

## Getting Started

### Prerequisites
* **Node.js**: `>= 20.0.0`
* **npm**: `>= 10.0.0`
* **Firebase Project**: Realtime Database & Storage enabled.
* **OpenAI API Key**: Access to GPT-4o-mini and Realtime APIs.

### 1. Clone & Install
```bash
git clone https://github.com/abdulmoiddd/Testing-closedesk-Multi-Tenant-Architecture.git
cd Testing-closedesk-Multi-Tenant-Architecture
npm install
```

### 2. Configure Environment Variables
Create `.env.local` in the project root:

```env
# Base Application URL
NEXT_PUBLIC_APP_URL=http://localhost:3000

# Firebase Client Configuration
NEXT_PUBLIC_FIREBASE_API_KEY=your_firebase_api_key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_DATABASE_URL=https://your-project-default-rtdb.firebaseio.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project-id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
NEXT_PUBLIC_FIREBASE_APP_ID=your_app_id
NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID=your_measurement_id

# OpenAI Intelligence
OPENAI_API_KEY=sk-proj-your_openai_api_key

# Google Maps Platform (Visitor Map Display)
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=your_google_maps_api_key

# Session Signing & Security (CD02)
SESSION_SECRET=your_32_byte_session_signing_secret_here

# AWS Polly Neural TTS (Optional Fallback)
CUSTOM_AWS_REGION=us-east-1
CUSTOM_AWS_ACCESS_KEY_ID=your_aws_access_key
CUSTOM_AWS_SECRET_ACCESS_KEY=your_aws_secret_key

# Calendar Integrations (Optional)
GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_google_client_secret
MICROSOFT_CLIENT_ID=your_microsoft_client_id
MICROSOFT_CLIENT_SECRET=your_microsoft_client_secret

# Webhooks & Maintenance
CRON_SECRET=your_secure_cron_secret
MAKE_COM_EMAIL_WEBHOOK_URL=https://hook.make.com/your_webhook
WEBHOOK_SECRET=your_webhook_secret
```

### 3. Run the Development Server
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the application:
* **Tenant & SuperAdmin Cockpit**: [http://localhost:3000/lg](http://localhost:3000/lg)
* **Embedded Chatbot Sandbox**: [http://localhost:3000/embed/chatbot?tenant=default](http://localhost:3000/embed/chatbot?tenant=default)
* **Operational Logs**: [http://localhost:3000/logs](http://localhost:3000/logs)
* **E2E Test Report**: [http://localhost:3000/e2e-report](http://localhost:3000/e2e-report)

---

## Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Starts Next.js development server with Turbopack. |
| `npm run build` | Compiles optimized Next.js production build. |
| `npm start` | Runs the compiled production server. |
| `npm run lint` | Analyzes code quality using ESLint. |
| `npm run audit:cd01` | Runs deterministic CD01 baseline audit (matrix verification, policy hashing, claim scan). |
| `npm run test:cd02` | Runs CD02 security acceptance suite (RBAC, step-up auth, scrypt, rate limiter, TOTP). |
| `npm run test:ai` | Executes synthetic AI evaluation and safety harness. |
| `node scripts/qa-simulator.js` | Runs end-to-end simulated chat and voice sessions. |
| `node scripts/industry_regression_suite.js` | Runs multi-vertical regression suites across business rules. |
| `node scripts/e2e_master_suite.js` | Runs master end-to-end platform acceptance suite. |

---

## Embedding on Client Websites

To embed the CloseDesk front-desk on any external website (WordPress, Webflow, Shopify, Squarespace, or static HTML), add this single script tag right before the closing `</body>` tag:

```html
<script 
  src="https://your-domain.com/widget.js" 
  data-tenant="your_tenant_id" 
  defer>
</script>
```

### How the Widget Works:
1. **Lightweight Loader**: Loads asynchronously without blocking the host page.
2. **Strict Privacy**: Displays the consent modal before activating cookies or telemetry (`src/Closedesk/Essential/CookieConsentBanner.jsx`).
3. **Isolated Iframe**: Injects a transparent, zero-conflict sandboxed iframe hosting `/embed/chatbot?tenant={tenantId}&anonId={uuid}`.
4. **Adaptive Resizing**: Automatically handles expandable chat window geometry and mobile screen-docking via cross-domain `postMessage`.

---

## Deployment

### Netlify
1. Connect the GitHub repository to Netlify.
2. Build Settings:
   * **Build Command:** `npm run build`
   * **Publish Directory:** `.next`
3. Ensure all environment variables from `.env.local` are added to the Netlify site settings.
4. Edge headers and CORS rules are pre-configured in [`netlify.toml`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/netlify.toml).

### Firebase Realtime Database & Cloud Functions
1. Deploy database security rules and index definitions:
   ```bash
   firebase deploy --only database
   ```
2. Deploy Cloud Functions for email dispatch and crons:
   ```bash
   cd functions && npm install && cd ..
   firebase deploy --only functions
   ```

---

## Security & Compliance

* **Server-Side RBAC & Step-Up Auth:** Destructive administrative actions (tenant provisioning, email protocol reconfiguration, password changes) require server-side session authentication with secondary factor verification (TOTP / Secondary PIN / Emergency Recovery Codes).
* **Cryptographic Passwords:** Passwords hashed with salted scrypt (`scrypt:<salt>:<hash>`) with timing-safe comparison to prevent timing attacks.
* **Cold-Start Persistent Throttling:** Brute-force protection stored in Firebase RTDB `/rate_limits/{clientKey}` persists across serverless cold starts.
* **Tenant Isolation:** Enforced at both the database rule level ([`database.rules.json`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/database.rules.json)) and API middleware layer ([`tenantResolver.js`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/lib/tenantResolver.js)).
* **NoSQL Injection Defense:** Centralized key sanitization ([`sanitizer.js`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/lib/sanitizer.js)) scrubs malicious characters before database writes.
* **Privacy Compliance:** Voice sessions and visitor location tracking require explicit user opt-in through the consent banner.
* **Auditing:** Complete operational logs with structured correlation IDs and automatic PII masking ([`logger.js`](file:///d:/Software%20House%2001/Closedesk-ready%20to%20deploy/src/lib/logger.js)).

---

## License

This project is proprietary and confidential. Unauthorized copying, distribution, or commercial deployment is strictly prohibited.  
Developed by **Aicyro**.
