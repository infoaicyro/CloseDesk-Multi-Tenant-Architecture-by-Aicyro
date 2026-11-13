// src/lib/alertManager.js
import { db } from "./firebase.js";
import { ref, push } from "firebase/database";
import { PRIMARY_INCIDENT_OWNER } from "./releaseManifest.js";
import { safeDbSet } from "./safeDb.js";

// In-memory cache provides burst protection and alert storm throttling
const alertCache = new Map();
export const THROTTLE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_DELIVERY_RETRIES = 3;

export const MONITORED_CRITICAL_EVENTS = [
  "lead_routing_failed",
  "booking_failed",
  "chatbot_engine_failure",
  "voice_service_unavailable",
  "database_unavailable",
  "cross_tenant_access_attempt",
  "failed_handoff",
  "provider_failure",
  "quota_trip",
  "stale_cleanup",
  "dead_letter_queue_threshold_exceeded",
  "rate_limit_exceeded",
];

export const REMEDIATION_RUNBOOKS = {
  failed_handoff: {
    runbook_section: "CD15 Runbook Section 4 (Failed-Queue & Dead-Letter Handling)",
    steps: [
      "1. Verify recipient email in tenants/{tenantId}/notification_settings.",
      "2. Confirm recipient satisfies RFC 5322 syntax validation.",
      "3. Execute safe manual replay via POST /api/notifications/replay with authorized session.",
    ],
  },
  provider_failure: {
    runbook_section: "CD15 Runbook Section 4.2 (Downstream Provider Outage Recovery)",
    steps: [
      "1. Check status of downstream provider (Google Calendar, SMTP, OpenAI).",
      "2. Confirm tenant fallback authorization if custom SMTP is unreachable.",
      "3. Ensure requests are safely downgraded to 'request_recorded' with zero ghost records.",
      "4. Monitor dead-letter queue for replay when provider recovers.",
    ],
  },
  quota_trip: {
    runbook_section: "CD15 Runbook Section 7 (Quota Trips & Rate Limit Throttling)",
    steps: [
      "1. Inspect API rate limiter counters in tenants/{tenantId}/rate_limits.",
      "2. Check external provider billing/quota dashboard for token exhaustion.",
      "3. Temporarily enable burst allowance or fail over to secondary API key.",
    ],
  },
  stale_cleanup: {
    runbook_section: "CD15 Runbook Section 7.4 (Log Retention Stale Cleanup Alerts)",
    steps: [
      "1. Check if settings/log_retention.is_approved is true.",
      "2. Verify CRON_SECRET authorization on /api/cron/retention-cleanup.",
      "3. Trigger manual retention run if scheduled task stalled beyond 24 hours.",
    ],
  },
  dead_letter_queue_threshold_exceeded: {
    runbook_section: "CD15 Runbook Section 4.3 (Dead-Letter Queue Remediation)",
    steps: [
      "1. Inspect dead-letter job in tenants/{tenantId}/notification_jobs/{jobId}.",
      "2. Analyze last_error and delivery_attempts history.",
      "3. Remediate root cause and trigger manual replay with operator credentials.",
    ],
  },
  database_unavailable: {
    runbook_section: "CD15 Runbook Section 5 (Database Timeout & Circuit Breaker)",
    steps: [
      "1. Check Firebase Realtime Database status at status.firebase.google.com.",
      "2. Confirm safeDb timeouts are active (bounded at <= 800ms).",
      "3. Inspect connection health and local fallback caches.",
    ],
  },
};

/**
 * Resets the in-memory alert cache (primarily for deterministic unit testing).
 */
export function clearAlertCache() {
  alertCache.clear();
}

/**
 * Builds an actionable, incident-owner-ready alert payload.
 */
export function buildActionableAlert({
  eventName,
  tenantId = "global",
  providerId = "none",
  errorCode = "UNKNOWN_ERROR",
  errorMessage = "An operational exception occurred.",
  correlationId = "N/A",
  severity = "P0",
  context = {},
}) {
  const cleanTenant = String(tenantId).toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
  const runbook = REMEDIATION_RUNBOOKS[eventName] || {
    runbook_section: "CD15 Runbook Section 2 (General Incident Escalation)",
    steps: [
      "1. Identify affected service and correlation ID.",
      "2. Review recent audit logs in system_logs.",
      "3. Escalate to primary incident commander if unrecovered within SLA.",
    ],
  };

  return {
    alert_id: `alt_${cleanTenant}_${Date.now()}`,
    severity: severity,
    title: `🚨 [${severity}] CloseDesk Operational Alert: ${eventName.toUpperCase()} (Tenant: ${cleanTenant})`,
    event_name: eventName,
    tenant_id: cleanTenant,
    provider_id: providerId,
    error_code: errorCode,
    error_message: errorMessage,
    correlation_id: correlationId,
    timestamp: new Date().toISOString(),
    status: "UNACKNOWLEDGED",
    incident_owner: {
      name: PRIMARY_INCIDENT_OWNER.name,
      role: PRIMARY_INCIDENT_OWNER.role,
      email: PRIMARY_INCIDENT_OWNER.email,
      phone: PRIMARY_INCIDENT_OWNER.phone,
      sla_minutes: PRIMARY_INCIDENT_OWNER.escalation_sla_minutes,
      escalation_channel: PRIMARY_INCIDENT_OWNER.escalation_channel,
    },
    actionable_remediation: {
      runbook_section: runbook.runbook_section,
      immediate_steps: runbook.steps,
    },
    context: context,
  };
}

/**
 * Dispatches or suppresses alerts based on burst rate limits and storm prevention.
 */
export async function processSmartAlert(level, eventType, eventName, logEntry = {}) {
  // 1. Identify Target Critical Events
  const isCritical =
    level === "CRITICAL" ||
    MONITORED_CRITICAL_EVENTS.includes(eventName) ||
    eventType === "security_audit";

  if (!isCritical) return { sent: false, reason: "not_critical" };

  const env = logEntry.environment || "production";
  const service = logEntry.service || "API";
  const tenantId = logEntry.tenantId || logEntry.tenant_id || "global";
  const providerId = logEntry.provider_id || logEntry.provider || "none";

  // Group by Environment, Tenant, Service, Event, and Provider
  const cacheKey = `${env}_${tenantId}_${service}_${eventName}_${providerId}`;
  const now = Date.now();
  const cached = alertCache.get(cacheKey) || { count: 0, lastSent: 0, suppressedCount: 0 };

  cached.count += 1;

  // 2. Alert Storm Prevention (Debouncing & Rate Limiting)
  const isSpike = cached.count === 10;
  const isThrottled = now - cached.lastSent < THROTTLE_WINDOW_MS && !isSpike;

  if (isThrottled) {
    cached.suppressedCount += 1;
    alertCache.set(cacheKey, cached);
    return {
      sent: false,
      reason: "alert_storm_suppressed",
      cacheKey,
      currentCount: cached.count,
      suppressedCount: cached.suppressedCount,
    };
  }

  // 3. Construct Actionable Alert Payload
  const actionableAlert = buildActionableAlert({
    eventName,
    tenantId,
    providerId,
    errorCode: logEntry.error_code || (isSpike ? "ALERT_SPIKE_DETECTED" : "CRITICAL_EVENT"),
    errorMessage: logEntry.error_message || logEntry.message || "Monitored operational event triggered.",
    correlationId: logEntry.correlation_id || "N/A",
    severity: isSpike || level === "CRITICAL" ? "P0" : "P1",
    context: {
      environment: env,
      service: service,
      occurrences_in_window: cached.count,
      suppressed_in_window: cached.suppressedCount,
      is_spike: isSpike,
    },
  });

  // 4. Record to Database Queue
  try {
    if (logEntry.dbOps?.pushAlert) {
      await logEntry.dbOps.pushAlert(actionableAlert);
    } else {
      const alertRef = ref(db, "system_alerts");
      const newAlertRef = push(alertRef);
      await safeDbSet(newAlertRef, actionableAlert, 400);
    }
    const resetCount = isSpike ? 0 : cached.count;
    alertCache.set(cacheKey, { count: resetCount, lastSent: now, suppressedCount: 0 });
    return { sent: true, alert: actionableAlert };
  } catch (err) {
    // Graceful offline fallback
    const resetCount = isSpike ? 0 : cached.count;
    alertCache.set(cacheKey, { count: resetCount, lastSent: now, suppressedCount: 0 });
    return { sent: true, alert: actionableAlert, offline_fallback: true };
  }
}
