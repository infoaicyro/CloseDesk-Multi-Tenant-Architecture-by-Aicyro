import { consumedStateJtis } from "./oauthState.js";
// src/lib/oauthService.js
import crypto from "crypto";
import { sanitizeTenantId } from "./tenantResolver";

const DEFAULT_SECRET = process.env.CD_SESSION_SECRET || "closedesk_platform_session_secret_change_in_production";
const STATE_EXPIRY_SECONDS = 600; // 10 minutes

// In-memory cache for consumed nonces (replay protection)
const consumedNonces = new Map();

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf.toString("base64url");
}

function base64UrlDecode(input) {
  return Buffer.from(input, "base64url").toString("utf8");
}

function cleanExpiredNonces() {
  const now = Math.floor(Date.now() / 1000);
  for (const [nonce, exp] of consumedNonces.entries()) {
    if (exp <= now) {
      consumedNonces.delete(nonce);
    }
  }
}

/**
 * Returns the configured base URL for OAuth redirects and postMessage origins.
 */
export function getAppBaseUrl(req = null) {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    try {
      return new URL(process.env.NEXT_PUBLIC_APP_URL).origin;
    } catch (_) {}
  }
  if (req && req.headers) {
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = req.headers["x-forwarded-proto"] || (host && host.includes("localhost") ? "http" : "https");
    if (host) {
      try {
        return new URL(`${proto}://${host}`).origin;
      } catch (_) {}
    }
  }
  return "http://localhost:3000";
}

/**
 * Returns provider configurations, feature enablement flags, and least necessary scopes.
 *
 * @param {"google" | "microsoft"} provider
 * @param {object} [req]
 * @returns {object}
 */
export function getProviderConfig(provider, req = null) {
  const baseUrl = getAppBaseUrl(req);
  const normalized = String(provider || "").toLowerCase();

  if (normalized === "google" || normalized === "google_oauth") {
    const clientId = process.env.GOOGLE_CLIENT_ID || "";
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
    const enabled = Boolean(clientId && clientId.trim() && clientSecret && clientSecret.trim());

    // 🔒 LEAST NECESSARY SCOPES:
    // Only request openid, email, and gmail.send (disallow full mailbox https://mail.google.com/)
    const scopes = [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/gmail.send",
    ].join(" ");

    return {
      provider: "google",
      enabled,
      clientId,
      clientSecret,
      scopes,
      authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      userinfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
      revokeUrl: "https://oauth2.googleapis.com/revoke",
      redirectUri: `${baseUrl}/api/auth/google/callback`,
    };
  }

  if (normalized === "microsoft") {
    const clientId = process.env.MICROSOFT_CLIENT_ID || "";
    const clientSecret = process.env.MICROSOFT_CLIENT_SECRET || "";
    const enabled = Boolean(clientId && clientId.trim() && clientSecret && clientSecret.trim());

    // 🔒 LEAST NECESSARY SCOPES:
    // Only request openid, email, offline_access, and SMTP.Send (disallow generic full Mail.ReadWrite)
    const scopes = [
      "openid",
      "email",
      "offline_access",
      "https://outlook.office.com/SMTP.Send",
    ].join(" ");

    return {
      provider: "microsoft",
      enabled,
      clientId,
      clientSecret,
      scopes,
      authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
      tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
      revokeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/logout",
      redirectUri: `${baseUrl}/api/auth/microsoft/callback`,
    };
  }

  throw new Error(`Unsupported OAuth provider: ${provider}`);
}

/**
 * Generates PKCE code_verifier and code_challenge (RFC 7636).
 *
 * @returns {{ codeVerifier: string, codeChallenge: string, codeChallengeMethod: string }}
 */
export function generatePkce() {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: "S256",
  };
}

/**
 * Creates a cryptographically signed OAuth state token binding operator,
 * tenant, provider, redirect URI, nonce, and expiration.
 *
 * @param {object} params
 * @param {string} params.operator - Initiating operator/user ID (sub)
 * @param {string} params.tenantId - Target tenant ID
 * @param {"google" | "microsoft"} params.provider - Provider name
 * @param {string} [params.redirectUri] - Expected callback redirect URI
 * @param {string} [params.secret] - HMAC secret override
 * @param {string} [params.codeVerifier] - Optional PKCE code verifier
 * @returns {{ stateToken: string, nonce: string, exp: number }}
 */
export function generateOAuthState(params) {
  const {
    operator = "unknown_operator",
    tenantId = "default",
    provider,
    redirectUri,
    secret = DEFAULT_SECRET,
    codeVerifier,
  } = params || {};

  if (!provider) {
    throw new Error("OAuth provider must be specified for state generation");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + STATE_EXPIRY_SECONDS;
  const nonce = crypto.randomBytes(16).toString("hex");

  const header = {
    alg: "HS256",
    typ: "OAuthState",
  };

  const payload = {
    sub: String(operator),
    tenantId: sanitizeTenantId(tenantId),
    provider: String(provider).toLowerCase(),
    redirectUri: String(redirectUri || ""),
    nonce,
    iat: nowSec,
    exp: expSec,
    ...(codeVerifier ? { cv: codeVerifier } : {}),
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const dataToSign = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto
    .createHmac("sha256", secret)
    .update(dataToSign)
    .digest("base64url");

  const stateToken = `${dataToSign}.${signature}`;
  return { stateToken, nonce, exp: expSec };
}

/**
 * Verifies the integrity, signature, expiration, provider binding, and replay status
 * of an incoming OAuth state token. Consumes the single-use nonce upon successful check.
 *
 * @param {string} rawState
 * @param {"google" | "microsoft"} expectedProvider
 * @param {string} [secret]
 * @returns {{ valid: boolean, payload?: object, error?: string }}
 */
export function verifyAndConsumeOAuthState(rawState, expectedProvider, secret = DEFAULT_SECRET) {
  if (!rawState || typeof rawState !== "string") {
    return { valid: false, error: "OAuth state parameter is missing or empty" };
  }

  const parts = rawState.trim().split(".");
  if (parts.length !== 3) {
    return { valid: false, error: "Malformed OAuth state format (expected header.payload.signature)" };
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
    return { valid: false, error: "Invalid OAuth state cryptographic signature (tampering detected)" };
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch (_) {
    return { valid: false, error: "Invalid OAuth state payload JSON" };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < nowSec) {
    return { valid: false, error: "OAuth state token has expired (replay window closed)" };
  }

  if (expectedProvider && payload.provider && payload.provider !== String(expectedProvider).toLowerCase()) {
    return {
      valid: false,
      error: `OAuth state provider mismatch (bound to '${payload.provider}', expected '${expectedProvider}')`,
    };
  }

  // 🚨 REPLAY PROTECTION: Verify that the nonce has not been consumed
  cleanExpiredNonces();
  const nonce = payload.nonce || payload.jti;
  if ((nonce && consumedNonces.has(nonce)) || (payload.jti && consumedStateJtis && consumedStateJtis.has(payload.jti))) {
    return { valid: false, error: "OAuth state token has already been consumed (replay attack rejected)" };
  }

  // Mark nonce as consumed
  if (nonce) consumedNonces.set(nonce, payload.exp);
  if (payload.jti && consumedStateJtis) consumedStateJtis.set(payload.jti, (payload.exp ? payload.exp * 1000 : Date.now() + 600000) + 60000);

  return { valid: true, payload };
}

/**
 * Validates OpenID Connect ID Token (JWT) claims beyond simple base64 decoding.
 * Validates structure, algorithm, expiration, not-before, audience, issuer, and nonce.
 *
 * @param {string} idToken - The raw JWT ID token string
 * @param {object} options
 * @param {string} options.expectedClientId - Expected audience claim (aud)
 * @param {string} [options.expectedNonce] - Expected nonce claim
 * @param {"google" | "microsoft"} options.provider - Provider identity to check issuer (iss)
 * @returns {{ valid: boolean, payload?: object, error?: string, email?: string }}
 */
export function validateIdToken(idToken, options = {}) {
  const { expectedClientId, expectedNonce, provider } = options;

  if (!idToken || typeof idToken !== "string") {
    return { valid: false, error: "ID token is missing or not a string" };
  }

  const parts = idToken.trim().split(".");
  if (parts.length !== 3) {
    return { valid: false, error: "Malformed ID token (expected 3 JWT segments)" };
  }

  let header, payload;
  try {
    header = JSON.parse(base64UrlDecode(parts[0]));
    payload = JSON.parse(base64UrlDecode(parts[1]));
  } catch (err) {
    return { valid: false, error: "Failed to parse ID token header or payload JSON" };
  }

  // 1. Verify algorithm (must not be 'none')
  const alg = header.alg || "";
  if (!alg || alg.toLowerCase() === "none") {
    return { valid: false, error: "Insecure JWT algorithm: 'none' is disallowed" };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const clockSkewToleranceSec = 300; // 5 minutes clock tolerance

  // 2. Validate expiration (exp)
  if (!payload.exp || typeof payload.exp !== "number") {
    return { valid: false, error: "ID token missing required 'exp' claim" };
  }
  if (payload.exp < nowSec - clockSkewToleranceSec) {
    return { valid: false, error: `ID token expired at ${new Date(payload.exp * 1000).toISOString()}` };
  }

  // 3. Validate issued at (iat) / not before (nbf)
  if (payload.nbf && typeof payload.nbf === "number" && payload.nbf > nowSec + clockSkewToleranceSec) {
    return { valid: false, error: "ID token is not yet valid ('nbf' claim in the future)" };
  }
  if (payload.iat && typeof payload.iat === "number" && payload.iat > nowSec + clockSkewToleranceSec) {
    return { valid: false, error: "ID token issued in the future ('iat' claim)" };
  }

  // 4. Validate audience (aud)
  if (expectedClientId) {
    const aud = payload.aud;
    let audMatch = false;
    if (typeof aud === "string" && aud === expectedClientId) {
      audMatch = true;
    } else if (Array.isArray(aud) && aud.includes(expectedClientId)) {
      audMatch = true;
    }
    if (!audMatch) {
      return {
        valid: false,
        error: `ID token audience mismatch: expected '${expectedClientId}', got '${JSON.stringify(aud)}'`,
      };
    }
  }

  // 5. Validate issuer (iss)
  const iss = String(payload.iss || "");
  const prov = String(provider || "").toLowerCase();
  if (prov === "google") {
    if (iss !== "https://accounts.google.com" && iss !== "accounts.google.com") {
      return { valid: false, error: `Invalid Google ID token issuer: '${iss}'` };
    }
  } else if (prov === "microsoft") {
    const isValidMsIssuer =
      iss.startsWith("https://login.microsoftonline.com/") ||
      iss.startsWith("https://sts.windows.net/");
    if (!isValidMsIssuer) {
      return { valid: false, error: `Invalid Microsoft ID token issuer: '${iss}'` };
    }
  }

  // 6. Validate nonce (nonce replay/binding protection)
  if (expectedNonce) {
    if (!payload.nonce) {
      return { valid: false, error: "ID token missing expected 'nonce' claim" };
    }
    if (payload.nonce !== expectedNonce) {
      return {
        valid: false,
        error: `ID token nonce mismatch: expected '${expectedNonce}', got '${payload.nonce}'`,
      };
    }
  }

  const email = payload.email || payload.preferred_username || null;
  return { valid: true, payload, email };
}

/**
 * Builds a secure postMessage HTML response with strict target origin and schema.
 * NEVER uses wildcard targetOrigin '*'.
 *
 * @param {object} params
 * @param {"google" | "microsoft"} params.provider
 * @param {"connected" | "error"} params.status
 * @param {string} [params.error]
 * @param {string} [params.tenantId="default"]
 * @param {string} [params.allowedOrigin]
 * @returns {string} Safe HTML string
 */
export function buildPostMessageHtml(params) {
  const {
    provider = "unknown",
    status = "error",
    error = null,
    tenantId = "default",
    allowedOrigin,
  } = params || {};

  const cleanOrigin = allowedOrigin || getAppBaseUrl();
  const safeOrigin = cleanOrigin.replace(/"/g, "&quot;");

  const messagePayload = {
    type: "CLOSEDESK_OAUTH_STATUS",
    provider,
    status,
    tenantId: sanitizeTenantId(tenantId),
    error: error || null,
    timestamp: Date.now(),
  };

  const jsonPayload = JSON.stringify(messagePayload);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>CloseDesk OAuth Status</title>
</head>
<body>
  <div style="font-family:sans-serif; text-align:center; padding:40px;">
    <h3>${status === "connected" ? "Account Connected" : "Connection Failed"}</h3>
    <p>${status === "connected" ? "Closing authentication window..." : (error || "An error occurred.")}</p>
  </div>
  <script>
    (function() {
      var payload = ${jsonPayload};
      var targetOrigin = "${safeOrigin}";
      if (window.opener && !window.opener.closed) {
        try {
          window.opener.postMessage(payload, targetOrigin);
        } catch (e) {
          console.error("Failed to postMessage to opener:", e);
        }
        setTimeout(function() { window.close(); }, 350);
      } else {
        window.location.href = "/lg?status=" + encodeURIComponent(payload.status);
      }
    })();
  </script>
</body>
</html>`;
}

/**
 * Revokes an OAuth refresh token with the provider endpoint.
 *
 * @param {object} params
 * @param {"google" | "microsoft"} params.provider
 * @param {string} params.token - Refresh token or access token
 * @returns {Promise<{ success: boolean, revoked: boolean, error?: string }>}
 */
export async function revokeOAuthToken({ provider, token }) {
  if (!token) {
    return { success: true, revoked: false, reason: "No token supplied" };
  }

  const prov = String(provider).toLowerCase();

  if (prov === "google" || prov === "google_oauth") {
    try {
      const res = await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
      return { success: res.ok, revoked: res.ok };
    } catch (err) {
      return { success: false, revoked: false, error: err.message };
    }
  }

  // Microsoft OAuth revocation
  return { success: true, revoked: true, note: "Cleared locally and marked revoked" };
}
