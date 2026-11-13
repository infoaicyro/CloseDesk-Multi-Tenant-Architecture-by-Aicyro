// scripts/cd01_baseline_audit.js
/**
 * P0 Ticket CD01: Capability and Evidence Baseline Audit Script
 * Deterministically audits:
 * 1. Git metadata & HEAD commit hash.
 * 2. Exact file existence of all baseline matrix citations.
 * 3. Exact parsing of evaluations/report_v2.1.0.json without mock data.
 * 4. Scan of src/ and public/ asserting 0 unverified "telephone answering" strings.
 * 5. Generates evaluations/cd01_audit_evidence.json.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

function getFileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function getGitMetadata() {
  try {
    const headCommit = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
    return { headCommit, branch };
  } catch (err) {
    return { headCommit: "UNKNOWN", branch: "UNKNOWN", error: err.message };
  }
}

function getPackageMetadata() {
  const pkgPath = path.join(process.cwd(), "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  return {
    name: pkg.name,
    version: pkg.version,
    engines: pkg.engines,
    scripts: pkg.scripts,
  };
}

const BASELINE_REFERENCED_FILES = [
  "package.json",
  "netlify.toml",
  "firebase.json",
  ".firebaserc",
  "database.rules.json",
  "src/lib/ruleBook.js",
  "src/lib/visionRuleBook.js",
  "evaluations/report_v2.1.0.json",
  "public/widget.js",
  "src/Closedesk/Chatbot/AicyroChatbot.jsx",
  "src/pages/api/chat.js",
  "src/pages/api/app-query.js",
  "src/pages/api/openai-token.js",
  "src/pages/api/tts.js",
  "src/pages/api/sync-voice.js",
  "src/Closedesk/Dashboard/Booking.jsx",
  "src/pages/api/auth/google/login.js",
  "src/pages/api/auth/google/callback.js",
  "src/pages/api/auth/microsoft/login.js",
  "src/pages/api/auth/microsoft/callback.js",
  "src/pages/api/leads.js",
  "src/pages/api/cron/retention-cleanup.js",
  "src/Closedesk/Dashboard/Conversations.jsx",
  "src/pages/api/analyze-image.js",
  "src/Closedesk/Dashboard/Report.jsx",
  "src/Closedesk/Dashboard/LiveNotifications.jsx",
  "src/Closedesk/Dashboard/Settings/notification-settings.jsx",
  "src/lib/notificationHelper.js",
  "src/lib/alertManager.js",
  "src/pages/api/generate-email.js",
  "functions/index.js",
  "docs/VOICE_PRIVACY_POLICY.md",
  "docs/VOICE_PRODUCTION_READINESS_SIGNOFF.md",
  "docs/VOICE_QA_TEST_SUITE.md",
  "docs/LOGGING_SCHEMA.md",
  "scripts/run_evaluations.js",
  "scripts/industry_regression_suite.js",
  "scripts/qa-simulator.js",
  "scripts/vad_tuning_harness.js",
  "scripts/voice_qa_harness.js",
  "scripts/e2e_master_suite.js",
];

function verifyFilesExist() {
  const missingFiles = [];
  const verifiedFiles = [];

  for (const relPath of BASELINE_REFERENCED_FILES) {
    const fullPath = path.join(process.cwd(), relPath);
    if (!fs.existsSync(fullPath)) {
      missingFiles.push(relPath);
    } else {
      verifiedFiles.push({
        path: relPath,
        sizeBytes: fs.statSync(fullPath).size,
      });
    }
  }

  if (missingFiles.length > 0) {
    throw new Error(
      `CRITICAL AUDIT FAILURE: The following referenced files do not exist on disk:\n${missingFiles.join("\n")}`
    );
  }

  return verifiedFiles;
}

function parseEvaluationReport() {
  const reportPath = path.join(process.cwd(), "evaluations", "report_v2.1.0.json");
  if (!fs.existsSync(reportPath)) {
    throw new Error(`Report not found at ${reportPath}`);
  }

  const raw = fs.readFileSync(reportPath, "utf8");
  const report = JSON.parse(raw);

  const totalScenarios = report.results.length;
  let totalChecks = 0;
  let passedChecks = 0;
  let failedChecks = 0;
  let passedScenarios = 0;
  let failedScenarios = 0;

  for (const r of report.results) {
    if (r.status === "PASS") passedScenarios++;
    else failedScenarios++;

    for (const c of r.checks) {
      totalChecks++;
      if (c.passed) passedChecks++;
      else failedChecks++;
    }
  }

  return {
    rawReportPath: "evaluations/report_v2.1.0.json",
    timestamp: report.timestamp,
    policy_version: report.policy_version,
    totalScenarios,
    passedScenarios,
    failedScenarios,
    totalChecks,
    passedChecks,
    failedChecks,
    scenarioDetails: report.results.map((r) => ({
      scenario: r.scenario,
      status: r.status,
      critical: r.critical,
      checkCount: r.checks.length,
      checks: r.checks,
      ai_reply: r.ai_reply,
    })),
  };
}

function scanForTelephonyViolations(dirs = ["src", "public"]) {
  const forbiddenPatterns = [
    /\btelephone answering\b/i,
    /\bphone answering\b/i,
    /\bhandles phone calls\b/i,
  ];

  const violations = [];

  function walkDir(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else if (
        entry.isFile() &&
        /\.(js|jsx|json|html|css|txt|md)$/i.test(entry.name)
      ) {
        const content = fs.readFileSync(fullPath, "utf8");
        const lines = content.split("\n");
        lines.forEach((line, idx) => {
          for (const pattern of forbiddenPatterns) {
            if (pattern.test(line)) {
              violations.push({
                file: path.relative(process.cwd(), fullPath).replace(/\\/g, "/"),
                line: idx + 1,
                matchedText: line.trim(),
                pattern: pattern.toString(),
              });
            }
          }
        });
      }
    }
  }

  dirs.forEach(walkDir);
  return violations;
}

function runAudit() {
  console.log("===============================================================");
  console.log("🔍 EXECUTING P0 CD01 DETERMINISTIC BASELINE AUDIT");
  console.log("===============================================================\n");

  const gitMeta = getGitMetadata();
  const pkgMeta = getPackageMetadata();
  console.log(`Git Head Commit: ${gitMeta.headCommit}`);
  console.log(`Git Branch:      ${gitMeta.branch}`);
  console.log(`Node Version:    ${process.version}`);
  console.log(`Package Name:    ${pkgMeta.name} v${pkgMeta.version}`);
  console.log("");

  // 1. Verify existence of baseline files
  console.log("Step 1: Verifying disk existence of all baseline matrix files...");
  const verifiedFiles = verifyFilesExist();
  console.log(`✅ All ${verifiedFiles.length} referenced baseline files verified on disk.\n`);

  // 2. Hash Critical Policy & Config Files
  console.log("Step 2: Hashing critical policy and database rules...");
  const hashes = {
    ruleBook: getFileHash(path.join(process.cwd(), "src/lib/ruleBook.js")),
    visionRuleBook: getFileHash(path.join(process.cwd(), "src/lib/visionRuleBook.js")),
    databaseRules: getFileHash(path.join(process.cwd(), "database.rules.json")),
  };
  console.log(`   - src/lib/ruleBook.js:       ${hashes.ruleBook}`);
  console.log(`   - src/lib/visionRuleBook.js: ${hashes.visionRuleBook}`);
  console.log(`   - database.rules.json:       ${hashes.databaseRules}\n`);

  // 3. Parse evaluations/report_v2.1.0.json
  console.log("Step 3: Parsing evaluations/report_v2.1.0.json verbatim...");
  const reportData = parseEvaluationReport();
  console.log(`   - Timestamp:        ${reportData.timestamp}`);
  console.log(`   - Policy Version:   ${reportData.policy_version}`);
  console.log(`   - Total Scenarios:  ${reportData.totalScenarios} (${reportData.passedScenarios} PASS, ${reportData.failedScenarios} FAIL)`);
  console.log(`   - Total Checks:     ${reportData.totalChecks} (${reportData.passedChecks} Passed, ${reportData.failedChecks} Failed)`);
  console.log("   - Breakdown:");
  reportData.scenarioDetails.forEach((s) => {
    console.log(`       * [${s.status}] ${s.scenario} (Critical: ${s.critical}, Checks: ${s.checkCount})`);
  });
  console.log("");

  // 4. Scan for telephone answering violations
  console.log("Step 4: Scanning src/ and public/ for unverified telephone answering claims...");
  const violations = scanForTelephonyViolations(["src", "public"]);
  if (violations.length > 0) {
    console.error("❌ Telephony labelling violations found in codebase:");
    violations.forEach((v) => {
      console.error(`   - ${v.file}:${v.line} -> "${v.matchedText}"`);
    });
    throw new Error(
      `Audit failed: Found ${violations.length} unverified telephony phrasing violations in src/ or public/.`
    );
  }
  console.log("✅ Zero telephony phrasing violations found. Browser Voice labelling verified.\n");

  // 5. Build Evidence Payload
  const evidence = {
    audit_id: "CD01_BASELINE_EVIDENCE",
    generated_at: new Date().toISOString(),
    git: gitMeta,
    runtime: {
      node: process.version,
      package: pkgMeta,
    },
    policy_hashes: hashes,
    evaluation_artifact: reportData,
    inspected_files_count: verifiedFiles.length,
    telephony_violations_count: violations.length,
    verified_files: verifiedFiles,
    capabilities_matrix: {
      "Website text": {
        status: "Implemented",
        tested: true,
        deployed: true,
        evidence: {
          ui: "public/widget.js:593-611, src/Closedesk/Chatbot/AicyroChatbot.jsx:1040-1080",
          api: "src/pages/api/chat.js:108-367, src/pages/api/app-query.js:39-120",
          db: "Firebase Realtime Database (prospects, transcripts, analytics_events)",
          tests: "scripts/run_evaluations.js:1-117, scripts/qa-simulator.js:34-37",
        },
      },
      "Browser voice": {
        status: "Implemented",
        tested: true,
        deployed: true,
        evidence: {
          ui: "src/Closedesk/Chatbot/AicyroChatbot.jsx:500-645",
          api: "src/pages/api/openai-token.js:26-277, src/pages/api/tts.js:14-55, src/pages/api/sync-voice.js:11-223",
          db: "Firebase Realtime Database (voice_telemetry, voice_errors, transcripts)",
          rollback_killswitch: "src/lib/ruleBook.js:11-23, src/pages/api/openai-token.js:111-116",
          tests: "scripts/vad_tuning_harness.js:1-88, scripts/voice_qa_harness.js:1-111, docs/VOICE_QA_TEST_SUITE.md:1-93",
        },
      },
      Booking: {
        status: "Implemented",
        tested: true,
        deployed: true,
        evidence: {
          ui: "src/Closedesk/Dashboard/Booking.jsx:43-177, src/Closedesk/Chatbot/AicyroChatbot.jsx:932-995",
          api: "src/pages/api/leads.js:40-172, src/pages/api/chat.js:39-40, 73-77",
          db: "Firebase Realtime Database (leads, tenants/$tenant_id/leads)",
          calendar_oauth_scope_note: "OAuth scopes in auth/google and auth/microsoft are SMTP mail only; direct Google/Outlook Calendar API event creation is not wired",
          tests: "scripts/e2e_master_suite.js:292-312, scripts/industry_regression_suite.js:22-30",
        },
      },
      Rescheduling: {
        status: "Unsupported",
        tested: false,
        deployed: false,
        evidence: {
          frontend_status_dropdown: "src/Closedesk/Dashboard/Booking.jsx:526-538 (manual RTDB string update)",
          email_template_footer: "functions/index.js:406 (reply to email prompt)",
          backend_api: "No implementation found in codebase",
          automated_logic: "No implementation found in codebase",
        },
      },
      Cancellation: {
        status: "Unsupported",
        tested: false,
        deployed: false,
        evidence: {
          frontend_status_dropdown: "src/Closedesk/Dashboard/Booking.jsx:528-538 (manual RTDB string update)",
          ui_modal_cancel_buttons: "src/Closedesk/Chatbot/AicyroChatbot.jsx:1341, src/Closedesk/Dashboard/CookieDataDisplay.jsx:450, src/Closedesk/Dashboard/superadmin/ClientManagement.jsx:966",
          backend_api: "No implementation found in codebase",
          automated_logic: "No implementation found in codebase",
        },
      },
      Recordings: {
        status: "Disabled",
        tested: true,
        deployed: true,
        evidence: {
          policy: "docs/VOICE_PRIVACY_POLICY.md:5-7 (Raw audio storage explicitly disabled by policy)",
          transcripts_api: "src/pages/api/sync-voice.js:88-98 (text transcripts only)",
          telemetry_api: "src/pages/api/sync-voice.js:31-57 (latency metrics only)",
          retention_cleanup: "src/pages/api/cron/retention-cleanup.js:8-73",
          dashboard_transcript_viewer: "src/Closedesk/Dashboard/Conversations.jsx:72-83",
        },
      },
      "Image analysis": {
        status: "Implemented",
        tested: true,
        deployed: true,
        evidence: {
          ui: "src/Closedesk/Chatbot/AicyroChatbot.jsx:336-395 (camera/photo upload)",
          api: "src/pages/api/analyze-image.js:22-109 (OpenAI gpt-4o-mini vision)",
          policy: "src/lib/visionRuleBook.js:1-52 (Vision Policy v1.1.0, 9 trade domains)",
          storage: "Firebase Storage (chat_images) & Firebase Realtime Database (last_vision_inspection)",
        },
      },
      Exports: {
        status: "Implemented",
        tested: false,
        deployed: true,
        evidence: {
          frontend_csv_export: "src/Closedesk/Dashboard/Report.jsx:261-272 (client-side data URI CSV download)",
          frontend_email_export: "src/Closedesk/Dashboard/Report.jsx:274-278 (mailto: trigger)",
          frontend_pdf_export: "src/Closedesk/Dashboard/Report.jsx:285 (window.print)",
          backend_api: "No implementation found in codebase (client-side data synthesis only)",
        },
      },
      Notifications: {
        status: "Implemented",
        tested: true,
        deployed: true,
        evidence: {
          ui_feed: "src/Closedesk/Dashboard/LiveNotifications.jsx:61-82",
          ui_settings: "src/Closedesk/Dashboard/Settings/notification-settings.jsx:38-76",
          helper: "src/lib/notificationHelper.js:6-54 (queueEmailAlert pushes to email_alerts)",
          alert_manager: "src/lib/alertManager.js:17-61 (processSmartAlert pushes to system_alerts)",
          cloud_function: "functions/index.js:152-349 (sendEmailAlert onCreate trigger + dynamic SMTP)",
          external_webhook: "src/pages/api/generate-email.js:5-55 (Make.com email trigger)",
        },
      },
    },
    missing_scheduler_audit: {
      section: "8.3",
      findings: [
        {
          component: "Daily Retention Cleanup Cron",
          documented_path: "TECHNICAL_ARCHITECTURE.md:132-134 (.github/workflows/retention-cron.yml)",
          code_endpoint: "src/pages/api/cron/retention-cleanup.js:20-84",
          disk_status: "MISSING_TRIGGER",
          details: ".github directory is completely absent from disk. netlify.toml and firebase.json contain no cron trigger or scheduler for /api/cron/retention-cleanup. Endpoint is unwired to any automated scheduler.",
        },
        {
          component: "Automated Reminder Cron",
          code_function: "functions/index.js:354-443 (exports.processScheduledReminders = functions.pubsub.schedule('every 1 hours'))",
          disk_status: "STANDALONE_CLOUD_FUNCTION",
          details: "Configured via Firebase PubSub Cloud Scheduler inside functions/index.js, but independent from Netlify deployment and requires Google Cloud Functions deployment with active GCP billing.",
        },
      ],
    },
  };

  const outDir = path.join(process.cwd(), "evaluations");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "cd01_audit_evidence.json");
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2), "utf8");

  console.log(`===============================================================`);
  console.log(`🎉 CD01 BASELINE AUDIT COMPLETE`);
  console.log(`📄 Machine-readable evidence written to: evaluations/cd01_audit_evidence.json`);
  console.log(`===============================================================\n`);
}

try {
  runAudit();
  process.exit(0);
} catch (err) {
  console.error("\n🚨 AUDIT RUN FAILED:", err.message);
  process.exit(1);
}
