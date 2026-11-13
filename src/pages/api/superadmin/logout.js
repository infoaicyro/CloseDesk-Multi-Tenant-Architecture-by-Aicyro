// src/pages/api/superadmin/logout.js
import { withApiLogger } from "../../../lib/apiMiddleware";
import { recordAuditTrail } from "../../../lib/auditTracer";
import {
  extractSession,
  revokeUserSessions,
  clearSessionCookie,
} from "../../../lib/authSession";

async function handler(req, res, apiLogger) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const session = await extractSession(req);
  const who = session ? session.sub : "unknown_superadmin";

  if (session && session.sub) {
    try {
      await revokeUserSessions(session.sub);
    } catch (err) {
      apiLogger.warn("auth", "session_revocation_failed", { error: err.message });
    }
  }

  // Clear HttpOnly session cookie
  res.setHeader("Set-Cookie", clearSessionCookie());

  recordAuditTrail(apiLogger, "superadmin_logout", {
    who,
    target: "superadmin_console",
    status: "success",
  });

  return res.status(200).json({
    success: true,
    message: "Super Admin session terminated and revoked successfully.",
  });
}

export default withApiLogger(handler, "SuperAdmin-Logout-API");
