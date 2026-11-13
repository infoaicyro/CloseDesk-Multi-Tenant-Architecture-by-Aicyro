// src/pages/api/voice/session.js
import { db } from "../../../lib/firebase";
import { withApiLogger } from "../../../lib/apiMiddleware";
import { resolveTenantId, sanitizeTenantId } from "../../../lib/tenantResolver";
import {
  heartbeatVoiceSession,
  revokeVoiceSession,
  validateVoiceSessionForAction,
  checkEffectiveVoicePermission,
  VOICE_SESSION_STATUS,
} from "../../../lib/voiceLifecycle";
import { sanitizeFirebaseKey } from "../../../lib/sanitizer";

const isValidSessionId = (id) => /^lead_\d+_[a-z0-9]{5,10}$/i.test(id);

async function handler(req, res, apiLogger) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const tenantId = sanitizeTenantId(resolveTenantId(req) || req.body?.tenant_id || "default");
  const { action = "heartbeat", session_id } = req.body || {};

  if (!session_id || !isValidSessionId(session_id)) {
    return res.status(400).json({ error: "A valid session_id format is required." });
  }

  const cleanSessionId = sanitizeFirebaseKey(session_id, "session");

  try {
    if (action === "heartbeat") {
      const result = await heartbeatVoiceSession({
        tenantId,
        sessionId: cleanSessionId,
        currentTime: Date.now(),
        dbInstance: db,
      });

      if (!result.active) {
        apiLogger.warn("voice_lifecycle", "voice_session_heartbeat_failed", {
          context: { tenantId, sessionId: cleanSessionId, reason: result.reason, status: result.status },
        });
      }

      return res.status(200).json(result);
    }

    if (action === "end") {
      const result = await revokeVoiceSession({
        tenantId,
        sessionId: cleanSessionId,
        reason: "User closed voice call",
        status: VOICE_SESSION_STATUS.COMPLETED,
        dbInstance: db,
      });

      apiLogger.info("voice_lifecycle", "voice_session_manually_ended", {
        context: { tenantId, sessionId: cleanSessionId },
      });

      return res.status(200).json(result);
    }

    if (action === "validate") {
      const result = await validateVoiceSessionForAction({
        tenantId,
        sessionId: cleanSessionId,
        dbInstance: db,
      });

      return res.status(result.allowed ? 200 : 403).json(result);
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (error) {
    apiLogger.error("Voice Session Endpoint Error:", error);
    return res.status(500).json({ error: "Failed to process voice session request" });
  }
}

export default withApiLogger(handler, "Voice-Session-API");
