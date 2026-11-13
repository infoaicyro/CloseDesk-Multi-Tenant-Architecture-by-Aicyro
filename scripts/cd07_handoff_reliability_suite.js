// scripts/cd07_handoff_reliability_suite.js
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Register custom ESM extension loader to allow Next.js route handlers to load in Node ESM
register("./scripts/esm_loader.mjs", pathToFileURL("./"));

// Dynamically import project modules
const {
  DELIVERY_STATUS,
  ACKNOWLEDGEMENT_STATUS,
  FOLLOW_UP_STATUS,
  isValidDeliveryTransition,
  isValidRecipientEmail,
  calculateExponentialBackoffMs,
  createNotificationJob,
  createDeliveryAttemptRecord,
} = await import("../src/lib/handoffContract.js");

const {
  resolveTenantRecipient,
  enqueueNotificationJob,
  claimNotificationJob,
  recordDeliveryAttempt,
  updateJobDeliveryStatus,
  acknowledgeNotificationJob,
  replayNotificationJob,
} = await import("../src/lib/handoffManager.js");

const { default: notificationsIndexHandler } = await import("../src/pages/api/notifications/index.js");
const { default: acknowledgeHandler } = await import("../src/pages/api/notifications/acknowledge.js");
const { default: replayHandler } = await import("../src/pages/api/notifications/replay.js");
const { default: settingsHandler } = await import("../src/pages/api/notifications/settings.js");

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
    const val = this.store.get(p);
    return val !== undefined && val !== null ? JSON.parse(JSON.stringify(val)) : null;
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
function createMockReqRes({ method = "POST", headers = {}, url = "/api/test", body = {}, query = {} } = {}) {
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
    json(data) {
      responseData = data;
      return res;
    },
    send(data) {
      responseData = data;
      return res;
    },
    setHeader(key, value) {
      resHeaders[key.toLowerCase()] = value;
      return res;
    },
    end() {
      return res;
    },
    getStatusCode() {
      return statusCode;
    },
    getBody() {
      return responseData;
    },
    getHeaders() {
      return resHeaders;
    },
  };

  return { req, res };
}

/**
 * Test Runner State
 */
const testResults = [];

function assert(condition, testName, details = "") {
  if (condition) {
    testResults.push({ name: testName, status: "PASSED", details });
    console.log(`  \x1b[32m✔\x1b[0m [PASS] ${testName}${details ? ` -> ${details}` : ""}`);
  } else {
    testResults.push({ name: testName, status: "FAILED", details });
    console.error(`  \x1b[31m✖\x1b[0m [FAIL] ${testName}${details ? ` -> ${details}` : ""}`);
  }
}

async function runAllTests() {
  console.log("\n================================================================================");
  console.log("   CD07: RELIABLE BUSINESS HANDOFF (P0) — ACCEPTANCE TEST SUITE");
  console.log("================================================================================\n");

  const memDb = new InMemoryDb();

  // -------------------------------------------------------------------------
  // SECTION 1: Recipient Resolution and Strict Validation (Phases 1-4)
  // -------------------------------------------------------------------------
  console.log("\n--- SECTION 1: Recipient Resolution and Syntax Validation ---");

  // TEST 1: Valid RFC 5322 recipient validation
  {
    const validEmails = [
      "lead-receiver@company.com",
      "sales.support+routing@domain.co.uk",
      "admin_123@sub.domain.org",
      "operator@domain.io",
    ];
    const invalidEmails = [
      "notanemail",
      "@nodomain.com",
      "missing.at.sign.com",
      "spaces in@email.com",
      "user@",
      "",
      null,
      undefined,
    ];

    const allValidsPass = validEmails.every(isValidRecipientEmail);
    const allInvalidsFail = invalidEmails.every((e) => !isValidRecipientEmail(e));

    assert(
      allValidsPass && allInvalidsFail,
      "TEST 1: RFC 5322 Recipient syntax validation accurately accepts valid and rejects malformed addresses",
      `Valid=${allValidsPass}, InvalidRejected=${allInvalidsFail}`
    );
  }

  // TEST 2: Tenant-specific recipient configuration resolution
  {
    memDb.clear();
    await memDb.set("tenants/tenant_alpha/notification_settings", {
      adminEmail: "Alpha.Sales@Company.com ",
      emailAlerts: true,
      urgentOnly: false,
    });

    const res = await resolveTenantRecipient({ tenantId: "tenant_alpha", dbOps: memDb });

    assert(
      res.valid === true && res.recipient === "alpha.sales@company.com" && res.source === "tenant_notification_settings",
      "TEST 2: resolveTenantRecipient resolves tenant-approved recipient in lowercase without cross-tenant pollution",
      `Recipient=${res.recipient}`
    );
  }

  // TEST 3: Missing recipient -> visible config failure, NO arbitrary fallback
  {
    memDb.clear();
    // No settings stored for tenant_empty
    const res = await resolveTenantRecipient({ tenantId: "tenant_empty", dbOps: memDb });

    assert(
      res.valid === false && res.recipient === null && res.source === "missing_settings",
      "TEST 3: Missing recipient produces visible configuration failure and halts dispatch without default fallback",
      `Reason=${res.reason}`
    );
  }

  // TEST 4: Invalid recipient syntax stored in settings produces validation failure
  {
    memDb.clear();
    await memDb.set("tenants/tenant_bad_syntax/notification_settings", {
      adminEmail: "invalid-email-address",
      emailAlerts: true,
    });

    const res = await resolveTenantRecipient({ tenantId: "tenant_bad_syntax", dbOps: memDb });

    assert(
      res.valid === false && res.source === "malformed_recipient",
      "TEST 4: Malformed recipient syntax in tenant configuration is rejected with malformed_recipient source",
      `Source=${res.source}`
    );
  }

  // TEST 5: Explicitly disabled notifications halts dispatch cleanly
  {
    memDb.clear();
    await memDb.set("tenants/tenant_muted/notification_settings", {
      adminEmail: "alerts@muted.com",
      emailAlerts: false,
    });

    const res = await resolveTenantRecipient({ tenantId: "tenant_muted", dbOps: memDb });

    assert(
      res.valid === false && res.disabled === true && res.source === "notifications_disabled",
      "TEST 5: Explicitly disabled tenant notifications halts dispatch cleanly with notifications_disabled",
      `Disabled=${res.disabled}`
    );
  }

  // -------------------------------------------------------------------------
  // SECTION 2: Queue Creation, Idempotency & Persistence (Phases 3 & 4)
  // -------------------------------------------------------------------------
  console.log("\n--- SECTION 2: Queue Creation, Deduplication & Persistence ---");

  // TEST 6: Valid lead + configured recipient creates durable queued job
  {
    memDb.clear();
    await memDb.set("tenants/tenant_test/notification_settings", {
      adminEmail: "ops@tenant.com",
      emailAlerts: true,
    });

    const { job, created } = await enqueueNotificationJob({
      tenantId: "tenant_test",
      leadId: "lead_101",
      title: "New Inbound Inquiry",
      message: "Lead interested in Enterprise Plan",
      leadData: { name: "John Doe", email: "john@example.com" },
      eventType: "created",
      dbOps: memDb,
    });

    const stored = await memDb.get(`tenants/tenant_test/notification_jobs/${job.job_id}`);

    assert(
      created === true &&
      stored &&
      stored.delivery_status === DELIVERY_STATUS.QUEUED &&
      stored.acknowledgement_status === ACKNOWLEDGEMENT_STATUS.UNACKNOWLEDGED &&
      (stored.assigned_recipient === "ops@tenant.com" || stored.recipient === "ops@tenant.com"),
      "TEST 6: Valid lead with configured recipient persists durable queued notification job",
      `JobId=${job.job_id}, Status=${stored?.delivery_status}`
    );
  }

  // TEST 7: Duplicate lead event -> deduplicated handoff (idempotent enqueue)
  {
    const { job: duplicateJob, created: duplicateCreated } = await enqueueNotificationJob({
      tenantId: "tenant_test",
      leadId: "lead_101",
      title: "New Inbound Inquiry",
      message: "Lead interested in Enterprise Plan",
      eventType: "created",
      dbOps: memDb,
    });

    assert(
      duplicateCreated === false && duplicateJob.job_id === "job_lead_101_created",
      "TEST 7: Duplicate lead event with same leadId and eventType returns existing job without duplicate insertion",
      `DuplicateCreated=${duplicateCreated}, JobId=${duplicateJob.job_id}`
    );
  }

  // TEST 8: Enqueue when recipient missing marks job as failed with configuration audit, preserving lead
  {
    const { job: failedJob } = await enqueueNotificationJob({
      tenantId: "tenant_no_config",
      leadId: "lead_202",
      title: "Unconfigured Tenant Inquiry",
      message: "Customer asking for quote",
      leadData: { name: "Bob Smith", email: "bob@example.com" },
      dbOps: memDb,
    });

    const storedFailed = await memDb.get(`tenants/tenant_no_config/notification_jobs/${failedJob.job_id}`);

    assert(
      storedFailed &&
      storedFailed.delivery_status === DELIVERY_STATUS.FAILED &&
      storedFailed.error_code === "MISSING_RECIPIENT",
      "TEST 8: Inbound lead on unconfigured tenant preserves lead and records visible configuration failure",
      `ErrorCode=${storedFailed?.error_code}`
    );
  }

  // -------------------------------------------------------------------------
  // SECTION 3: Worker Reliability, Atomic Leases & Fencing (Phases 5 & 6)
  // -------------------------------------------------------------------------
  console.log("\n--- SECTION 3: Worker Leases, Concurrency & Fencing Tokens ---");

  // TEST 9: Concurrent workers -> safe claiming, exactly one winner
  {
    memDb.clear();
    await memDb.set("tenants/tenant_racing/notification_settings", {
      adminEmail: "racing@tenant.com",
      emailAlerts: true,
    });

    const { job } = await enqueueNotificationJob({
      tenantId: "tenant_racing",
      leadId: "lead_race_1",
      title: "Race Test",
      message: "Testing atomic worker claim",
      eventType: "lead_capture",
      dbOps: memDb,
    });

    // Worker 1 and Worker 2 try to claim concurrently
    const [claim1, claim2] = await Promise.all([
      claimNotificationJob({ tenantId: "tenant_racing", jobId: job.job_id, workerId: "worker_node_1", dbOps: memDb }),
      claimNotificationJob({ tenantId: "tenant_racing", jobId: job.job_id, workerId: "worker_node_2", dbOps: memDb }),
    ]);

    const winnerCount = (claim1.claimed ? 1 : 0) + (claim2.claimed ? 1 : 0);

    assert(
      winnerCount === 1,
      "TEST 9: Concurrent workers race to claim job; atomic lease grants exactly one claim winner",
      `Worker1Claimed=${claim1.claimed}, Worker2Claimed=${claim2.claimed}`
    );
  }

  // TEST 10: Worker crash / lease expiration recovery
  {
    // Simulate Worker 1 holding a lease that expired 10 seconds ago
    const expiredTimestamp = new Date(Date.now() - 10000).toISOString();
    await memDb.update("tenants/tenant_racing/notification_jobs/job_lead_race_1_lead_capture", {
      delivery_status: DELIVERY_STATUS.CLAIMED,
      claimed_by: "worker_crashed",
      lease_expires_at: expiredTimestamp,
    });

    // Worker 3 now attempts to claim
    const claimAfterCrash = await claimNotificationJob({
      tenantId: "tenant_racing",
      jobId: "job_lead_race_1_lead_capture",
      workerId: "worker_node_3",
      dbOps: memDb,
    });

    assert(
      claimAfterCrash.claimed === true && claimAfterCrash.job.claimed_by === "worker_node_3",
      "TEST 10: Crashed worker's expired lease is successfully recovered and re-claimed by an active worker",
      `NewClaimer=${claimAfterCrash.job?.claimed_by}`
    );
  }

  // TEST 11: Stale worker update rejection (fencing token protects against zombie workers)
  {
    // Stale Worker 1 has fencing token version 1
    const staleResult = await updateJobDeliveryStatus({
      tenantId: "tenant_racing",
      jobId: "job_lead_race_1_lead_capture",
      targetStatus: DELIVERY_STATUS.PROVIDER_ACCEPTED,
      fencingToken: 1, // Stale! The job has incremented version after Worker 3 claim
      dbOps: memDb,
    });

    assert(
      staleResult.success === false && staleResult.reason === "fencing_token_mismatch",
      "TEST 11: Stale worker update with outdated fencing token is rejected without mutating state",
      `RejectedReason=${staleResult.reason}`
    );
  }

  // TEST 12: Permitted Delivery Transition Matrix enforcement
  {
    const queuedToClaimed = isValidDeliveryTransition(DELIVERY_STATUS.QUEUED, DELIVERY_STATUS.CLAIMED);
    const claimedToAccepted = isValidDeliveryTransition(DELIVERY_STATUS.CLAIMED, DELIVERY_STATUS.PROVIDER_ACCEPTED);
    const acceptedToQueued = isValidDeliveryTransition(DELIVERY_STATUS.PROVIDER_ACCEPTED, DELIVERY_STATUS.QUEUED);
    const failedToClaimed = isValidDeliveryTransition(DELIVERY_STATUS.FAILED, DELIVERY_STATUS.CLAIMED);

    assert(
      queuedToClaimed && claimedToAccepted && !acceptedToQueued && !failedToClaimed,
      "TEST 12: Delivery Transition Matrix enforces strict forward progression and rejects invalid regressions",
      `Queued->Claimed:${queuedToClaimed}, Accepted->Queued:${acceptedToQueued}`
    );
  }

  // -------------------------------------------------------------------------
  // SECTION 4: Provider Semantics, Ambiguity & Retries (Phases 3, 5, 6)
  // -------------------------------------------------------------------------
  console.log("\n--- SECTION 4: Provider Delivery Semantics & Failure Recovery ---");

  // TEST 13: Provider acceptance -> provider_accepted, NOT acknowledged
  {
    memDb.clear();
    await memDb.set("tenants/tenant_prov/notification_settings", { adminEmail: "sales@tenantprov.com" });

    const { job } = await enqueueNotificationJob({
      tenantId: "tenant_prov",
      leadId: "lead_303",
      title: "VIP Booking",
      message: "Lead booked demo",
      eventType: "lead_capture",
      dbOps: memDb,
    });

    const claimed = await claimNotificationJob({
      tenantId: "tenant_prov",
      jobId: job.job_id,
      workerId: "active_worker",
      dbOps: memDb,
    });

    // Simulate provider 250 OK response
    await recordDeliveryAttempt({
      tenantId: "tenant_prov",
      jobId: job.job_id,
      attemptNumber: 1,
      recipient: "sales@tenantprov.com",
      status: DELIVERY_STATUS.PROVIDER_ACCEPTED,
      providerMessageId: "<msg-9923812@mail.service.com>",
      dbOps: memDb,
    });

    await updateJobDeliveryStatus({
      tenantId: "tenant_prov",
      jobId: job.job_id,
      targetStatus: DELIVERY_STATUS.PROVIDER_ACCEPTED,
      fencingToken: claimed.job.version,
      providerMessageId: "<msg-9923812@mail.service.com>",
      dbOps: memDb,
    });

    const deliveredJob = await memDb.get(`tenants/tenant_prov/notification_jobs/${job.job_id}`);

    assert(
      deliveredJob.delivery_status === DELIVERY_STATUS.PROVIDER_ACCEPTED &&
      deliveredJob.acknowledgement_status === ACKNOWLEDGEMENT_STATUS.UNACKNOWLEDGED,
      "TEST 13: Provider acceptance sets delivery_status to 'provider_accepted' and preserves 'unacknowledged'",
      `Delivery=${deliveredJob.delivery_status}, Ack=${deliveredJob.acknowledgement_status}`
    );
  }

  // TEST 14: Worker restart after acceptance -> no duplicate send
  {
    const reClaim = await claimNotificationJob({
      tenantId: "tenant_prov",
      jobId: "job_lead_303_lead_capture",
      workerId: "restarted_worker",
      dbOps: memDb,
    });

    assert(
      reClaim.claimed === false && reClaim.reason === "job_not_claimable",
      "TEST 14: Worker restart after provider acceptance prevents duplicate dispatch",
      `Claimed=${reClaim.claimed}, Reason=${reClaim.reason}`
    );
  }

  // TEST 15: Outage / bounded retries & exponential backoff calculation
  {
    const backoff1 = calculateExponentialBackoffMs(1, 1000, 30000);
    const backoff2 = calculateExponentialBackoffMs(2, 1000, 30000);
    const backoff3 = calculateExponentialBackoffMs(3, 1000, 30000);

    const isGrowing = backoff1 >= 900 && backoff2 >= 1800 && backoff3 >= 3600 && backoff2 > backoff1 && backoff3 > backoff2;

    assert(
      isGrowing,
      "TEST 15: Exponential backoff calculation applies bounded jittered backoff across delivery retries",
      `Backoffs: ${backoff1}ms, ${backoff2}ms, ${backoff3}ms`
    );
  }

  // TEST 16: Unknown provider outcome -> marked as unknown, requires reconciliation
  {
    memDb.clear();
    await memDb.set("tenants/tenant_timeout/notification_settings", { adminEmail: "timeout@tenant.com" });

    const { job } = await enqueueNotificationJob({
      tenantId: "tenant_timeout",
      leadId: "lead_timeout_1",
      title: "Timeout Lead",
      message: "Socket hang up simulation",
      eventType: "lead_capture",
      dbOps: memDb,
    });

    const claimed = await claimNotificationJob({
      tenantId: "tenant_timeout",
      jobId: job.job_id,
      workerId: "worker_to",
      dbOps: memDb,
    });

    // Provider timed out without a definitive response code
    await recordDeliveryAttempt({
      tenantId: "tenant_timeout",
      jobId: job.job_id,
      attemptNumber: 1,
      recipient: "timeout@tenant.com",
      status: DELIVERY_STATUS.UNKNOWN,
      errorCode: "ETIMEDOUT",
      errorMessage: "Provider socket timed out after 10000ms",
      dbOps: memDb,
    });

    await updateJobDeliveryStatus({
      tenantId: "tenant_timeout",
      jobId: job.job_id,
      targetStatus: DELIVERY_STATUS.UNKNOWN,
      fencingToken: claimed.job.version,
      lastError: "Provider socket timed out after 10000ms",
      errorCode: "ETIMEDOUT",
      dbOps: memDb,
    });

    const unknownJob = await memDb.get(`tenants/tenant_timeout/notification_jobs/${job.job_id}`);

    assert(
      unknownJob.delivery_status === DELIVERY_STATUS.UNKNOWN && unknownJob.is_ambiguous === true,
      "TEST 16: Indeterminate provider timeouts mark delivery_status as 'unknown' and flag as ambiguous",
      `DeliveryStatus=${unknownJob.delivery_status}, Ambiguous=${unknownJob.is_ambiguous}`
    );
  }

  // TEST 17: Safe manual replay of failed/unknown job creates traceable attempt
  {
    const replayResult = await replayNotificationJob({
      tenantId: "tenant_timeout",
      jobId: "job_lead_timeout_1_lead_capture",
      actor: "operator_sarah",
      dbOps: memDb,
    });

    const replayedJob = await memDb.get("tenants/tenant_timeout/notification_jobs/job_lead_timeout_1_lead_capture");

    assert(
      replayResult.replayed === true &&
      replayedJob.delivery_status === DELIVERY_STATUS.QUEUED &&
      replayedJob.replay_count === 1 &&
      replayedJob.replayed_by === "operator_sarah",
      "TEST 17: Manual replay resets delivery_status to 'queued' and records operator audit metadata",
      `ReplayCount=${replayedJob.replay_count}, By=${replayedJob.replayed_by}`
    );
  }

  // -------------------------------------------------------------------------
  // SECTION 5: Human Acknowledgement & Tenant Isolation (Phases 7 & 8)
  // -------------------------------------------------------------------------
  console.log("\n--- SECTION 5: Human Acknowledgement & Security Isolation ---");

  // TEST 18: Human acknowledgement records actor and timestamp
  {
    memDb.clear();
    await memDb.set("tenants/tenant_ack/notification_settings", { adminEmail: "ack@tenant.com" });

    const { job } = await enqueueNotificationJob({
      tenantId: "tenant_ack",
      leadId: "lead_ack_1",
      title: "Inquiry to Acknowledge",
      message: "Please call client back",
      eventType: "lead_capture",
      dbOps: memDb,
    });

    // Mark as delivered
    await updateJobDeliveryStatus({
      tenantId: "tenant_ack",
      jobId: job.job_id,
      targetStatus: DELIVERY_STATUS.PROVIDER_ACCEPTED,
      fencingToken: 1,
      dbOps: memDb,
    });

    // Operator acknowledges
    const ackResult = await acknowledgeNotificationJob({
      tenantId: "tenant_ack",
      jobId: job.job_id,
      actor: "sales_rep_bob",
      notes: "Called customer and scheduled walkthrough",
      dbOps: memDb,
    });

    const ackedJob = await memDb.get(`tenants/tenant_ack/notification_jobs/${job.job_id}`);

    assert(
      ackResult.acknowledged === true &&
      ackedJob.acknowledgement_status === ACKNOWLEDGEMENT_STATUS.ACKNOWLEDGED &&
      ackedJob.acknowledged_by === "sales_rep_bob" &&
      typeof ackedJob.acknowledged_at === "string",
      "TEST 18: Human acknowledgement records responsible actor, timestamp, and notes",
      `AckStatus=${ackedJob.acknowledgement_status}, By=${ackedJob.acknowledged_by}`
    );
  }

  // TEST 19: Duplicate acknowledgement is idempotent
  {
    const originalJob = await memDb.get("tenants/tenant_ack/notification_jobs/job_lead_ack_1_lead_capture");
    const originalTime = originalJob.acknowledged_at;

    const duplicateAck = await acknowledgeNotificationJob({
      tenantId: "tenant_ack",
      jobId: "job_lead_ack_1_lead_capture",
      actor: "another_rep",
      notes: "Duplicate click",
      dbOps: memDb,
    });

    const updatedJob = await memDb.get("tenants/tenant_ack/notification_jobs/job_lead_ack_1_lead_capture");

    assert(
      duplicateAck.alreadyAcknowledged === true &&
      updatedJob.acknowledged_at === originalTime &&
      updatedJob.acknowledged_by === "sales_rep_bob",
      "TEST 19: Duplicate human acknowledgement is idempotent and does not overwrite original timestamp or actor",
      `AlreadyAck=${duplicateAck.alreadyAcknowledged}, ActorPreserved=${updatedJob.acknowledged_by === "sales_rep_bob"}`
    );
  }

  // TEST 20: Cross-tenant destination or credentials fallback rejection
  {
    memDb.clear();
    // Tenant A has configured settings
    await memDb.set("tenants/tenant_a/notification_settings", { adminEmail: "admin@tenanta.com" });
    // Tenant B has NO settings
    const tenantBRecipient = await resolveTenantRecipient({ tenantId: "tenant_b", dbOps: memDb });

    assert(
      tenantBRecipient.valid === false && tenantBRecipient.recipient === null,
      "TEST 20: Tenant B cannot fall back to Tenant A's recipient configuration or default credentials",
      `TenantBValid=${tenantBRecipient.valid}, Recipient=${tenantBRecipient.recipient}`
    );
  }

  // -------------------------------------------------------------------------
  // SECTION 6: API Security, Authorization & Secret Protection
  // -------------------------------------------------------------------------
  console.log("\n--- SECTION 6: API Route Handlers, Tenant Auth & Secret Redaction ---");

  // TEST 21: Cross-tenant acknowledgement via API rejection (403/401)
  {
    // Mock unauthorized request where session is tenant_b but targeting tenant_a in headers
    const { req, res } = createMockReqRes({
      method: "POST",
      headers: {
        "x-tenant-id": "tenant_a",
        // Note: No valid session token matching tenant_a
      },
      body: { job_id: "job_123" },
    });

    await acknowledgeHandler(req, res);

    assert(
      res.getStatusCode() === 401 || res.getStatusCode() === 403,
      "TEST 21: API route /api/notifications/acknowledge rejects unauthenticated or cross-tenant manipulation with 401/403",
      `Status=${res.getStatusCode()}`
    );
  }

  // TEST 22: Secret exposure audit — tokens, passwords and secrets never present in job records or responses
  {
    const sensitiveTokens = ["ghp_secretToken12345", "SG.sendgrid_api_key_sample", "super_smtp_password_999", "refresh_token_xyz"];

    const sampleJob = createNotificationJob({
      tenantId: "tenant_sec",
      leadId: "lead_sec_1",
      title: "Secret Audit",
      message: "Lead message with no credentials",
      recipient: "sec@tenant.com",
    });

    const sampleAttempt = createDeliveryAttemptRecord({
      attemptNumber: 1,
      recipient: "sec@tenant.com",
      status: DELIVERY_STATUS.FAILED,
      errorMessage: "Connection refused to smtp.mail.com:587",
    });

    const jobStr = JSON.stringify(sampleJob) + JSON.stringify(sampleAttempt);
    const hasSecrets = sensitiveTokens.some((tok) => jobStr.includes(tok));

    assert(
      !hasSecrets && !jobStr.toLowerCase().includes("password") && !jobStr.toLowerCase().includes("refreshtoken"),
      "TEST 22: Secret Exposure Audit — Notification jobs and delivery attempt records never contain credentials or tokens",
      `HasSecrets=${hasSecrets}`
    );
  }

  // -------------------------------------------------------------------------
  // SUMMARY
  // -------------------------------------------------------------------------
  const total = testResults.length;
  const passed = testResults.filter((r) => r.status === "PASSED").length;
  const failed = total - passed;

  console.log("\n================================================================================");
  console.log(`   CD07 TEST RESULTS: ${passed}/${total} PASSED  (${failed} FAILED)`);
  console.log("================================================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Test runner threw unhandled exception:", err);
  process.exit(1);
});
