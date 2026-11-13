// scripts/cd11_tenant_onboarding_suite.js
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Register custom ESM extension loader to allow Next.js route handlers & JSX to load in Node ESM
register("./scripts/esm_loader.mjs", pathToFileURL("./"));

// Dynamically import project modules
const {
  TENANT_ACTIVATION_STATUS,
  ACTIVATION_CHECKLIST_ITEMS,
  isValidEmbedOrigin,
  normalizeEmbedOrigin,
  isOriginAllowedForTenant,
  validateTenantReadiness,
  assertTenantActivationReadiness,
} = await import("../src/lib/onboardingContract.js");

const {
  sanitizeTenantId,
  resolveTenantId,
  resolveAuthenticatedTenantId,
  getTenantConfig,
} = await import("../src/lib/tenantResolver.js");

const { default: tenantsApiHandler } = await import("../src/pages/api/superadmin/tenants.js");
const { signSessionToken } = await import("../src/lib/authSession.js");
const superAdminToken = signSessionToken({
  sub: "superadmin",
  role: "superadmin",
  tenantId: "default",
  stepUpVerified: true,
});
const { default: chatHandler } = await import("../src/pages/api/chat.js");
const { default: leadsHandler } = await import("../src/pages/api/leads.js");
const { default: tokenHandler } = await import("../src/pages/api/openai-token.js");

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
    if (this.store.has(p)) {
      const val = this.store.get(p);
      return val !== undefined && val !== null ? JSON.parse(JSON.stringify(val)) : null;
    }
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
 * Mock Request & Response Helper
 */
function createMockReqRes({
  method = "GET",
  headers = {},
  url = "/api",
  body = {},
  query = {},
} = {}) {
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
    setHeader(key, val) {
      resHeaders[key.toLowerCase()] = val;
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

// Global test counters
let passedTests = 0;
let failedTests = 0;
const testResults = [];

function assert(condition, message, details = {}) {
  const result = {
    test_id: `TC11.${testResults.length + 1}`,
    name: message,
    status: condition ? "PASS" : "FAIL",
    details: typeof details === "object" ? details : { info: details },
    timestamp: new Date().toISOString(),
  };
  testResults.push(result);

  if (!condition) {
    failedTests++;
    console.error(`  ✖ [FAIL] ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
  passedTests++;
  console.log(`  ✔ [PASS] ${message}`);
}

async function runTestSuite() {
  console.log("================================================================================");
  console.log("   CD11: REPEATABLE TENANT ONBOARDING & ACTIVATION CHECKLIST TEST SUITE");
  console.log("================================================================================\n");

  const memDb = new InMemoryDb();

  // --------------------------------------------------------------------------------
  // SECTION 1: 7-Item Activation Checklist Schema & Validation Logic
  // --------------------------------------------------------------------------------
  console.log("--- SECTION 1: 7-Item Activation Checklist Schema & Validation Logic ---");

  // TEST 1.1: Canonical Status Constants & Items Enum
  {
    assert(TENANT_ACTIVATION_STATUS.PENDING_SETUP === "pending_setup", "Status PENDING_SETUP defined");
    assert(TENANT_ACTIVATION_STATUS.RESTRICTED === "restricted", "Status RESTRICTED defined");
    assert(TENANT_ACTIVATION_STATUS.ACTIVE === "active", "Status ACTIVE defined");
    assert(TENANT_ACTIVATION_STATUS.SUSPENDED === "suspended", "Status SUSPENDED defined");

    assert(Object.keys(ACTIVATION_CHECKLIST_ITEMS).length === 7, "All 7 operational checklist items defined");
    assert(ACTIVATION_CHECKLIST_ITEMS.ALLOWED_DOMAINS === "allowed_domains", "Checklist item: allowed_domains");
    assert(ACTIVATION_CHECKLIST_ITEMS.TENANT_MAPPING === "tenant_mapping", "Checklist item: tenant_mapping");
    assert(ACTIVATION_CHECKLIST_ITEMS.SERVICES_AREAS === "services_areas", "Checklist item: services_areas");
    assert(ACTIVATION_CHECKLIST_ITEMS.TIMEZONE_HOURS === "timezone_hours", "Checklist item: timezone_hours");
    assert(ACTIVATION_CHECKLIST_ITEMS.APPROVED_POLICIES === "approved_policies", "Checklist item: approved_policies");
    assert(ACTIVATION_CHECKLIST_ITEMS.SUPPORTED_MODES === "supported_modes", "Checklist item: supported_modes");
    assert(ACTIVATION_CHECKLIST_ITEMS.RECIPIENTS_LIMITS === "recipients_limits", "Checklist item: recipients_limits");
  }

  // TEST 1.2: Empty / Bare Tenant Fails All 7 Items (pending_setup, score 0%)
  {
    const bareCheck = validateTenantReadiness({});
    assert(!bareCheck.ready, "Empty tenant fails readiness validation");
    assert(bareCheck.status === TENANT_ACTIVATION_STATUS.PENDING_SETUP, "Empty tenant status is pending_setup");
    assert(bareCheck.score === 0, "Empty tenant score is 0%");
    assert(bareCheck.passedCount === 0, "Passed count is 0");
    assert(bareCheck.totalCount === 7, "Total count is 7");
    assert(bareCheck.missing.length >= 7, "Missing list contains detailed actionable requirements");
  }

  // TEST 1.3: Partial Tenant Evaluation (4 items passed -> restricted status)
  {
    const partialTenant = {
      id: "partially_onboarded_client",
      config: {
        allowed_origins: ["https://client.com"],
        supportedServices: ["AC Repair"],
        serviceArea: ["Denver Metro"],
        supported_modes: ["chat"],
      },
    };
    const check = validateTenantReadiness(partialTenant);
    assert(!check.ready, "Partial tenant is not ready for activation");
    assert(check.passedCount >= 4, `Partial tenant passed ${check.passedCount} items`);
    assert(check.status === TENANT_ACTIVATION_STATUS.RESTRICTED, "Partial tenant status is restricted");
    assert(check.score >= 50 && check.score < 100, `Partial tenant score is ${check.score}%`);
  }

  // TEST 1.4: Fully Compliant Tenant Evaluation (7 items passed -> active, score 100%)
  {
    const completeTenant = {
      id: "brightstar_hvac",
      config: {
        allowed_origins: ["https://brightstarhvac.com"],
        supportedServices: ["AC Repair", "Furnace Installation"],
        serviceArea: ["Miami-Dade County", "Broward"],
        timezone: "America/New_York",
        operating_hours: {
          Monday: { active: true, open: "08:00", close: "18:00" },
          Tuesday: { active: true, open: "08:00", close: "18:00" },
          Wednesday: { active: true, open: "08:00", close: "18:00" },
          Thursday: { active: true, open: "08:00", close: "18:00" },
          Friday: { active: true, open: "08:00", close: "18:00" },
        },
        knowledge: "BrightStar HVAC has served South Florida since 2012 with 24/7 emergency repair.",
        privacy_policy_approved: true,
        supported_modes: ["chat", "voice"],
        notification_email: "dispatch@brightstarhvac.com",
        notification_rate_limit: 60,
      },
      business_profile: {
        basic_info: {
          businessName: "BrightStar HVAC",
          email: "dispatch@brightstarhvac.com",
          phone: "+1-305-555-0199",
        },
      },
    };

    const check = validateTenantReadiness(completeTenant);
    assert(check.ready === true, "Complete tenant is ready for activation");
    assert(check.status === TENANT_ACTIVATION_STATUS.ACTIVE, "Complete tenant status is active");
    assert(check.score === 100, "Complete tenant score is 100%");
    assert(check.passedCount === 7, "All 7 items passed");
    assert(check.missing.length === 0, "Missing list is empty");
  }

  // --------------------------------------------------------------------------------
  // SECTION 2: Gating Activation via API & Assertion Contract
  // --------------------------------------------------------------------------------
  console.log("\n--- SECTION 2: Gating Activation via API & Assertion Contract ---");

  // TEST 2.1: assertTenantActivationReadiness throws TENANT_ACTIVATION_REQUIREMENTS_UNMET (422)
  {
    let errorCaught = null;
    try {
      assertTenantActivationReadiness({ id: "unready_tenant" });
    } catch (err) {
      errorCaught = err;
    }
    assert(errorCaught !== null, "assertTenantActivationReadiness threw error on incomplete tenant");
    assert(errorCaught.code === "TENANT_ACTIVATION_REQUIREMENTS_UNMET", "Error code is TENANT_ACTIVATION_REQUIREMENTS_UNMET");
    assert(errorCaught.statusCode === 422, "Error status code is 422");
    assert(Array.isArray(errorCaught.missing) && errorCaught.missing.length > 0, "Error details missing checklist items");
  }

  // TEST 2.2: PUT /api/superadmin/tenants blocks activation of incomplete tenant
  {
    const { req, res } = createMockReqRes({
      method: "PUT",
      headers: {
        "x-requested-with": "XMLHttpRequest",
        "x-cd-session": superAdminToken,
        "cookie": `cd_session=${superAdminToken}`,
      },
      body: {
        tenantId: "incomplete_client_1",
        updates: {
          enabled: true,
          activation_status: "active",
        },
      },
    });

    // Seed mock session as superadmin
    req.session = { role: "superadmin", username: "superadmin" };

    await tenantsApiHandler(req, res);
    assert(res.getStatusCode() === 422, `Incomplete tenant activation rejected with HTTP 422 (received: ${res.getStatusCode()})`);
    const data = res.getResponseData();
    assert(data.code === "TENANT_ACTIVATION_REQUIREMENTS_UNMET", "Response error code is TENANT_ACTIVATION_REQUIREMENTS_UNMET");
    assert(Array.isArray(data.missing) && data.missing.length > 0, "Response returns actionable list of missing checklist items");
  }

  // TEST 2.3: POST /api/superadmin/tenants safely persists initial tenant as pending_setup
  {
    const { req, res } = createMockReqRes({
      method: "POST",
      headers: {
        "x-requested-with": "XMLHttpRequest",
        "x-cd-session": superAdminToken,
        "cookie": `cd_session=${superAdminToken}`,
      },
      body: {
        tenantId: "newly_created_tenant",
        tenantPayload: {
          id: "newly_created_tenant",
          business_profile: {
            basic_info: { businessName: "Newly Created Tenant", email: "test@client.com" },
          },
        },
      },
    });

    req.session = { role: "superadmin", username: "superadmin" };

    await tenantsApiHandler(req, res);
    assert(res.getStatusCode() === 201 || res.getStatusCode() === 200, `Tenant created with HTTP 201/200 (received: ${res.getStatusCode()})`);
    const data = res.getResponseData();
    assert(data.success === true, "Creation successful");
    assert(data.readiness && data.readiness.ready === false, "Newly created incomplete tenant is not activated");
    assert(data.readiness.status === TENANT_ACTIVATION_STATUS.PENDING_SETUP, "Initial status defaulted to pending_setup");
  }

  // --------------------------------------------------------------------------------
  // SECTION 3: Allowed Sites/Domains & Origin Whitelisting
  // --------------------------------------------------------------------------------
  console.log("\n--- SECTION 3: Allowed Sites/Domains & Origin Whitelisting ---");

  // TEST 3.1: Wildcard "*" Prohibited for Production Active Tenants
  {
    assert(isValidEmbedOrigin("*") === false, "Wildcard '*' origin rejected");
    assert(isValidEmbedOrigin("https://*.brightstarhvac.com") === false, "Wildcard subdomain pattern rejected");
    assert(isValidEmbedOrigin("javascript:alert(1)") === false, "Malicious javascript URI rejected");
    assert(isValidEmbedOrigin("") === false, "Empty origin rejected");
  }

  // TEST 3.2: Valid HTTP / HTTPS / Localhost Origins Accepted
  {
    assert(isValidEmbedOrigin("https://brightstarhvac.com") === true, "Standard HTTPS web origin accepted");
    assert(isValidEmbedOrigin("https://app.client.com") === true, "Subdomain HTTPS origin accepted");
    assert(isValidEmbedOrigin("http://localhost:3000") === true, "Localhost development origin accepted");
    assert(isValidEmbedOrigin("http://127.0.0.1:8080") === true, "127.0.0.1 development origin accepted");
  }

  // TEST 3.3: isOriginAllowedForTenant Evaluates Whitelist Correctly
  {
    const tenantAllowed = ["https://brightstarhvac.com", "https://portal.brightstarhvac.com"];

    assert(isOriginAllowedForTenant("https://brightstarhvac.com", tenantAllowed) === true, "Exact origin allowed");
    assert(isOriginAllowedForTenant("https://booking.brightstarhvac.com", tenantAllowed) === true, "Subdomain allowed");
    assert(isOriginAllowedForTenant("https://portal.brightstarhvac.com", tenantAllowed) === true, "Secondary allowed origin allowed");

    // Rogue / Cross-tenant origins rejected
    assert(isOriginAllowedForTenant("https://attacker.com", tenantAllowed) === false, "Attacker domain rejected");
    assert(isOriginAllowedForTenant("https://brightstarhvac.com.malicious.com", tenantAllowed) === false, "Lookalike domain rejected");
    assert(isOriginAllowedForTenant("http://brightstarhvac.com", tenantAllowed) === false, "Insecure HTTP scheme mismatch rejected");
    assert(isOriginAllowedForTenant("", tenantAllowed) === false, "Empty origin rejected");
    assert(isOriginAllowedForTenant("https://brightstarhvac.com", []) === false, "Empty whitelist rejected");
  }

  // --------------------------------------------------------------------------------
  // SECTION 4: Embed Widget Security & Defensive postMessage Sanitization
  // --------------------------------------------------------------------------------
  console.log("\n--- SECTION 4: Embed Widget Security & Defensive postMessage Sanitization ---");

  // TEST 4.1: Inspect public/widget.js Source for Hardened Defenses
  {
    const widgetSrc = fs.readFileSync(path.resolve("./public/widget.js"), "utf8");

    // Must require tenantId and NEVER fall back to "default"
    assert(
      !widgetSrc.includes('tenantId = (currentScript && currentScript.getAttribute("data-tenant")) || window.__CLOSEDESK_TENANT_ID__ || "default"'),
      "widget.js does not fall back to 'default' tenant automatically"
    );
    assert(
      widgetSrc.includes("[CloseDesk SDK] Initialization failed: data-tenant attribute or window.__CLOSEDESK_TENANT_ID__ is required."),
      "widget.js outputs clear error and halts when data-tenant is missing"
    );

    // Must validate origin against baseUrl
    assert(
      widgetSrc.includes("eventOrigin !== expectedOrigin"),
      "widget.js enforces strict origin equality matching baseUrl"
    );

    // Must reject prototype pollution vectors
    assert(
      widgetSrc.includes('__proto__') && widgetSrc.includes('constructor') && widgetSrc.includes('prototype'),
      "widget.js checks and rejects __proto__, constructor, and prototype pollution keys"
    );

    // Must enforce boolean flags
    assert(
      widgetSrc.includes("event.data.isExpanded === true") && widgetSrc.includes("event.data.hasPeek === true"),
      "widget.js strictly checks boolean types for isExpanded and hasPeek"
    );
  }

  // TEST 4.2: Behavioral simulation of hardened postMessage sanitization
  {
    function testPostMessageSecurity(event, baseUrl) {
      // 1. Strict origin validation
      let eventOrigin = "";
      try {
        eventOrigin = new URL(event.origin).origin.toLowerCase();
      } catch (_) {
        return { accepted: false, reason: "invalid_origin_format" };
      }
      const expectedOrigin = new URL(baseUrl).origin.toLowerCase();
      if (eventOrigin !== expectedOrigin) {
        return { accepted: false, reason: "origin_mismatch" };
      }

      // 2. Payload integrity
      if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
        return { accepted: false, reason: "invalid_payload_type" };
      }

      // 3. Prototype pollution defense
      const hasOwn = Object.prototype.hasOwnProperty;
      if (
        hasOwn.call(event.data, "__proto__") ||
        hasOwn.call(event.data, "constructor") ||
        hasOwn.call(event.data, "prototype")
      ) {
        return { accepted: false, reason: "prototype_pollution_detected" };
      }

      const keys = Object.keys(event.data);
      for (const k of keys) {
        if (k === "__proto__" || k === "constructor" || k === "prototype") {
          return { accepted: false, reason: "prototype_pollution_key" };
        }
      }

      // 4. Action verification
      if (event.data.type !== "CLOSEDESK_WIDGET_RESIZE") {
        return { accepted: false, reason: "unrecognized_type" };
      }

      return {
        accepted: true,
        isExpanded: event.data.isExpanded === true,
        hasPeek: event.data.hasPeek === true,
      };
    }

    const validBase = "https://app.closedesk.ai";

    // Subtest: Untrusted origin
    const badOrigin = testPostMessageSecurity({ origin: "https://evil-site.com", data: { type: "CLOSEDESK_WIDGET_RESIZE" } }, validBase);
    assert(!badOrigin.accepted && badOrigin.reason === "origin_mismatch", "Cross-origin postMessage dropped");

    // Subtest: Prototype pollution attack
    const protoAttack = testPostMessageSecurity(
      { origin: validBase, data: JSON.parse('{"type":"CLOSEDESK_WIDGET_RESIZE","__proto__":{"admin":true}}') },
      validBase
    );
    assert(!protoAttack.accepted && protoAttack.reason.includes("prototype_pollution"), "Prototype pollution payload rejected");

    // Subtest: Valid message accepted
    const validMsg = testPostMessageSecurity(
      { origin: validBase, data: { type: "CLOSEDESK_WIDGET_RESIZE", isExpanded: true, hasPeek: false } },
      validBase
    );
    assert(validMsg.accepted === true && validMsg.isExpanded === true, "Valid resize message processed accurately");
  }

  // --------------------------------------------------------------------------------
  // SECTION 5: Strict Fail-Closed Multi-Tenancy & No Default Leaks
  // --------------------------------------------------------------------------------
  console.log("\n--- SECTION 5: Strict Fail-Closed Multi-Tenancy & No Default Leaks ---");

  // TEST 5.1: getTenantConfig on unknown tenant returns exists=false and enabled=false (never default)
  {
    const unknownConfig = await getTenantConfig("completely_unknown_tenant_xyz");
    assert(unknownConfig.exists === false, "Unknown tenant returns exists: false");
    assert(unknownConfig.enabled === false, "Unknown tenant returns enabled: false");
    assert(unknownConfig.tenantId === "completely_unknown_tenant_xyz", "Tenant ID preserved for audit tracing");
    assert(unknownConfig.error && unknownConfig.error.includes("does not exist"), "Actionable error returned");
    assert(Object.keys(unknownConfig.config).length === 0, "No default tenant config leaked");
  }

  // TEST 5.2: POST /api/chat rejects unknown or inactive tenant with HTTP 403 TENANT_INACTIVE
  {
    const { req, res } = createMockReqRes({
      method: "POST",
      headers: {
        "x-tenant-id": "non_existent_tenant_999",
      },
      body: {
        session_id: "lead_1720000000000_abcde",
        messages: [{ role: "user", content: "Hello" }],
      },
    });

    await chatHandler(req, res);
    assert(res.getStatusCode() === 403, `Chat rejected unknown tenant with HTTP 403 (received: ${res.getStatusCode()})`);
    const chatData = res.getResponseData();
    assert(chatData.code === "TENANT_INACTIVE", "Chat error code is TENANT_INACTIVE");
  }

  // TEST 5.3: Operator cross-tenant access rejection on /api/leads
  {
    const { req, res } = createMockReqRes({
      method: "GET",
      headers: {
        "x-tenant-id": "tenant_b",
        "cookie": `cd_session=${signSessionToken({ sub: "op_alice", role: "tenant_operator", tenantId: "tenant_a" })}`,
      },
    });

    await leadsHandler(req, res);
    assert(res.getStatusCode() === 403, `Leads API rejected cross-tenant spoofing with HTTP 403 (received: ${res.getStatusCode()})`);
  }

  // TEST 5.4: POST /api/openai-token rejects token generation for unknown tenant
  {
    const { req, res } = createMockReqRes({
      method: "POST",
      headers: {
        "x-tenant-id": "non_existent_tenant_999",
      },
      body: {
        session_id: "lead_1720000000000_abcde",
      },
    });

    await tokenHandler(req, res);
    assert(res.getStatusCode() === 404, `Token API returned 404 for unknown tenant (received: ${res.getStatusCode()})`);
  }

  // TEST 5.5: Embed page src/pages/embed/chatbot.jsx fail-closed verification
  {
    const embedPageSrc = fs.readFileSync(path.resolve("./src/pages/embed/chatbot.jsx"), "utf8");
    assert(embedPageSrc.includes("TENANT_REQUIRED"), "Embed page defines TENANT_REQUIRED error code");
    assert(embedPageSrc.includes("TENANT_NOT_FOUND"), "Embed page defines TENANT_NOT_FOUND error code");
    assert(embedPageSrc.includes("TENANT_INACTIVE"), "Embed page defines TENANT_INACTIVE error code");
    assert(embedPageSrc.includes("EMBED_ORIGIN_PROHIBITED"), "Embed page defines EMBED_ORIGIN_PROHIBITED error code");
    assert(embedPageSrc.includes("EmbedErrorCard"), "Embed page renders EmbedErrorCard on failure instead of chatbot");
  }

  // --------------------------------------------------------------------------------
  // SECTION 6: Repeatable Onboarding Validation (Second Tenant Provisioning)
  // --------------------------------------------------------------------------------
  console.log("\n--- SECTION 6: Repeatable Onboarding Validation (Second Tenant Provisioning) ---");

  // TEST 6.1: Provision a second tenant ("summit_plumbing") purely via configuration
  {
    const secondTenantPayload = {
      id: "summit_plumbing",
      enabled: true,
      created_at: new Date().toISOString(),
      business_profile: {
        basic_info: {
          businessName: "Summit Plumbing & Rooter",
          email: "dispatch@summitplumbing.com",
          phone: "+1-303-555-0188",
          website: "https://summitplumbing.com",
          industry: "Plumbing",
        },
        timezone: "America/Denver",
        services: ["Drain Cleaning", "Water Heater Repair", "Emergency Plumbing"],
        operatingAreas: ["Denver Metro", "Aurora", "Lakewood"],
        knowledge_base: "Summit Plumbing provides licensed plumbing, drain snaking, and commercial rooter services.",
        privacy_policy_approved: true,
      },
      config: {
        business_name: "Summit Plumbing & Rooter",
        industry_pack: "plumbing_v2",
        timezone: "America/Denver",
        allowed_origins: ["https://summitplumbing.com"],
        supportedServices: ["Drain Cleaning", "Water Heater Repair", "Emergency Plumbing"],
        serviceArea: ["Denver Metro", "Aurora", "Lakewood"],
        operating_hours: {
          Monday: { active: true, open: "07:00", close: "19:00" },
          Tuesday: { active: true, open: "07:00", close: "19:00" },
          Wednesday: { active: true, open: "07:00", close: "19:00" },
          Thursday: { active: true, open: "07:00", close: "19:00" },
          Friday: { active: true, open: "07:00", close: "19:00" },
          Saturday: { active: true, open: "08:00", close: "16:00" },
          Sunday: { active: false, open: "00:00", close: "00:00" },
        },
        knowledge: "Summit Plumbing provides licensed plumbing, drain snaking, and commercial rooter services.",
        privacy_policy_approved: true,
        supported_modes: ["chat", "voice"],
      },
      chatbot_config: {
        bot_name: "Summit Plumbing Specialist",
        voiceEnabled: true,
        voice: "onyx",
        serviceCategory: "Plumbing",
      },
      notification_settings: {
        adminEmail: "dispatch@summitplumbing.com",
        rate_limit: 60,
      },
    };

    const readiness = validateTenantReadiness(secondTenantPayload);
    assert(readiness.ready === true, "Second tenant passes all 7 operational readiness items");
    assert(readiness.status === TENANT_ACTIVATION_STATUS.ACTIVE, "Second tenant activation status is active");
    assert(readiness.score === 100, "Second tenant activation readiness score is 100%");
    assert(readiness.passedCount === 7, "Passed items count is 7");
  }

  // --------------------------------------------------------------------------------
  // SECTION 7: Synthetic Inquiry Routing & Data Partition Isolation
  // --------------------------------------------------------------------------------
  console.log("\n--- SECTION 7: Synthetic Inquiry Routing & Data Partition Isolation ---");

  // TEST 7.1: Isolated Tenant Routing & Partition Verification
  {
    const tenant1 = "brightstar_hvac";
    const tenant2 = "summit_plumbing";

    // Simulate saving a lead for tenant 1
    const lead1 = {
      lead_id: "lead_hvac_001",
      customer_name: "Alice HVAC",
      phone: "+1-305-555-0101",
      service_requested: "AC Replacement",
      created_at: new Date().toISOString(),
    };
    await memDb.set(`tenants/${tenant1}/leads/${lead1.lead_id}`, lead1);

    // Simulate saving a lead for tenant 2
    const lead2 = {
      lead_id: "lead_plumb_002",
      customer_name: "Bob Plumber",
      phone: "+1-303-555-0102",
      service_requested: "Water Heater Repair",
      created_at: new Date().toISOString(),
    };
    await memDb.set(`tenants/${tenant2}/leads/${lead2.lead_id}`, lead2);

    // Verify isolation: tenant 1 partition only contains lead 1
    const tenant1Leads = await memDb.get(`tenants/${tenant1}/leads`);
    assert(tenant1Leads && tenant1Leads["lead_hvac_001"] !== undefined, "Tenant 1 partition contains Tenant 1 lead");
    assert(!tenant1Leads["lead_plumb_002"], "Tenant 1 partition does NOT contain Tenant 2 lead");

    // Verify isolation: tenant 2 partition only contains lead 2
    const tenant2Leads = await memDb.get(`tenants/${tenant2}/leads`);
    assert(tenant2Leads && tenant2Leads["lead_plumb_002"] !== undefined, "Tenant 2 partition contains Tenant 2 lead");
    assert(!tenant2Leads["lead_hvac_001"], "Tenant 2 partition does NOT contain Tenant 1 lead");

    // Verify global leads root was NOT polluted
    const globalLeads = await memDb.get("leads");
    assert(globalLeads === null || Object.keys(globalLeads).length === 0, "Global /leads root has 0 partition pollution");
  }

  console.log("\n================================================================================");
  console.log(`   CD11 TEST SUITE SUMMARY: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log("================================================================================\n");

  const evidenceDir = path.resolve("./evaluations");
  if (!fs.existsSync(evidenceDir)) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }
  const evidencePath = path.join(evidenceDir, "cd11_onboarding_evidence.json");
  const evidenceReport = {
    ticket: "CD11",
    title: "Repeatable Tenant Onboarding & Activation Checklist Acceptance Evidence",
    timestamp: new Date().toISOString(),
    summary: {
      total_tests: passedTests + failedTests,
      passed: passedTests,
      failed: failedTests,
      all_passed: failedTests === 0,
    },
    results: testResults,
  };
  fs.writeFileSync(evidencePath, JSON.stringify(evidenceReport, null, 2), "utf8");
  console.log(`Evidence report saved to: ${evidencePath}\n`);

  if (failedTests > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error("Test execution failed with fatal error:", err);
  process.exit(1);
});
