// src/pages/api/notifications/settings.js
import { ref } from "firebase/database";
import { withApiLogger } from "../../../lib/apiMiddleware";
import { db } from "../../../lib/firebase";
import { resolveAuthenticatedTenantId } from "../../../lib/tenantResolver";
import { safeDbGet, safeDbUpdate } from "../../../lib/safeDb";
import { isValidRecipientEmail } from "../../../lib/handoffContract";
import { sanitizeFirebasePayload, redactSensitiveSecrets } from "../../../lib/sanitizer";

async function handler(req, res, apiLogger) {
  // CORS Headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-tenant-id, x-correlation-id, x-session-id"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // 🚨 SECURITY: Operator session verification & cross-tenant spoofing prevention
  const authResult = await resolveAuthenticatedTenantId(req);
  if (!authResult.allowed) {
    apiLogger.warn("security", "unauthorized_notification_settings_blocked", {
      context: { error: authResult.error, status: authResult.status },
    });
    return res.status(authResult.status || 401).json({ error: authResult.error });
  }

  const tenantId = authResult.tenantId;
  const settingsPath = tenantId && tenantId !== "default"
    ? `tenants/${tenantId}/notification_settings`
    : `settings/notification_settings`;

  // --- GET: Fetch Tenant Notification Settings ---
  if (req.method === "GET") {
    try {
      let snapshot = null;
      try {
        snapshot = await safeDbGet(ref(db, settingsPath), 600);
      } catch (e) {
        // Database offline fallback
      }

      const settings = snapshot && snapshot.exists() ? redactSensitiveSecrets(snapshot.val()) : {
        emailAlerts: true,
        smsAlerts: false,
        urgentOnly: false,
        adminEmail: "",
        backupEmail: "",
        adminPhone: "",
      };

      return res.status(200).json({
        success: true,
        tenant_id: tenantId,
        settings,
      });
    } catch (error) {
      apiLogger.error("notification_lifecycle", "fetch_settings_failed", { error });
      return res.status(500).json({ error: "Failed to fetch notification settings." });
    }
  }

  // --- POST: Update Tenant Notification Settings ---
  if (req.method === "POST") {
    const rawPayload = req.body || {};
    const sanitized = sanitizeFirebasePayload(rawPayload);

    // Validate recipient format if provided
    if (sanitized.adminEmail) {
      const cleanEmail = String(sanitized.adminEmail).trim().toLowerCase();
      if (!isValidRecipientEmail(cleanEmail)) {
        apiLogger.warn("notification_lifecycle", "invalid_recipient_format", {
          context: { email: cleanEmail, tenantId, field: "adminEmail" },
        });
        return res.status(400).json({
          error: `Invalid email recipient syntax: '${cleanEmail}' does not conform to RFC 5322.`,
        });
      }
      sanitized.adminEmail = cleanEmail;
    }

    if (sanitized.backupEmail) {
      const cleanBackup = String(sanitized.backupEmail).trim().toLowerCase();
      if (!isValidRecipientEmail(cleanBackup)) {
        apiLogger.warn("notification_lifecycle", "invalid_backup_recipient_format", {
          context: { email: cleanBackup, tenantId, field: "backupEmail" },
        });
        return res.status(400).json({
          error: `Invalid backup recipient syntax: '${cleanBackup}' does not conform to RFC 5322.`,
        });
      }
      sanitized.backupEmail = cleanBackup;
    }

    try {
      const patch = {
        emailAlerts: sanitized.emailAlerts !== undefined ? Boolean(sanitized.emailAlerts) : true,
        smsAlerts: Boolean(sanitized.smsAlerts),
        urgentOnly: Boolean(sanitized.urgentOnly),
        adminEmail: sanitized.adminEmail || "",
        backupEmail: sanitized.backupEmail || "",
        adminPhone: sanitized.adminPhone || "",
        updated_at: new Date().toISOString(),
        updated_by: authResult.userId || authResult.username || "authenticated_operator",
      };

      await safeDbUpdate(ref(db, settingsPath), patch, 800);

      apiLogger.info("notification_lifecycle", "settings_updated", {
        context: { tenantId, updated_by: patch.updated_by, recipient: patch.adminEmail },
      });

      return res.status(200).json({
        success: true,
        tenant_id: tenantId,
        settings: patch,
      });
    } catch (error) {
      apiLogger.error("notification_lifecycle", "update_settings_failed", { error });
      return res.status(500).json({ error: "Failed to update notification settings." });
    }
  }

  return res.status(405).json({ error: "Method not allowed." });
}

export default withApiLogger(handler, "Notification-Settings-API");
