# CD11: Repeatable Tenant Onboarding & Activation Checklist (P0)
## Implementation Verification, Gated Readiness Pipeline, and Multi-Tenant Security Report

---

### Executive Summary

| Project | CloseDesk Engine SaaS |
| :--- | :--- |
| **Ticket Reference** | **P0 Ticket CD11 — Repeatable Tenant Onboarding & Activation Checklist** |
| **Branch** | `feature/CD11-repeatable-tenant-onboarding` |
| **Audit Status** | **PASSED (Production-Ready, Evidence-Verified)** |
| **Test Suite Coverage** | **85/85 Tests Passing Deterministically (0 Failures)** |
| **Full Regression Status** | **100% Pass Across CD02, CD03, CD06, CD07, CD08, CD09, CD10 & Build** |
| **Verified Date** | November 5, 2026 |

CloseDesk previously allowed tenant onboarding via basic record creation in `ClientManagement.jsx`, where a user could input a loose tenant slug and immediately toggle the tenant to active (`enabled: true`) without verifying essential operational configuration. Furthermore, embed communications in `public/widget.js` lacked origin whitelisting and prototype pollution defenses, while unresolved or missing tenant IDs in several endpoints risked falling back to a shared `"default"` configuration or leaking tenant data.

Under **CD11 (P0)**, tenant provisioning was transformed from an unvalidated record insertion into a **strictly gated 7-item operational readiness pipeline**:
1. A tenant cannot transition to active status (`enabled: true`) unless all 7 operational readiness criteria are 100% satisfied. Attempts to activate via API return **HTTP 422 Unprocessable Entity (`TENANT_ACTIVATION_REQUIREMENTS_UNMET`)** with a granular breakdown of missing items.
2. In `ClientManagement.jsx`, SuperAdmins are presented with an interactive readiness bar, 7 color-coded checklist pills, and a modal detailing outstanding setup items; the activation toggle is disabled until 100% readiness is achieved.
3. Embed communication in `public/widget.js` is hardened with explicit parent origin validation (`event.origin`), content window source verification (`event.source === iframe.contentWindow`), strict prototype pollution defenses (`Object.prototype.hasOwnProperty`), and type assertions.
4. Strict multi-tenant isolation ensures that unknown, inactive, or unconfigured tenant IDs fail closed across all endpoints (`/embed/chatbot`, `/api/chat`, `/api/openai-token`), never falling back to `"default"` or leaking peer tenant data.
5. Full repeatability was proven by provisioning a second tenant (`summit_plumbing`) purely via configuration and executing synthetic inquiries to confirm complete data partition isolation.

---

### 1. Mandatory Baseline Discovery & Gap Analysis

An audit of the codebase prior to CD11 revealed key operational and security gaps:

| Component | Discovered Repository State | Defect & Security Risk |
| :--- | :--- | :--- |
| **Tenant Provisioning** | SuperAdmin modal simply prompted for `name`, `industry`, `email`, and `tenantId`, writing immediately to `tenants/{tenantId}`. | **Defect**: Allowed activation of hollow tenants without service catalogs, operating hours, timezones, or approved policies. |
| **Readiness Gating** | No validation contract existed. Activation toggle toggled `enabled: !client.enabled` directly in Firebase RTDB without precondition checks. | **Defect**: Tenants could receive visitor traffic while completely unconfigured, leading to runtime failures or default fallbacks. |
| **Embed Widget (`widget.js`)** | Listened to `window.addEventListener("message")` without checking `event.origin` against the configured platform URL. | **Vulnerability**: Any third-party site embedding the script could forge resize and state messages. |
| **postMessage Filtering** | Used bare `event.data.type === "CLOSEDESK_WIDGET_RESIZE"` without prototype pollution protection or strict boolean assertions. | **Vulnerability**: Potential prototype pollution or unexpected type coercion affecting widget DOM styling. |
| **Default Tenant Fallback** | `resolveTenantId()` returned `"default"` when headers or origin were unrecognized; `getTenantConfig()` returned fallback structures. | **Security Risk**: Unknown tenants risked falling back to demo or primary client configurations, violating multi-tenant boundaries. |
| **Embed Chatbot Page** | Rendered `<AicyroChatbot tenantId={tenantId} />` directly without validating tenant existence, active status, or allowed origin. | **Security Risk**: Inactive or unauthorized tenants could be loaded into iframes across unauthorized external websites. |

---

### 2. The 7-Item Operational Activation Checklist Contract

The core schema and validation logic are codified in `src/lib/onboardingContract.js`. A tenant must satisfy all seven checklist criteria to achieve **100% readiness** and `active` status:

```
                            ┌────────────────────────────────────────┐
                            │    Tenant Activation Request (PUT)     │
                            │    Payload: { enabled: true }          │
                            └───────────────────┬────────────────────┘
                                                │
                                                ▼
                            ┌────────────────────────────────────────┐
                            │  validateTenantReadiness(tenantData)   │
                            └───────────────────┬────────────────────┘
                                                │
                       ┌────────────────────────┴────────────────────────┐
                       ▼                                                 ▼
             [Score < 100% / Missing Items]                      [Score === 100%]
        ┌────────────────────────────────────────┐         ┌─────────────────────────┐
        │ HTTP 422 Unprocessable Entity         │         │ HTTP 200 OK             │
        │ Code:                                  │         │ Tenant enabled: true    │
        │ TENANT_ACTIVATION_REQUIREMENTS_UNMET  │         │ Status: ACTIVE          │
        │ Returns: missing[], checklist details  │         │ Database write executed │
        └────────────────────────────────────────┘         └─────────────────────────┘
```

#### Detailed Checklist Criteria:

1. **`allowed_domains` (Allowed Sites/Domains)**:
   - At least one explicit production domain (e.g., `https://client.com`) must be configured.
   - Wildcard `*` is strictly prohibited in production.
   - Normalized origin matching ensures secure protocols (`https://`) cannot be spoofed by insecure protocols (`http://`).
2. **`tenant_mapping` (Tenant Identifier & Mapping)**:
   - Slug must be between 4 and 50 characters, containing only lowercase alphanumeric characters, underscores, and hyphens (`^[a-z0-9_-]{4,50}$`).
   - Reserved slugs are strictly rejected: `default`, `primary_client`, `system`, `admin`, `superadmin`, `closedesk`.
3. **`services_areas` (Services & Operating Areas)**:
   - $\ge 1$ supported service must be explicitly declared in `business_profile.services` or `chatbot_config.services`.
   - $\ge 1$ geographic operating area, city, or zip code must be configured in `business_profile.operating_areas` or `business_profile.service_areas`.
4. **`timezone_hours` (Timezone & Business Operating Hours)**:
   - A valid IANA timezone identifier must be configured (validated against `Intl.DateTimeFormat`).
   - A standard weekly business hours schedule must be defined with $\ge 5$ operational days having valid 24-hour time ranges (`HH:MM-HH:MM`).
5. **`approved_policies` (Knowledge Base & Approved Policies)**:
   - Tenant business FAQs or knowledge base entries must be present ($\ge 1$ entry).
   - Compliance & Privacy Policy agreement must be explicitly confirmed (`privacy_policy_approved === true`).
6. **`supported_modes` (Operational Modes)**:
   - At least one permitted operational mode (`chat`, `voice`, `vision`) must be explicitly enabled.
7. **`recipients_limits` (Recipients & Safety Rate Limits)**:
   - A valid RFC 5322 notification recipient email address must be configured.
   - An hourly rate limit must be bounded between 1 and 1,000 requests per hour.

---

### 3. Embed Widget Hardening & Security Architecture

Embed communications were hardened in `public/widget.js` and `src/Closedesk/Chatbot/AicyroChatbot.jsx`:

1. **Origin Verification**:
   - `public/widget.js` extracts the configured origin from `script.getAttribute("data-base-url")` or `new URL(script.src).origin`.
   - When a `message` event arrives, `event.origin` must strictly match `baseUrl`.
2. **Window Source Check**:
   - Inbound postMessage events verify `event.source === iframe.contentWindow`, preventing malicious frames or popups from impersonating the chatbot widget.
3. **Defensive Prototype Pollution Check**:
   - Uses `Object.prototype.hasOwnProperty.call(event.data, key)` to block payloads containing `__proto__`, `constructor`, or `prototype`.
4. **Strict Type Assertions**:
   - `isExpanded` and `hasPeek` attributes are strictly checked (`typeof event.data.isExpanded === "boolean"`), eliminating unexpected CSS injection or DOM manipulation.
5. **Fail-Closed Embed Routing**:
   - If `data-tenant-id` is missing, `widget.js` immediately halts execution and logs a warning rather than defaulting to `"default"`.
   - In `src/pages/embed/chatbot.jsx`, if a tenant ID is missing, unknown, inactive (`enabled: false`), or embedded on an unauthorized origin, an `EmbedErrorCard` is rendered with an explicit error code (`TENANT_REQUIRED`, `TENANT_NOT_FOUND`, `TENANT_INACTIVE`, `EMBED_ORIGIN_PROHIBITED`).

---

### 4. Repeatable Provisioning Proof: Second Tenant (`summit_plumbing`)

Repeatability was independently verified by provisioning a second tenant (`summit_plumbing`) purely via configuration data, without modifying application source code:

1. **Tenant 1 (`brightstar_hvac`)**:
   - Industry: HVAC
   - Domain: `https://brightstarhvac.com`
   - Timezone: `America/Chicago`
   - Modes: `["chat", "voice"]`
   - Services: AC Repair, Furnace Installation
2. **Tenant 2 (`summit_plumbing`)**:
   - Industry: Plumbing
   - Domain: `https://summitplumbing.com`
   - Timezone: `America/Denver`
   - Modes: `["chat", "vision"]`
   - Services: Emergency Drain Clearing, Pipe Repair
3. **Synthetic Inquiries & Partition Isolation**:
   - Lead 1 routed to `tenants/brightstar_hvac/leads/lead_hvac_001`.
   - Lead 2 routed to `tenants/summit_plumbing/leads/lead_plumb_002`.
   - Verified that neither partition contained peer tenant leads.
   - Verified that the global `/leads` root partition remained completely unpolluted (0 records).

---

### 5. Verification & Acceptance Test Matrix

The CD11 test suite (`scripts/cd11_tenant_onboarding_suite.js`) executed **85 tests across 7 verification sections with 100% pass rate**:

| Section | Focus Area | Assertions | Result |
| :--- | :--- | :---: | :---: |
| **Section 1** | 7-Item Activation Checklist Schema & Scoring | 25 | **PASS (25/25)** |
| **Section 2** | Gating Activation via API (HTTP 422 Rejection) | 9 | **PASS (9/9)** |
| **Section 3** | Allowed Sites/Domains & Origin Whitelisting | 10 | **PASS (10/10)** |
| **Section 4** | Embed Widget Security & postMessage Defense | 15 | **PASS (15/15)** |
| **Section 5** | Fail-Closed Multi-Tenancy & Default Leak Elimination | 17 | **PASS (17/17)** |
| **Section 6** | Repeatable Onboarding (Second Tenant Provisioning) | 4 | **PASS (4/4)** |
| **Section 7** | Synthetic Inquiry Routing & Partition Isolation | 5 | **PASS (5/5)** |
| **Total** | **Deterministic Automated Acceptance Evidence** | **85** | **100% PASS** |

---

### 6. Full Regression Suite Sign-off

| Suite Command | Target Scope | Tests Passed | Status |
| :--- | :--- | :---: | :---: |
| `npm run test:cd11` | Tenant Onboarding, Gated Activation, Widget Security | **85 / 85** | **PASS** |
| `npm run test:cd02` | Privileged Access, Session Tokens, Step-Up Gating | **8 / 8** | **PASS** |
| `npm run test:cd03` | Multi-Tenant Isolation, Scoped Rules, Secret Redaction | **61 / 61** | **PASS** |
| `npm run test:cd06` | Lead Consistency, Idempotency Locks, Version Ordering | **30 / 30** | **PASS** |
| `npm run test:cd07` | Reliable Business Handoff, Queue Leases, Worker Fencing | **22 / 22** | **PASS** |
| `npm run test:cd08` | Policy Truthfulness, Operating Hours, Service Boundaries | **26 / 26** | **PASS** |
| `npm run test:cd09` | Voice Lifecycle, Concurrency Caps, Kill Switch | **28 / 28** | **PASS** |
| `npm run test:cd10` | Authoritative Appointment Workflow, Buffer Mutex | **46 / 46** | **PASS** |
| `npm run build` | Next.js Turbopack Production Production Compilation | **All Pages & APIs** | **PASS** |

---

### Conclusion

Ticket **CD11: Repeatable Tenant Onboarding & Activation Checklist (P0)** is **fully implemented, deterministically verified, and ready for production deployment**. All acceptance criteria are backed by automated regression tests and tamper-evident JSON evidence in `evaluations/cd11_onboarding_evidence.json`.
