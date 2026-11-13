// scripts/cd03_live_project_rules_suite.mjs
import fs from "fs";

const RTDB_BASE = "https://aichatbot-a6217-default-rtdb.firebaseio.com";

console.log("================================================================================");
console.log("   EXECUTING ADVERSARIAL RULES TESTS AGAINST DEDICATED FIREBASE PROJECT");
console.log(`   Target Instance: ${RTDB_BASE}`);
console.log("================================================================================\n");

const tests = [
  { id: "LR1.1", name: "Root database read (.read: false)", path: "/.json", method: "GET", expectedStatus: 401 },
  { id: "LR1.2", name: "Root database write (.write: false)", path: "/.json", method: "PUT", body: { exploit: true }, expectedStatus: 401 },
  { id: "LR1.3", name: "Parent /tenants bulk dump read (.read: false)", path: "/tenants.json", method: "GET", expectedStatus: 401 },
  { id: "LR1.4", name: "Parent /settings bulk dump read (.read: false)", path: "/settings.json", method: "GET", expectedStatus: 401 },
  { id: "LR1.5", name: "Global settings/email_config read (.read: superadmin only)", path: "/settings/email_config.json", method: "GET", expectedStatus: 401 },
  { id: "LR1.6", name: "Tenant email_config read (.read: superadmin only)", path: "/tenants/tenant_a/email_config.json", method: "GET", expectedStatus: 401 },
  { id: "LR1.7", name: "Tenant secrets read (.read: false)", path: "/tenants/tenant_a/secrets.json", method: "GET", expectedStatus: 401 },
  { id: "LR1.8", name: "system_security read (.read: false)", path: "/system_security.json", method: "GET", expectedStatus: 401 },
  { id: "LR1.9", name: "Direct unauthenticated write to tenant leads (.write: auth token required)", path: "/tenants/tenant_a/leads.json", method: "POST", body: { hacker: "lead_bypass" }, expectedStatus: 401 },
  { id: "LR1.10", name: "Direct unauthenticated write to tenant cookies (.write: auth token required)", path: "/tenants/tenant_a/user_cookies.json", method: "POST", body: { cookie: "injected" }, expectedStatus: 401 },
  { id: "LR1.11", name: "Direct unauthenticated write to global leads (.write: superadmin)", path: "/leads.json", method: "POST", body: { name: "Fake Root Lead" }, expectedStatus: 401 },
  { id: "LR1.12", name: "Direct unauthenticated write to email_alerts (.write: superadmin phishing defense)", path: "/email_alerts.json", method: "POST", body: { to: "victim@example.com", text: "Phish" }, expectedStatus: 401 },
  { id: "LR1.13", name: "Direct unauthenticated write to scheduled_reminders (.write: superadmin)", path: "/scheduled_reminders.json", method: "POST", body: { text: "Spam" }, expectedStatus: 401 },
  { id: "LR1.14", name: "Direct unauthenticated write to system_logs (.write: superadmin)", path: "/system_logs/structured_events.json", method: "POST", body: { log: "forged" }, expectedStatus: 401 },
  { id: "LR1.15", name: "Intentional public visitor read: appearance (.read: true)", path: "/tenants/tenant_a/appearance.json", method: "GET", expectedStatus: 200 },
  { id: "LR1.16", name: "Intentional public visitor read: chatbot_config (.read: true)", path: "/tenants/tenant_a/chatbot_config.json", method: "GET", expectedStatus: 200 },
  { id: "LR1.17", name: "Intentional public visitor read: business_profile (.read: true)", path: "/tenants/tenant_a/business_profile.json", method: "GET", expectedStatus: 200 },
  { id: "LR1.18", name: "Atomic multi-path write attempting cross-tenant injection via REST patch", path: "/.json", method: "PATCH", body: { "tenants/tenant_a/leads/lead_1": { name: "A" }, "tenants/tenant_b/leads/lead_2": { name: "B" } }, expectedStatus: 401 },
];

async function run() {
  const results = [];
  let passedCount = 0;

  for (const t of tests) {
    const url = `${RTDB_BASE}${t.path}`;
    const opts = {
      method: t.method,
      headers: { "Content-Type": "application/json" },
    };
    if (t.body) {
      opts.body = JSON.stringify(t.body);
    }

    try {
      const res = await fetch(url, opts);
      const text = await res.text();
      const passed = res.status === t.expectedStatus;
      if (passed) passedCount++;

      console.log(`  [${passed ? "PASS" : "FAIL"}] [${t.id}] ${t.name}`);
      console.log(`         HTTP ${t.method} ${t.path} -> Status: ${res.status} (Expected: ${t.expectedStatus}) | Response: ${text.slice(0, 80).replace(/\n/g, "")}`);

      results.push({
        id: t.id,
        name: t.name,
        method: t.method,
        path: t.path,
        expectedStatus: t.expectedStatus,
        actualStatus: res.status,
        responseSnippet: text.slice(0, 100),
        status: passed ? "PASS" : "FAIL",
      });
    } catch (err) {
      console.log(`  [FAIL] [${t.id}] ${t.name}: Network/Fetch error: ${err.message}`);
      results.push({
        id: t.id,
        name: t.name,
        status: "FAIL",
        error: err.message,
      });
    }
  }

  console.log("\n================================================================================");
  console.log(`   DEDICATED PROJECT EXECUTION SUMMARY: ${passedCount} PASSED | ${tests.length - passedCount} FAILED | ${tests.length} TOTAL`);
  console.log("================================================================================\n");

  const evidence = {
    target: RTDB_BASE,
    timestamp: new Date().toISOString(),
    total: tests.length,
    passed: passedCount,
    failed: tests.length - passedCount,
    results,
  };

  fs.writeFileSync("evaluations/cd03_dedicated_project_evidence.json", JSON.stringify(evidence, null, 2), "utf8");
  console.log("Saved live evidence to evaluations/cd03_dedicated_project_evidence.json");
}

run();
