// src/pages/api/appointments/book.js
import { withApiLogger } from "../../../lib/apiMiddleware";
import { resolveTenantId, sanitizeTenantId } from "../../../lib/tenantResolver";
import { commitAppointment } from "../../../lib/appointmentScheduler";
import { sanitizeFirebasePayload } from "../../../lib/sanitizer";
import { db } from "../../../lib/firebase";

async function handler(req, res, apiLogger) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  if (!req.body || typeof req.body !== "object") {
    return res.status(400).json({ error: "Invalid payload format." });
  }

  const payload = sanitizeFirebasePayload(req.body);
  const tenantId = sanitizeTenantId(resolveTenantId(req) || payload.tenant_id || "default");

  // Prevent cross-tenant spoofing in payload
  if (payload.tenant_id && sanitizeTenantId(payload.tenant_id) !== tenantId) {
    apiLogger.warn("security", "cross_tenant_booking_blocked", {
      context: { headerTenant: tenantId, payloadTenant: payload.tenant_id },
    });
    return res.status(403).json({
      error: `Cross-tenant booking forbidden. Context is '${tenantId}' but payload requested '${payload.tenant_id}'.`,
    });
  }

  const startIso = payload.start_time || payload.startIso || payload.booked_slot;
  if (!startIso) {
    return res.status(400).json({ error: "start_time is required for booking." });
  }

  const customerInfo = {
    name: payload.name || payload.customer_name || payload.contact?.name || null,
    email: payload.email || payload.customer_email || payload.contact?.email || null,
    phone: payload.phone || payload.customer_phone || payload.contact?.phone || null,
  };

  const customerAgreement = payload.customer_agreement !== undefined
    ? payload.customer_agreement
    : payload.customerAgreement;

  const operationKey = req.headers["x-idempotency-key"] || payload.operation_key || `op_book_${Date.now()}`;

  try {
    const result = await commitAppointment({
      tenantId,
      leadId: payload.lead_id || payload.firebaseId || null,
      conversationId: payload.conversation_id || payload.session_id || null,
      customerInfo,
      service: payload.service || payload.service_requested || "General Consultation",
      startIso,
      durationMinutes: Number(payload.duration_minutes) || 60,
      preBufferMinutes: Number(payload.pre_buffer_minutes) || 0,
      postBufferMinutes: Number(payload.post_buffer_minutes) || 0,
      capacity: Number(payload.capacity) || 1,
      timezone: payload.timezone || "UTC",
      customerAgreement,
      operationKey,
      bookingMode: payload.booking_mode,
      tenantConfig: payload.tenant_config || {},
      dbInstance: db,
    });

    if (!result.success) {
      if (result.code === "CUSTOMER_AGREEMENT_REQUIRED") {
        return res.status(422).json(result);
      }
      if (result.code === "SLOT_CAPACITY_EXCEEDED") {
        return res.status(409).json(result);
      }
      if (result.status === "booking_outcome_unknown") {
        return res.status(202).json(result);
      }
      return res.status(400).json(result);
    }

    apiLogger.info("appointment_lifecycle", "booking_committed", {
      context: { tenantId, appointmentId: result.appointment_id, status: result.status },
    });

    return res.status(200).json(result);
  } catch (error) {
    apiLogger.error("appointment_lifecycle", "booking_failed", { error });
    return res.status(500).json({ error: error.message || "Failed to commit appointment." });
  }
}

export default withApiLogger(handler, "AppointmentBookAPI");
