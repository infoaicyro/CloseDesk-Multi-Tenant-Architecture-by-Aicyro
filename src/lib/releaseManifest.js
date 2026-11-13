// src/lib/releaseManifest.js
import { COMMON_POLICY_VERSION } from "./policyContract.js";

/**
 * ============================================================================
 * CLOSEDESK RELEASE MANIFEST & INCIDENT ESCALATION CONTRACT (CD15)
 * ============================================================================
 * Identifies Application, Background Worker, Database Rules, Policy/Config,
 * and Environment versions together as an immutable, bundled release unit.
 *
 * Source: Master Architecture Baseline Sections 4.2, 5.4-5.14, 11.1
 * ============================================================================
 */

export const APPLICATION_VERSION = "2.1.0";
export const WORKER_VERSION = "2.1.0-cf-worker";
export const RULES_VERSION = "2026.11.05-cd03-rules";
export const RULES_CHECKSUM_SHA256 = "49f360c2392f6e311618ea170be672711a5e5997d7894e32e8fdf4227d158a4d";
export const POLICY_CONFIG_VERSION = COMMON_POLICY_VERSION || "2.15.0";
export const DEFAULT_ENVIRONMENT_VERSION = typeof process !== "undefined" && process.env?.NODE_ENV === "production"
  ? "pilot-production-2.1.0"
  : "pilot-staging-2.1.0";

export const PRIMARY_INCIDENT_OWNER = {
  name: "Platform SRE & Incident On-Call Lead",
  role: "Primary Incident Commander",
  email: "ops-oncall@closedesk.com",
  phone: "+1-800-555-0199",
  escalation_channel: "pagerduty://service/closedesk-sre-p0",
  escalation_sla_minutes: 15,
};

export const SECONDARY_INCIDENT_OWNER = {
  name: "Principal Security & Operations Officer",
  role: "Secondary Escalation / Security Officer",
  email: "security-ops@closedesk.com",
  phone: "+1-800-555-0198",
  escalation_channel: "pagerduty://service/closedesk-sec-p0",
  escalation_sla_minutes: 30,
};

export const RELEASE_MANAGER = {
  name: "Release Management & DevOps Lead",
  role: "Release Verification Coordinator",
  email: "release-ops@closedesk.com",
};

/**
 * Computes or retrieves deterministic SHA-256 hash of database.rules.json.
 */
export function getRulesChecksum() {
  return RULES_CHECKSUM_SHA256;
}

/**
 * Returns the unified release bundle manifest.
 */
export function getReleaseManifest(overrides = {}) {
  const envVersion = overrides.environment_version ||
    (typeof process !== "undefined" && (process.env?.RELEASE_ENV_VERSION || DEFAULT_ENVIRONMENT_VERSION)) ||
    DEFAULT_ENVIRONMENT_VERSION;

  const gitCommit = overrides.git_commit ||
    (typeof process !== "undefined" && (process.env?.GIT_COMMIT_SHA || process.env?.COMMIT_REF)) ||
    "f2b247b";

  return {
    release_id: `rel_${APPLICATION_VERSION}_${gitCommit.slice(0, 7)}`,
    timestamp: new Date().toISOString(),
    versions: {
      application_version: overrides.application_version || APPLICATION_VERSION,
      worker_version: overrides.worker_version || WORKER_VERSION,
      rules_version: overrides.rules_version || RULES_VERSION,
      rules_checksum_sha256: getRulesChecksum(),
      policy_config_version: overrides.policy_config_version || POLICY_CONFIG_VERSION,
      environment_version: envVersion,
      git_commit: gitCommit,
    },
    incident_management: {
      primary_owner: PRIMARY_INCIDENT_OWNER,
      secondary_owner: SECONDARY_INCIDENT_OWNER,
      release_manager: RELEASE_MANAGER,
      escalation_sla_minutes: 15,
      notification_channels: ["email", "pagerduty", "system_alerts_queue"],
    },
    release_status: "ACTIVE_PILOT_CANDIDATE",
  };
}

/**
 * Validates that all required version identifiers and ownership fields are intact.
 */
export function verifyReleaseManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    return { valid: false, error: "Manifest is missing or not an object." };
  }

  const v = manifest.versions || {};
  const requiredVersions = [
    "application_version",
    "worker_version",
    "rules_version",
    "policy_config_version",
    "environment_version",
  ];

  for (const field of requiredVersions) {
    if (!v[field] || typeof v[field] !== "string" || !v[field].trim()) {
      return { valid: false, error: `Missing or empty required version identifier: '${field}'.` };
    }
  }

  const im = manifest.incident_management || {};
  if (!im.primary_owner || !im.primary_owner.email || !im.primary_owner.name) {
    return { valid: false, error: "Missing required primary incident owner identification." };
  }

  return { valid: true };
}
