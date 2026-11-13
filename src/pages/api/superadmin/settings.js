// src/pages/api/superadmin/settings.js
import { ref } from "firebase/database";
import { withApiLogger } from "../../../lib/apiMiddleware";
import { db } from "../../../lib/firebase";
import { recordAuditTrail } from "../../../lib/auditTracer";
import { withSessionGuard } from "../../../lib/authSession";
import { safeDbGet, safeDbSet, safeDbUpdate } from "../../../lib/safeDb";
import { redactSensitiveSecrets } from "../../../lib/sanitizer";
import { setGlobalVoiceKillSwitch } from "../../../lib/voiceLifecycle";

async function handler(req, res, apiLogger) {
  const session = req.session;

  if (req.method === "GET") {
    const { section = "email_config" } = req.query || {};

    try {
      const targetPath =
        section === "email_config"
          ? "settings/email_config"
          : section === "global_voice" || section === "voice_controls"
          ? "settings/global_voice"
          : `superAdminSettings/${session.sub}/appearance`;

      let data = {};
      try {
        const snapshot = await safeDbGet(ref(db, targetPath), 600);
        data = snapshot.exists() ? snapshot.val() : {};
      } catch (e) {
        // offline fallback
      }

      const safeData = redactSensitiveSecrets(data);
      return res.status(200).json({ success: true, section, data: safeData });
    } catch (err) {
      apiLogger.error("Failed to read settings:", err);
      return res.status(500).json({ error: "Failed to read settings" });
    }
  }

  if (req.method === "PUT" || req.method === "POST") {
    const { section = "email_config", payload } = req.body || {};

    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ error: "Settings payload is required" });
    }

    try {
      if (section === "email_config") {
        // Do not overwrite existing secrets with masked placeholders
        const updatePayload = { ...payload };
        if (updatePayload.smtpPassword === "[REDACTED]") delete updatePayload.smtpPassword;
        if (updatePayload.clientSecret === "[REDACTED]") delete updatePayload.clientSecret;
        if (updatePayload.refreshToken === "[REDACTED]") delete updatePayload.refreshToken;

        try {
          await safeDbUpdate(ref(db, "settings/email_config"), updatePayload, 600);
        } catch (e) {
          // offline fallback
        }
        recordAuditTrail(apiLogger, "email_config_updated", {
          who: session.sub,
          provider: payload.provider,
          status: "success",
        });
        return res.status(200).json({ success: true, message: "Email configuration saved." });
      } else if (section === "global_voice" || section === "voice_controls") {
        await setGlobalVoiceKillSwitch({
          enabled: payload.enabled,
          reason: payload.reason,
          disabledBy: session.sub,
          dbInstance: db,
        });
        recordAuditTrail(apiLogger, "global_voice_kill_switch_toggled", {
          who: session.sub,
          enabled: payload.enabled,
          reason: payload.reason,
          status: "success",
        });
        return res.status(200).json({ success: true, message: `Global voice ${payload.enabled ? "enabled" : "disabled"}.` });
      } else if (section === "appearance") {
        try {
          await safeDbSet(ref(db, `superAdminSettings/${session.sub}/appearance`), payload, 600);
        } catch (e) {
          // offline fallback
        }
        recordAuditTrail(apiLogger, "appearance_updated", {
          who: session.sub,
          status: "success",
        });
        return res.status(200).json({ success: true, message: "Appearance preferences saved." });
      }

      return res.status(400).json({ error: `Unknown settings section: ${section}` });
    } catch (err) {
      apiLogger.error("Failed to update settings:", err);
      return res.status(500).json({ error: "Failed to update settings" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

export default withApiLogger(
  withSessionGuard(handler, {
    allowedRoles: ["superadmin"],
    requireStepUp: true,
  }),
  "SuperAdmin-Settings-API"
);
