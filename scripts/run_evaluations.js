// scripts/run_evaluations.js
const fs = require("fs");
const path = require("path");

// Ensure your local dev server is running on this port
const API_URL = "http://localhost:3000/api/chat";
const POLICY_VERSION = "2.1.0";

const SCENARIOS = [
  {
    name: "Pricing First",
    messages: [{ role: "user", content: "How much does CloseDesk cost?" }],
    evaluators: (res) => [
      {
        name: "Factual Pricing Given",
        passed: res.reply.includes("97") || res.reply.includes("297"),
      },
      { name: "Intent Logged", passed: res.intent_object.includes("Pricing") },
    ],
  },
  {
    name: "Immediate Human Handoff",
    messages: [
      { role: "user", content: "Stop talking to me, get me a human now." },
    ],
    evaluators: (res) => [
      {
        name: "Action State Switched",
        passed:
          res.next_action === "HUMAN_HANDOFF" ||
          res.flags.includes("ESCALATE_HUMAN"),
      },
    ],
  },
  {
    name: "Critical Data Deletion Trigger",
    messages: [{ role: "user", content: "Delete all my data and forget me." }],
    evaluators: (res) => [
      {
        name: "Deletion Flag Emitted",
        passed: res.flags.includes("TRIGGER_DATA_DELETION"),
      },
    ],
    critical: true,
  },
];

async function runSuite() {
  console.log(
    `\n🚀 Starting QA Regression Suite for Policy v${POLICY_VERSION}...\n`,
  );
  let passedTests = 0,
    totalTests = 0,
    criticalFailure = false;
  const reportData = {
    timestamp: new Date().toISOString(),
    policy_version: POLICY_VERSION,
    results: [],
  };

  for (const scenario of SCENARIOS) {
    process.stdout.write(`Evaluating [${scenario.name}]... `);
    try {
      // Note: Node 18+ is required for the native fetch API
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: `QA_TEST_${Date.now()}`,
          channel: "regression_suite",
          messages: scenario.messages,
          current_lead_data: {},
        }),
      });

      const data = await response.json();
      const checks = scenario.evaluators(data);
      const allPassed = checks.every((c) => c.passed);

      if (scenario.critical && !allPassed) criticalFailure = true;
      checks.forEach((c) => {
        totalTests++;
        if (c.passed) passedTests++;
      });

      reportData.results.push({
        scenario: scenario.name,
        status: allPassed ? "PASS" : "FAIL",
        critical: scenario.critical || false,
        checks: checks,
        ai_reply: data.reply,
      });
      console.log(allPassed ? "✅ PASS" : "❌ FAIL");
    } catch (err) {
      console.log(`⚠️ ERROR: ${err.message}`);
      criticalFailure = true;
    }
  }

  const reportDir = path.join(process.cwd(), "evaluations");
  fs.writeFileSync(
    path.join(reportDir, `report_v${POLICY_VERSION}.json`),
    JSON.stringify(reportData, null, 2),
  );

  if (criticalFailure) {
    console.error(`\n🚨 CRITICAL FAILURE DETECTED. Blocking release pipeline.`);
    process.exit(1);
  } else {
    console.log(
      `\n✨ Suite completed successfully: ${passedTests}/${totalTests} Passed.`,
    );
    process.exit(0);
  }
}

runSuite();
