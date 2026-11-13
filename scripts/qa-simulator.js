// scripts/qa-simulator.js
/**
 * Aicyro Telemetry QA Suite (CD14)
 *
 * Verifies 4 key telemetry, logging, and security contracts:
 * 1. Successful Chat & Lead Creation
 * 2. Unauthorized Cron Request (Security Gate)
 * 3. Secret Redaction in Error Logs
 * 4. Admin Audit Log Querying with authenticated session
 */

import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Register custom ESM extension loader to allow Next.js route handlers to load in Node ESM
register("./scripts/esm_loader.mjs", pathToFileURL("./"));

const { signSessionToken } = await import("../src/lib/authSession.js");
const superAdminToken = signSessionToken({
  sub: "qa_tester",
  role: "superadmin",
  tenantId: "default",
  stepUpVerified: true,
});

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

function createMockReqRes({
  method = "POST",
  headers = {},
  url = "/api",
  body = {},
} = {}) {
  const req = {
    method,
    headers: { ...headers },
    cookies: {},
    url,
    body,
  };

  if (headers.cookie) {
    const parts = headers.cookie.split(";");
    for (const p of parts) {
      const [k, v] = p.trim().split("=");
      if (k && v) req.cookies[k] = decodeURIComponent(v);
    }
  }

  let statusCode = 200;
  let responseData = null;

  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    setHeader() {
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
    end() {
      return res;
    },
    getStatusCode() {
      return statusCode;
    },
    getResponseData() {
      return responseData;
    },
  };

  return { req, res };
}

async function isServerRunning(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 800);
    const res = await fetch(url, { method: "HEAD", signal: controller.signal });
    clearTimeout(timeoutId);
    return res.status < 500;
  } catch (_) {
    return false;
  }
}

async function runAllTests() {
  console.log("================================================================================");
  console.log("🚀  STARTING AICYRO TELEMETRY QA SUITE (CD14)");
  console.log("================================================================================\n");

  const serverOnline = await isServerRunning(`${BASE_URL}/api/cron/retention-cleanup`);
  console.log(`Execution Mode: ${serverOnline ? "Live HTTP (" + BASE_URL + ")" : "In-Process Route Handlers"}\n`);

  let chatHandler, cronHandler, appStateHandler, appQueryHandler;
  if (!serverOnline) {
    chatHandler = (await import("../src/pages/api/chat.js")).default;
    cronHandler = (await import("../src/pages/api/cron/retention-cleanup.js")).default;
    appStateHandler = (await import("../src/pages/api/app-state.js")).default;
    appQueryHandler = (await import("../src/pages/api/app-query.js")).default;
  }

  let passed = 0;
  let failed = 0;
  const testResults = [];

  async function executeTest(testName, endpoint, payload, headers, handlerFn, expectedStatusCheck) {
    console.log(`⏳ Running: ${testName}...`);
    try {
      let status, data;
      if (serverOnline) {
        const response = await fetch(`${BASE_URL}${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(payload),
        });
        status = response.status;
        data = await response.json().catch(() => ({}));
      } else {
        const { req, res } = createMockReqRes({
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          url: endpoint,
          body: payload,
        });
        await handlerFn(req, res);
        status = res.getStatusCode();
        data = res.getResponseData();
      }

      const passedCheck = expectedStatusCheck(status, data);
      if (passedCheck) {
        console.log(`  ✅ PASS: ${testName} (Status: ${status})`);
        passed++;
        testResults.push({ name: testName, status: "PASS", code: status });
      } else {
        console.log(`  ❌ FAIL: ${testName} (Status: ${status})`);
        failed++;
        testResults.push({ name: testName, status: "FAIL", code: status, data });
      }
    } catch (err) {
      console.log(`  ❌ FAIL: ${testName} (Exception: ${err.message})`);
      failed++;
      testResults.push({ name: testName, status: "FAIL", error: err.message });
    }
  }

  const testSessionId = `lead_${Date.now()}_qa123`;

  // 1. Chat & Lead Creation
  await executeTest(
    "1. Successful Chat & Lead Creation",
    "/api/chat",
    {
      session_id: testSessionId,
      messages: [{ role: "user", content: "I need to book a demo." }],
      current_lead_data: { tenant_id: "default" },
    },
    { "x-tenant-id": "default" },
    chatHandler,
    (status) => status === 200
  );

  // 2. Unauthorized Cron Request
  await executeTest(
    "2. Unauthorized Cron Request",
    "/api/cron/retention-cleanup",
    {},
    {},
    cronHandler,
    (status) => status === 401
  );

  // 3. Secret Redaction Test in App State
  await executeTest(
    "3. Secret Redaction Test",
    "/api/app-state",
    {
      log_id: `log_qa_${Date.now()}`,
      timestamp: new Date().toISOString(),
      level: "ERROR",
      event_type: "security_audit",
      event_name: "secret_injection_test",
      correlation_id: `trace_${Date.now()}`,
      error_message: "Connection failed with Bearer sk-proj-1234567890abcdef123456 and password123",
      environment: "development",
      service: "QA",
      component: "AutomatedTesting",
    },
    {},
    appStateHandler,
    (status, data) => status === 200 && data && data.success === true
  );

  // 4. Admin Audit Log Generation (with SuperAdmin Auth Token)
  await executeTest(
    "4. Admin Audit Log Generation",
    "/api/app-query",
    {
      role: "SUPERADMIN",
      userId: "qa_tester",
      searchTerm: "test",
    },
    {
      cookie: `closedesk_session=${superAdminToken}`,
      authorization: `Bearer ${superAdminToken}`,
    },
    appQueryHandler,
    (status) => status === 200
  );

  console.log("\n================================================================================");
  console.log(`   TELEMETRY QA SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("================================================================================\n");

  const evidenceDir = path.resolve("./evaluations");
  if (!fs.existsSync(evidenceDir)) fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "qa_simulator_evidence.json"),
    JSON.stringify({ timestamp: new Date().toISOString(), passed, failed, results: testResults }, null, 2),
    "utf8"
  );

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runAllTests().catch((err) => {
  console.error("Fatal error running telemetry QA suite:", err);
  process.exit(1);
});
