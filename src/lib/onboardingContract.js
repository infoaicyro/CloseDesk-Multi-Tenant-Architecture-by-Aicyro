// src/lib/onboardingContract.js
import { isValidIanaTimezone } from "./appointmentContract";
import { isValidRecipientEmail } from "./handoffContract";

/**
 * CloseDesk Tenant Activation & Operational Readiness Contract (CD11)
 *
 * Defines the 7-item operational activation checklist, tenant lifecycle statuses,
 * domain validation algorithms, and readiness verification gates.
 */

export const TENANT_ACTIVATION_STATUS = Object.freeze({
  PENDING_SETUP: "pending_setup",
  RESTRICTED: "restricted",
  ACTIVE: "active",
  SUSPENDED: "suspended",
});

export const ACTIVATION_CHECKLIST_ITEMS = Object.freeze({
  ALLOWED_DOMAINS: "allowed_domains",
  TENANT_MAPPING: "tenant_mapping",
  SERVICES_AREAS: "services_areas",
  TIMEZONE_HOURS: "timezone_hours",
  APPROVED_POLICIES: "approved_policies",
  SUPPORTED_MODES: "supported_modes",
  RECIPIENTS_LIMITS: "recipients_limits",
});

/**
 * Validates domain/origin syntax for embed whitelisting.
 * Prohibits wildcard "*" for active production tenants.
 */
export function isValidEmbedOrigin(origin) {
  if (!origin || typeof origin !== "string") return false;
  const trimmed = origin.trim().toLowerCase();

  // Wildcard is strictly forbidden for active production tenants
  if (trimmed === "*" || trimmed.includes("*")) return false;

  // Localhost allowed for development
  if (/^http:\/\/localhost(:\d+)?$/.test(trimmed) || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(trimmed)) {
    return true;
  }

  // Standard HTTPS/HTTP web origin validation (e.g., https://brightstarhvac.com)
  try {
    const url = new URL(trimmed);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.includes(".");
  } catch (_) {
    // If entered without protocol, test hostname pattern
    return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(trimmed);
  }
}

/**
 * Normalizes an origin or domain string into a standard lowercase protocol+host format.
 */
export function normalizeEmbedOrigin(origin) {
  if (!origin || typeof origin !== "string") return "";
  let clean = origin.trim().toLowerCase();
  if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
    clean = `https://${clean}`;
  }
  try {
    const parsed = new URL(clean);
    return `${parsed.protocol}//${parsed.host}`;
  } catch (_) {
    return clean;
  }
}

/**
 * Evaluates whether an incoming request origin matches the tenant's allowed embed origins.
 */
export function isOriginAllowedForTenant(incomingOrigin, allowedOrigins = []) {
  if (!incomingOrigin || typeof incomingOrigin !== "string") return false;
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) return false;

  const normalizedIncoming = normalizeEmbedOrigin(incomingOrigin);
  let incomingParsed = null;
  try {
    incomingParsed = new URL(normalizedIncoming);
  } catch (_) {
    return false;
  }

  const incomingHost = incomingParsed.hostname;
  const incomingProtocol = incomingParsed.protocol;

  for (const allowed of allowedOrigins) {
    if (!allowed || typeof allowed !== "string") continue;
    const cleanAllowed = allowed.trim().toLowerCase();

    // Development wildcard (only if explicitly allowed in dev environment)
    if (cleanAllowed === "*") return true;

    const normalizedAllowed = normalizeEmbedOrigin(cleanAllowed);
    if (normalizedIncoming === normalizedAllowed) return true;

    try {
      const allowedParsed = new URL(normalizedAllowed);
      // Protocol match required: insecure http cannot impersonate https
      if (incomingProtocol !== allowedParsed.protocol) {
        continue;
      }
      const allowedHost = allowedParsed.hostname;
      if (incomingHost === allowedHost || incomingHost.endsWith(`.${allowedHost}`)) {
        return true;
      }
    } catch (_) {}
  }

  return false;
}

/**
 * Validates the 7-item Operational Activation Checklist for a tenant.
 *
 * @param {object} tenantData Full tenant record or merged partition payload
 * @returns {object} { ready: boolean, status: string, score: number, items: object, missing: string[] }
 */
export function validateTenantReadiness(tenantData = {}) {
  const missing = [];
  const checklist = {};

  const tenantId = tenantData.id || tenantData.tenantId;
  const config = tenantData.config || {};
  const bizProfile = tenantData.business_profile || {};
  const notifSettings = tenantData.notification_settings || {};
  const chatbotConfig = tenantData.chatbot_config || {};

  // 1. Allowed Sites / Domains
  const origins = config.allowed_origins || bizProfile.allowed_origins || [];
  const validOrigins = Array.isArray(origins)
    ? origins.filter(isValidEmbedOrigin)
    : (typeof origins === "string" && isValidEmbedOrigin(origins) ? [origins] : []);

  const hasAllowedDomains = validOrigins.length > 0;
  checklist[ACTIVATION_CHECKLIST_ITEMS.ALLOWED_DOMAINS] = {
    passed: hasAllowedDomains,
    details: hasAllowedDomains ? validOrigins : "No valid production embed origin configured (wildcards rejected)",
  };
  if (!hasAllowedDomains) {
    missing.push("Allowed Sites/Domains: At least one explicit production domain (e.g., https://client.com) is required (wildcard '*' prohibited)");
  }

  // 2. Tenant Mapping
  const cleanId = tenantId ? String(tenantId).trim().toLowerCase() : "";
  const isValidSlug = /^[a-z0-9][a-z0-9_-]{2,48}[a-z0-9]$/.test(cleanId) && cleanId !== "default" && cleanId !== "primary_client";
  checklist[ACTIVATION_CHECKLIST_ITEMS.TENANT_MAPPING] = {
    passed: isValidSlug,
    details: isValidSlug ? cleanId : "Invalid tenant identifier format (must be 4-50 lowercase alphanumeric, underscores, or hyphens)",
  };
  if (!isValidSlug) {
    missing.push("Tenant Mapping: Unique clean tenant identifier slug (4-50 characters) is required");
  }

  // 3. Services & Operating Areas
  const supportedServices = config.supportedServices || bizProfile.supportedServices || bizProfile.services || [];
  const serviceArea = config.serviceArea || bizProfile.serviceArea || bizProfile.operatingAreas || [];
  const hasServices = Array.isArray(supportedServices) && supportedServices.length > 0 && supportedServices.some((s) => String(s).trim().length > 0);
  const hasAreas = Array.isArray(serviceArea) && serviceArea.length > 0 && serviceArea.some((a) => String(a).trim().length > 0);
  const hasServicesAndAreas = Boolean(hasServices && hasAreas);

  checklist[ACTIVATION_CHECKLIST_ITEMS.SERVICES_AREAS] = {
    passed: hasServicesAndAreas,
    details: {
      servicesCount: Array.isArray(supportedServices) ? supportedServices.length : 0,
      areasCount: Array.isArray(serviceArea) ? serviceArea.length : 0,
    },
  };
  if (!hasServicesAndAreas) {
    if (!hasServices) missing.push("Services: At least one supported service must be explicitly listed");
    if (!hasAreas) missing.push("Operating Areas: At least one geographic operating area, city, or zip code must be configured");
  }

  // 4. Timezone & Business Hours
  const tz = config.timezone || bizProfile.timezone;
  const schedule = config.operating_hours || bizProfile.schedule;
  const hasValidTz = isValidIanaTimezone(tz);
  const hasValidSchedule = Boolean(schedule && typeof schedule === "object" && Object.keys(schedule).length >= 5);
  const hasTimezoneAndHours = Boolean(hasValidTz && hasValidSchedule);

  checklist[ACTIVATION_CHECKLIST_ITEMS.TIMEZONE_HOURS] = {
    passed: hasTimezoneAndHours,
    details: { timezone: tz || "Unset", hasSchedule: hasValidSchedule },
  };
  if (!hasTimezoneAndHours) {
    if (!hasValidTz) missing.push("Timezone: Valid IANA timezone identifier is required");
    if (!hasValidSchedule) missing.push("Business Hours: Standard weekly operating schedule must be configured");
  }

  // 5. Approved Knowledge & Policies
  const knowledge = config.knowledge || bizProfile.knowledge || bizProfile.knowledge_base;
  const privacyApproved = config.privacy_policy_approved === true || bizProfile.privacy_policy_approved === true;
  const hasKnowledge = Boolean(
    (typeof knowledge === "string" && knowledge.trim().length >= 10) ||
    (Array.isArray(knowledge) && knowledge.length > 0) ||
    (typeof knowledge === "object" && knowledge !== null && Object.keys(knowledge).length > 0)
  );
  const hasPoliciesApproved = Boolean(hasKnowledge && privacyApproved);

  checklist[ACTIVATION_CHECKLIST_ITEMS.APPROVED_POLICIES] = {
    passed: hasPoliciesApproved,
    details: { hasKnowledge, privacyApproved },
  };
  if (!hasPoliciesApproved) {
    if (!hasKnowledge) missing.push("Knowledge: Tenant business FAQs or knowledge base entries are required");
    if (!privacyApproved) missing.push("Policies: Compliance & Privacy policy agreement must be approved");
  }

  // 6. Supported Modes
  const supportedModes = config.supported_modes || chatbotConfig.supported_modes || bizProfile.supported_modes;
  const hasValidModes = Array.isArray(supportedModes) && supportedModes.length > 0 && supportedModes.every((m) => ["chat", "voice", "vision"].includes(m.toLowerCase()));

  checklist[ACTIVATION_CHECKLIST_ITEMS.SUPPORTED_MODES] = {
    passed: hasValidModes,
    details: supportedModes || [],
  };
  if (!hasValidModes) {
    missing.push("Supported Modes: At least one permitted operational mode (chat, voice, vision) must be enabled");
  }

  // 7. Recipients & Notification Limits
  const recipient = notifSettings.adminEmail || notifSettings.recipient || config.notification_email || bizProfile.basic_info?.email;
  const hasValidRecipient = isValidRecipientEmail(recipient);
  const rateLimit = Number(notifSettings.rate_limit || config.notification_rate_limit) || 60;
  const hasValidRateLimit = rateLimit >= 1 && rateLimit <= 1000;
  const hasRecipientsAndLimits = Boolean(hasValidRecipient && hasValidRateLimit);

  checklist[ACTIVATION_CHECKLIST_ITEMS.RECIPIENTS_LIMITS] = {
    passed: hasRecipientsAndLimits,
    details: { recipient: hasValidRecipient ? recipient : "Invalid/Missing", rateLimit },
  };
  if (!hasRecipientsAndLimits) {
    if (!hasValidRecipient) missing.push("Recipients: Valid RFC 5322 notification recipient email address is required");
    if (!hasValidRateLimit) missing.push("Rate Limits: Bounded alert notification rate limit (1-1000/hr) is required");
  }

  // Score calculation (0 - 100)
  const totalItems = Object.keys(ACTIVATION_CHECKLIST_ITEMS).length;
  const passedItems = Object.values(checklist).filter((item) => item.passed).length;
  const score = Math.round((passedItems / totalItems) * 100);

  const ready = missing.length === 0;
  const status = ready
    ? TENANT_ACTIVATION_STATUS.ACTIVE
    : passedItems >= 4
    ? TENANT_ACTIVATION_STATUS.RESTRICTED
    : TENANT_ACTIVATION_STATUS.PENDING_SETUP;

  return {
    ready,
    status,
    score,
    passedCount: passedItems,
    totalCount: totalItems,
    checklist,
    missing,
  };
}

/**
 * Asserts readiness or throws an actionable error detailing missing operational checklist items.
 */
export function assertTenantActivationReadiness(tenantData = {}) {
  const check = validateTenantReadiness(tenantData);
  if (!check.ready) {
    const error = new Error(`Tenant '${tenantData.id || "unknown"}' cannot be activated: Operational checklist requirements incomplete (${check.passedCount}/${check.totalCount} passed):\n- ${check.missing.join("\n- ")}`);
    error.code = "TENANT_ACTIVATION_REQUIREMENTS_UNMET";
    error.statusCode = 422;
    error.missing = check.missing;
    error.checklist = check.checklist;
    throw error;
  }
  return check;
}
