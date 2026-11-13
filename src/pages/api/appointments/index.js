// src/pages/api/appointments/index.js
import { withApiLogger } from "../../../lib/apiMiddleware";
import { resolveAuthenticatedTenantId, resolveTenantId, sanitizeTenantId } from "../../../lib/tenantResolver";
import { redactSensitiveSecrets } from "../../../lib/sanitizer";
import { safeDbGet } from "../../../lib/safeDb";
import { ref } from "firebase/database";
import { db } from "../../../lib/firebase";

async function handler(req, res, apiLogger) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed. Use GET." });
  }

  // Operator authentication check
  const authResult = await resolveAuthenticatedTenantId(req);
  const tenantId = authResult.allowed
    ? authResult.tenantId
    : sanitizeTenantId(resolveTenantId(req) || "default");

  const path = tenantId && tenantId !== "default" ? `tenants/${tenantId}/appointments` : "appointments";

  try {
    let snapshot = null;
    try {
      snapshot = await safeDbGet(ref(db, path), 800);
    } catch (e) {
      // Database timeout / offline fallback
    }

    if (snapshot && snapshot.exists()) {
      const data = redactSensitiveSecrets(snapshot.val());
      return res.status(200).json(data);
    }

    return res.status(200).json({});
  } catch (error) {
    apiLogger.error("appointment_lifecycle", "fetch_appointments_failed", { error });
    return res.status(500).json({ error: "Failed to fetch appointments." });
  }
}

export default withApiLogger(handler, "AppointmentsListAPI");
