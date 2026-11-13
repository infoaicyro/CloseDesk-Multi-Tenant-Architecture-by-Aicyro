// src/pages/api/appointments/cancel.js
import { withApiLogger } from "../../../lib/apiMiddleware";
import { resolveTenantId, sanitizeTenantId } from "../../../lib/tenantResolver";
import { cancelAppointment } from "../../../lib/appointmentScheduler";
import { sanitizeFirebasePayload } from "../../../lib/sanitizer";
import { db } from "../../../lib/firebase";

async function handler(req, res, apiLogger) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const payload = sanitizeFirebasePayload(req.body || {});
  const tenantId = sanitizeTenantId(resolveTenantId(req) || payload.tenant_id || "default");
  const appointmentId = payload.appointment_id || payload.appointmentId;

  if (!appointmentId) {
    return res.status(400).json({ error: "appointment_id is required to cancel." });
  }

  try {
    const result = await cancelAppointment({
      tenantId,
      appointmentId,
      reason: payload.reason || "Customer requested cancellation",
      actor: payload.actor || "customer",
      dbInstance: db,
    });

    apiLogger.info("appointment_lifecycle", "appointment_cancelled", {
      context: { tenantId, appointmentId },
    });

    return res.status(200).json(result);
  } catch (error) {
    const status = error.statusCode || 500;
    apiLogger.error("appointment_lifecycle", "cancellation_failed", { error });
    return res.status(status).json({ error: error.message || "Failed to cancel appointment." });
  }
}

export default withApiLogger(handler, "AppointmentCancelAPI");
