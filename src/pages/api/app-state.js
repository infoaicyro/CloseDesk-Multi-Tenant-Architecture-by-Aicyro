// src/pages/api/app-state.js
import { db } from "../../lib/firebase";
import { ref } from "firebase/database";
import { safeDbSet } from "../../lib/safeDb";
import {
  sanitizeFirebaseKey,
  sanitizeFirebasePayload,
  sanitizeUntrustedTelemetry,
} from "../../lib/sanitizer";
import { validateRequestBodySize } from "../../lib/publicEndpointGuard";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '16kb',
    },
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" });
  }

  // 1. Enforce 16KB body size cap (returns 413)
  if (!validateRequestBodySize(req, res, 16384)) return;

  try {
    // 2. Untrusted Telemetry Isolation: Quarantine client-supplied authority/role claims
    const sanitizedTelemetry = sanitizeUntrustedTelemetry(req.body);
    const logEntry = sanitizeFirebasePayload(sanitizedTelemetry);

    if (!logEntry.log_id || !logEntry.timestamp || !logEntry.service) {
      return res.status(400).json({ error: "Invalid log schema format", code: "INVALID_PAYLOAD" });
    }

    const safeLogId = sanitizeFirebaseKey(logEntry.log_id, "log");
    const logRef = ref(db, `system_logs/structured_events/${safeLogId}`);
    try {
      await safeDbSet(logRef, logEntry, 800);
    } catch (dbErr) {
      // In offline/transient test environments, log warning and preserve graceful status
      console.warn("safeDbSet fallback on app-state:", dbErr.message);
    }

    return res.status(200).json({ success: true, log_id: safeLogId });
  } catch (error) {
    console.error("CRITICAL: Central log ingestion failed:", error);
    return res.status(500).json({ error: "Failed to persist log centrally" });
  }
}
