// scripts/qa-simulator.js
// Run this via terminal: node scripts/qa-simulator.js

const BASE_URL = "http://localhost:3000";

async function runTest(testName, endpoint, payload, expectedStatus) {
  console.log(`\n⏳ Running: ${testName}...`);
  try {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    
    if (response.status === expectedStatus || (expectedStatus === 200 && response.ok)) {
      console.log(`✅ PASS: ${testName} (Status ${response.status})`);
    } else {
      console.log(`❌ FAIL: ${testName} (Expected ${expectedStatus}, got ${response.status})`);
      const errorText = await response.text();
      console.log(`   Reason: ${errorText}`);
    }
  } catch (error) {
    console.log(`❌ FAIL: Network error on ${testName}`, error.message);
  }
}

async function runAllTests() {
  console.log("🚀 STARTING AICYRO TELEMETRY QA SUITE...\n");

  // FIX 1: Generate a Session ID that strictly matches the sync-voice.js Regex (^lead_\d+_[a-z0-9]{5,10}$)
  const testSessionId = `lead_${Date.now()}_qa123`;

  // 1. Successful Chat & Lead Creation
  await runTest("1. Successful Chat & Lead Creation", "/api/chat", {
    session_id: testSessionId,
    messages: [{ role: "user", content: "I need to book a demo." }]
  }, 200);

  // 2. Invalid Email (Tool Failure)
  await runTest("2. Invalid Email Tool Validation", "/api/sync-voice", {
    session_id: testSessionId,
    tool_name: "update_prospect_context",
    tool_args: { contact_info: { email: "not-an-email" } }
  }, 200);

  // 3. Unauthorized Request (Cron Security)
  await runTest("3. Unauthorized Cron Request", "/api/cron/retention-cleanup", {}, 401);

  // 4. Secret-in-Error Injection (Redaction Test)
  // FIX 2: Provide a complete payload with log_id, timestamp, and component to pass API schema validation
  await runTest("4. Secret Redaction Test", "/api/app-state", {
    log_id: `log_qa_${Date.now()}`,
    timestamp: new Date().toISOString(),
    level: "ERROR",
    event_type: "security_audit",
    event_name: "secret_injection_test",
    correlation_id: `trace_${Date.now()}`,
    error_message: "Connection failed with Bearer sk-proj-1234567890abcdef123456 and password123",
    environment: "development",
    service: "QA",
    component: "AutomatedTesting"
  }, 200);

  // 5. Admin Audit Log Generation
  await runTest("5. Admin Audit Log Generation", "/api/app-query", {
    role: "SUPERADMIN",
    userId: "qa_tester",
    searchTerm: "test"
  }, 200);

  console.log("\n🎉 AUTOMATED QA COMPLETE. Check your logs.jsx dashboard to verify entries and redaction!");
}

runAllTests();