// src/pages/api/cookie-consent.js
import { ref, set } from "firebase/database";
import { safeDbSet } from "../../lib/safeDb";
import { withApiLogger } from "../../lib/apiMiddleware";
import { db } from "../../lib/firebase";
import { resolveTenantId } from "../../lib/tenantResolver";
import { sanitizeFirebaseKey, sanitizeUntrustedTelemetry } from "../../lib/sanitizer";
import { validateRequestBodySize } from "../../lib/publicEndpointGuard";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '16kb',
    },
  },
};

// Helper: Safely deep-sanitize objects to ensure NO property contains `undefined`
// which causes Firebase Realtime Database set() to throw fatal errors
function sanitizeForFirebase(obj) {
  return JSON.parse(
    JSON.stringify(obj, (key, value) => (value === undefined ? null : value))
  );
}

async function handler(req, res, apiLogger) {
  // CORS Headers for cross-domain SDK embed requests
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-tenant-id, x-correlation-id, x-session-id"
  );

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" });
  }

  // 1. Enforce 16KB body size cap (returns 413)
  if (!validateRequestBodySize(req, res, 16384)) return;

  try {
    // Robust body parsing: handle objects, raw JSON strings, and buffers
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (_) {
        body = {};
      }
    } else if (Buffer.isBuffer(body)) {
      try {
        body = JSON.parse(body.toString("utf8"));
      } catch (_) {
        body = {};
      }
    }

    if (!body || typeof body !== "object") {
      body = {};
    }
    body = sanitizeUntrustedTelemetry(body);

    const {
      anonId,
      username,
      deviceName,
      consentStatus = "accepted",
      ipAddress,
      ipLocation = {},
      location = {},
      language,
      timeZone,
      rawUserAgent,
      hostUrl = "",
      pagePath = "",
      tenant_id,
    } = body;

    const safeAnonId = sanitizeFirebaseKey(anonId, "visitor");
    if (!anonId || !safeAnonId) {
      return res.status(400).json({ error: "Valid anonId is required" });
    }

    const tenantId = resolveTenantId(req) || tenant_id || "default";
    const timestamp = new Date().toISOString();

    // Fallback IP extraction from server headers if client didn't supply it
    const clientIp =
      ipAddress && ipAddress !== "unknown"
        ? ipAddress
        : (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
            .split(",")[0]
            .trim();

    // Parse numeric coordinates safely for Google Maps markers
    const numLat =
      location && location.lat != null && !isNaN(Number(location.lat))
        ? Number(location.lat)
        : ipLocation && ipLocation.lat != null && !isNaN(Number(ipLocation.lat))
        ? Number(ipLocation.lat)
        : null;

    const numLng =
      location && location.lng != null && !isNaN(Number(location.lng))
        ? Number(location.lng)
        : ipLocation && ipLocation.lng != null && !isNaN(Number(ipLocation.lng))
        ? Number(ipLocation.lng)
        : null;

    const locationStatus =
      (location && location.status) ||
      (consentStatus === "accepted" && numLat != null ? "allowed" : "rejected");

    const payload = sanitizeForFirebase({
      id: String(anonId),
      anonId: String(anonId),
      username: username || `Visitor_${String(anonId).substring(4, 12)}`,
      deviceName: deviceName || "Unknown Device",
      consentStatus: String(consentStatus),
      ipAddress: clientIp,
      ipLocation: {
        ip: clientIp,
        city: (ipLocation && ipLocation.city) || "Unknown",
        region: (ipLocation && ipLocation.region) || "Unknown",
        country: (ipLocation && ipLocation.country) || "Unknown",
        lat: numLat,
        lng: numLng,
      },
      location: {
        status: locationStatus,
        lat: numLat,
        lng: numLng,
      },
      language: language || "en-US",
      timeZone: timeZone || "UTC",
      rawUserAgent: rawUserAgent || req.headers["user-agent"] || "unknown",
      hostUrl: hostUrl || "",
      pagePath: pagePath || "/",
      tenant_id: tenantId,
      isArchived: false,
      updatedAt: timestamp,
    });

    // 1. Write to global user_cookies partition (consumed by Pulse Dashboard /lg)
    const globalCookieRef = ref(db, `user_cookies/${safeAnonId}`);
    try {
      await safeDbSet(globalCookieRef, payload, 400);
    } catch (_) {
      // offline fallback
    }

    // 2. Also write to tenant-scoped partition for multi-tenant isolation
    if (tenantId && tenantId !== "default") {
      const tenantCookieRef = ref(db, `tenants/${tenantId}/user_cookies/${safeAnonId}`);
      try {
        await safeDbSet(tenantCookieRef, payload, 400);
      } catch (_) {
        // offline fallback
      }
    }

    return res.status(200).json({ success: true, anonId, tenantId });
  } catch (error) {
    apiLogger.error("Cookie Consent Save Error:", error);
    return res.status(500).json({ error: "Failed to persist cookie data" });
  }
}

export default withApiLogger(handler, "CookieConsent-API");
