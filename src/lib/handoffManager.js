// src/lib/handoffManager.js
import { ref, get, set, update, push } from "firebase/database";
import { db } from "./firebase";
import { safeDbGet, safeDbSet, safeDbUpdate } from "./safeDb";
import {
  DELIVERY_STATUS,
  ACKNOWLEDGEMENT_STATUS,
  FOLLOW_UP_STATUS,
  isValidDeliveryTransition,
  isValidRecipientEmail,
  createNotificationJob,
  createDeliveryAttemptRecord,
} from "./handoffContract";
import { sanitizeFirebaseKey } from "./sanitizer";
import { processSmartAlert, MAX_DELIVERY_RETRIES } from "./alertManager";

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
        // offline fallback
      }
    },
    update: async (dbPath, patch) => {
      if (dbOps?.update) return await dbOps.update(dbPath, patch);
      if (typeof dbInstance?.update === "function") return await dbInstance.update(dbPath, patch);
      const dbRef = ref(dbInstance || db, dbPath);
      try {
        await safeDbUpdate(dbRef, patch, 800);
      } catch (_) {
        // offline fallback
      }
    },
  };
}

/**
 * Resolves the tenant-approved recipient configuration with strict validation.
 */
export async function resolveTenantRecipient({ tenantId = "default", dbInstance = db, dbOps = null }) {
  const cleanTenant = String(tenantId).toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
  const ops = resolveDbOps(dbInstance, dbOps);

  const settingsPath = cleanTenant && cleanTenant !== "default"
    ? `tenants/${cleanTenant}/notification_settings`
    : `settings/notification_settings`;

  const settings = await ops.get(settingsPath);

  if (!settings) {
    return {
      valid: false,
      reason: `Tenant '${cleanTenant}' has no notification settings configured.`,
      recipient: null,
      source: "missing_settings",
    };
  }

  if (settings.emailAlerts === false) {
    return {
      valid: false,
      disabled: true,
      reason: `Email notifications are explicitly disabled for tenant '${cleanTenant}'.`,
      recipient: null,
      source: "notifications_disabled",
    };
  }

  const rawRecipient = settings.adminEmail || settings.leadReceivers || settings.primaryRecipient;
  if (!rawRecipient || typeof rawRecipient !== "string" || !rawRecipient.trim()) {
    return {
      valid: false,
      reason: `No destination email recipient configured for tenant '${cleanTenant}'.`,
      recipient: null,
      source: "empty_recipient",
    };
  }

  const cleanRecipient = rawRecipient.trim().toLowerCase();
  if (!isValidRecipientEmail(cleanRecipient)) {
    return {
      valid: false,
      reason: `Configured recipient '${cleanRecipient}' for tenant '${cleanTenant}' is malformed (RFC 5322 invalid).`,
      recipient: cleanRecipient,
      source: "malformed_recipient",
    };
  }

  return {
    valid: true,
    recipient: cleanRecipient,
    source: "tenant_notification_settings",
    urgentOnly: Boolean(settings.urgentOnly),
  };
}

/**
 * Creates and enqueues a durable notification job with deduplication protection.
 */
export async function enqueueNotificationJob({
  tenantId = "default",
  leadId,
  title,
  message,
  leadData = {},
  eventType = "end",
  visitorEmailConfig = null,
  dbInstance = db,
  dbOps = null,
}) {
  const cleanTenant = String(tenantId).toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
  const cleanLeadId = sanitizeFirebaseKey(String(leadId || "unknown"), "lead");
  const stableJobId = `job_${cleanLeadId}_${eventType}`;
  const ops = resolveDbOps(dbInstance, dbOps);

  const jobPath = cleanTenant && cleanTenant !== "default"
    ? `tenants/${cleanTenant}/notification_jobs/${stableJobId}`
    : `notification_jobs/${stableJobId}`;

  // 1. Check for existing job to guarantee deduplication on lead replay
  const existingJob = await ops.get(jobPath);
  if (existingJob) {
    return {
      job: existingJob,
      jobId: stableJobId,
      isNew: false,
      created: false,
      deduplicated: true,
    };
  }

  // 2. Resolve approved recipient
  const recipientResolution = await resolveTenantRecipient({ tenantId: cleanTenant, dbInstance, dbOps });

  // 3. Construct canonical job
  const newJob = createNotificationJob({
    jobId: stableJobId,
    leadId: cleanLeadId,
    tenantId: cleanTenant,
    eventType,
    title,
    message,
    leadData,
    visitorEmailConfig,
    assignedRecipient: recipientResolution.recipient,
    recipientSource: recipientResolution.source,
  });

  if (!recipientResolution.valid) {
    newJob.delivery_status = DELIVERY_STATUS.FAILED;
    newJob.failure_reason = recipientResolution.reason;
    newJob.error_code = recipientResolution.source === "missing_settings" || recipientResolution.source === "empty_recipient"
      ? "MISSING_RECIPIENT"
      : "INVALID_RECIPIENT";
    newJob.recipient_validated = false;
  }

  // 4. Persist job durably
  await ops.set(jobPath, newJob);

  return {
    job: newJob,
    jobId: stableJobId,
    isNew: true,
    created: true,
    deduplicated: false,
    recipientResolution,
  };
}

const claimMutexes = new Map();

async function withJobMutex(key, fn) {
  let prevPromise = claimMutexes.get(key) || Promise.resolve();
  let release;
  const currentPromise = new Promise((resolve) => {
    release = resolve;
  });
  claimMutexes.set(key, prevPromise.then(() => currentPromise));

  await prevPromise;
  try {
    return await fn();
  } finally {
    release();
    if (claimMutexes.get(key) === currentPromise) {
      claimMutexes.delete(key);
    }
  }
}

/**
 * Atomically claims a queued job for worker processing with lease expiration recovery.
 */
export async function claimNotificationJob({
  tenantId = "default",
  jobId,
  workerId,
  leaseMs = 120000, // 2 minutes lease
  dbInstance = db,
  dbOps = null,
}) {
  const cleanTenant = String(tenantId).toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
  const cleanJobId = sanitizeFirebaseKey(jobId, "job");
  const ops = resolveDbOps(dbInstance, dbOps);

  const jobPath = cleanTenant && cleanTenant !== "default"
    ? `tenants/${cleanTenant}/notification_jobs/${cleanJobId}`
    : `notification_jobs/${cleanJobId}`;

  return await withJobMutex(jobPath, async () => {
    const job = await ops.get(jobPath);
    if (!job) {
      return { claimed: false, reason: "job_not_found" };
    }

    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    // Check if job is claimable
    const isQueued = job.delivery_status === DELIVERY_STATUS.QUEUED;
    const isLeaseExpired =
      job.delivery_status === DELIVERY_STATUS.CLAIMED &&
      job.lease_expires_at &&
      now >
        (typeof job.lease_expires_at === "string"
          ? new Date(job.lease_expires_at).getTime()
          : job.lease_expires_at);

    if (!isQueued && !isLeaseExpired) {
      return {
        claimed: false,
        reason: "job_not_claimable",
        currentStatus: job.delivery_status,
        job,
      };
    }

    // Check attempt limit
    if (job.attempt_count >= job.max_attempts) {
      await ops.update(jobPath, {
        delivery_status: DELIVERY_STATUS.FAILED,
        failure_reason: `Max delivery attempts exhausted (${job.attempt_count}/${job.max_attempts}).`,
        updated_at: nowIso,
        version: (job.version || 1) + 1,
      });
      return {
        claimed: false,
        reason: "attempts_exhausted",
        job,
      };
    }

    // Claim job
    const newVersion = (job.version || 1) + 1;
    const claimedJob = {
      ...job,
      delivery_status: DELIVERY_STATUS.CLAIMED,
      claimed_by: String(workerId),
      lease_expires_at: now + leaseMs,
      attempt_count: (job.attempt_count || 0) + 1,
      last_attempt_at: nowIso,
      version: newVersion,
      updated_at: nowIso,
    };

    await ops.set(jobPath, claimedJob);
    return {
      claimed: true,
      job: claimedJob,
      ...claimedJob,
    };
  });
}

/**
 * Records an immutable delivery attempt in the audit trail.
 */
export async function recordDeliveryAttempt({
  tenantId = "default",
  jobId,
  attemptRecord,
  attemptNumber = 1,
  recipient = null,
  status = DELIVERY_STATUS.UNKNOWN,
  providerMessageId = null,
  errorCode = null,
  errorMessage = null,
  dbInstance = db,
  dbOps = null,
}) {
  const cleanTenant = String(tenantId).toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
  const cleanJobId = sanitizeFirebaseKey(jobId, "job");
  const ops = resolveDbOps(dbInstance, dbOps);

  const record = attemptRecord || createDeliveryAttemptRecord({
    attemptNumber,
    recipient,
    status,
    providerMessageId,
    errorCode,
    errorMessage,
  });

  const attemptPath = cleanTenant && cleanTenant !== "default"
    ? `tenants/${cleanTenant}/delivery_attempts/${cleanJobId}/${record.attempt_id}`
    : `delivery_attempts/${cleanJobId}/${record.attempt_id}`;

  await ops.set(attemptPath, record);
  return record;
}

/**
 * Updates job delivery status with monotonic version protection against stale workers.
 */
export async function updateJobDeliveryStatus({
  tenantId = "default",
  jobId,
  status,
  targetStatus,
  version,
  fencingToken,
  failureReason = null,
  lastError = null,
  errorCode = null,
  providerMessageId = null,
  isAmbiguous = false,
  is_ambiguous = false,
  nextRetryAt = null,
  dbInstance = db,
  dbOps = null,
}) {
  const cleanTenant = String(tenantId).toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
  const cleanJobId = sanitizeFirebaseKey(jobId, "job");
  const ops = resolveDbOps(dbInstance, dbOps);

  const finalStatus = targetStatus || status;
  const effectiveVersion = fencingToken !== undefined ? fencingToken : version;
  const effectiveReason = lastError || failureReason;
  const effectiveAmbiguous = Boolean(isAmbiguous || is_ambiguous || finalStatus === DELIVERY_STATUS.UNKNOWN);

  const jobPath = cleanTenant && cleanTenant !== "default"
    ? `tenants/${cleanTenant}/notification_jobs/${cleanJobId}`
    : `notification_jobs/${cleanJobId}`;

  const currentJob = await ops.get(jobPath);
  if (!currentJob) throw new Error(`Job '${cleanJobId}' not found.`);

  // Stale worker protection: Fencing token verification
  if (effectiveVersion !== undefined && currentJob.version > effectiveVersion) {
    return {
      success: false,
      reason: "fencing_token_mismatch",
      error: `Stale worker update rejected: Attempted version (${effectiveVersion}) < persisted version (${currentJob.version}).`,
      currentVersion: currentJob.version,
    };
  }

  // Validate state transition
  if (!isValidDeliveryTransition(currentJob.delivery_status, finalStatus)) {
    return {
      success: false,
      reason: "invalid_delivery_transition",
      error: `Invalid delivery transition from '${currentJob.delivery_status}' to '${finalStatus}'.`,
    };
  }

  const nowIso = new Date().toISOString();
  const attemptsCount = currentJob.attempts || 1;
  const isDeadLetter = finalStatus === DELIVERY_STATUS.FAILED && attemptsCount >= (MAX_DELIVERY_RETRIES || 3);

  const patch = {
    delivery_status: finalStatus,
    failure_reason: effectiveReason,
    last_error: effectiveReason,
    error_code: errorCode || currentJob.error_code || null,
    provider_message_id: providerMessageId || currentJob.provider_message_id,
    is_ambiguous: effectiveAmbiguous,
    is_dead_letter: isDeadLetter,
    next_retry_at: isDeadLetter ? null : nextRetryAt,
    lease_expires_at: null,
    claimed_by: null,
    updated_at: nowIso,
    version: (currentJob.version || 1) + 1,
  };

  await ops.update(jobPath, patch);

  // 🚨 CD15: Trigger Actionable Operational Alerts on Provider Failure or Dead-Letter
  if (finalStatus === DELIVERY_STATUS.FAILED) {
    try {
      await processSmartAlert("CRITICAL", "notification_lifecycle", "provider_failure", {
        tenantId: cleanTenant,
        error_code: errorCode || "PROVIDER_DELIVERY_FAILED",
        error_message: effectiveReason || "Provider delivery failed.",
        correlation_id: currentJob.lead_id || cleanJobId,
        provider_id: currentJob.provider_id || "nodemailer-smtp",
      });

      if (isDeadLetter) {
        await processSmartAlert("CRITICAL", "notification_lifecycle", "dead_letter_queue_threshold_exceeded", {
          tenantId: cleanTenant,
          error_code: "DLQ_THRESHOLD_EXCEEDED",
          error_message: `Notification job '${cleanJobId}' reached maximum retry threshold (${attemptsCount} attempts) and is held in dead-letter state.`,
          correlation_id: currentJob.lead_id || cleanJobId,
          provider_id: currentJob.provider_id || "nodemailer-smtp",
        });
      }
    } catch (_) {
      // safe fallback
    }
  }

  return { success: true, ...currentJob, ...patch };
}

/**
 * Human acknowledgement of a handoff. Only authorized tenant users can acknowledge.
 */
export async function acknowledgeNotificationJob({
  tenantId = "default",
  jobId,
  actor,
  notes = null,
  dbInstance = db,
  dbOps = null,
}) {
  const cleanTenant = String(tenantId).toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
  const cleanJobId = sanitizeFirebaseKey(jobId, "job");
  const ops = resolveDbOps(dbInstance, dbOps);

  const jobPath = cleanTenant && cleanTenant !== "default"
    ? `tenants/${cleanTenant}/notification_jobs/${cleanJobId}`
    : `notification_jobs/${cleanJobId}`;

  const job = await ops.get(jobPath);
  if (!job) {
    const err = new Error(`Notification job '${cleanJobId}' not found.`);
    err.status = 404;
    throw err;
  }

  // Cross-tenant verification
  if (job.tenant_id && job.tenant_id !== cleanTenant) {
    const err = new Error(`Cross-tenant acknowledgement forbidden. Job belongs to '${job.tenant_id}', but operator requested '${cleanTenant}'.`);
    err.code = "CROSS_TENANT_ACKNOWLEDGEMENT_FORBIDDEN";
    err.status = 403;
    throw err;
  }

  // Idempotency: Duplicate acknowledgements succeed safely without overwriting initial actor/timestamp
  if (job.acknowledgement_status === ACKNOWLEDGEMENT_STATUS.ACKNOWLEDGED) {
    return {
      acknowledged: true,
      alreadyAcknowledged: true,
      jobId: cleanJobId,
      acknowledged_at: job.acknowledged_at || job.acknowledgement_timestamp,
      acknowledged_by: job.acknowledged_by || job.acknowledgement_actor,
    };
  }

  const nowIso = new Date().toISOString();
  const patch = {
    acknowledgement_status: ACKNOWLEDGEMENT_STATUS.ACKNOWLEDGED,
    acknowledgement_actor: String(actor || "authorized_operator"),
    acknowledged_by: String(actor || "authorized_operator"),
    acknowledgement_timestamp: nowIso,
    acknowledged_at: nowIso,
    acknowledgement_notes: notes ? String(notes) : null,
    updated_at: nowIso,
    version: (job.version || 1) + 1,
  };

  await ops.update(jobPath, patch);
  return {
    acknowledged: true,
    alreadyAcknowledged: false,
    jobId: cleanJobId,
    acknowledged_at: nowIso,
    acknowledged_by: patch.acknowledged_by,
  };
}

/**
 * Safe manual replay of a failed or unknown notification job by an authorized operator.
 */
export async function replayNotificationJob({
  tenantId = "default",
  jobId,
  actor,
  dbInstance = db,
  dbOps = null,
}) {
  const cleanTenant = String(tenantId).toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
  const cleanJobId = sanitizeFirebaseKey(jobId, "job");
  const ops = resolveDbOps(dbInstance, dbOps);

  const jobPath = cleanTenant && cleanTenant !== "default"
    ? `tenants/${cleanTenant}/notification_jobs/${cleanJobId}`
    : `notification_jobs/${cleanJobId}`;

  const job = await ops.get(jobPath);
  if (!job) {
    const err = new Error(`Notification job '${cleanJobId}' not found.`);
    err.status = 404;
    throw err;
  }

  // Cross-tenant check
  if (job.tenant_id && job.tenant_id !== cleanTenant) {
    const err = new Error(`Cross-tenant replay forbidden.`);
    err.code = "CROSS_TENANT_REPLAY_FORBIDDEN";
    err.status = 403;
    throw err;
  }

  // Re-verify recipient configuration
  const recipientRes = await resolveTenantRecipient({ tenantId: cleanTenant, dbInstance, dbOps });

  const nowIso = new Date().toISOString();
  const patch = {
    delivery_status: recipientRes.valid ? DELIVERY_STATUS.QUEUED : DELIVERY_STATUS.FAILED,
    failure_reason: recipientRes.valid ? null : recipientRes.reason,
    assigned_recipient: recipientRes.recipient || job.assigned_recipient,
    recipient_validated: recipientRes.valid,
    next_retry_at: nowIso,
    is_ambiguous: false,
    replay_count: (job.replay_count || 0) + 1,
    replayed_by: String(actor),
    replayed_at: nowIso,
    updated_at: nowIso,
    version: (job.version || 1) + 1,
  };

  await ops.update(jobPath, patch);
  return { replayed: true, job: { ...job, ...patch } };
}
