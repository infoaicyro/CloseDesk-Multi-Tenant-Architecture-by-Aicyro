// src/pages/api/appointments/availability.js
import { withApiLogger } from "../../../lib/apiMiddleware";
import { resolveTenantId, sanitizeTenantId } from "../../../lib/tenantResolver";
import { checkSlotAvailability } from "../../../lib/appointmentScheduler";
import { db } from "../../../lib/firebase";

async function handler(req, res, apiLogger) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use GET or POST." });
  }

  const tenantId = sanitizeTenantId(resolveTenantId(req) || "default");
  const params = req.method === "GET" ? req.query : req.body;

  const startIso = params.start_time || params.startIso || params.slot;
  if (!startIso) {
    return res.status(400).json({ error: "start_time (ISO 8601 string) is required." });
  }

  const durationMinutes = Number(params.duration_minutes || params.duration) || 60;
  const preBufferMinutes = Number(params.pre_buffer_minutes || params.preBuffer) || 0;
  const postBufferMinutes = Number(params.post_buffer_minutes || params.postBuffer) || 0;
  const capacity = Number(params.capacity) || 1;
  const timezone = params.timezone || "UTC";
  const service = params.service || "General Consultation";

  try {
    const result = await checkSlotAvailability({
      tenantId,
      service,
      startIso,
      durationMinutes,
      preBufferMinutes,
      postBufferMinutes,
      capacity,
      timezone,
      dbInstance: db,
    });

    apiLogger.info("appointment_lifecycle", "availability_checked", {
      context: { tenantId, startIso, available: result.available, bookings: result.currentBookings },
    });

    return res.status(200).json(result);
  } catch (error) {
    apiLogger.error("appointment_lifecycle", "availability_check_failed", { error });
    return res.status(500).json({ error: error.message || "Failed to check slot availability." });
  }
}

export default withApiLogger(handler, "AppointmentAvailabilityAPI");
