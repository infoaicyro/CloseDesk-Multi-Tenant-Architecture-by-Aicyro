// src/lib/totp.js
import crypto from "crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Decodes a RFC 4648 Base32 string into a Buffer.
 *
 * @param {string} base32Str
 * @returns {Buffer}
 */
export function base32Decode(base32Str) {
  if (typeof base32Str !== "string") {
    throw new Error("Base32 input must be a string");
  }
  const clean = base32Str.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx === -1) {
      throw new Error(`Invalid Base32 character: ${clean[i]}`);
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/**
 * Encodes a Buffer into a RFC 4648 Base32 string (without padding).
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * Generates an RFC 6238 TOTP code for a given secret and timestamp.
 *
 * @param {string|Buffer} secret - Base32 string or raw Buffer
 * @param {number} [timestampMs=Date.now()]
 * @param {number} [timeStepSeconds=30]
 * @param {number} [digits=6]
 * @returns {string}
 */
export function generateTotp(secret, timestampMs = Date.now(), timeStepSeconds = 30, digits = 6) {
  const key = typeof secret === "string" ? base32Decode(secret) : secret;
  const counter = Math.floor(timestampMs / 1000 / timeStepSeconds);

  const counterBuf = Buffer.alloc(8);
  // Big-endian 64-bit integer
  counterBuf.writeUInt32BE(0, 0);
  counterBuf.writeUInt32BE(counter, 4);

  const hmac = crypto.createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const codeInt =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = codeInt % Math.pow(10, digits);
  return otp.toString().padStart(digits, "0");
}

/**
 * Validates a user-supplied TOTP code allowing ±1 window drift.
 *
 * @param {string} token - 6-digit candidate code
 * @param {string|Buffer} secret - Base32 string or raw Buffer
 * @param {number} [windowSteps=1] - timesteps allowed before/after (default: 1 step = ±30s)
 * @param {number} [timestampMs=Date.now()]
 * @returns {boolean}
 */
export function verifyTotp(token, secret, windowSteps = 1, timestampMs = Date.now()) {
  if (!token || typeof token !== "string") {
    return false;
  }
  const cleanToken = token.trim();
  if (!/^\d{6}$/.test(cleanToken)) {
    return false;
  }

  const timeStepSeconds = 30;
  const baseTime = timestampMs;

  for (let offset = -windowSteps; offset <= windowSteps; offset++) {
    const candidateTime = baseTime + offset * timeStepSeconds * 1000;
    const generated = generateTotp(secret, candidateTime, timeStepSeconds, 6);
    if (crypto.timingSafeEqual(Buffer.from(cleanToken), Buffer.from(generated))) {
      return true;
    }
  }

  return false;
}

/**
 * Generates a random Base32 secret (20 bytes / 160 bits).
 *
 * @returns {string}
 */
export function generateRandomSecret() {
  const bytes = crypto.randomBytes(20);
  return base32Encode(bytes);
}

/**
 * Generates an otpauth:// URI for authenticator apps (Google Authenticator, etc.)
 *
 * @param {string} account - Account name (e.g. superadmin)
 * @param {string} issuer - Platform name (e.g. CloseDesk)
 * @param {string} secret - Base32 secret
 * @returns {string}
 */
export function generateOtpAuthUri(account, issuer, secret) {
  const encodedAccount = encodeURIComponent(account);
  const encodedIssuer = encodeURIComponent(issuer);
  return `otpauth://totp/${encodedIssuer}:${encodedAccount}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;
}

/**
 * Hashes an emergency recovery code (e.g. "A1B2-C3D4") using SHA-256 for storage.
 *
 * @param {string} rawCode
 * @returns {string}
 */
export function hashRecoveryCode(rawCode) {
  const clean = rawCode.replace(/[\s-]/g, "").toUpperCase();
  return crypto.createHash("sha256").update(clean).digest("hex");
}

/**
 * Verifies candidate recovery code against a list of hashed recovery codes.
 * Returns the matching hash index if matched, or -1 if not matched.
 *
 * @param {string} candidateCode
 * @param {string[]} hashedCodesList
 * @returns {number}
 */
export function verifyRecoveryCode(candidateCode, hashedCodesList) {
  if (!candidateCode || !Array.isArray(hashedCodesList)) {
    return -1;
  }
  const clean = candidateCode.replace(/[\s-]/g, "").toUpperCase();
  if (clean.length < 8) {
    return -1;
  }

  const candidateHash = crypto.createHash("sha256").update(clean).digest("hex");
  const candidateBuf = Buffer.from(candidateHash, "hex");

  for (let i = 0; i < hashedCodesList.length; i++) {
    const storedHash = hashedCodesList[i];
    if (typeof storedHash === "string" && storedHash.length === 64) {
      const storedBuf = Buffer.from(storedHash, "hex");
      if (crypto.timingSafeEqual(candidateBuf, storedBuf)) {
        return i;
      }
    }
  }

  return -1;
}
