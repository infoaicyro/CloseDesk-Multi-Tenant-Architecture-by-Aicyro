// src/lib/authSession.js
import crypto from "crypto";
import { ref, get, set } from "firebase/database";
import { db } from "./firebase.js";

export const SESSION_COOKIE_NAME = "cd_session";
const DEFAULT_SECRET = process.env.CD_SESSION_SECRET || "closedesk_platform_session_secret_change_in_production";
const SESSION_EXPIRY_NORMAL = 24 * 60 * 60; // 24 hours in seconds
const SESSION_EXPIRY_PRE_STEPUP = 15 * 60;   // 15 minutes in seconds

// In-memory revocation cache to handle cold-starts or offline runs
const revocationCache = new Map();

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf.toString("base64url");
}

function base64UrlDecode(input) {
  return Buffer.from(input, "base64url").toString("utf8");
}

/**
 * Signs a session token using HMAC-SHA256 with explicit claims.
 *
 * @param {object} claims
 * @param {string} claims.sub - Username or user ID
 * @param {string} claims.role - "superadmin" | "tenant_operator"
 * @param {string} claims.tenantId - Associated tenant ID
 * @param {boolean} [claims.stepUpVerified=false] - Secondary factor verified status
 * @param {number} [claims.sessionVersion=1] - Incremented on password/credential rotation
 * @param {number} [claims.expiresIn] - Expiration duration in seconds
 * @param {string} [secret] - Signing secret override
 * @returns {string} - Compact signed token (header.payload.signature)
 */
export function signSessionToken(claims, secret = DEFAULT_SECRET) {
  if (!claims || !claims.sub || !claims.role) {
    throw new Error("Session claims must include sub and role");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = claims.expiresIn
    ? nowSec + claims.expiresIn
    : nowSec + (claims.stepUpVerified ? SESSION_EXPIRY_NORMAL : SESSION_EXPIRY_PRE_STEPUP);

  const header = {
    alg: "HS256",
    typ: "JWT",
  };

  const payload = {
    sub: String(claims.sub),
    role: String(claims.role),
    tenantId: String(claims.tenantId || "default"),
    stepUpVerified: Boolean(claims.stepUpVerified),
    sessionVersion: Number(claims.sessionVersion || 1),
    iat: nowSec,
    exp: expSec,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac("sha256", secret)
    .update(dataToSign)
    .digest("base64url");

  return `${dataToSign}.${signature}`;
}

/**
 * Verifies the cryptographic signature and expiration of a session token.
 *
 * @param {string} token
 * @param {string} [secret]
 * @returns {{ valid: boolean, payload?: object, reason?: string }}
 */
export function verifySessionToken(token, secret = DEFAULT_SECRET) {
  if (!token || typeof token !== "string") {
    return { valid: false, reason: "Token missing or invalid type" };
  }

  const parts = token.trim().split(".");
  if (parts.length !== 3) {
    return { valid: false, reason: "Malformed token format" };
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(dataToSign)
    .digest("base64url");

  const sigBuf = Buffer.from(signature);
  const expSigBuf = Buffer.from(expectedSignature);

  if (sigBuf.length !== expSigBuf.length || !crypto.timingSafeEqual(sigBuf, expSigBuf)) {
    return { valid: false, reason: "Invalid cryptographic signature" };
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch (e) {
    return { valid: false, reason: "Invalid token payload JSON" };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < nowSec) {
    return { valid: false, reason: "Session token expired", payload };
  }

  return { valid: true, payload };
}

async function safeDbGet(dbRef, timeoutMs = 600) {
  return Promise.race([
    get(dbRef),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Firebase read timeout")), timeoutMs)
    ),
  ]);
}

async function safeDbSet(dbRef, data, timeoutMs = 600) {
  return Promise.race([
    set(dbRef, data),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Firebase write timeout")), timeoutMs)
    ),
  ]);
}

/**
 * Checks whether a session has been revoked or invalidated via credential rotation.
 *
 * @param {string} sub - Username/uid
 * @param {number} iat - Token issuance timestamp (seconds)
 * @param {number} sessionVersion - Token session version
 * @returns {Promise<boolean>} - True if revoked, false if valid
 */
export async function isSessionRevoked(sub, iat, sessionVersion) {
  const cleanSub = String(sub).toLowerCase().replace(/[.#$[\]/:]/g, "_");
  const cacheKey = cleanSub;

  let metadata = revocationCache.get(cacheKey) || null;

  try {
    const revRef = ref(db, `system_security/sessions/${cleanSub}`);
    const snapshot = await safeDbGet(revRef, 600);
    if (snapshot.exists()) {
      metadata = snapshot.val();
      revocationCache.set(cacheKey, metadata);
    }
  } catch (err) {
    // Fall back to in-memory revocation cache if Firebase is unreachable
  }

  if (!metadata) {
    return false;
  }

  // If token was issued before or at the revocation timestamp, it is revoked
  if (metadata.revokedBefore && iat <= metadata.revokedBefore) {
    return true;
  }

  // If user credential was rotated and token sessionVersion is older, it is revoked
  if (metadata.minSessionVersion && sessionVersion < metadata.minSessionVersion) {
    return true;
  }

  return false;
}

/**
 * Revokes all current active sessions for a user (e.g. on explicit logout).
 *
 * @param {string} sub
 * @returns {Promise<void>}
 */
export async function revokeUserSessions(sub) {
  const cleanSub = String(sub).toLowerCase().replace(/[.#$[\]/:]/g, "_");
  const nowSec = Math.floor(Date.now() / 1000);

  const existing = revocationCache.get(cleanSub) || {};
  const updated = {
    ...existing,
    revokedBefore: nowSec,
    revokedAt: nowSec,
  };

  revocationCache.set(cleanSub, updated);

  try {
    const revRef = ref(db, `system_security/sessions/${cleanSub}`);
    await safeDbSet(revRef, updated, 600);
  } catch (err) {
    // Preserved in memory cache
  }
}

/**
 * Bumps the user's credential version and revokes existing sessions (e.g. on password change).
 *
 * @param {string} sub
 * @returns {Promise<number>} - New session version
 */
export async function recordCredentialRotation(sub) {
  const cleanSub = String(sub).toLowerCase().replace(/[.#$[\]/:]/g, "_");
  const nowSec = Math.floor(Date.now() / 1000);

  const existing = revocationCache.get(cleanSub) || {};
  const newVersion = (existing.minSessionVersion || 1) + 1;

  const updated = {
    ...existing,
    minSessionVersion: newVersion,
    credentialsRotatedAt: nowSec,
    revokedBefore: nowSec,
  };

  revocationCache.set(cleanSub, updated);

  try {
    const revRef = ref(db, `system_security/sessions/${cleanSub}`);
    await safeDbSet(revRef, updated, 600);
  } catch (err) {
    // Preserved in memory
  }

  return newVersion;
}

/**
 * Parses cookies from incoming HTTP request.
 *
 * @param {object} req
 * @returns {Record<string, string>}
 */
export function parseCookies(req) {
  const cookieHeader = req.headers?.cookie || req.headers?.Cookie || "";
  const cookies = {};
  if (!cookieHeader) return cookies;

  cookieHeader.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx !== -1) {
      const key = pair.slice(0, idx).trim();
      const val = pair.slice(idx + 1).trim();
      cookies[key] = decodeURIComponent(val);
    }
  });

  return cookies;
}

/**
 * Formats a Set-Cookie header value with production security flags.
 *
 * @param {string} token
 * @param {number} [maxAgeSeconds=SESSION_EXPIRY_NORMAL]
 * @param {object} [options]
 * @returns {string}
 */
export function serializeSessionCookie(token, maxAgeSeconds = SESSION_EXPIRY_NORMAL, options = {}) {
  const isProd = process.env.NODE_ENV === "production";
  const secure = options.secure !== undefined ? options.secure : isProd;
  const sameSite = options.sameSite || "Strict";
  const path = options.path || "/";

  let cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=${path}; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAgeSeconds}`;
  if (secure) {
    cookie += "; Secure";
  }
  return cookie;
}

/**
 * Returns a Set-Cookie string that immediately clears the session cookie.
 *
 * @param {object} [options]
 * @returns {string}
 */
export function clearSessionCookie(options = {}) {
  const isProd = process.env.NODE_ENV === "production";
  const secure = options.secure !== undefined ? options.secure : isProd;
  const path = options.path || "/";

  let cookie = `${SESSION_COOKIE_NAME}=; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  if (secure) {
    cookie += "; Secure";
  }
  return cookie;
}

/**
 * Extracts and verifies the active session from an incoming request.
 * Checks cookie, Authorization header, and x-cd-session header.
 *
 * @param {object} req
 * @param {string} [secret]
 * @returns {Promise<object|null>} - Verified session payload or null
 */
export async function extractSession(req, secret = DEFAULT_SECRET) {
  if (!req) return null;

  // 1. Check cookies
  const cookies = parseCookies(req);
  let rawToken = cookies[SESSION_COOKIE_NAME];

  // 2. Check Authorization header: Bearer <token>
  if (!rawToken && req.headers?.authorization) {
    const authHeader = req.headers.authorization;
    if (authHeader.startsWith("Bearer ")) {
      rawToken = authHeader.slice(7).trim();
    }
  }

  // 3. Check custom header x-cd-session
  if (!rawToken && req.headers?.["x-cd-session"]) {
    rawToken = req.headers["x-cd-session"];
  }

  if (!rawToken) {
    return null;
  }

  const result = verifySessionToken(rawToken, secret);
  if (!result.valid || !result.payload) {
    return null;
  }

  const { sub, iat, sessionVersion } = result.payload;
  const revoked = await isSessionRevoked(sub, iat, sessionVersion);
  if (revoked) {
    return null;
  }

  return result.payload;
}

/**
 * Validates state-changing HTTP requests against Cross-Site Request Forgery (CSRF).
 *
 * @param {object} req
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateCsrf(req) {
  if (!req) return { valid: false, error: "Missing request" };

  const method = (req.method || "GET").toUpperCase();
  // Safe idempotent methods do not require CSRF origin checks
  if (["GET", "HEAD", "OPTIONS"].includes(method)) {
    return { valid: true };
  }

  // Custom headers cannot be attached in standard browser cross-origin forms
  if (
    req.headers?.["x-requested-with"] ||
    req.headers?.["x-cd-session"] ||
    req.headers?.["x-csrf-token"]
  ) {
    return { valid: true };
  }

  // Origin / Referer validation
  const origin = req.headers?.origin;
  const referer = req.headers?.referer;
  const host = req.headers?.host;

  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (host && originUrl.host === host) {
        return { valid: true };
      }
      // Allow localhost in development
      if (originUrl.hostname === "localhost" || originUrl.hostname === "127.0.0.1") {
        return { valid: true };
      }
      // Check configured app URL
      if (process.env.NEXT_PUBLIC_APP_URL) {
        const appUrl = new URL(process.env.NEXT_PUBLIC_APP_URL);
        if (originUrl.host === appUrl.host) {
          return { valid: true };
        }
      }
    } catch (e) {
      return { valid: false, error: "Malformed Origin header" };
    }
  } else if (referer) {
    try {
      const refererUrl = new URL(referer);
      if (host && refererUrl.host === host) {
        return { valid: true };
      }
      if (refererUrl.hostname === "localhost" || refererUrl.hostname === "127.0.0.1") {
        return { valid: true };
      }
    } catch (e) {
      return { valid: false, error: "Malformed Referer header" };
    }
  }

  // If no custom header and Origin/Referer doesn't match host, reject
  if (origin || referer) {
    return { valid: false, error: "Cross-site request origin disallowed" };
  }

  // In test runners or direct curl/server calls without browser Origin/Referer, allow if non-browser
  return { valid: true };
}

/**
 * Universal Route Guard wrapper for privileged API routes.
 *
 * @param {Function} handler
 * @param {object} options
 * @param {string[]} [options.allowedRoles] - e.g. ["superadmin"] or ["superadmin", "tenant_operator"]
 * @param {boolean} [options.requireStepUp=false] - Whether step-up verification is strictly required
 * @returns {Function} Next.js API handler
 */
export function withSessionGuard(handler, options = {}) {
  const { allowedRoles = [], requireStepUp = false } = options;

  return async (req, res, apiLogger) => {
    // 1. CSRF Protection for state-changing calls
    const csrfCheck = validateCsrf(req);
    if (!csrfCheck.valid) {
      return res.status(403).json({ error: csrfCheck.error || "CSRF verification failed" });
    }

    // 2. Extract and verify session
    const session = await extractSession(req);
    if (!session) {
      return res.status(401).json({ error: "Authentication required. Active session missing or expired." });
    }

    // 3. Role enforcement (RBAC)
    if (allowedRoles.length > 0 && !allowedRoles.includes(session.role)) {
      return res.status(403).json({ error: "Access denied. Insufficient role permissions." });
    }

    // 4. Step-up enforcement
    if (requireStepUp && !session.stepUpVerified) {
      return res.status(403).json({
        error: "Secondary factor step-up verification required before accessing this endpoint.",
        stepUpRequired: true,
      });
    }

    // Attach verified session to request object
    req.session = session;

    return handler(req, res, apiLogger);
  };
}
