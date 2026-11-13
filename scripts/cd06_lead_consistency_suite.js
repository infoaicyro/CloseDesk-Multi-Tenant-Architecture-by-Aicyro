// scripts/cd06_lead_consistency_suite.js
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Register custom ESM extension loader to allow Next.js route handlers to load in Node ESM
register("./scripts/esm_loader.mjs", pathToFileURL("./"));

// Dynamically import project modules
const {
  LIFECYCLE_STATUS,
  PRIORITY_LEVEL,
  ACTION_STATUS,
  createCanonicalLead,
  updateLeadLifecycle,
  updateLeadPriority,
  isValidLifecycleTransition,
  assertNotStaleUpdate,
  mapToCanonicalLifecycle,
} = await import("../src/lib/leadContract.js");

const {
  hashPayload,
  acquireIdempotencyLock,
  completeIdempotencyLock,
  failIdempotencyLock,
  markIdempotencyLockUnknown,
  getIdempotencyLockPath,
  LOCK_STATUS,
} = await import("../src/lib/idempotencyLocker.js");

const {
  validateVoiceEvent,
} = await import("../src/lib/voiceAuth.js");

const {
  withRetryTrace,
} = await import("../src/lib/retryTracer.js");

const { default: leadsHandler } = await import("../src/pages/api/leads.js");
const { default: syncVoiceHandler } = await import("../src/pages/api/sync-voice.js");

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
  let headersSent = false;
  const resHeaders = {};

  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(data) {
      responseData = data;
      headersSent = true;
      return res;
    },
    setHeader(key, value) {
      resHeaders[key.toLowerCase()] = value;
      return res;
    },
    getStatusCode: () => statusCode,
    getData: () => responseData,
  };

  return { req, res };
}

/**
 * Scoped API Logger for Testing
 */
function createTestLogger() {
  const logs = [];
  return {
    info: (domain, event, data) => logs.push({ level: "info", domain, event, data }),
    warn: (domain, event, data) => logs.push({ level: "warn", domain, event, data }),
    error: (domain, event, data) => logs.push({ level: "error", domain, event, data }),
    critical: (domain, event, data) => logs.push({ level: "critical", domain, event, data }),
    getLogs: () => logs,
    clear: () => { logs.length = 0; },
  };
}

// Global Test Runner State
const testResults = [];

function assert(condition, testName, details = "") {
  if (condition) {
    testResults.push({ name: testName, status: "PASSED", details });
    console.log(`\x1b[32m✔ PASS:\x1b[0m ${testName} ${details ? `(${details})` : ""}`);
  } else {
    testResults.push({ name: testName, status: "FAILED", details });
    console.error(`\x1b[31m✖ FAIL:\x1b[0m ${testName} ${details ? `(${details})` : ""}`);
  }
}

async function runAllTests() {
  console.log("\n================================================================================");
  console.log("   CD06 — LEAD AND ACTION CONSISTENCY INDEPENDENT VERIFICATION SUITE");
  console.log("================================================================================\n");

  const mockDb = new InMemoryDb();

  // -------------------------------------------------------------------------
  // GROUP 1: Canonical Lead Contract & Unknown Values (Phase 2)
  // -------------------------------------------------------------------------
  console.log("\n--- GROUP 1: Canonical Lead Contract & Unknown Values (Phase 2) ---");

  // TEST 1.1: Valid canonical lead payload produces normalized contract
  {
    const raw = {
      tenant_id: "Tenant_Alpha",
      session_id: "sess_12345",
      name: "Alice Smith",
      email: "alice@example.com",
      phone: "+15551234567",
      location: "Denver, CO",
      service_requested: "HVAC Inspection",
      priority: "HIGH",
      booking_status: "Meeting Booked",
    };
    const lead = createCanonicalLead(raw);
    assert(
      lead.tenant_id === "tenant_alpha" &&
      lead.conversation_id === "sess_12345" &&
      lead.contact.name === "Alice Smith" &&
      lead.location === "Denver, CO" &&
      lead.service_requested === "HVAC Inspection" &&
      lead.priority === PRIORITY_LEVEL.HIGH &&
      lead.lifecycle_status === LIFECYCLE_STATUS.BOOKED &&
      lead.version === 1,
      "TEST 1.1: Canonical lead construction with valid identities",
      `tenant=${lead.tenant_id}, version=${lead.version}`
    );
  }

  // TEST 1.2: Missing customer contact details remain strictly null (NEVER invented)
  {
    const raw = {
      tenant_id: "tenant_beta",
      session_id: "sess_anon",
    };
    const lead = createCanonicalLead(raw);
    assert(
      lead.contact.name === null &&
      lead.contact.email === null &&
      lead.contact.phone === null &&
      lead.name === null &&
      lead.email === null &&
      lead.phone === null,
      "TEST 1.2: Missing customer contact details remain strictly null",
      "No fake names like 'Valued Customer' or dummy emails invented"
    );
  }

  // TEST 1.3: Unconfirmed location and service remain strictly null
  {
    const raw = {
      tenant_id: "tenant_gamma",
      session_id: "sess_empty",
    };
    const lead = createCanonicalLead(raw);
    assert(
      lead.location === null &&
      lead.service_requested === null &&
      lead.requested_action === null,
      "TEST 1.3: Unconfirmed location and service remain strictly null",
      "Location & service are not assumed or fabricated"
    );
  }

  // TEST 1.4: Priority and Lifecycle Independence
  {
    const initialLead = createCanonicalLead({
      tenant_id: "tenant_alpha",
      name: "Bob",
      booking_status: "Captured",
      priority: "LOW",
    });

    // 1. Update lifecycle: must NOT alter priority
    const lifecycleUpdated = updateLeadLifecycle(initialLead, LIFECYCLE_STATUS.BOOKED);
    const lifecycleOk = (
      lifecycleUpdated.lifecycle_status === LIFECYCLE_STATUS.BOOKED &&
      lifecycleUpdated.booking_status === "Meeting Booked" &&
      lifecycleUpdated.priority === PRIORITY_LEVEL.LOW &&
      lifecycleUpdated.lead_score === "Low" &&
      lifecycleUpdated.version === 2
    );

    // 2. Update priority: must NOT alter lifecycle status
    const priorityUpdated = updateLeadPriority(lifecycleUpdated, PRIORITY_LEVEL.HIGH);
    const priorityOk = (
      priorityUpdated.priority === PRIORITY_LEVEL.HIGH &&
      priorityUpdated.lead_score === "High" &&
      priorityUpdated.lifecycle_status === LIFECYCLE_STATUS.BOOKED &&
      priorityUpdated.booking_status === "Meeting Booked" &&
      priorityUpdated.version === 3
    );

    assert(
      lifecycleOk && priorityOk,
      "TEST 1.4: Strict Priority and Lifecycle Independence",
      `v2 priority=${lifecycleUpdated.priority}, v3 lifecycle=${priorityUpdated.lifecycle_status}`
    );
  }

  // TEST 1.5: Flat compatibility accessors match canonical contract for dashboard
  {
    const lead = createCanonicalLead({
      name: "Charlie",
      email: "charlie@test.com",
      priority: "URGENT",
      booking_status: "Meeting Booked",
    });
    assert(
      lead.firebaseId &&
      lead.name === "Charlie" &&
      lead.email === "charlie@test.com" &&
      lead.lead_score === "High" &&
      lead.booking_status === "Meeting Booked",
      "TEST 1.5: Flat compatibility accessors match canonical contract",
      "Dashboard components can seamlessly read existing fields"
    );
  }

  // -------------------------------------------------------------------------
  // GROUP 2: Lifecycle State Machine & Concurrency Protection (Phase 5)
  // -------------------------------------------------------------------------
  console.log("\n--- GROUP 2: Lifecycle State Machine & Concurrency Protection (Phase 5) ---");

  // TEST 2.1: Permitted transitions succeed
  {
    assert(
      isValidLifecycleTransition(LIFECYCLE_STATUS.NEW, LIFECYCLE_STATUS.CONTACTED) &&
      isValidLifecycleTransition(LIFECYCLE_STATUS.CONTACTED, LIFECYCLE_STATUS.QUALIFIED) &&
      isValidLifecycleTransition(LIFECYCLE_STATUS.QUALIFIED, LIFECYCLE_STATUS.BOOKED) &&
      isValidLifecycleTransition(LIFECYCLE_STATUS.BOOKED, LIFECYCLE_STATUS.CLOSED),
      "TEST 2.1: Permitted forward lifecycle transitions succeed",
      "NEW -> CONTACTED -> QUALIFIED -> BOOKED -> CLOSED"
    );
  }

  // TEST 2.2: Permitted re-engagement transitions succeed
  {
    assert(
      isValidLifecycleTransition(LIFECYCLE_STATUS.ABANDONED, LIFECYCLE_STATUS.CONTACTED) &&
      isValidLifecycleTransition(LIFECYCLE_STATUS.LOST, LIFECYCLE_STATUS.NEW),
      "TEST 2.2: Permitted re-engagement transitions succeed",
      "ABANDONED -> CONTACTED, LOST -> NEW"
    );
  }

  // TEST 2.3: Terminal transition rejection from CLOSED
  {
    let caughtError = null;
    const closedLead = createCanonicalLead({ lifecycle_status: LIFECYCLE_STATUS.CLOSED });
    try {
      updateLeadLifecycle(closedLead, LIFECYCLE_STATUS.NEW);
    } catch (err) {
      caughtError = err;
    }
    assert(
      caughtError && caughtError.code === "INVALID_LIFECYCLE_TRANSITION",
      "TEST 2.3: Terminal state cannot transition to NEW",
      `Caught: ${caughtError?.message}`
    );
  }

  // TEST 2.4: Illegal backwards transition rejected
  {
    let caughtError = null;
    const bookedLead = createCanonicalLead({ lifecycle_status: LIFECYCLE_STATUS.BOOKED });
    try {
      updateLeadLifecycle(bookedLead, LIFECYCLE_STATUS.NEW);
    } catch (err) {
      caughtError = err;
    }
    assert(
      caughtError && caughtError.code === "INVALID_LIFECYCLE_TRANSITION",
      "TEST 2.4: Illegal backward transition (BOOKED -> NEW) rejected",
      `Caught: ${caughtError?.message}`
    );
  }

  // TEST 2.5: Monotonic version check rejects stale update
  {
    const existing = { version: 5, updated_at: "2026-11-04T12:00:00Z" };
    const incomingStale = { version: 4, updated_at: "2026-11-04T12:05:00Z" };
    let staleCaught = false;
    try {
      assertNotStaleUpdate(existing, incomingStale);
    } catch (err) {
      staleCaught = err.code === "STALE_UPDATE_VERSION";
    }
    assert(
      staleCaught,
      "TEST 2.5: Stale update rejected via version counter",
      "Incoming version (4) < persisted version (5)"
    );
  }

  // TEST 2.6: Strict timestamp ordering rejects older timestamp
  {
    const existing = { version: 5, updated_at: "2026-11-04T12:00:00Z" };
    const incomingOlderTime = { updated_at: "2026-11-04T11:59:00Z" };
    let timestampCaught = false;
    try {
      assertNotStaleUpdate(existing, incomingOlderTime);
    } catch (err) {
      timestampCaught = err.code === "STALE_UPDATE_TIMESTAMP";
    }
    assert(
      timestampCaught,
      "TEST 2.6: Stale update rejected via timestamp ordering",
      "Incoming timestamp older than persisted state"
    );
  }

  // -------------------------------------------------------------------------
  // GROUP 3: Idempotency State Locking (Phase 3)
  // -------------------------------------------------------------------------
  console.log("\n--- GROUP 3: Idempotency State Locking (Phase 3) ---");

  // TEST 3.1: Fresh lock acquisition sets pending state
  {
    mockDb.clear();
    const opKey = "op_test_001";
    const payload = { name: "David", service: "Plumbing" };
    const lockRes = await acquireIdempotencyLock({
      tenantId: "tenant_alpha",
      conversationId: "sess_001",
      operationKey: opKey,
      payload,
      ttlMs: 60000,
      dbInstance: mockDb,
    });

    const storedVal = await mockDb.get(getIdempotencyLockPath("tenant_alpha", opKey));

    assert(
      lockRes.status === "acquired" &&
      storedVal.status === LOCK_STATUS.PENDING &&
      storedVal.tenant_id === "tenant_alpha" &&
      storedVal.payload_hash === hashPayload(payload),
      "TEST 3.1: Fresh lock acquisition initializes pending state",
      `path=${getIdempotencyLockPath("tenant_alpha", opKey)}`
    );
  }

  // TEST 3.2: Replay with same key + same payload returns original completed result
  {
    const opKey = "op_test_001";
    const payload = { name: "David", service: "Plumbing" };

    // Complete the lock
    const originalResponse = { id: "lead_999", success: true, booking: "Confirmed" };
    await completeIdempotencyLock({
      tenantId: "tenant_alpha",
      operationKey: opKey,
      responseData: originalResponse,
      dbInstance: mockDb,
    });

    // Submit identical replay
    const replayRes = await acquireIdempotencyLock({
      tenantId: "tenant_alpha",
      conversationId: "sess_001",
      operationKey: opKey,
      payload,
      dbInstance: mockDb,
    });

    assert(
      replayRes.status === "cached" &&
      replayRes.cachedResponse.id === "lead_999" &&
      replayRes.cachedResponse.booking === "Confirmed",
      "TEST 3.2: Replay with same key + same payload returns cached result",
      `Cached lead ID=${replayRes.cachedResponse?.id}`
    );
  }

  // TEST 3.3: Replay with same key + CHANGED payload is safely rejected (409 Conflict)
  {
    const opKey = "op_test_001";
    const alteredPayload = { name: "David", service: "Roofing (ALTERED)" };

    const conflictRes = await acquireIdempotencyLock({
      tenantId: "tenant_alpha",
      conversationId: "sess_001",
      operationKey: opKey,
      payload: alteredPayload,
      dbInstance: mockDb,
    });

    assert(
      conflictRes.status === "payload_mismatch" &&
      conflictRes.statusCode === 409,
      "TEST 3.3: Replay with same key + changed payload safely rejected with 409 Conflict",
      `Status=${conflictRes.status}`
    );
  }

  // TEST 3.4: Concurrent in-flight duplicate submission returns 409 in_progress
  {
    const opKey = "op_concurrent_002";
    const payload = { test: "concurrent" };

    // Worker 1 acquires lock
    await acquireIdempotencyLock({
      tenantId: "tenant_alpha",
      conversationId: "sess_002",
      operationKey: opKey,
      payload,
      ttlMs: 60000,
      dbInstance: mockDb,
    });

    // Worker 2 attempts concurrent submission
    const concurrentRes = await acquireIdempotencyLock({
      tenantId: "tenant_alpha",
      conversationId: "sess_002",
      operationKey: opKey,
      payload,
      ttlMs: 60000,
      dbInstance: mockDb,
    });

    assert(
      concurrentRes.status === "in_progress" &&
      concurrentRes.statusCode === 409,
      "TEST 3.4: Concurrent in-flight duplicate submission returns 409 in_progress",
      `statusCode=${concurrentRes.statusCode}`
    );
  }

  // TEST 3.5: Expired pending lock safely recovered
  {
    const opKey = "op_expired_003";
    const payload = { test: "recover" };

    // Acquire lock with expired TTL
    await acquireIdempotencyLock({
      tenantId: "tenant_alpha",
      conversationId: "sess_003",
      operationKey: opKey,
      payload,
      ttlMs: -1000, // Instantly expired
      dbInstance: mockDb,
    });

    // Next worker should safely recover lock
    const recoverRes = await acquireIdempotencyLock({
      tenantId: "tenant_alpha",
      conversationId: "sess_003",
      operationKey: opKey,
      payload,
      ttlMs: 60000,
      dbInstance: mockDb,
    });

    assert(
      recoverRes.status === "acquired" &&
      recoverRes.recovered === true,
      "TEST 3.5: Expired pending lock safely recovered without destroying state",
      `recovered=${recoverRes.recovered}`
    );
  }

  // TEST 3.6: Prior failed operation allows controlled retry
  {
    const opKey = "op_fail_004";
    const payload = { test: "retry_after_fail" };

    await acquireIdempotencyLock({
      tenantId: "tenant_alpha",
      conversationId: "sess_004",
      operationKey: opKey,
      payload,
      dbInstance: mockDb,
    });

    await failIdempotencyLock({
      tenantId: "tenant_alpha",
      operationKey: opKey,
      error: new Error("Network timeout"),
      dbInstance: mockDb,
    });

    // Retry submission
    const retryRes = await acquireIdempotencyLock({
      tenantId: "tenant_alpha",
      conversationId: "sess_004",
      operationKey: opKey,
      payload,
      dbInstance: mockDb,
    });

    assert(
      retryRes.status === "acquired" &&
      retryRes.retriedAfterFailure === true,
      "TEST 3.6: Prior failed operation allows controlled retry",
      `retriedAfterFailure=${retryRes.retriedAfterFailure}`
    );
  }

  // TEST 3.7: Unknown external state requires reconciliation before retry
  {
    const opKey = "op_unknown_005";
    const payload = { test: "unknown_state" };

    await acquireIdempotencyLock({
      tenantId: "tenant_alpha",
      conversationId: "sess_005",
      operationKey: opKey,
      payload,
      dbInstance: mockDb,
    });

    await markIdempotencyLockUnknown({
      tenantId: "tenant_alpha",
      operationKey: opKey,
      reason: "Gateway timeout during payment capture",
      externalReference: "ext_tx_888",
      dbInstance: mockDb,
    });

    const retryUnknown = await acquireIdempotencyLock({
      tenantId: "tenant_alpha",
      conversationId: "sess_005",
      operationKey: opKey,
      payload,
      dbInstance: mockDb,
    });

    assert(
      retryUnknown.status === "unknown_external" &&
      retryUnknown.statusCode === 409 &&
      retryUnknown.reconciliationDetails.external_reference === "ext_tx_888",
      "TEST 3.7: Unknown external state requires reconciliation before retry",
      `ref=${retryUnknown.reconciliationDetails?.external_reference}`
    );
  }

  // -------------------------------------------------------------------------
  // GROUP 4: Tenant Isolation & Cross-Tenant Protection (Phase 9)
  // -------------------------------------------------------------------------
  console.log("\n--- GROUP 4: Tenant Isolation & Cross-Tenant Protection (Phase 9) ---");

  // TEST 4.1: Operation keys are strictly scoped per tenant
  {
    const key = "shared_op_key_100";
    const pathA = getIdempotencyLockPath("tenant_a", key);
    const pathB = getIdempotencyLockPath("tenant_b", key);
    assert(
      pathA !== pathB &&
      pathA.startsWith("tenants/tenant_a/") &&
      pathB.startsWith("tenants/tenant_b/"),
      "TEST 4.1: Operation key paths strictly scoped per tenant",
      `A: ${pathA} vs B: ${pathB}`
    );
  }

  // TEST 4.2: Cross-tenant lock manipulation throws 403 Forbidden
  {
    const opKey = "op_cross_tenant_test";
    const lockPath = getIdempotencyLockPath("tenant_victim", opKey);
    await mockDb.set(lockPath, {
      tenant_id: "tenant_victim",
      status: LOCK_STATUS.PENDING,
      payload_hash: hashPayload({ data: "secret" }),
      expires_at: Date.now() + 60000,
    });

    let crossTenantError = null;
    try {
      await acquireIdempotencyLock({
        tenantId: "tenant_attacker",
        conversationId: "sess_hacker",
        operationKey: opKey,
        payload: { data: "secret" },
        dbOps: {
          get: async () => mockDb.get(lockPath),
          set: async (p, v) => mockDb.set(p, v),
          update: async (p, v) => mockDb.update(p, v),
        },
      });
    } catch (err) {
      crossTenantError = err;
    }

    assert(
      crossTenantError &&
      crossTenantError.code === "CROSS_TENANT_IDEMPOTENCY_CONFLICT" &&
      crossTenantError.status === 403,
      "TEST 4.2: Cross-tenant lock tampering throws 403 CROSS_TENANT_IDEMPOTENCY_CONFLICT",
      `Caught: ${crossTenantError?.message}`
    );
  }

  // TEST 4.3: Realtime Database rules enforce tenant isolation for locks & nonces
  {
    const rulesText = fs.readFileSync("database.rules.json", "utf8");
    const parsedRules = JSON.parse(rulesText);
    const tenantRules = parsedRules.rules.tenants.$tenant_id;

    const hasLocksRule = (
      tenantRules.idempotency_locks &&
      tenantRules.idempotency_locks[".read"].includes("auth.token.tenant_id === $tenant_id") &&
      tenantRules.idempotency_locks[".write"].includes("auth.token.tenant_id === $tenant_id")
    );

    const hasNoncesRule = (
      tenantRules.voice_nonces &&
      tenantRules.voice_nonces[".read"].includes("auth.token.tenant_id === $tenant_id") &&
      tenantRules.voice_nonces[".write"].includes("auth.token.tenant_id === $tenant_id")
    );

    const hasProspectsRule = (
      tenantRules.prospects &&
      tenantRules.prospects[".read"].includes("auth.token.tenant_id === $tenant_id") &&
      tenantRules.prospects[".write"].includes("auth.token.tenant_id === $tenant_id")
    );

    assert(
      hasLocksRule && hasNoncesRule && hasProspectsRule,
      "TEST 4.3: Realtime Database rules enforce tenant isolation for locks, nonces, and prospects",
      "Rules checked in database.rules.json"
    );
  }

  // -------------------------------------------------------------------------
  // GROUP 5: Voice Event Authenticity, Freshness & Replay Protection (Phase 4)
  // -------------------------------------------------------------------------
  console.log("\n--- GROUP 5: Voice Event Authenticity, Freshness & Replay Protection (Phase 4) ---");

  // TEST 5.1: Voice event with invalid token rejected when secret configured
  {
    process.env.VOICE_WEBHOOK_SECRET = "super_secret_voice_token_xyz";
    const { req } = createMockReqRes({
      headers: { "x-voice-token": "wrong_token" },
      body: { session_id: "lead_12345_abcdef" },
    });

    const authRes = await validateVoiceEvent(req, "tenant_voice", mockDb);
    assert(
      !authRes.allowed && authRes.status === 401,
      "TEST 5.1: Voice event with invalid token rejected with 401 Unauthorized",
      `Status: ${authRes.status}`
    );
    delete process.env.VOICE_WEBHOOK_SECRET;
  }

  // TEST 5.2: Stale voice event (older than freshness window) rejected
  {
    const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 minutes old
    const { req } = createMockReqRes({
      headers: { "x-voice-timestamp": staleTime },
      body: { session_id: "lead_12345_abcdef" },
    });

    const freshRes = await validateVoiceEvent(req, "tenant_voice", mockDb);
    assert(
      !freshRes.allowed && freshRes.status === 400 && freshRes.error.includes("Stale voice event"),
      "TEST 5.2: Stale voice event (>5 min old) rejected with 400 Bad Request",
      `Error: ${freshRes.error}`
    );
  }

  // TEST 5.3: Replay of voice event with identical nonce rejected
  {
    const nonce = "voice_nonce_abc123";
    const { req } = createMockReqRes({
      headers: {
        "x-voice-nonce": nonce,
        "x-voice-timestamp": new Date().toISOString(),
      },
      body: { session_id: "lead_12345_abcdef" },
    });

    // First arrival
    const firstRes = await validateVoiceEvent(req, "tenant_voice", mockDb);
    // Second arrival (Replay)
    const replayRes = await validateVoiceEvent(req, "tenant_voice", mockDb);

    assert(
      firstRes.allowed === true &&
      replayRes.allowed === false &&
      replayRes.status === 409 &&
      replayRes.error.includes("Replay attack detected"),
      "TEST 5.3: Replay of voice event with same nonce rejected with 409 Conflict",
      `Replay status: ${replayRes.status}`
    );
  }

  // -------------------------------------------------------------------------
  // GROUP 6: External Action Consistency & RetryTracer (Phase 6 & 8)
  // -------------------------------------------------------------------------
  console.log("\n--- GROUP 6: External Action Consistency & RetryTracer (Phase 6 & 8) ---");

  // TEST 6.1: retryTracer successfully tracks attempt lifecycle and recovers
  {
    const testLogger = createTestLogger();
    let attempts = 0;

    const result = await withRetryTrace(testLogger, "Test_Operation", { maxAttempts: 3, delayMs: 10 }, async (att) => {
      attempts++;
      if (att < 2) throw new Error("Transient network glitch");
      return { success: true };
    });

    const logs = testLogger.getLogs();
    const hasRetryWarn = logs.some((l) => l.event === "operation_failed_retrying");
    const hasRecoverSuccess = logs.some((l) => l.event === "operation_retry_success");

    assert(
      result.success === true && attempts === 2 && hasRetryWarn && hasRecoverSuccess,
      "TEST 6.1: retryTracer tracks attempts and logs recovery lifecycle",
      `Attempts=${attempts}`
    );
  }

  // TEST 6.2: Ambiguous timeout correctly transitions to 'unknown' status
  {
    const testLogger = createTestLogger();
    let caughtErr = null;

    try {
      await withRetryTrace(testLogger, "External_Payment_Call", { maxAttempts: 2, delayMs: 10 }, async () => {
        const err = new Error("ESOCKETTIMEDOUT: Gateway did not answer in 5000ms");
        err.code = "ESOCKETTIMEDOUT";
        throw err;
      });
    } catch (err) {
      caughtErr = err;
    }

    const logs = testLogger.getLogs();
    const finalLog = logs.find((l) => l.event === "operation_final_failure");

    assert(
      caughtErr &&
      caughtErr.isAmbiguousTimeout === true &&
      caughtErr.finalStatus === "unknown" &&
      finalLog?.data?.context?.final_status === "unknown",
      "TEST 6.2: Ambiguous socket timeout transitions to 'unknown' status, NOT silent success or drop",
      `finalStatus=${caughtErr?.finalStatus}`
    );
  }

  // TEST 6.3: retryTracer automatically redacts sensitive credentials from logs
  {
    const testLogger = createTestLogger();
    try {
      await withRetryTrace(testLogger, "Auth_Sync", { maxAttempts: 1, delayMs: 5 }, async () => {
        throw new Error("Failed connecting with password=SuperSecretPassword123 and Bearer eyJhbGciOiJIUzI1Ni...");
      });
    } catch {}

    const logs = testLogger.getLogs();
    const criticalLog = logs.find((l) => l.event === "operation_final_failure");
    const loggedReason = criticalLog?.data?.context?.failure_reason || "";

    assert(
      !loggedReason.includes("SuperSecretPassword123") &&
      !loggedReason.includes("eyJhbGci") &&
      loggedReason.includes("[REDACTED]"),
      "TEST 6.3: retryTracer automatically redacts passwords and bearer tokens from logs",
      `Logged: ${loggedReason}`
    );
  }

  // TEST 6.4: retryTracer reconciliation hook prevents duplicate execution
  {
    const testLogger = createTestLogger();
    let externalExecutions = 0;

    const result = await withRetryTrace(testLogger, "Dispatched_Webhook", {
      maxAttempts: 3,
      delayMs: 10,
      reconcileFn: async (attempt) => {
        if (attempt > 1) {
          // Check provider: External action was already executed!
          return { alreadyExecuted: true, cachedResult: { booked: true, deduplicated: true } };
        }
        return null;
      },
    }, async (att) => {
      externalExecutions++;
      if (att === 1) throw new Error("Socket closed prematurely");
      return { booked: true };
    });

    assert(
      result.deduplicated === true && externalExecutions === 1,
      "TEST 6.4: Reconciliation hook prevents duplicate side-effect after ambiguous failure",
      `Executions=${externalExecutions}`
    );
  }

  // -------------------------------------------------------------------------
  // GROUP 7: Frontend Consistency & Lead Terminal (Phase 7)
  // -------------------------------------------------------------------------
  console.log("\n--- GROUP 7: Frontend Consistency & Lead Terminal (Phase 7) ---");

  // TEST 7.1: Chatbot AicyroChatbot awaits durable backend lead confirmation
  {
    const chatbotSource = fs.readFileSync("src/Closedesk/Chatbot/AicyroChatbot.jsx", "utf8");
    const awaitsConfirmation = chatbotSource.includes("const confirmedLead = await submitLead");
    const displaysRefId = chatbotSource.includes("Ref: ${confirmedLead?.lead_id");
    const passesIdempotencyKey = chatbotSource.includes('"x-idempotency-key": operationKey');

    assert(
      awaitsConfirmation && displaysRefId && passesIdempotencyKey,
      "TEST 7.1: Chatbot awaits durable backend lead confirmation and passes idempotency key before success UI",
      "submitLead is awaited with durable Ref ID"
    );
  }

  // TEST 7.2: TerminalScreen renders explicit badges for pending and unknown states
  {
    const terminalSource = fs.readFileSync("src/Closedesk/Dashboard/TerminalScreen.jsx", "utf8");
    const hasPendingBadge = terminalSource.includes('status.includes("PENDING")') && terminalSource.includes("Pending");
    const hasUnknownBadge = terminalSource.includes('status.includes("UNKNOWN")') && terminalSource.includes("Unknown");
    const hasTableHelper = terminalSource.includes("{getStatusBadge(lead)}");

    assert(
      hasPendingBadge && hasUnknownBadge && hasTableHelper,
      "TEST 7.2: TerminalScreen renders explicit badges for Pending, Unknown, and Booked states",
      "getStatusBadge helper renders pending/unknown states"
    );
  }

  // -------------------------------------------------------------------------
  // SUMMARY
  // -------------------------------------------------------------------------
  const total = testResults.length;
  const passed = testResults.filter((r) => r.status === "PASSED").length;
  const failed = total - passed;

  console.log("\n================================================================================");
  console.log(`   CD06 TEST RESULTS: ${passed}/${total} PASSED  (${failed} FAILED)`);
  console.log("================================================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Test runner threw unhandled exception:", err);
  process.exit(1);
});
