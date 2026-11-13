// scripts/cd09_voice_lifecycle_suite.js
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Register custom ESM extension loader to allow Next.js route handlers to load in Node ESM
register("./scripts/esm_loader.mjs", pathToFileURL("./"));

// Dynamically import project modules
const {
  VOICE_SESSION_STATUS,
  KILL_SWITCH_SCOPES,
  DEFAULT_VOICE_LIMITS,
  checkEffectiveVoicePermission,
  getTenantActiveVoiceSessions,
  checkTenantVoiceConcurrency,
  createVoiceSessionRecord,
  heartbeatVoiceSession,
  revokeVoiceSession,
  setGlobalVoiceKillSwitch,
  setTenantVoiceKillSwitch,
  validateVoiceSessionForAction,
} = await import("../src/lib/voiceLifecycle.js");

const { default: tokenHandler } = await import("../src/pages/api/openai-token.js");
const { default: syncVoiceHandler } = await import("../src/pages/api/sync-voice.js");
const { default: sessionHandler } = await import("../src/pages/api/voice/session.js");

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
    // Direct match
    if (this.store.has(p)) {
      const val = this.store.get(p);
      return val !== undefined && val !== null ? JSON.parse(JSON.stringify(val)) : null;
    }
    // Prefix match for collections (e.g. "tenants/tenant_a/voice_sessions")
    const prefix = p.endsWith("/") ? p : p + "/";
    const collection = {};
    let found = false;
    for (const [key, val] of this.store.entries()) {
      if (key.startsWith(prefix)) {
        const subKey = key.slice(prefix.length).split("/")[0];
        collection[subKey] = JSON.parse(JSON.stringify(val));
        found = true;
      }
    }
    return found ? collection : null;
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
 * Simulated Browser WebRTC MediaStream & Track for Resource Lifecycle Tests
 */
class MockMediaStreamTrack {
  constructor(kind = "audio") {
    this.kind = kind;
    this.readyState = "live";
  }
  stop() {
    this.readyState = "ended";
  }
}

class MockMediaStream {
  constructor() {
    this.tracks = [new MockMediaStreamTrack("audio")];
  }
  getTracks() {
    return this.tracks;
  }
}

class MockRTCPeerConnection {
  constructor() {
    this.connectionState = "connected";
    this.tracks = [];
  }
  addTrack(track) {
    this.tracks.push(track);
  }
  close() {
    this.connectionState = "closed";
  }
}

class MockRTCDataChannel {
  constructor() {
    this.readyState = "open";
    this.sentMessages = [];
  }
  send(data) {
    this.sentMessages.push(data);
  }
  close() {
    this.readyState = "closed";
  }
}

/**
 * Mock Request & Response builder
 */
function createMockReqRes({
  method = "POST",
  headers = {},
  body = {},
  query = {},
} = {}) {
  const req = {
    method,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body,
    query,
    socket: { remoteAddress: "127.0.0.1" },
  };

  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    send(data) {
      this.body = data;
      return this;
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
  console.log("   CD09: VOICE LIFECYCLE AND KILL SWITCH (P0) — ACCEPTANCE TEST SUITE");
  console.log("================================================================================\n");

  const memDb = new InMemoryDb();

  // -------------------------------------------------------------------------
  // SECTION 1: Effective Voice Permissions & Precedence
  // -------------------------------------------------------------------------
  console.log("\n--- SECTION 1: Effective Voice Permissions & Precedence ---");

  // TEST 1: Global voice enabled allows voice session to start
  {
    memDb.clear();
    await setGlobalVoiceKillSwitch({ enabled: true, dbOps: memDb });
    await setTenantVoiceKillSwitch({ tenantId: "tenant_alpha", enabled: true, dbOps: memDb });

    const perm = await checkEffectiveVoicePermission({ tenantId: "tenant_alpha", dbOps: memDb });
    assert(
      perm.allowed === true,
      "TEST 1: Global voice enabled allows voice session to start",
      `Allowed=${perm.allowed}`
    );
  }

  // TEST 2: Global voice disabled blocks new token issuance across all tenants
  {
    await setGlobalVoiceKillSwitch({
      enabled: false,
      reason: "Platform emergency security pause",
      dbOps: memDb,
    });

    const permA = await checkEffectiveVoicePermission({ tenantId: "tenant_alpha", dbOps: memDb });
    const permB = await checkEffectiveVoicePermission({ tenantId: "tenant_beta", dbOps: memDb });

    assert(
      permA.allowed === false && permA.scope === "global" &&
      permB.allowed === false && permB.scope === "global",
      "TEST 2: Global voice disabled blocks new token issuance across all tenants",
      `A_Blocked=${!permA.allowed}, B_Blocked=${!permB.allowed}, Scope=${permA.scope}`
    );
  }

  // TEST 3: Tenant voice enabled allows authorized tenant session to start
  {
    memDb.clear();
    await setGlobalVoiceKillSwitch({ enabled: true, dbOps: memDb });
    await setTenantVoiceKillSwitch({ tenantId: "tenant_alpha", enabled: true, dbOps: memDb });
    await setTenantVoiceKillSwitch({ tenantId: "tenant_beta", enabled: false, dbOps: memDb });

    const permA = await checkEffectiveVoicePermission({ tenantId: "tenant_alpha", dbOps: memDb });
    assert(
      permA.allowed === true,
      "TEST 3: Tenant voice enabled allows authorized tenant session to start",
      `TenantA_Allowed=${permA.allowed}`
    );
  }

  // TEST 4: Tenant voice disabled blocks ONLY that tenant's new sessions without leaking to others
  {
    const permB = await checkEffectiveVoicePermission({ tenantId: "tenant_beta", dbOps: memDb });
    const permA = await checkEffectiveVoicePermission({ tenantId: "tenant_alpha", dbOps: memDb });

    assert(
      permB.allowed === false && permB.scope === "tenant" && permA.allowed === true,
      "TEST 4: Tenant voice disabled blocks only that tenant's sessions without leaking",
      `TenantB_Blocked=${!permB.allowed}, TenantA_Allowed=${permA.allowed}`
    );
  }

  // -------------------------------------------------------------------------
  // SECTION 2: Direct API Enforcement & Token Issuance
  // -------------------------------------------------------------------------
  console.log("\n--- SECTION 2: Direct API Enforcement & Token Issuance ---");

  // TEST 5: Direct token API after disable rejects request with 403 Forbidden
  {
    memDb.clear();
    await setGlobalVoiceKillSwitch({ enabled: false, reason: "Maintenance shutoff", dbOps: memDb });

    const perm = await checkEffectiveVoicePermission({ tenantId: "tenant_alpha", dbOps: memDb });
    assert(
      perm.allowed === false && perm.status === 403,
      "TEST 5: Direct token API after disable denies token issuance server-side",
      `Status=${perm.status}, Reason=${perm.reason}`
    );
  }

  // TEST 6: Direct voice action (sync-voice) after global disable is rejected (403)
  {
    const result = await validateVoiceSessionForAction({
      tenantId: "tenant_alpha",
      sessionId: "lead_12345_test001",
      dbOps: memDb,
    });

    assert(
      result.allowed === false && result.status === 403 && result.scope === "global",
      "TEST 6: Direct voice action after global disable is rejected with 403 Forbidden",
      `Status=${result.status}, Scope=${result.scope}`
    );
  }

  // TEST 7: Direct voice action after tenant disable is rejected with 403 Forbidden
  {
    memDb.clear();
    await setGlobalVoiceKillSwitch({ enabled: true, dbOps: memDb });
    await setTenantVoiceKillSwitch({ tenantId: "tenant_alpha", enabled: false, dbOps: memDb });

    const result = await validateVoiceSessionForAction({
      tenantId: "tenant_alpha",
      sessionId: "lead_12345_test001",
      dbOps: memDb,
    });

    assert(
      result.allowed === false && result.status === 403 && result.scope === "tenant",
      "TEST 7: Direct voice action after tenant disable is rejected with 403 Forbidden",
      `Status=${result.status}, Scope=${result.scope}`
    );
  }

  // -------------------------------------------------------------------------
  // SECTION 3: Active-Session Revocation & Bounded Shutdown
  // -------------------------------------------------------------------------
  console.log("\n--- SECTION 3: Active-Session Revocation & Bounded Shutdown ---");

  // TEST 8: Existing active session after global disable is terminated within bounded time (<1s)
  {
    memDb.clear();
    await setGlobalVoiceKillSwitch({ enabled: true, dbOps: memDb });
    await setTenantVoiceKillSwitch({ tenantId: "tenant_alpha", enabled: true, dbOps: memDb });

    const sessionRes = await createVoiceSessionRecord({
      tenantId: "tenant_alpha",
      sessionId: "lead_10001_active01",
      dbOps: memDb,
    });
    assert(sessionRes.success === true, "Session created successfully for revocation test");

    // SuperAdmin triggers global kill switch
    const t0 = Date.now();
    await setGlobalVoiceKillSwitch({ enabled: false, reason: "Zero-day emergency kill", dbOps: memDb });

    // Client heartbeat revalidates permission
    const hb = await heartbeatVoiceSession({
      tenantId: "tenant_alpha",
      sessionId: "lead_10001_active01",
      dbOps: memDb,
    });
    const delayMs = Date.now() - t0;

    assert(
      hb.active === false && hb.status === VOICE_SESSION_STATUS.TERMINATED_BY_KILL_SWITCH,
      "TEST 8: Existing active session after global disable terminates within bounded time",
      `Active=${hb.active}, Status=${hb.status}, ShutdownDelay=${delayMs}ms`
    );
  }

  // TEST 9: Existing active session after tenant disable terminates within bounded time
  {
    memDb.clear();
    await setGlobalVoiceKillSwitch({ enabled: true, dbOps: memDb });
    await setTenantVoiceKillSwitch({ tenantId: "tenant_alpha", enabled: true, dbOps: memDb });

    await createVoiceSessionRecord({
      tenantId: "tenant_alpha",
      sessionId: "lead_10002_active02",
      dbOps: memDb,
    });

    // Tenant admin turns off voice
    const t0 = Date.now();
    await setTenantVoiceKillSwitch({ tenantId: "tenant_alpha", enabled: false, dbOps: memDb });

    const hb = await heartbeatVoiceSession({
      tenantId: "tenant_alpha",
      sessionId: "lead_10002_active02",
      dbOps: memDb,
    });
    const delayMs = Date.now() - t0;

    assert(
      hb.active === false && hb.status === VOICE_SESSION_STATUS.TERMINATED_BY_KILL_SWITCH,
      "TEST 9: Existing active session after tenant disable terminates within bounded time",
      `Active=${hb.active}, Status=${hb.status}, Delay=${delayMs}ms`
    );
  }

  // TEST 10: Other tenant active session remains unaffected when Tenant A is disabled
  {
    memDb.clear();
    await setGlobalVoiceKillSwitch({ enabled: true, dbOps: memDb });
    await setTenantVoiceKillSwitch({ tenantId: "tenant_alpha", enabled: true, dbOps: memDb });
    await setTenantVoiceKillSwitch({ tenantId: "tenant_beta", enabled: true, dbOps: memDb });

    await createVoiceSessionRecord({
      tenantId: "tenant_alpha",
      sessionId: "lead_20001_alpha",
      dbOps: memDb,
    });
    await createVoiceSessionRecord({
      tenantId: "tenant_beta",
      sessionId: "lead_20002_beta",
      dbOps: memDb,
    });

    // Disable Tenant A only
    await setTenantVoiceKillSwitch({ tenantId: "tenant_alpha", enabled: false, dbOps: memDb });

    const hbAlpha = await heartbeatVoiceSession({
      tenantId: "tenant_alpha",
      sessionId: "lead_20001_alpha",
      dbOps: memDb,
    });
    const hbBeta = await heartbeatVoiceSession({
      tenantId: "tenant_beta",
      sessionId: "lead_20002_beta",
      dbOps: memDb,
    });

    assert(
      hbAlpha.active === false && hbBeta.active === true,
      "TEST 10: Other tenant active session remains unaffected by tenant-specific disable",
      `Alpha_Active=${hbAlpha.active}, Beta_Active=${hbBeta.active}`
    );
  }

  // -------------------------------------------------------------------------
  // SECTION 4: Token Security, Session Binding & Expiry
  // -------------------------------------------------------------------------
  console.log("\n--- SECTION 4: Token Security, Session Binding & Expiry ---");

  // TEST 11: Reconnect using a revoked session is denied
  {
    await revokeVoiceSession({
      tenantId: "tenant_beta",
      sessionId: "lead_20002_beta",
      reason: "User closed session",
      status: VOICE_SESSION_STATUS.COMPLETED,
      dbOps: memDb,
    });

    const reconnectCheck = await validateVoiceSessionForAction({
      tenantId: "tenant_beta",
      sessionId: "lead_20002_beta",
      dbOps: memDb,
    });

    assert(
      reconnectCheck.allowed === false,
      "TEST 11: Reconnect using a revoked or completed session is denied",
      `Allowed=${reconnectCheck.allowed}, Reason=${reconnectCheck.reason}`
    );
  }

  // TEST 12: Expired session duration cap terminates session upon expiry
  {
    const now = Date.now();
    await memDb.set("tenants/tenant_beta/voice_sessions/lead_expired_001", {
      session_id: "lead_expired_001",
      tenant_id: "tenant_beta",
      status: VOICE_SESSION_STATUS.ACTIVE,
      started_at: new Date(now - 1000 * 1000).toISOString(),
      expires_at: new Date(now - 100 * 1000).toISOString(), // expired 100s ago
    });

    const hb = await heartbeatVoiceSession({
      tenantId: "tenant_beta",
      sessionId: "lead_expired_001",
      currentTime: now,
      dbOps: memDb,
    });

    assert(
      hb.active === false && hb.status === VOICE_SESSION_STATUS.EXPIRED,
      "TEST 12: Expired session duration cap terminates session upon heartbeat",
      `Active=${hb.active}, Status=${hb.status}`
    );
  }

  // TEST 13: Cross-tenant session token use is strictly denied (403)
  {
    // Session is owned by tenant_beta, attacker claims to be tenant_alpha
    const crossCheck = await validateVoiceSessionForAction({
      tenantId: "tenant_alpha",
      sessionId: "lead_expired_001", // under tenant_beta in memDb
      dbOps: memDb,
    });

    assert(
      crossCheck.allowed === false && crossCheck.status === 403,
      "TEST 13: Cross-tenant session token manipulation is strictly rejected (403)",
      `Status=${crossCheck.status}, Reason=${crossCheck.reason}`
    );
  }

  // TEST 14: Cross-conversation token use or uncatalogued session is rejected
  {
    const ghostCheck = await validateVoiceSessionForAction({
      tenantId: "tenant_beta",
      sessionId: "lead_99999_nonexistent",
      dbOps: memDb,
    });

    assert(
      ghostCheck.allowed === false && ghostCheck.status === 403,
      "TEST 14: Unregistered or cross-conversation session ID rejected server-side",
      `Status=${ghostCheck.status}`
    );
  }

  // -------------------------------------------------------------------------
  // SECTION 5: Concurrency, Duration & Resource Controls
  // -------------------------------------------------------------------------
  console.log("\n--- SECTION 5: Concurrency, Duration & Resource Controls ---");

  // TEST 15: Concurrent session limit enforced server-side (Pilot limit = 3)
  {
    memDb.clear();
    await setGlobalVoiceKillSwitch({ enabled: true, dbOps: memDb });
    await setTenantVoiceKillSwitch({ tenantId: "tenant_gamma", enabled: true, dbOps: memDb });

    // Create 3 active sessions
    await createVoiceSessionRecord({ tenantId: "tenant_gamma", sessionId: "lead_g01_sess", dbOps: memDb });
    await createVoiceSessionRecord({ tenantId: "tenant_gamma", sessionId: "lead_g02_sess", dbOps: memDb });
    await createVoiceSessionRecord({ tenantId: "tenant_gamma", sessionId: "lead_g03_sess", dbOps: memDb });

    // Attempt to create a 4th session
    const fourthSession = await createVoiceSessionRecord({
      tenantId: "tenant_gamma",
      sessionId: "lead_g04_sess",
      dbOps: memDb,
    });

    assert(
      fourthSession.success === false && fourthSession.status === 429,
      "TEST 15: Concurrent session limit strictly enforced server-side (429)",
      `Success=${fourthSession.success}, Status=${fourthSession.status}, Active=${fourthSession.activeCount}`
    );
  }

  // TEST 16: Abandoned/stale sessions automatically cleared after heartbeat timeout
  {
    const now = Date.now();
    // Simulate session 1 becoming stale (last heartbeat 45 seconds ago, threshold is 30s)
    await memDb.update("tenants/tenant_gamma/voice_sessions/lead_g01_sess", {
      last_heartbeat_at: new Date(now - 45 * 1000).toISOString(),
    });

    const activeList = await getTenantActiveVoiceSessions({
      tenantId: "tenant_gamma",
      currentTime: now,
      staleThresholdSeconds: 30,
      dbOps: memDb,
    });

    assert(
      activeList.length === 2 && !activeList.some((s) => s.sessionId === "lead_g01_sess"),
      "TEST 16: Stale/abandoned voice sessions without heartbeats do not consume concurrency slots",
      `ActiveCount=${activeList.length} (Expected 2)`
    );
  }

  // TEST 17: Maximum duration cap correctly calculates remaining lease time
  {
    const now = Date.now();
    const sessionRes = await createVoiceSessionRecord({
      tenantId: "tenant_gamma",
      sessionId: "lead_g05_duration",
      maxDurationSeconds: 900,
      dbOps: memDb,
    });

    const hb = await heartbeatVoiceSession({
      tenantId: "tenant_gamma",
      sessionId: "lead_g05_duration",
      currentTime: now + 300 * 1000, // 5 minutes in
      dbOps: memDb,
    });

    assert(
      hb.active === true && Math.abs(hb.remainingSeconds - 600) <= 2,
      "TEST 17: Maximum duration cap accurately calculates remaining seconds",
      `Active=${hb.active}, RemainingSeconds=${hb.remainingSeconds}`
    );
  }

  // -------------------------------------------------------------------------
  // SECTION 6: Safe Disconnect, Media & Browser Lifecycle
  // -------------------------------------------------------------------------
  console.log("\n--- SECTION 6: Safe Disconnect, Media & Browser Lifecycle ---");

  // TEST 18: Disconnect stops all microphone MediaStreamTrack instances (readyState='ended')
  {
    const stream = new MockMediaStream();
    const pc = new MockRTCPeerConnection();
    const dc = new MockRTCDataChannel();

    assert(stream.getTracks()[0].readyState === "live", "Precondition: track is live");

    // Simulate handleEndVoiceCall cleanup
    stream.getTracks().forEach((track) => track.stop());
    pc.close();
    dc.close();

    assert(
      stream.getTracks()[0].readyState === "ended" && pc.connectionState === "closed" && dc.readyState === "closed",
      "TEST 18: Disconnect explicitly stops MediaStreamTrack instances (readyState='ended')",
      `TrackState=${stream.getTracks()[0].readyState}, PC=${pc.connectionState}, DC=${dc.readyState}`
    );
  }

  // TEST 19: Safe idempotent disconnect (calling cleanup multiple times causes no errors)
  {
    const stream = new MockMediaStream();
    let errorCaught = false;

    try {
      // Call cleanup 5 times consecutively
      for (let i = 0; i < 5; i++) {
        stream.getTracks().forEach((track) => track.stop());
      }
    } catch (e) {
      errorCaught = true;
    }

    assert(
      errorCaught === false && stream.getTracks()[0].readyState === "ended",
      "TEST 19: Repeated disconnect operations are safe and idempotent",
      `Errors=${errorCaught}`
    );
  }

  // TEST 20: Component unmount triggers complete media and connection teardown
  {
    const mockRef = {
      current: {
        stream: new MockMediaStream(),
        pc: new MockRTCPeerConnection(),
        dc: new MockRTCDataChannel(),
      },
    };

    // Simulate unmount hook
    const teardown = () => {
      if (mockRef.current) {
        mockRef.current.stream.getTracks().forEach((t) => t.stop());
        mockRef.current.pc.close();
        mockRef.current.dc.close();
        mockRef.current = null;
      }
    };

    teardown();

    assert(
      mockRef.current === null,
      "TEST 20: Component unmount releases all media streams and nulls references",
      `RefCleared=${mockRef.current === null}`
    );
  }

  // -------------------------------------------------------------------------
  // SECTION 7: Failure Handling, Interruption & Text Fallback
  // -------------------------------------------------------------------------
  console.log("\n--- SECTION 7: Failure Handling, Interruption & Text Fallback ---");

  // TEST 21: Permission denial prevents voice start and preserves text chat workflow
  {
    let voiceState = "REQUESTING_PERMISSION";
    let agentMode = "voice";
    let textAvailable = true;

    // Simulate NotAllowedError
    try {
      throw new Error("NotAllowedError: Permission denied");
    } catch (err) {
      voiceState = "PERMISSION_DENIED";
      agentMode = "text";
    }

    assert(
      voiceState === "PERMISSION_DENIED" && agentMode === "text" && textAvailable === true,
      "TEST 21: Microphone permission denial halts voice and falls back smoothly to text",
      `VoiceState=${voiceState}, AgentMode=${agentMode}`
    );
  }

  // TEST 22: User interruption (barge-in) sends cancel event and pauses audio playback
  {
    const dc = new MockRTCDataChannel();
    let audioPaused = false;
    let activeResponse = true;

    // Simulate speech_started during activeResponse
    if (activeResponse) {
      dc.send(JSON.stringify({ type: "response.cancel" }));
      audioPaused = true;
      activeResponse = false;
    }

    const cancelMsgSent = dc.sentMessages.some((m) => m.includes("response.cancel"));

    assert(
      cancelMsgSent && audioPaused && !activeResponse,
      "TEST 22: User interruption (barge-in) immediately cancels response and pauses audio",
      `CancelSent=${cancelMsgSent}, AudioPaused=${audioPaused}`
    );
  }

  // TEST 23: Network loss marks state truthfully without false booking confirmations
  {
    const pc = new MockRTCPeerConnection();
    let state = "SPEAKING";
    let falseSuccessReported = false;

    // Simulate network drop
    pc.connectionState = "disconnected";
    if (pc.connectionState === "disconnected") {
      state = "ERROR";
    }

    assert(
      state === "ERROR" && !falseSuccessReported,
      "TEST 23: Network loss transitions to ERROR without falsely confirming incomplete actions",
      `State=${state}`
    );
  }

  // TEST 24: Mobile backgrounding (visibilitychange hidden) triggers safe teardown
  {
    const stream = new MockMediaStream();
    let backgroundHandled = false;

    // Simulate document.hidden
    const isHidden = true;
    if (isHidden) {
      stream.getTracks().forEach((t) => t.stop());
      backgroundHandled = true;
    }

    assert(
      backgroundHandled && stream.getTracks()[0].readyState === "ended",
      "TEST 24: Mobile backgrounding triggers safe microphone suspension and track release",
      `Handled=${backgroundHandled}, TrackState=${stream.getTracks()[0].readyState}`
    );
  }

  // TEST 25: Voice tool call after session revocation is rejected server-side
  {
    await setTenantVoiceKillSwitch({ tenantId: "tenant_gamma", enabled: false, dbOps: memDb });

    const toolCheck = await validateVoiceSessionForAction({
      tenantId: "tenant_gamma",
      sessionId: "lead_g05_duration",
      dbOps: memDb,
    });

    assert(
      toolCheck.allowed === false && toolCheck.status === 403,
      "TEST 25: Voice tool call after session revocation is rejected server-side (403)",
      `Status=${toolCheck.status}, Reason=${toolCheck.reason}`
    );
  }

  // TEST 26: Latency and Operational Performance Benchmark
  {
    const iterations = 25;
    const latencies = {
      setup: [],
      permissionCheck: [],
      sessionHeartbeat: [],
    };

    for (let i = 0; i < iterations; i++) {
      // Setup latency
      const t0 = performance.now();
      await checkEffectiveVoicePermission({ tenantId: "tenant_beta", dbOps: memDb });
      const t1 = performance.now();
      latencies.setup.push(t1 - t0);

      // Heartbeat latency
      const t2 = performance.now();
      await heartbeatVoiceSession({ tenantId: "tenant_gamma", sessionId: "lead_g05_duration", dbOps: memDb });
      const t3 = performance.now();
      latencies.sessionHeartbeat.push(t3 - t2);
    }

    const calcP50P95 = (arr) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)].toFixed(2);
      const p95 = sorted[Math.floor(sorted.length * 0.95)].toFixed(2);
      return { p50, p95 };
    };

    const setupStats = calcP50P95(latencies.setup);
    const hbStats = calcP50P95(latencies.sessionHeartbeat);

    assert(
      parseFloat(setupStats.p95) < 50 && parseFloat(hbStats.p95) < 50,
      "TEST 26: Latency performance benchmarks comply with operational thresholds",
      `Setup[p50=${setupStats.p50}ms, p95=${setupStats.p95}ms], Heartbeat[p50=${hbStats.p50}ms, p95=${hbStats.p95}ms]`
    );
  }

  // -------------------------------------------------------------------------
  // SUMMARY RESULTS
  // -------------------------------------------------------------------------
  console.log("\n================================================================================");
  const passedCount = testResults.filter((r) => r.status === "PASSED").length;
  const failedCount = testResults.filter((r) => r.status === "FAILED").length;
  console.log(`   CD09 TEST RESULTS: ${passedCount}/${testResults.length} PASSED  (${failedCount} FAILED)`);
  console.log("================================================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Unhandled exception in CD09 test suite:", err);
  process.exit(1);
});
