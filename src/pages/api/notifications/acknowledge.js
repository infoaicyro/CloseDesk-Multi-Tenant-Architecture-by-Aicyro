// src/pages/api/notifications/acknowledge.js
import { withApiLogger } from "../../../lib/apiMiddleware";
import { db } from "../../../lib/firebase";
import { resolveAuthenticatedTenantId } from "../../../lib/tenantResolver";
import { acknowledgeNotificationJob } from "../../../lib/handoffManager";

async function handler(req, res, apiLogger) {
  // CORS Headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-tenant-id, x-correlation-id, x-session-id"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  // 🚨 SECURITY: Operator session verification & cross-tenant spoofing prevention
  const authResult = await resolveAuthenticatedTenantId(req);
  if (!authResult.allowed) {
    apiLogger.warn("security", "unauthorized_acknowledgement_blocked", {
      context: { error: authResult.error, status: authResult.status },
    });
    return res.status(authResult.status || 401).json({ error: authResult.error });
  }

  const { job_id, notes } = req.body || {};
  if (!job_id || typeof job_id !== "string") {
    return res.status(400).json({ error: "A valid job_id string is required." });
  }

  try {
    const tenantId = authResult.tenantId;
    const actor = authResult.userId || authResult.username || "authenticated_operator";

    // 🚨 CD07: Human acknowledgement with tenant isolation & idempotency
    const result = await acknowledgeNotificationJob({
      tenantId,
      jobId: job_id,
      actor,
      notes,
      dbInstance: db,
    });

    apiLogger.info("notification_lifecycle", "notification_acknowledged", {
      context: {
        job_id,
        tenantId,
        actor,
        already_acknowledged: result.alreadyAcknowledged,
      },
    });

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (error) {
    if (error.code === "CROSS_TENANT_ACKNOWLEDGEMENT_FORBIDDEN" || error.status === 403) {
      apiLogger.warn("security", "cross_tenant_acknowledgement_blocked", {
        context: { error: error.message, tenantId: authResult.tenantId, job_id },
      });
      return res.status(403).json({ error: error.message });
    }

    if (error.status === 404) {
      return res.status(404).json({ error: error.message });
    }

    apiLogger.error("notification_lifecycle", "notification_acknowledgement_failed", { error });
    return res.status(500).json({ error: "Failed to acknowledge notification job." });
  }
}

export default withApiLogger(handler, "Notification-Acknowledge-API");
