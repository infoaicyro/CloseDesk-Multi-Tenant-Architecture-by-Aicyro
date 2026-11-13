// src/lib/oauthState.js
import crypto from "crypto";
import { signSessionToken, verifySessionToken } from "./authSession.js";

// In-memory cache for consumed state nonces to prevent replay attacks
export const consumedStateJtis = new Map();

// Regularly purge expired nonces
if (typeof setInterval !== "undefined") {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [jti, expTime] of consumedStateJtis.entries()) {
      if (now > expTime) {
        consumedStateJtis.delete(jti);
      }
    }
  }, 5 * 60 * 1000);
  if (timer.unref) timer.unref();
}

/**
 * Generates an HMAC-signed OAuth state token embedding:
 * - sub (user ID / username)
 * - role (strictly superadmin)
 * - purpose ("email_oauth_connect")
 * - jti (cryptographic random nonce for replay defense)
 * - exp (10-minute expiry)
 *
 * @param {object} options
 * @param {string} options.sub
 * @param {string} [options.role="superadmin"]
 * @param {string} [options.purpose="email_oauth_connect"]
 * @param {number} [options.expiresIn=600]
 * @returns {string} Signed compact token
 */
export function generateOAuthState({ sub, role = "superadmin", purpose = "email_oauth_connect", expiresIn = 600 }) {
  if (!sub) {
    throw new Error("Cannot generate OAuth state without user sub");
  }

  const jti = crypto.randomUUID();
  return signSessionToken({
    sub,
    role,
    purpose,
    jti,
    expiresIn,
  });
}

/**
 * Validates the OAuth state token:
 * 1. Cryptographic HMAC signature check
 * 2. Expiration check
 * 3. Purpose validation ("email_oauth_connect")
 * 4. Role validation ("superadmin")
 * 5. User binding (if caller session sub is provided, must match)
 * 6. Single-use replay protection (jti nonce must not have been previously consumed)
 *
 * @param {string} stateToken
 * @param {object} [options]
 * @param {string} [options.expectedPurpose="email_oauth_connect"]
 * @param {string} [options.expectedSub=null]
 * @returns {{ valid: boolean, payload?: object, error?: string }}
 */
export function validateOAuthState(stateToken, options = {}) {
  const { expectedPurpose = "email_oauth_connect", expectedSub = null } = options;

  if (!stateToken || typeof stateToken !== "string") {
    return { valid: false, error: "Missing or invalid OAuth state parameter" };
  }

  const verified = verifySessionToken(stateToken);
  if (!verified.valid || !verified.payload) {
    return { valid: false, error: verified.reason || "Invalid or expired state token signature" };
  }

  const payload = verified.payload;

  // Purpose validation
  if (payload.purpose !== expectedPurpose) {
    return { valid: false, error: `Invalid state purpose. Expected '${expectedPurpose}', got '${payload.purpose}'.` };
  }

  // Role validation
  if (payload.role !== "superadmin") {
    return { valid: false, error: "Unauthorized state role. SuperAdmin role required." };
  }

  // User binding validation
  if (expectedSub && payload.sub !== expectedSub) {
    return { valid: false, error: `OAuth state user binding mismatch. Issued for '${payload.sub}', but callback received for '${expectedSub}'.` };
  }

  // Replay protection via jti nonce
  const jti = payload.jti;
  if (!jti) {
    return { valid: false, error: "OAuth state is missing cryptographic nonce (jti). Potential replay attack." };
  }

  if (consumedStateJtis.has(jti)) {
    return { valid: false, error: "OAuth state token has already been consumed. Replay attack blocked." };
  }

  // Mark jti as consumed until token expiration + 60s grace buffer
  const expMs = (payload.exp ? payload.exp * 1000 : Date.now() + 600000) + 60000;
  consumedStateJtis.set(jti, expMs);

  return { valid: true, payload };
}
