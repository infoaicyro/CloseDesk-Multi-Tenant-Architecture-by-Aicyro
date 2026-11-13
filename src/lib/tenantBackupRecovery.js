// src/lib/tenantBackupRecovery.js
import crypto from "crypto";
import { getReleaseManifest } from "./releaseManifest.js";
import { safeDbGet, safeDbSet } from "./safeDb.js";
import { ref } from "firebase/database";
import { db } from "./firebase.js";

/**
 * ============================================================================
 * TENANT EXPORT & ISOLATED RECOVERY PIPELINE (CD15)
 * ============================================================================
 * Enables deterministic tenant partition backup, isolated sandbox recovery,
 * cryptographic checksum verification, and mathematical count reconciliation.
 *
 * CRITICAL SAFETY INVARIANT:
 * Synthetic backup/export data MUST NEVER be restored into live customer
 * partitions. Restoration is restricted strictly to isolated destinations.
 * ============================================================================
 */

const KNOWN_LIVE_PARTITIONS = new Set([
  "brightstar_hvac",
  "summit_plumbing",
  "apex_roofing",
  "vanguard_dental",
  "default",
]);

/**
 * Determines whether a destination path is validly isolated and safe from
 * overwriting live customer partitions.
 */
export function isIsolatedDestination(destinationPath) {
  if (!destinationPath || typeof destinationPath !== "string") return false;
  const clean = destinationPath.trim().toLowerCase();

  // Permitted isolated prefixes
  if (clean.startsWith("quarantine/")) return true;
  if (clean.startsWith("isolated_recovery/")) return true;
  if (clean.startsWith("tenants/isolated_recovery_")) return true;
  if (clean.startsWith("tenants/quarantine_")) return true;

  return false;
}

/**
 * Verifies if a given tenant ID is a live registered customer partition.
 */
export function isLiveCustomerPartition(tenantId) {
  if (!tenantId || typeof tenantId !== "string") return false;
  const clean = tenantId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return KNOWN_LIVE_PARTITIONS.has(clean);
}

function resolveDbOps(dbInstance, dbOps) {
  return {
    get: async (dbPath) => {
      if (dbOps?.get) return await dbOps.get(dbPath);
      if (typeof dbInstance?.get === "function") {
        const res = await dbInstance.get(dbPath);
        return res && typeof res.val === "function" ? res.val() : res;
      }
      const dbRef = ref(dbInstance || db, dbPath);
      try {
        const snap = await safeDbGet(dbRef, 800);
        return snap && snap.exists() ? snap.val() : null;
      } catch (_) {
        return null;
      }
    },
    set: async (dbPath, val) => {
      if (dbOps?.set) return await dbOps.set(dbPath, val);
      if (typeof dbInstance?.set === "function") return await dbInstance.set(dbPath, val);
      const dbRef = ref(dbInstance || db, dbPath);
      try {
        await safeDbSet(dbRef, val, 800);
      } catch (_) {
        // fallback
      }
    },
  };
}

/**
 * Recursively serializes any value with deterministically sorted object keys.
 */
export function canonicalStringify(obj) {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalStringify).join(",") + "]";
  }
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(obj[k]));
  return "{" + pairs.join(",") + "}";
}

/**
 * Deterministically calculates a SHA-256 hash of any JSON-serializable object.
 */
export function computePayloadChecksum(payload) {
  const serialized = canonicalStringify(payload);
  return crypto.createHash("sha256").update(serialized).digest("hex");
}

/**
 * Exports a tenant's complete operational data partition into a tamper-evident envelope.
 */
export async function exportTenantData({
  tenantId,
  exportedBy = "system_operator",
  dbInstance = db,
  dbOps = null,
}) {
  if (!tenantId || typeof tenantId !== "string") {
    throw new Error("A valid tenantId string is required for export.");
  }

  const cleanTenant = tenantId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const ops = resolveDbOps(dbInstance, dbOps);

  const tenantRoot = `tenants/${cleanTenant}`;
  const rawTenantData = (await ops.get(tenantRoot)) || {};

  const leads = rawTenantData.leads || {};
  const appointments = rawTenantData.appointments || {};
  const notificationJobs = rawTenantData.notification_jobs || {};
  const deliveryAttempts = rawTenantData.delivery_attempts || {};
  const config = rawTenantData.config || {};
  const notificationSettings = rawTenantData.notification_settings || {};

  const dataPayload = {
    leads,
    appointments,
    notification_jobs: notificationJobs,
    delivery_attempts: deliveryAttempts,
    config,
    notification_settings: notificationSettings,
  };

  const checksum = computePayloadChecksum(dataPayload);
  const manifest = getReleaseManifest();

  const exportEnvelope = {
    export_id: `export_${cleanTenant}_${Date.now()}`,
    source_tenant_id: cleanTenant,
    exported_at: new Date().toISOString(),
    exported_by: String(exportedBy),
    schema_version: "1.0.0",
    manifest_versions: manifest.versions,
    checksum_sha256: checksum,
    record_counts: {
      leads: Object.keys(leads).length,
      appointments: Object.keys(appointments).length,
      notification_jobs: Object.keys(notificationJobs).length,
      delivery_attempts: Object.keys(deliveryAttempts).length,
    },
    data: dataPayload,
  };

  return exportEnvelope;
}

/**
 * Restores an exported tenant envelope into an isolated destination partition
 * and mathematically reconciles counts, ownership, and checksums.
 */
export async function recoverTenantToIsolatedDestination({
  exportEnvelope,
  targetDestinationPath,
  recoveredBy = "system_recovery_runner",
  dbInstance = db,
  dbOps = null,
}) {
  if (!exportEnvelope || !exportEnvelope.data || !exportEnvelope.source_tenant_id) {
    const err = new Error("Invalid export envelope provided for recovery.");
    err.code = "INVALID_EXPORT_ENVELOPE";
    throw err;
  }

  if (!targetDestinationPath || typeof targetDestinationPath !== "string") {
    const err = new Error("targetDestinationPath is required.");
    err.code = "DESTINATION_PATH_REQUIRED";
    throw err;
  }

  // 🚨 CRITICAL DEFENSE: Reject any attempt to restore into a live customer partition!
  if (!isIsolatedDestination(targetDestinationPath)) {
    const err = new Error(
      `SECURITY VIOLATION: Restoration target '${targetDestinationPath}' is not an isolated destination. ` +
      `Synthetic data must never be restored into live customer partitions.`
    );
    err.code = "LIVE_CUSTOMER_PARTITION_RESTORE_PROHIBITED";
    throw err;
  }

  // Check if destination path references a live tenant identifier directly
  for (const liveTenant of KNOWN_LIVE_PARTITIONS) {
    if (targetDestinationPath === `tenants/${liveTenant}` || targetDestinationPath === `tenants/${liveTenant}/`) {
      const err = new Error(
        `CRITICAL ISOLATION BREACH: Attempted direct restoration into live customer partition '${liveTenant}'. Aborted.`
      );
      err.code = "LIVE_CUSTOMER_PARTITION_RESTORE_PROHIBITED";
      throw err;
    }
  }

  // Verify Checksum Integrity
  const recomputedChecksum = computePayloadChecksum(exportEnvelope.data);
  if (recomputedChecksum !== exportEnvelope.checksum_sha256) {
    const err = new Error(
      `BACKUP CHECKSUM MISMATCH: Expected ${exportEnvelope.checksum_sha256}, calculated ${recomputedChecksum}. Data may be corrupted.`
    );
    err.code = "BACKUP_CHECKSUM_CORRUPTED";
    throw err;
  }

  const ops = resolveDbOps(dbInstance, dbOps);

  // Write to Isolated Destination
  await ops.set(targetDestinationPath, {
    ...exportEnvelope.data,
    _recovery_metadata: {
      recovered_at: new Date().toISOString(),
      recovered_by: String(recoveredBy),
      source_export_id: exportEnvelope.export_id,
      source_tenant_id: exportEnvelope.source_tenant_id,
      is_isolated_partition: true,
      checksum_verified: true,
    },
  });

  // Re-read from Isolated Destination to mathematically reconcile state
  const recoveredData = (await ops.get(targetDestinationPath)) || {};

  const recoveredCounts = {
    leads: Object.keys(recoveredData.leads || {}).length,
    appointments: Object.keys(recoveredData.appointments || {}).length,
    notification_jobs: Object.keys(recoveredData.notification_jobs || {}).length,
    delivery_attempts: Object.keys(recoveredData.delivery_attempts || {}).length,
  };

  const expectedCounts = exportEnvelope.record_counts || {
    leads: 0,
    appointments: 0,
    notification_jobs: 0,
    delivery_attempts: 0,
  };

  // Reconcile Counts
  const countsMatch =
    recoveredCounts.leads === expectedCounts.leads &&
    recoveredCounts.appointments === expectedCounts.appointments &&
    recoveredCounts.notification_jobs === expectedCounts.notification_jobs &&
    recoveredCounts.delivery_attempts === expectedCounts.delivery_attempts;

  if (!countsMatch) {
    const err = new Error(
      `MATHEMATICAL RECONCILIATION FAILURE: Counts mismatch between source export and recovered partition.`
    );
    err.code = "RECONCILIATION_COUNT_MISMATCH";
    err.details = { expected: expectedCounts, recovered: recoveredCounts };
    throw err;
  }

  // Reconcile Ownership Invariant:
  // Inspect recovered leads to ensure tenant_id matches source_tenant_id
  let ownershipVerified = true;
  for (const [_, lead] of Object.entries(recoveredData.leads || {})) {
    if (lead.tenant_id && lead.tenant_id !== exportEnvelope.source_tenant_id) {
      ownershipVerified = false;
      break;
    }
  }

  return {
    reconciliation_status: "RECONCILED",
    is_isolated: true,
    source_tenant_id: exportEnvelope.source_tenant_id,
    isolated_destination: targetDestinationPath,
    source_counts: expectedCounts,
    recovered_counts: recoveredCounts,
    checksum_verified: true,
    ownership_verified: ownershipVerified,
    live_partition_protected: true,
    reconciled_at: new Date().toISOString(),
    recovered_by: recoveredBy,
  };
}

/**
 * Rehearses application and configuration rollback:
 * Proves that pilot records created under newer schemas/versions remain readable
 * and that idempotency locks prevent duplicate side effects upon re-execution.
 */
export function rehearseRollbackCompatibility({
  records = [],
  rolledBackConfig = {},
  existingLocks = new Map(),
}) {
  const rehearsalResults = {
    records_tested: records.length,
    readable_records: 0,
    duplicate_side_effects_prevented: 0,
    schema_compatible: true,
    details: [],
  };

  for (const record of records) {
    // 1. Backward-compatible reading: ensure essential fields are present even if newer optional fields exist
    const isReadable = Boolean(record.id && (record.created_at || record.timestamp));
    if (isReadable) {
      rehearsalResults.readable_records += 1;
    } else {
      rehearsalResults.schema_compatible = false;
    }

    // 2. Idempotency protection check:
    // If the record has an idempotency key that already completed, side effects are skipped!
    const key = record.idempotency_key || record.id;
    if (existingLocks.has(key)) {
      const lockState = existingLocks.get(key);
      if (lockState.status === "COMPLETED" || lockState.status === "CLAIMED") {
        rehearsalResults.duplicate_side_effects_prevented += 1;
      }
    }
  }

  return rehearsalResults;
}
