// src/lib/idempotencyLocker.js
import crypto from "crypto";
import { ref, get, set, update } from "firebase/database";
import { db } from "./firebase";
import { sanitizeFirebaseKey } from "./sanitizer";
import { safeDbGet, safeDbSet, safeDbUpdate } from "./safeDb";

export const LOCK_STATUS = Object.freeze({
  PENDING: "pending",
  COMPLETED: "completed",
  FAILED: "failed",
  UNKNOWN: "unknown",
});

const DEFAULT_LOCK_TTL_MS = 60 * 1000; // 60 seconds

/**
 * Deterministically serializes and hashes an arbitrary payload using SHA-256.
 */
export function hashPayload(payload) {
  if (payload === undefined || payload === null) return crypto.createHash("sha256").update("").digest("hex");
  
  const sortKeys = (obj) => {
    if (obj === null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(sortKeys);
    return Object.keys(obj)
      .sort()
      .reduce((acc, key) => {
        // Exclude ephemeral / non-semantic fields from payload hash calculation
        if (["last_interaction_at", "updated_at", "timestamp", "trace_id", "correlation_id"].includes(key)) {
          return acc;
        }
        acc[key] = sortKeys(obj[key]);
        return acc;
      }, {});
  };

  const canonicalJson = JSON.stringify(sortKeys(payload));
  return crypto.createHash("sha256").update(canonicalJson).digest("hex");
}

/**
 * Resolves the tenant-isolated Realtime Database path for an idempotency lock.
 */
export function getIdempotencyLockPath(tenantId, operationKey) {
  const cleanTenant = tenantId ? String(tenantId).toLowerCase().trim().replace(/[^a-z0-9_-]/g, "") : "default";
  const cleanOpKey = sanitizeFirebaseKey(operationKey, "op");
  return cleanTenant && cleanTenant !== "default"
    ? `tenants/${cleanTenant}/idempotency_locks/${cleanOpKey}`
    : `idempotency_locks/${cleanOpKey}`;
}

function resolveDbOps(dbInstance, dbOps) {
  return {
    get: async (lockPath) => {
      if (dbOps?.get) return await dbOps.get(lockPath);
      if (typeof dbInstance?.get === "function") {
        const res = await dbInstance.get(lockPath);
        return res && typeof res.val === "function" ? res.val() : res;
      }
      const lockRef = ref(dbInstance || db, lockPath);
      try {
        const snap = await safeDbGet(lockRef, 800);
        return snap && snap.exists() ? snap.val() : null;
      } catch (_) {
        return null;
      }
    },
    set: async (lockPath, val) => {
      if (dbOps?.set) return await dbOps.set(lockPath, val);
      if (typeof dbInstance?.set === "function") return await dbInstance.set(lockPath, val);
      const lockRef = ref(dbInstance || db, lockPath);
      try {
        await safeDbSet(lockRef, val, 800);
      } catch (_) {
        // offline fallback
      }
    },
    update: async (lockPath, patch) => {
      if (dbOps?.update) return await dbOps.update(lockPath, patch);
      if (typeof dbInstance?.update === "function") return await dbInstance.update(lockPath, patch);
      const lockRef = ref(dbInstance || db, lockPath);
      try {
        await safeDbUpdate(lockRef, patch, 800);
      } catch (_) {
        // offline fallback
      }
    },
  };
}

/**
 * Atomically acquires or recovers an idempotency state lock.
 */
export async function acquireIdempotencyLock({
  tenantId = "default",
  conversationId = "unknown",
  operationKey,
  payload = {},
  ttlMs = DEFAULT_LOCK_TTL_MS,
  dbInstance = db,
  dbOps = null,
}) {
  if (!operationKey || typeof operationKey !== "string" || !operationKey.trim()) {
    throw new Error("A valid operationKey is required for idempotency state locking.");
  }

  const cleanTenant = tenantId ? String(tenantId).toLowerCase().trim() : "default";
  const cleanOpKey = sanitizeFirebaseKey(operationKey.trim(), "op");
  const lockPath = getIdempotencyLockPath(cleanTenant, cleanOpKey);
  const ops = resolveDbOps(dbInstance, dbOps);

  const payloadHash = hashPayload(payload);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // Read current lock state
  const existingLock = await ops.get(lockPath);

  if (!existingLock) {
    // 1. Fresh Lock: Set pending state
    const newLock = {
      operation_key: cleanOpKey,
      tenant_id: cleanTenant,
      conversation_id: String(conversationId),
      payload_hash: payloadHash,
      status: LOCK_STATUS.PENDING,
      created_at: nowIso,
      locked_at: now,
      expires_at: now + ttlMs,
      recovery_count: 0,
    };

    await ops.set(lockPath, newLock);
    return {
      status: "acquired",
      isNew: true,
      operationKey: cleanOpKey,
      payloadHash,
      lockPath,
    };
  }

  // 2. Tenant Isolation Verification
  if (existingLock.tenant_id && existingLock.tenant_id !== cleanTenant) {
    const error = new Error(`Cross-tenant operation key conflict: Lock owned by '${existingLock.tenant_id}' cannot be accessed by '${cleanTenant}'.`);
    error.code = "CROSS_TENANT_IDEMPOTENCY_CONFLICT";
    error.status = 403;
    throw error;
  }

  // 3. Payload Integrity Check (Detect Changed Payload with Same Key)
  if (existingLock.payload_hash && existingLock.payload_hash !== payloadHash) {
    return {
      status: "payload_mismatch",
      error: "Idempotency key conflict: Operation key was previously submitted with a different payload.",
      statusCode: 409,
      operationKey: cleanOpKey,
      existingHash: existingLock.payload_hash,
      incomingHash: payloadHash,
    };
  }

  // 4. Completed Operation: Return Cached Result
  if (existingLock.status === LOCK_STATUS.COMPLETED) {
    return {
      status: "cached",
      operationKey: cleanOpKey,
      cachedResponse: existingLock.response_data,
      completedAt: existingLock.completed_at,
    };
  }

  // 5. In-Flight Pending Operation: Check for Expiry
  if (existingLock.status === LOCK_STATUS.PENDING) {
    if (now < existingLock.expires_at) {
      // Unexpired lock: Return concurrent in-progress state
      return {
        status: "in_progress",
        message: "Operation is currently being processed by another worker or request.",
        statusCode: 409,
        operationKey: cleanOpKey,
        lockedAt: existingLock.locked_at,
        expiresAt: existingLock.expires_at,
      };
    } else {
      // Expired lock: Safely recover without overwriting newer state
      const updatedLock = {
        ...existingLock,
        status: LOCK_STATUS.PENDING,
        locked_at: now,
        expires_at: now + ttlMs,
        recovery_count: (existingLock.recovery_count || 0) + 1,
        last_recovered_at: nowIso,
      };
      await ops.set(lockPath, updatedLock);
      return {
        status: "acquired",
        recovered: true,
        operationKey: cleanOpKey,
        payloadHash,
        lockPath,
      };
    }
  }

  // 6. Unknown External State: Reconciliation Required
  if (existingLock.status === LOCK_STATUS.UNKNOWN) {
    return {
      status: "unknown_external",
      message: "Prior operation entered an ambiguous external state. Manual or automatic reconciliation required before retry.",
      statusCode: 409,
      reconciliationDetails: existingLock.reconciliation_details || null,
      operationKey: cleanOpKey,
    };
  }

  // 7. Failed Prior Operation: Allow controlled retry
  if (existingLock.status === LOCK_STATUS.FAILED) {
    // Overwrite lock to pending for retry
    await ops.update(lockPath, {
      status: LOCK_STATUS.PENDING,
      locked_at: now,
      expires_at: now + ttlMs,
      retry_count: (existingLock.retry_count || 0) + 1,
      last_retry_at: nowIso,
    });
    return {
      status: "acquired",
      retriedAfterFailure: true,
      operationKey: cleanOpKey,
      payloadHash,
      lockPath,
    };
  }

  return {
    status: "acquired",
    operationKey: cleanOpKey,
    payloadHash,
    lockPath,
  };
}

/**
 * Transitions an idempotency lock to COMPLETED with stored response data.
 */
export async function completeIdempotencyLock({
  tenantId = "default",
  operationKey,
  responseData = {},
  dbInstance = db,
  dbOps = null,
}) {
  const cleanTenant = tenantId ? String(tenantId).toLowerCase().trim() : "default";
  const cleanOpKey = sanitizeFirebaseKey(operationKey, "op");
  const lockPath = getIdempotencyLockPath(cleanTenant, cleanOpKey);
  const ops = resolveDbOps(dbInstance, dbOps);

  await ops.update(lockPath, {
    status: LOCK_STATUS.COMPLETED,
    response_data: responseData,
    completed_at: new Date().toISOString(),
  });
}

/**
 * Transitions an idempotency lock to FAILED with error context.
 */
export async function failIdempotencyLock({
  tenantId = "default",
  operationKey,
  error = {},
  dbInstance = db,
  dbOps = null,
}) {
  const cleanTenant = tenantId ? String(tenantId).toLowerCase().trim() : "default";
  const cleanOpKey = sanitizeFirebaseKey(operationKey, "op");
  const lockPath = getIdempotencyLockPath(cleanTenant, cleanOpKey);
  const ops = resolveDbOps(dbInstance, dbOps);

  await ops.update(lockPath, {
    status: LOCK_STATUS.FAILED,
    error_details: {
      message: error.message || String(error),
      code: error.code || "OPERATION_FAILED",
      failed_at: new Date().toISOString(),
    },
  });
}

/**
 * Transitions an idempotency lock to UNKNOWN (e.g. on external call timeout or ambiguous response).
 */
export async function markIdempotencyLockUnknown({
  tenantId = "default",
  operationKey,
  reason = "External service response timed out",
  externalReference = null,
  dbInstance = db,
  dbOps = null,
}) {
  const cleanTenant = tenantId ? String(tenantId).toLowerCase().trim() : "default";
  const cleanOpKey = sanitizeFirebaseKey(operationKey, "op");
  const lockPath = getIdempotencyLockPath(cleanTenant, cleanOpKey);
  const ops = resolveDbOps(dbInstance, dbOps);

  await ops.update(lockPath, {
    status: LOCK_STATUS.UNKNOWN,
    reconciliation_details: {
      reason,
      external_reference: externalReference,
      marked_unknown_at: new Date().toISOString(),
    },
  });
}
