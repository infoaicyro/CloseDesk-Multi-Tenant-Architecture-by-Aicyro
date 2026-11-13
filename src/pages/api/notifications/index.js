// src/pages/api/notifications/index.js
import { ref } from "firebase/database";
import { withApiLogger } from "../../../lib/apiMiddleware";
import { db } from "../../../lib/firebase";
import { resolveAuthenticatedTenantId } from "../../../lib/tenantResolver";
import { safeDbGet } from "../../../lib/safeDb";
import { redactSensitiveSecrets } from "../../../lib/sanitizer";

async function handler(req, res, apiLogger) {
  // CORS Headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-tenant-id, x-correlation-id, x-session-id"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  // 🚨 SECURITY: Operator session verification & cross-tenant spoofing prevention
  const authResult = await resolveAuthenticatedTenantId(req);
  if (!authResult.allowed) {
    apiLogger.warn("security", "unauthorized_notifications_fetch_blocked", {
      context: { error: authResult.error, status: authResult.status },
    });
    return res.status(authResult.status || 401).json({ error: authResult.error });
  }

  try {
    const tenantId = authResult.tenantId;
    const jobsPath = tenantId && tenantId !== "default"
      ? `tenants/${tenantId}/notification_jobs`
      : "notification_jobs";

    let snapshot = null;
    try {
      snapshot = await safeDbGet(ref(db, jobsPath), 800);
    } catch (e) {
      // Database offline fallback
    }

    const jobsVal = snapshot && snapshot.exists() ? snapshot.val() : {};
    const safeJobs = redactSensitiveSecrets(jobsVal);

    // Convert to sorted array (newest first)
    const jobsArray = Object.keys(safeJobs).map((key) => ({
      id: key,
      ...safeJobs[key],
    })).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    apiLogger.info("notification_lifecycle", "notification_jobs_fetched", {
      context: { count: jobsArray.length, tenantId },
    });

    return res.status(200).json({
      success: true,
      tenant_id: tenantId,
      jobs: jobsArray,
    });
  } catch (error) {
    apiLogger.error("notification_lifecycle", "notification_jobs_fetch_failed", { error });
    return res.status(500).json({ error: "Failed to fetch notification jobs." });
  }
}

export default withApiLogger(handler, "Notification-Jobs-API");
