// src/pages/api/appointments/reschedule.js
import { withApiLogger } from "../../../lib/apiMiddleware";
import { resolveTenantId, sanitizeTenantId } from "../../../lib/tenantResolver";
import { rescheduleAppointment } from "../../../lib/appointmentScheduler";
import { sanitizeFirebasePayload } from "../../../lib/sanitizer";
import { db } from "../../../lib/firebase";

async function handler(req, res, apiLogger) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  const payload = sanitizeFirebasePayload(req.body || {});
  const tenantId = sanitizeTenantId(resolveTenantId(req) || payload.tenant_id || "default");
  const appointmentId = payload.appointment_id || payload.appointmentId;
  const newStartIso = payload.new_start_time || payload.newStartIso || payload.new_slot;

  if (!appointmentId || !newStartIso) {
    return res.status(400).json({ error: "appointment_id and new_start_time are required to reschedule." });
  }

  const customerAgreement = payload.customer_agreement !== undefined
    ? payload.customer_agreement
    : payload.customerAgreement !== undefined
    ? payload.customerAgreement
    : true;

  try {
    const result = await rescheduleAppointment({
      tenantId,
      appointmentId,
      newStartIso,
      newDurationMinutes: payload.new_duration_minutes ? Number(payload.new_duration_minutes) : null,
      customerAgreement,
      reason: payload.reason || "Customer requested reschedule",
      dbInstance: db,
    });

    if (!result.success) {
      return res.status(409).json(result);
    }

    apiLogger.info("appointment_lifecycle", "appointment_rescheduled", {
      context: { tenantId, appointmentId, newStartIso },
    });

    return res.status(200).json(result);
  } catch (error) {
    const status = error.statusCode || 500;
    apiLogger.error("appointment_lifecycle", "reschedule_failed", { error });
    return res.status(status).json({ error: error.message || "Failed to reschedule appointment." });
  }
}

export default withApiLogger(handler, "AppointmentRescheduleAPI");
