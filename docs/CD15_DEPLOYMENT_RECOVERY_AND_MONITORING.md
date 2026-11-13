# CD15: Deployment Recovery, Monitoring, and Incident Runbook (P0)
## Multi-Component Versioning, Rollback Rehearsal, Isolated Tenant Recovery, Alert Storm Suppression, and Operational Runbook

---

### Executive Summary

| Project | CloseDesk Engine SaaS |
| :--- | :--- |
| **Ticket Reference** | **P0 Ticket CD15 — Deployment Recovery and Monitoring (P0 Minimum Runbook & P1 Scale Hardening)** |
| **Specification Sources** | **Sections 4.2 p15; 5.4–5.14 pp17–20; 5.18 p21; 11.1 p36** |
| **Branch** | `feature/CD15-deployment-recovery-and-monitoring` |
| **Audit Status** | **PASSED (Production-Ready, Evidence-Verified)** |
| **CD15 Test Matrix** | **54/54 Tests Passing Deterministically (0 Failures)** |
| **Full Regression Status** | **100% Pass Across All Pilot Test Suites (CD02, CD03, CD06, CD07, CD08, CD09, CD10, CD11, CD14, Build)** |
| **Observed Violations** | **0 Critical Violations (Zero Leaks, Zero Live Data Overwrites, Zero Duplicate Side Effects)** |
| **Verified Date** | November 5, 2026 |

CloseDesk previously lacked a unified release identification contract, binding application code, background cloud functions, database security rules, chatbot policy definitions, and deployment environments into disjointed artifacts. Operational alerting was unformatted, lacked named incident ownership, and lacked alert storm suppression controls. Furthermore, tenant data backups had no formal mathematical reconciliation pipeline or fail-closed protection against accidental synthetic restoration into live customer partitions.

Under **CD15 (P0)**, deployment recovery, monitoring, and incident operations have been formalized into an integrated, evidence-backed operational baseline:
1. **Unified Release Manifest**: Application (`2.1.0`), Worker (`2.1.0-cf-worker`), Rules (`2026.11.05-cd03-rules`), Policy/Config (`2.15.0`), and Environment versions are bundled into an immutable, verifiable manifest (`src/lib/releaseManifest.js`) exposed via authenticated SuperAdmin endpoints (`/api/superadmin/release-manifest`) and deployment health checks (`/api/version`).
2. **Named Incident & Release Ownership**: Named Primary Incident Commander (`ops-oncall@closedesk.com`, 15-minute SLA), Secondary Security Escalation Officer, and Release Coordinator with automated PagerDuty routing.
3. **Application & Config Rollback Rehearsal**: Verified that rolling back application configuration leaves pilot records (`leads`, `appointments`, `notification_jobs`) completely readable, while existing idempotency locks prevent duplicate side effects upon re-execution.
4. **Synthetic Tenant Export & Isolated Destination Recovery**: Complete tenant operational partitions are exported into cryptographic SHA-256 envelopes and restored strictly into isolated sandbox destinations (`quarantine/` or `isolated_recovery/`). Mathematical count and tenant ownership reconciliation confirms 100% fidelity.
5. **Anti-Corruption Boundary**: Direct restoration into live customer partitions (`tenants/brightstar_hvac`, `tenants/summit_plumbing`) is strictly prohibited and fails closed (`LIVE_CUSTOMER_PARTITION_RESTORE_PROHIBITED`).
6. **Actionable Incident Alerting**: Downstream provider failures (Calendar 500, SMTP timeout, Quota trips, Stale cleanup) generate actionable P0 alerts containing named incident owners and direct step-by-step remediation runbooks.
7. **Alert Storm Suppression**: Sliding 5-minute debouncing prevents alert floods across serverless instances, while a 10-count error tripwire immediately issues an aggregated spike alert.
8. **Failed-Queue & Dead-Letter Queue (DLQ)**: Failed notification jobs enforce bounded retries (`attempts <= 3`). Upon reaching the threshold, jobs transition to Dead-Letter state (`is_dead_letter: true`), halt automated retry thrashing, and require authorized manual replay (`/api/notifications/replay`).

---

### 1. Unified Release Manifest & Multi-Component Versioning

Per Sections 4.2 and 11.1, release verification requires binding all architectural layers together as a single identifiable release unit. The release manifest is codified in `src/lib/releaseManifest.js`:

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              CLOSEDESK RELEASE MANIFEST                                 │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  Release ID: rel_2.1.0_f2b247b                                                         │
│  Timestamp: 2026-11-05T21:40:00.000Z                                                   │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  Component Layers:                                                                     │
│  1. Application Version:    2.1.0              (package.json core runtime)             │
│  2. Worker Version:         2.1.0-cf-worker    (functions/index.js background tasks)   │
│  3. Rules Version:          2026.11.05-cd03-rules (database.rules.json security rules) │
│     Rules Checksum (SHA256): 49f360c2392f6e311618ea170be672711a5e5997d7894e32e8fdf4...│
│  4. Policy Config Version:  2.15.0             (ruleBook.js & policyEngine.js)         │
│  5. Environment Version:    pilot-production-2.1.0                                     │
│  6. Git Commit Ref:         f2b247b                                                    │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  Incident Management:                                                                  │
│  - Primary Incident Owner:  Platform SRE & Incident On-Call Lead                       │
│                             (ops-oncall@closedesk.com | SLA: 15 minutes)               │
│  - Secondary Escalation:    Principal Security Officer (security-ops@closedesk.com)    │
│  - Release Coordinator:     Release & DevOps Lead (release-ops@closedesk.com)          │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

#### Verification Invariants:
- All 5 version identifiers must be present, non-empty, and valid strings.
- The `database.rules.json` SHA-256 hash ensures that database security rules deployed to Firebase match the candidate commit exactly.
- SuperAdmins can inspect and audit the active release bundle via `GET /api/superadmin/release-manifest`.
- Monitoring probes can query `GET /api/version` for automated health and version tracking.

---

### 2. Incident Management, Escalation Tree & Contacts

The operational escalation matrix defines clear ownership and SLAs for production incidents:

| Escalation Tier | Role | Assigned Contact | Channel | Response SLA |
| :--- | :--- | :--- | :--- | :--- |
| **Tier 1 (Primary)** | Primary Incident Commander | Platform SRE On-Call Lead | `ops-oncall@closedesk.com`<br>`pagerduty://closedesk-sre-p0`<br>`+1-800-555-0199` | **15 minutes** |
| **Tier 2 (Secondary)** | Security & Governance Officer | Principal Security Engineer | `security-ops@closedesk.com`<br>`pagerduty://closedesk-sec-p0`<br>`+1-800-555-0198` | **30 minutes** |
| **Tier 3 (Executive)** | Head of Engineering | Platform Operations VP | `eng-leadership@closedesk.com` | **60 minutes** |
| **Release Lead** | Release Coordinator | Release & DevOps Lead | `release-ops@closedesk.com` | Prior to Release Gate Sign-off |

---

### 3. Emergency Switch-Off & Kill Switch Controls

In the event of an operational anomaly, security incident, or upstream provider failure, operations has four levels of emergency switch-off:

```
                                  ┌─────────────────────────────┐
                                  │   EMERGENCY SWITCH-OFF TREE │
                                  └──────────────┬──────────────┘
                                                 │
          ┌───────────────────────┬──────────────┴──────────────┬───────────────────────┐
          ▼                       ▼                             ▼                       ▼
┌──────────────────┐    ┌──────────────────┐          ┌──────────────────┐    ┌──────────────────┐
│ Level 1: Global  │    │ Level 2: Tenant  │          │ Level 3: Tenant  │    │ Level 4: Engine  │
│ Voice Kill       │    │ Voice Kill       │          │ Readiness Halt   │    │ Maintenance      │
├──────────────────┤    ├──────────────────┤          ├──────────────────┤    ├──────────────────┤
│ Scope: Platform  │    │ Scope: Specific  │          │ Scope: Specific  │    │ Scope: Global    │
│ Target: settings/│    │ Target: tenants/ │          │ Target: tenants/ │    │ Target: settings/│
│ global_voice     │    │ {id}/chatbot_conf│          │ {id}/config      │    │ maintenance      │
│ Action: Revokes  │    │ Action: Hides UI │          │ Action: Embed    │    │ Action: Returns  │
│ all voice tokens │    │ mic button &     │          │ falls back to    │    │ 503 service      │
│ (HTTP 503).      │    │ blocks /token.   │          │ inactive card.   │    │ unavailable.     │
└──────────────────┘    └──────────────────┘          └──────────────────┘    └──────────────────┘
```

#### Operational Runbook Procedures:

#### 3.1 Activating Global Voice Kill Switch
1. In Firebase Realtime Database or SuperAdmin Settings Console:
   - Path: `settings/global_voice`
   - Set: `{"enabled": false, "reason": "Emergency global voice kill-switch activated", "disabled_at": "<ISO-TIMESTAMP>"}`
2. Alternatively, set environment variable `VOICE_GLOBAL_KILL_SWITCH=true` in hosting provider dashboard.
3. **Observed System Effect**: All calls to `/api/openai-token` and `/api/voice/session` immediately return `HTTP 503 Service Unavailable` with scope `"global"`. Frontend widgets hide voice controls and gracefully fall back to text chat.

#### 3.2 Activating Tenant Voice Kill Switch
1. In Firebase Realtime Database:
   - Path: `tenants/{tenantId}/chatbot_config`
   - Set: `{"voiceEnabled": false, "voiceChatAgent": false, "voice_status_reason": "Disabled by tenant admin"}`
2. **Observed System Effect**: Voice token issuance for `{tenantId}` returns `HTTP 403 Forbidden` (`TENANT_VOICE_DISABLED`), leaving other tenants and the text chat unaffected.

#### 3.3 Halting Inactive or Compromised Tenant
1. In SuperAdmin Console or Firebase:
   - Path: `tenants/{tenantId}/config`
   - Set: `{"enabled": false}`
2. **Observed System Effect**: Embed widget on external websites renders the secure `EmbedErrorCard` (`TENANT_INACTIVE`), and all inbound chat/lead submissions return `HTTP 403`.

---

### 4. Failed-Queue & Dead-Letter Queue (DLQ) Handling

Per Sections 5.17 and 8.10, notification delivery must be bounded, traceable, and protected against infinite retry loops.

```
                           ┌────────────────────────────────────────┐
                           │   Lead Notification Job Enqueued       │
                           │   Path: /tenants/{id}/notification_jobs│
                           └───────────────────┬────────────────────┘
                                               │
                                               ▼
                           ┌────────────────────────────────────────┐
                           │      Worker Claims Job (Lease Lock)    │
                           │      Status: "claimed" | Version: N    │
                           └───────────────────┬────────────────────┘
                                               │
                                 ┌─────────────┴─────────────┐
                                 │ Attempt Delivery via SMTP │
                                 └─────────────┬─────────────┘
                                               │
                        ┌──────────────────────┴──────────────────────┐
                        ▼                                             ▼
              [Provider Accepted]                             [Provider Rejected / 500]
      Status: "provider_accepted"                                     │
      Ack: "unacknowledged"                                           ▼
      Emits: delivery_attempts record                 Increment attempts count (attempts++)
                                                                      │
                                                ┌─────────────────────┴─────────────────────┐
                                                ▼                                           ▼
                                        [Attempts < 3]                              [Attempts >= 3]
                               Status: "failed"                            Status: "failed"
                               next_retry_at: Exponential Backoff          is_dead_letter: true
                               Emits: provider_failure Alert               next_retry_at: null (Retries Haltered)
                                                                           Emits: dead_letter_threshold Alert
                                                                                        │
                                                                                        ▼
                                                                           [Requires Manual Replay]
                                                                           POST /api/notifications/replay
```

#### Dead-Letter Queue Operational Rules:
1. **Retry Bound (`MAX_DELIVERY_RETRIES = 3`)**: A job is retried with exponential jittered backoff at most 3 times.
2. **Dead-Letter State**: On the 3rd failure, `is_dead_letter` is flagged `true`, and `next_retry_at` is set to `null` to stop worker thrashing.
3. **DLQ Alert**: An actionable P0 alert `dead_letter_queue_threshold_exceeded` is dispatched to the incident commander.
4. **Manual Replay Procedure**:
   - Operator investigates failure reason in `tenants/{tenantId}/delivery_attempts/{jobId}`.
   - Operator verifies or updates `tenants/{tenantId}/notification_settings`.
   - Operator submits authenticated replay request:
     ```bash
     curl -X POST https://api.closedesk.com/api/notifications/replay \
       -H "Authorization: Bearer <OPERATOR_JWT>" \
       -H "Content-Type: application/json" \
       -d '{"job_id": "job_retry_test"}'
     ```
   - Replay resets status to `"queued"`, increments `replay_count: 1`, and logs `replayed_by: "sre_operator_john"`.
5. **Cross-Tenant Protection**: Replaying a job belonging to Tenant A with Tenant B credentials is strictly rejected with `HTTP 403 Forbidden` (`CROSS_TENANT_REPLAY_FORBIDDEN`).

---

### 5. Application & Configuration Rollback Runbook

When a faulty release commit or bad configuration must be rolled back:

#### Rollback Execution Procedure:
1. **Identify Rollback Target**: Select the last known-good git commit (e.g., `git checkout <KNOWN_GOOD_SHA>`).
2. **Execute Deployment Rollback**: Trigger hosting rollback in Netlify/Vercel or redeploy container.
3. **Verify Database Backward Compatibility**:
   - CloseDesk data contracts (`leadContract.js`, `appointmentContract.js`, `handoffContract.js`) use strict additive schema design.
   - Pilot records generated under newer versions preserve required base fields (`id`, `created_at`, `tenant_id`, `status`), allowing older runtimes to read and parse them without runtime exceptions.
4. **Verify Idempotency Side-Effect Suppression**:
   - Re-running transactions or webhook replays against existing idempotency locks checks `status === "COMPLETED"`.
   - The rolled-back runtime immediately returns the cached transaction response without re-executing calendar bookings or re-sending notification emails.
5. **Post-Rollback Verification Checklist**:
   - [ ] Query `GET /api/version` to confirm active application version.
   - [ ] Run `npm run test:cd15` to verify rollback invariant assertions pass.
   - [ ] Inspect `system_alerts` queue to confirm zero active alert spikes.

---

### 6. Tenant Export & Isolated Recovery Runbook

Per Section 11.3, backup and recovery operations must be rehearsed against synthetic tenant data and mathematically reconciled without risking live customer partitions.

#### 6.1 Tenant Export Procedure
Exports the complete operational partition (`leads`, `appointments`, `notification_jobs`, `delivery_attempts`, `config`, `notification_settings`):
```javascript
import { exportTenantData } from "./src/lib/tenantBackupRecovery.js";

const exportEnvelope = await exportTenantData({
  tenantId: "brightstar_hvac",
  exportedBy: "sre_incident_lead",
});
// Generates tamper-evident JSON envelope with record_counts and checksum_sha256
```

#### 6.2 Isolated Sandbox Recovery & Count Reconciliation
Restores the envelope into an isolated quarantine partition:
```javascript
import { recoverTenantToIsolatedDestination } from "./src/lib/tenantBackupRecovery.js";

const report = await recoverTenantToIsolatedDestination({
  exportEnvelope,
  targetDestinationPath: "quarantine/tenant_recovery_test",
  recoveredBy: "sre_dr_runner",
});
```

#### 6.3 Mathematical Reconciliation Report
The recovery engine reads back the restored partition and compares counts and hashes:
```json
{
  "reconciliation_status": "RECONCILED",
  "is_isolated": true,
  "source_tenant_id": "brightstar_hvac",
  "isolated_destination": "quarantine/tenant_recovery_test",
  "source_counts": {
    "leads": 2,
    "appointments": 1,
    "notification_jobs": 1,
    "delivery_attempts": 1
  },
  "recovered_counts": {
    "leads": 2,
    "appointments": 1,
    "notification_jobs": 1,
    "delivery_attempts": 1
  },
  "checksum_verified": true,
  "ownership_verified": true,
  "live_partition_protected": true,
  "reconciled_at": "2026-11-05T21:48:00.000Z"
}
```

#### 6.4 Critical Anti-Corruption Boundary
> [!CAUTION]
> **Live Customer Partition Overwrite Defense**:
> Attempts to recover synthetic or backup data into live customer partitions (`tenants/brightstar_hvac`, `tenants/summit_plumbing`, or any registered live tenant) are **strictly blocked at the contract level** (`LIVE_CUSTOMER_PARTITION_RESTORE_PROHIBITED`).
> Recovery paths MUST begin with `quarantine/`, `isolated_recovery/`, or `tenants/isolated_recovery_`.

---

### 7. Actionable Alerting & Alert Storm Suppression

Operational alerts are codified in `src/lib/alertManager.js`:

#### 7.1 Monitored Operational Triggers
1. **`failed_handoff`**: Inbound lead could not be routed; destination email missing or malformed.
2. **`provider_failure`**: Downstream integration (Google Calendar, SMTP, OpenAI) returned 500 error or timed out.
3. **`quota_trip`**: Inbound traffic or API requests exceeded tenant or platform rate limits.
4. **`stale_cleanup`**: Scheduled log retention cleanup job failed or was aborted due to unapproved policy.
5. **`dead_letter_queue_threshold_exceeded`**: Notification job failed 3 times and was quarantined in DLQ.
6. **`database_unavailable`**: Realtime Database write or read exceeded the 800ms `safeDb` threshold.

#### 7.2 Actionable Alert Payload Format
Alerts delivered to incident owners contain direct remediation context:
```json
{
  "alert_id": "alt_brightstar_hvac_1762379400000",
  "severity": "P0",
  "title": "🚨 [P0] CloseDesk Operational Alert: PROVIDER_FAILURE (Tenant: brightstar_hvac)",
  "event_name": "provider_failure",
  "tenant_id": "brightstar_hvac",
  "provider_id": "google_calendar",
  "error_code": "PROVIDER_500_OUTAGE",
  "error_message": "Google Calendar API returned 500 Internal Server Error during commit",
  "correlation_id": "tx_chaos_cal_001",
  "incident_owner": {
    "name": "Platform SRE & Incident On-Call Lead",
    "email": "ops-oncall@closedesk.com",
    "sla_minutes": 15,
    "escalation_channel": "pagerduty://service/closedesk-sre-p0"
  },
  "actionable_remediation": {
    "runbook_section": "CD15 Runbook Section 4.2 (Downstream Provider Outage Recovery)",
    "immediate_steps": [
      "1. Check status of downstream provider (Google Calendar, SMTP, OpenAI).",
      "2. Confirm tenant fallback authorization if custom SMTP is unreachable.",
      "3. Ensure requests are safely downgraded to 'request_recorded' with zero ghost records.",
      "4. Monitor dead-letter queue for replay when provider recovers."
    ]
  }
}
```

#### 7.3 Alert Storm Prevention Controls
- **Sliding Window Debouncing**: Duplicate errors for the same `(environment, tenant, service, event, provider)` are throttled within a **5-minute window (`THROTTLE_WINDOW_MS = 300,000ms`)**. The first error is dispatched immediately; subsequent errors increment `suppressed_count`.
- **Spike Tripwire**: If 10 errors occur within the throttle window, the debouncer breaks silence and immediately dispatches an aggregated **HIGH ERROR RATE SPIKE ALERT** (`is_spike: true`).

---

### 8. Acceptance Test Matrix (`scripts/cd15_deployment_recovery_suite.js`)

The CD15 acceptance suite executed **54 automated assertions across 8 operational suites**, with **54 passing and 0 failures**:

```
================================================================================
   CD15 DEPLOYMENT RECOVERY & MONITORING — AUDIT TEST EXECUTION
================================================================================
 Suite 1: Unified Release Manifest & Multi-Component Versioning [13/13 PASS]
 Suite 2: Application & Config Rollback Rehearsal               [ 3/ 3 PASS]
 Suite 3: Synthetic Tenant Export & Isolated Sandbox Recovery   [13/13 PASS]
 Suite 4: Live Customer Partition Restoration Protection        [ 3/ 3 PASS]
 Suite 5: Actionable Incident Alerting & Provider 500 Injection  [ 7/ 7 PASS]
 Suite 6: Alert Storm Prevention & Rate Limiting Controls        [ 3/ 3 PASS]
 Suite 7: Failed-Queue & Dead-Letter Queue (DLQ) Handling       [ 8/ 8 PASS]
 Suite 8: Emergency Switch-Off & Kill Switch Verification       [ 4/ 4 PASS]
--------------------------------------------------------------------------------
 Total Test Assertions:  54
 Passed Assertions:      54
 Failed Assertions:       0
 Release Gate Status:    APPROVED_FOR_RELEASE
================================================================================
```

---

### 9. P1 Scale Hardening Roadmap

While P0 minimum runbook requirements are fully met, the following scale hardening items are prioritized for P1:

| Area | P1 Objective | Implementation Approach |
| :--- | :--- | :--- |
| **Distributed Alert Throttling** | Multi-instance Redis / Upstash debouncing | Replace in-memory `alertCache` with distributed Redis token bucket across serverless edge regions. |
| **Automated DLQ Replay Worker** | Autonomous backoff recovery | Background Cloud Function triggered every 15 minutes to re-evaluate DLQ jobs whose downstream providers have recovered. |
| **Cross-Region Database Replicas** | Multi-region disaster recovery | Configure secondary read-replicas in GCP europe-west1 with automated DNS failover. |
| **Tenant Partition Auto-Archiving** | Cold storage lifecycle | Automatically stream records older than 90 days from Firebase RTDB to Google Cloud Storage (GCS) Parquet cold tiers. |

---

### 10. Operational Sign-Off and Certification

> [!IMPORTANT]
> **CD15 Release Sign-Off Statement**:
> 1. **Release Manifest Bundled**: Application, worker, rules, and policy versions are unified and verifiable.
> 2. **Rollback Rehearsed**: Known-good rollback maintains record readability and prevents duplicate side effects via idempotency.
> 3. **Isolated Recovery Reconciled**: Export/recovery drill verified 100% count and ownership reconciliation in an isolated destination.
> 4. **Live Data Protected**: Synthetic test data is strictly prohibited from restoring into live customer partitions.
> 5. **Actionable Alerting & DLQ**: Provider failure alerts deliver actionable runbooks to named owners; alert storms are bounded; failed jobs transition to DLQ after 3 retries.
> 6. **Production Build**: Next.js 16.1.6 production compilation succeeds with 0 errors.

**Candidate Commit Release Status**: **APPROVED FOR PILOT DEPLOYMENT (P0)**.
