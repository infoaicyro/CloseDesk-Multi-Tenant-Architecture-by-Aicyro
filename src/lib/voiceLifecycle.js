// src/lib/voiceLifecycle.js
import { ref, get, set, update } from "firebase/database";
import { db } from "./firebase.js";
import { sanitizeTenantId } from "./tenantResolver.js";
import { sanitizeFirebaseKey } from "./sanitizer.js";

/**
 * CD09: Authoritative Voice Lifecycle, Permissions & Kill-Switch System (P0)
 */

export const VOICE_SESSION_STATUS = {
  ACTIVE: "active",
  REVOKED: "revoked",
  EXPIRED: "expired",
  COMPLETED: "completed",
  TERMINATED_BY_KILL_SWITCH: "terminated_by_kill_switch",
};

export const KILL_SWITCH_SCOPES = {
  GLOBAL: "global",
  TENANT: "tenant",
  WORKFLOW: "workflow",
};

// --- DEFAULT RESOURCE LIMITS (Configurable per Tenant / Product Policy) ---
export const DEFAULT_VOICE_LIMITS = {
  MAX_CONCURRENT_SESSIONS_PER_TENANT: 3, // Pilot limit to prevent runaway API billing
  MAX_SESSION_DURATION_SECONDS: 900,     // 15 minutes hard duration cap
  HEARTBEAT_INTERVAL_SECONDS: 10,        // Heartbeat pulse every 10s
  STALE_HEARTBEAT_SECONDS: 30,           // Discard sessions unheartbeated for >30s
  TOKEN_EXPIRY_SECONDS: 60,              // WebRTC ephemeral secret expiry window
};

function resolveDbOps(dbInstance, dbOps) {
  return {
    get: async (dbPath) => {
      if (dbOps?.get) return await dbOps.get(dbPath);
      if (typeof dbInstance?.get === "function") {
        const res = await dbInstance.get(dbPath);
        return res && typeof res.val === "function" ? res.val() : res;
      }
      const dbRef = ref(dbInstance || db, dbPath);
      const snap = await get(dbRef);
      return snap && snap.exists() ? snap.val() : null;
    },
    set: async (dbPath, val) => {
      if (dbOps?.set) return await dbOps.set(dbPath, val);
      if (typeof dbInstance?.set === "function") return await dbInstance.set(dbPath, val);
      const dbRef = ref(dbInstance || db, dbPath);
      await set(dbRef, val);
    },
    update: async (dbPath, val) => {
      if (dbOps?.update) return await dbOps.update(dbPath, val);
      if (typeof dbInstance?.update === "function") return await dbInstance.update(dbPath, val);
      const dbRef = ref(dbInstance || db, dbPath);
      await update(dbRef, val);
    },
  };
}

/**
 * 1. EFFECTIVE VOICE PERMISSION CHECK
 * Precedence: Global Kill Switch > Tenant Voice Enablement > Workflow Enablement
 */
export async function checkEffectiveVoicePermission({
  tenantId = "default",
  workflowId = null,
  dbInstance = db,
  dbOps = null,
} = {}) {
  const cleanTenant = sanitizeTenantId(tenantId) || "default";
  const ops = resolveDbOps(dbInstance, dbOps);

  // 1.1 Scope 1: Global Platform Kill Switch
  // Checked in environment variables AND in durable settings database
  if (process.env.VOICE_GLOBAL_KILL_SWITCH === "true" || process.env.VOICE_GLOBAL_KILL_SWITCH === "1") {
    return {
      allowed: false,
      scope: KILL_SWITCH_SCOPES.GLOBAL,
      reason: "Voice services are disabled globally across the platform via environment override.",
      status: 403,
    };
  }

  try {
    const globalSettings = await ops.get("settings/global_voice");
    if (globalSettings && globalSettings.enabled === false) {
      return {
        allowed: false,
        scope: KILL_SWITCH_SCOPES.GLOBAL,
        reason: globalSettings.reason || "Voice services have been disabled globally by the platform SuperAdmin.",
        disabledAt: globalSettings.disabled_at,
        status: 403,
      };
    }
  } catch (_) {
    // If global settings read fails, allow tenant check to proceed unless env is set
  }

  // 1.2 Scope 2: Tenant-Level Voice Enablement
  const tenantPath = cleanTenant && cleanTenant !== "default"
    ? `tenants/${cleanTenant}/chatbot_config`
    : "settings/chatbot_config";

  try {
    const botConfig = await ops.get(tenantPath);
    if (botConfig) {
      const voiceEnabled = botConfig.voiceEnabled !== false && botConfig.voiceChatAgent !== false;
      if (!voiceEnabled) {
        return {
          allowed: false,
          scope: KILL_SWITCH_SCOPES.TENANT,
          tenantId: cleanTenant,
          reason: `Voice services have been disabled for tenant '${cleanTenant}'. Please use text chat.`,
          status: 403,
        };
      }
    }
  } catch (err) {
    console.warn(`[VoiceLifecycle] Failed to read tenant ${cleanTenant} config:`, err.message);
  }

  // 1.3 Scope 3: Workflow-Specific Voice Enablement (if specified)
  if (workflowId) {
    const workflowPath = cleanTenant && cleanTenant !== "default"
      ? `tenants/${cleanTenant}/workflows/${workflowId}`
      : `workflows/${workflowId}`;
    try {
      const workflowConfig = await ops.get(workflowPath);
      if (workflowConfig && workflowConfig.voiceEnabled === false) {
        return {
          allowed: false,
          scope: KILL_SWITCH_SCOPES.WORKFLOW,
          workflowId,
          reason: `Voice is disabled for workflow '${workflowId}'.`,
          status: 403,
        };
      }
    } catch (_) {}
  }

  return {
    allowed: true,
    tenantId: cleanTenant,
  };
}

/**
 * 2. GET CURRENTLY ACTIVE VOICE SESSIONS FOR TENANT
 * Filters out expired and stale sessions automatically.
 */
export async function getTenantActiveVoiceSessions({
  tenantId = "default",
  currentTime = Date.now(),
  staleThresholdSeconds = DEFAULT_VOICE_LIMITS.STALE_HEARTBEAT_SECONDS,
  dbInstance = db,
  dbOps = null,
} = {}) {
  const cleanTenant = sanitizeTenantId(tenantId) || "default";
  const ops = resolveDbOps(dbInstance, dbOps);
  const sessionsPath = cleanTenant && cleanTenant !== "default"
    ? `tenants/${cleanTenant}/voice_sessions`
    : "voice_sessions";

  const allSessions = (await ops.get(sessionsPath)) || {};
  const activeSessions = [];
  const staleThresholdMs = staleThresholdSeconds * 1000;

  for (const [id, session] of Object.entries(allSessions)) {
    if (!session || typeof session !== "object") continue;

    // Check status
    if (session.status !== VOICE_SESSION_STATUS.ACTIVE) continue;

    // Check duration expiry
    const expiresAt = new Date(session.expires_at).getTime();
    if (!isNaN(expiresAt) && currentTime >= expiresAt) continue;

    // Check stale heartbeat
    const lastHeartbeat = new Date(session.last_heartbeat_at || session.started_at).getTime();
    if (!isNaN(lastHeartbeat) && currentTime - lastHeartbeat > staleThresholdMs) continue;

    activeSessions.push({
      sessionId: id,
      ...session,
    });
  }

  return activeSessions;
}

/**
 * 3. CHECK TENANT CONCURRENCY LIMITS
 */
export async function checkTenantVoiceConcurrency({
  tenantId = "default",
  maxConcurrent = DEFAULT_VOICE_LIMITS.MAX_CONCURRENT_SESSIONS_PER_TENANT,
  dbInstance = db,
  dbOps = null,
} = {}) {
  const cleanTenant = sanitizeTenantId(tenantId) || "default";
  const activeSessions = await getTenantActiveVoiceSessions({ tenantId: cleanTenant, dbInstance, dbOps });

  if (activeSessions.length >= maxConcurrent) {
    return {
      allowed: false,
      activeCount: activeSessions.length,
      maxConcurrent,
      reason: `Tenant '${cleanTenant}' has reached maximum concurrent voice sessions (${activeSessions.length}/${maxConcurrent}). Please try again later or use text chat.`,
    };
  }

  return {
    allowed: true,
    activeCount: activeSessions.length,
    maxConcurrent,
  };
}

/**
 * 4. CREATE DURABLE VOICE SESSION RECORD
 * Server-side durable binding to tenant, conversation, IP, and duration lease.
 */
export async function createVoiceSessionRecord({
  tenantId = "default",
  sessionId,
  conversationId = null,
  clientIp = "unknown",
  maxDurationSeconds = DEFAULT_VOICE_LIMITS.MAX_SESSION_DURATION_SECONDS,
  dbInstance = db,
  dbOps = null,
} = {}) {
  const cleanTenant = sanitizeTenantId(tenantId) || "default";
  const cleanSessionId = sanitizeFirebaseKey(sessionId, "session");
  const ops = resolveDbOps(dbInstance, dbOps);

  // Re-verify permission & concurrency before writing session
  const perm = await checkEffectiveVoicePermission({ tenantId: cleanTenant, dbInstance, dbOps });
  if (!perm.allowed) {
    return { success: false, status: perm.status, error: perm.reason, scope: perm.scope };
  }

  const concurrency = await checkTenantVoiceConcurrency({ tenantId: cleanTenant, dbInstance, dbOps });
  if (!concurrency.allowed) {
    return { success: false, status: 429, error: concurrency.reason, activeCount: concurrency.activeCount };
  }

  const now = Date.now();
  const expiresAt = new Date(now + maxDurationSeconds * 1000).toISOString();

  const sessionRecord = {
    session_id: cleanSessionId,
    tenant_id: cleanTenant,
    conversation_id: conversationId || cleanSessionId,
    client_ip: clientIp,
    status: VOICE_SESSION_STATUS.ACTIVE,
    started_at: new Date(now).toISOString(),
    last_heartbeat_at: new Date(now).toISOString(),
    expires_at: expiresAt,
    max_duration_seconds: maxDurationSeconds,
    created_at: new Date(now).toISOString(),
  };

  const sessionPath = cleanTenant && cleanTenant !== "default"
    ? `tenants/${cleanTenant}/voice_sessions/${cleanSessionId}`
    : `voice_sessions/${cleanSessionId}`;

  await ops.set(sessionPath, sessionRecord);

  return {
    success: true,
    session: sessionRecord,
  };
}

/**
 * 5. HEARTBEAT AND PERMISSION REVALIDATION
 * Revalidates that the session is still active, tenant/global voice is still enabled,
 * and duration cap has not expired.
 */
export async function heartbeatVoiceSession({
  tenantId = "default",
  sessionId,
  currentTime = Date.now(),
  dbInstance = db,
  dbOps = null,
} = {}) {
  const cleanTenant = sanitizeTenantId(tenantId) || "default";
  const cleanSessionId = sanitizeFirebaseKey(sessionId, "session");
  const ops = resolveDbOps(dbInstance, dbOps);

  const sessionPath = cleanTenant && cleanTenant !== "default"
    ? `tenants/${cleanTenant}/voice_sessions/${cleanSessionId}`
    : `voice_sessions/${cleanSessionId}`;

  const session = await ops.get(sessionPath);
  if (!session) {
    return {
      active: false,
      status: "not_found",
      reason: "Voice session not found or terminated.",
    };
  }

  // 5.1 Check if already marked non-active
  if (session.status !== VOICE_SESSION_STATUS.ACTIVE) {
    return {
      active: false,
      status: session.status,
      reason: session.revocation_reason || `Voice session status is '${session.status}'.`,
    };
  }

  // 5.2 Check maximum duration cap
  const expiresAt = new Date(session.expires_at).getTime();
  if (!isNaN(expiresAt) && currentTime >= expiresAt) {
    await ops.update(sessionPath, {
      status: VOICE_SESSION_STATUS.EXPIRED,
      revocation_reason: "Maximum session duration exceeded.",
      ended_at: new Date(currentTime).toISOString(),
    });
    return {
      active: false,
      status: VOICE_SESSION_STATUS.EXPIRED,
      reason: "Maximum voice session duration (15 minutes) reached.",
    };
  }

  // 5.3 Revalidate effective voice permission (Global + Tenant Kill Switches)
  const perm = await checkEffectiveVoicePermission({ tenantId: cleanTenant, dbInstance, dbOps });
  if (!perm.allowed) {
    await ops.update(sessionPath, {
      status: VOICE_SESSION_STATUS.TERMINATED_BY_KILL_SWITCH,
      revocation_reason: perm.reason,
      kill_switch_scope: perm.scope,
      ended_at: new Date(currentTime).toISOString(),
    });
    return {
      active: false,
      status: VOICE_SESSION_STATUS.TERMINATED_BY_KILL_SWITCH,
      reason: perm.reason,
      scope: perm.scope,
    };
  }

  // 5.4 Update heartbeat
  await ops.update(sessionPath, {
    last_heartbeat_at: new Date(currentTime).toISOString(),
  });

  const remainingSeconds = Math.max(0, Math.round((expiresAt - currentTime) / 1000));

  return {
    active: true,
    status: VOICE_SESSION_STATUS.ACTIVE,
    remainingSeconds,
    lastHeartbeat: new Date(currentTime).toISOString(),
  };
}

/**
 * 6. REVOKE / END VOICE SESSION
 */
export async function revokeVoiceSession({
  tenantId = "default",
  sessionId,
  reason = "Session closed by user or operator.",
  status = VOICE_SESSION_STATUS.COMPLETED,
  dbInstance = db,
  dbOps = null,
} = {}) {
  const cleanTenant = sanitizeTenantId(tenantId) || "default";
  const cleanSessionId = sanitizeFirebaseKey(sessionId, "session");
  const ops = resolveDbOps(dbInstance, dbOps);

  const sessionPath = cleanTenant && cleanTenant !== "default"
    ? `tenants/${cleanTenant}/voice_sessions/${cleanSessionId}`
    : `voice_sessions/${cleanSessionId}`;

  const existing = await ops.get(sessionPath);
  if (!existing) {
    return { success: true, message: "Session already absent." };
  }

  await ops.update(sessionPath, {
    status,
    revocation_reason: reason,
    ended_at: new Date().toISOString(),
  });

  return {
    success: true,
    sessionId: cleanSessionId,
    status,
    reason,
  };
}

/**
 * 7. SET GLOBAL VOICE KILL SWITCH
 */
export async function setGlobalVoiceKillSwitch({
  enabled,
  reason = "",
  disabledBy = "superadmin",
  dbInstance = db,
  dbOps = null,
} = {}) {
  const ops = resolveDbOps(dbInstance, dbOps);
  const now = new Date().toISOString();

  await ops.set("settings/global_voice", {
    enabled: Boolean(enabled),
    reason: enabled ? "Voice enabled globally." : (reason || "Emergency global voice kill-switch activated."),
    updated_by: disabledBy,
    updated_at: now,
    ...(enabled ? {} : { disabled_at: now }),
  });

  return {
    success: true,
    enabled: Boolean(enabled),
    updated_at: now,
  };
}

/**
 * 8. SET TENANT VOICE KILL SWITCH
 */
export async function setTenantVoiceKillSwitch({
  tenantId = "default",
  enabled,
  reason = "",
  updatedBy = "admin",
  dbInstance = db,
  dbOps = null,
} = {}) {
  const cleanTenant = sanitizeTenantId(tenantId) || "default";
  const ops = resolveDbOps(dbInstance, dbOps);
  const now = new Date().toISOString();

  const configPath = cleanTenant && cleanTenant !== "default"
    ? `tenants/${cleanTenant}/chatbot_config`
    : "settings/chatbot_config";

  const existing = (await ops.get(configPath)) || {};

  await ops.update(configPath, {
    ...existing,
    voiceEnabled: Boolean(enabled),
    voiceChatAgent: Boolean(enabled),
    voice_status_reason: enabled ? "Voice enabled by tenant admin." : (reason || "Voice disabled by tenant admin."),
    voice_updated_at: now,
    voice_updated_by: updatedBy,
  });

  return {
    success: true,
    tenantId: cleanTenant,
    voiceEnabled: Boolean(enabled),
    updated_at: now,
  };
}

/**
 * 9. VALIDATE VOICE SESSION FOR ACTION (Used by sync-voice.js)
 * Validates that the session is bound to tenant, active, unexpired, and not killed.
 */
export async function validateVoiceSessionForAction({
  tenantId = "default",
  sessionId,
  dbInstance = db,
  dbOps = null,
} = {}) {
  const cleanTenant = sanitizeTenantId(tenantId) || "default";
  const cleanSessionId = sanitizeFirebaseKey(sessionId, "session");
  const ops = resolveDbOps(dbInstance, dbOps);

  // 1. Check Global & Tenant permission
  const perm = await checkEffectiveVoicePermission({ tenantId: cleanTenant, dbInstance, dbOps });
  if (!perm.allowed) {
    return {
      allowed: false,
      status: 403,
      reason: `Voice action rejected: ${perm.reason}`,
      scope: perm.scope,
    };
  }

  // 2. Check Session Record
  const sessionPath = cleanTenant && cleanTenant !== "default"
    ? `tenants/${cleanTenant}/voice_sessions/${cleanSessionId}`
    : `voice_sessions/${cleanSessionId}`;

  const session = await ops.get(sessionPath);
  if (!session) {
    // If no session record exists (e.g. legacy or unverified session id)
    return {
      allowed: false,
      status: 403,
      reason: "Voice action rejected: Voice session does not exist or has expired.",
    };
  }

  // Verify tenant ownership
  if (session.tenant_id && session.tenant_id !== cleanTenant) {
    return {
      allowed: false,
      status: 403,
      reason: `Cross-tenant voice session violation: Session owned by '${session.tenant_id}' cannot be accessed by '${cleanTenant}'.`,
    };
  }

  // Verify status
  if (session.status !== VOICE_SESSION_STATUS.ACTIVE) {
    return {
      allowed: false,
      status: 403,
      reason: `Voice action rejected: Session '${cleanSessionId}' is ${session.status} (${session.revocation_reason || "revoked"}).`,
    };
  }

  // Verify duration expiry
  const now = Date.now();
  const expiresAt = new Date(session.expires_at).getTime();
  if (!isNaN(expiresAt) && now >= expiresAt) {
    return {
      allowed: false,
      status: 403,
      reason: "Voice action rejected: Voice session duration cap exceeded.",
    };
  }

  return {
    allowed: true,
    session,
  };
}
