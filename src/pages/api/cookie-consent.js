// src/pages/api/cookie-consent.js
import { ref, set } from "firebase/database";
import { withApiLogger } from "../../lib/apiMiddleware";
import { db } from "../../lib/firebase";
import { resolveTenantId, resolveAuthenticatedTenantId, sanitizeTenantId } from "../../lib/tenantResolver";
import { sanitizeFirebaseKey, redactSensitiveSecrets, sanitizeUntrustedTelemetry } from "../../lib/sanitizer";
import { safeDbGet, safeDbSet } from "../../lib/safeDb";
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

  // ==========================================
  // GET REQUEST: FETCH COOKIE RECORDS FOR DASHBOARD
  // ==========================================
  if (req.method === "GET") {
    const authResult = await resolveAuthenticatedTenantId(req);
    if (!authResult.allowed) {
      apiLogger.warn("security", "unauthorized_cookie_data_fetch_blocked", {
        context: { error: authResult.error, status: authResult.status },
      });
      return res.status(authResult.status || 401).json({ error: authResult.error });
    }

    try {
      const tenantId = authResult.tenantId;
      const cookiesPath =
        tenantId && tenantId !== "default"
          ? `tenants/${tenantId}/user_cookies`
          : "user_cookies";

      let snapshot = null;
      try {
        snapshot = await safeDbGet(ref(db, cookiesPath), 600);
      } catch (e) {
        // offline fallback
      }

      if (snapshot && snapshot.exists()) {
        const val = redactSensitiveSecrets(snapshot.val());
        return res.status(200).json({ success: true, cookies: val, tenantId });
      }

      return res.status(200).json({ success: true, cookies: {}, tenantId });
    } catch (err) {
      apiLogger.error("Cookie Data Fetch Error:", err);
      return res.status(500).json({ error: "Failed to fetch cookie data" });
    }
  }

  // ==========================================
  // POST REQUEST: RECORD COOKIE CONSENT (VISITOR)
  // ==========================================
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

    const rawTenant = resolveTenantId(req) || tenant_id || "default";
    const tenantId = sanitizeTenantId(rawTenant);
    const timestamp = new Date().toISOString();

    // Fallback IP extraction from server headers if client didn't supply it
    const clientIp =
      ipAddress && ipAddress !== "unknown"
        ? String(ipAddress).substring(0, 45)
        : (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown")
            .split(",")[0]
            .trim()
            .substring(0, 45);

    // UPDATED: Parse exact GPS and IP coordinates separately to prevent merging issues
    const ipLat =
      ipLocation && ipLocation.lat != null && !isNaN(Number(ipLocation.lat))
        ? Number(ipLocation.lat)
        : null;
    const ipLng =
      ipLocation && ipLocation.lng != null && !isNaN(Number(ipLocation.lng))
        ? Number(ipLocation.lng)
        : null;

    const exactLat =
      location && location.lat != null && !isNaN(Number(location.lat))
        ? Number(location.lat)
        : null;
    const exactLng =
      location && location.lng != null && !isNaN(Number(location.lng))
        ? Number(location.lng)
        : null;

    const locationStatus =
      (location && location.status) ||
      (consentStatus === "accepted" && exactLat != null ? "allowed" : "rejected");

    const payload = sanitizeForFirebase({
      id: String(safeAnonId),
      anonId: String(safeAnonId),
      username: String(username || `Visitor_${String(safeAnonId).substring(4, 12)}`).substring(0, 50),
      deviceName: String(deviceName || "Unknown Device").substring(0, 60),
      consentStatus: String(consentStatus).substring(0, 20),
      ipAddress: clientIp,
      ipLocation: {
        ip: clientIp,
        city: String((ipLocation && ipLocation.city) || "Unknown").substring(0, 50),
        region: String((ipLocation && ipLocation.region) || "Unknown").substring(0, 50),
        country: String((ipLocation && ipLocation.country) || "Unknown").substring(0, 50),
        lat: ipLat,
        lng: ipLng,
      },
      location: {
        status: String(locationStatus).substring(0, 20),
        lat: exactLat,
        lng: exactLng,
      },
      language: String(language || "en-US").substring(0, 20),
      timeZone: String(timeZone || "UTC").substring(0, 40),
      rawUserAgent: String(rawUserAgent || req.headers["user-agent"] || "unknown").substring(0, 255),
      hostUrl: String(hostUrl || "").substring(0, 255),
      pagePath: String(pagePath || "/").substring(0, 255),
      tenant_id: tenantId,
      isArchived: false,
      updatedAt: timestamp,
    });

    // 1. Write to tenant-scoped partition for multi-tenant isolation
    if (tenantId && tenantId !== "default") {
      const tenantCookieRef = ref(db, `tenants/${tenantId}/user_cookies/${safeAnonId}`);
      try {
        await safeDbSet(tenantCookieRef, payload, 600);
      } catch (e) {
        // offline fallback
      }
    } else {
      // 2. Write to default partition
      const globalCookieRef = ref(db, `user_cookies/${safeAnonId}`);
      try {
        await safeDbSet(globalCookieRef, payload, 600);
      } catch (e) {
        // offline fallback
      }
    }

    return res.status(200).json({ success: true, anonId: safeAnonId, tenantId });
  } catch (error) {
    apiLogger.error("Cookie Consent Save Error:", error);
    return res.status(500).json({ error: "Failed to persist cookie data" });
  }
}

export default withApiLogger(handler, "CookieConsent-API");
