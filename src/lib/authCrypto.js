// src/lib/authCrypto.js
import crypto from "crypto";

const SCRYPT_PREFIX = "scrypt:";
const SALT_BYTES = 16;
const KEY_LEN = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

/**
 * Derives a salted scrypt hash for the given plaintext.
 * Returns formatted string: "scrypt:<saltHex>:<hashHex>"
 *
 * @param {string} plaintext
 * @returns {string}
 */
export function hashPassword(plaintext) {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("Password must be a non-empty string");
  }
  const salt = crypto.randomBytes(SALT_BYTES).toString("hex");
  const derivedKey = crypto.scryptSync(plaintext, salt, KEY_LEN, SCRYPT_OPTIONS);
  return `${SCRYPT_PREFIX}${salt}:${derivedKey.toString("hex")}`;
}

/**
 * Timing-safe string comparison to protect against timing attacks.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeStringEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");

  if (bufA.length !== bufB.length) {
    // Constant time dummy check to avoid length leak
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verifies a plaintext password against a stored password string.
 * Supports:
 *   1. Modern salted scrypt: "scrypt:<salt>:<hash>"
 *   2. Legacy plaintext strings (for backwards compatibility migration)
 *
 * @param {string} candidatePlaintext
 * @param {string} storedHashOrPlaintext
 * @returns {{ match: boolean, needsUpgrade: boolean }}
 */
export function verifyPassword(candidatePlaintext, storedHashOrPlaintext) {
  if (typeof candidatePlaintext !== "string" || typeof storedHashOrPlaintext !== "string") {
    return { match: false, needsUpgrade: false };
  }

  const cleanCandidate = candidatePlaintext.trim();
  const cleanStored = storedHashOrPlaintext.trim();

  if (cleanStored.startsWith(SCRYPT_PREFIX)) {
    const parts = cleanStored.slice(SCRYPT_PREFIX.length).split(":");
    if (parts.length !== 2) {
      return { match: false, needsUpgrade: false };
    }
    const [salt, expectedHashHex] = parts;
    const derivedKey = crypto.scryptSync(cleanCandidate, salt, KEY_LEN, SCRYPT_OPTIONS);
    const expectedKey = Buffer.from(expectedHashHex, "hex");

    if (derivedKey.length !== expectedKey.length) {
      crypto.timingSafeEqual(derivedKey, derivedKey);
      return { match: false, needsUpgrade: false };
    }

    const match = crypto.timingSafeEqual(derivedKey, expectedKey);
    return { match, needsUpgrade: false };
  }

  // Legacy plaintext backwards compatibility check
  const isMatch = timingSafeStringEqual(cleanCandidate, cleanStored);
  return {
    match: isMatch,
    needsUpgrade: isMatch, // If matched plaintext, flag for immediate auto-upgrade
  };
}
