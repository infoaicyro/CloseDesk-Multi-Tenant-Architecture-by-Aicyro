// src/lib/persistentRateLimiter.js
import { ref, get, set, remove } from "firebase/database";
import { db } from "./firebase.js";

// In-memory fallback map to maintain resilience if Firebase is unreachable or in tests
const inMemoryFallback = new Map();

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

async function safeDbRemove(dbRef, timeoutMs = 600) {
  return Promise.race([
    remove(dbRef),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Firebase remove timeout")), timeoutMs)
    ),
  ]);
}

function sanitizeKey(key) {
  return String(key || "default")
    .replace(/[.#$[\]/:]/g, "_")
    .slice(0, 128);
}

/**
 * Extracts a normalized client IP identifier from request headers or socket.
 *
 * @param {object} req
 * @returns {string}
 */
export function getClientIp(req) {
  if (!req) return "unknown_ip";
  const forwarded = req.headers?.["x-forwarded-for"];
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown_ip";
}

/**
 * Checks whether an action for a given key is currently rate-limited.
 *
 * @param {string} rawKey
 * @param {object} options
 * @param {number} [options.maxAttempts=5]
 * @param {number} [options.lockoutMs=15*60*1000]
 * @param {number} [options.windowMs=15*60*1000]
 * @returns {Promise<{ allowed: boolean, remainingAttempts: number, retryAfter: number }>}
 */
export async function checkRateLimit(rawKey, options = {}) {
  const { maxAttempts = 5, lockoutMs = 15 * 60 * 1000, windowMs = 15 * 60 * 1000 } = options;
  const key = sanitizeKey(rawKey);
  const now = Date.now();

  let record = null;
  try {
    const rateRef = ref(db, `system_security/rate_limits/${key}`);
    const snapshot = await safeDbGet(rateRef, 600);
    if (snapshot.exists()) {
      record = snapshot.val();
    }
  } catch (err) {
    // Graceful fallback to memory
    record = inMemoryFallback.get(key) || null;
  }

  if (!record) {
    record = inMemoryFallback.get(key) || null;
  }

  if (!record) {
    return { allowed: true, remainingAttempts: maxAttempts, retryAfter: 0 };
  }

  // Check if currently locked out
  if (record.lockedUntil && now < record.lockedUntil) {
    const remainingSeconds = Math.ceil((record.lockedUntil - now) / 1000);
    return {
      allowed: false,
      remainingAttempts: 0,
      retryAfter: remainingSeconds,
    };
  }

  // Check if window has expired
  if (record.firstAttemptAt && now - record.firstAttemptAt > windowMs) {
    return { allowed: true, remainingAttempts: maxAttempts, retryAfter: 0 };
  }

  const remaining = Math.max(0, maxAttempts - (record.count || 0));
  return {
    allowed: remaining > 0,
    remainingAttempts: remaining,
    retryAfter: remaining === 0 ? Math.ceil(lockoutMs / 1000) : 0,
  };
}

/**
 * Records a failed attempt for a given key and triggers lockout if max attempts exceeded.
 *
 * @param {string} rawKey
 * @param {object} options
 * @param {number} [options.maxAttempts=5]
 * @param {number} [options.lockoutMs=15*60*1000]
 * @param {number} [options.windowMs=15*60*1000]
 * @returns {Promise<{ allowed: boolean, count: number, locked: boolean, retryAfter: number }>}
 */
export async function recordFailedAttempt(rawKey, options = {}) {
  const { maxAttempts = 5, lockoutMs = 15 * 60 * 1000, windowMs = 15 * 60 * 1000 } = options;
  const key = sanitizeKey(rawKey);
  const now = Date.now();

  let record = null;
  try {
    const rateRef = ref(db, `system_security/rate_limits/${key}`);
    const snapshot = await safeDbGet(rateRef, 600);
    if (snapshot.exists()) {
      record = snapshot.val();
    }
  } catch (err) {
    record = inMemoryFallback.get(key) || null;
  }

  if (!record) {
    record = inMemoryFallback.get(key) || null;
  }

  let count = 1;
  let firstAttemptAt = now;

  if (record) {
    // If window expired, reset count
    if (record.firstAttemptAt && now - record.firstAttemptAt > windowMs) {
      count = 1;
      firstAttemptAt = now;
    } else {
      count = (record.count || 0) + 1;
      firstAttemptAt = record.firstAttemptAt || now;
    }
  }

  const isLocked = count >= maxAttempts;
  const lockedUntil = isLocked ? now + lockoutMs : 0;
  const retryAfter = isLocked ? Math.ceil(lockoutMs / 1000) : 0;

  const updatedRecord = {
    count,
    firstAttemptAt,
    lastAttemptAt: now,
    lockedUntil,
  };

  // Update in-memory fallback
  inMemoryFallback.set(key, updatedRecord);

  // Persist to Firebase
  try {
    const rateRef = ref(db, `system_security/rate_limits/${key}`);
    await safeDbSet(rateRef, updatedRecord, 600);
  } catch (err) {
    // In-memory fallback is already recorded
  }

  return {
    allowed: !isLocked,
    count,
    locked: isLocked,
    retryAfter,
  };
}

/**
 * Resets rate limit records for a given key after successful authentication.
 *
 * @param {string} rawKey
 * @returns {Promise<void>}
 */
export async function resetRateLimit(rawKey) {
  const key = sanitizeKey(rawKey);
  inMemoryFallback.delete(key);

  try {
    const rateRef = ref(db, `system_security/rate_limits/${key}`);
    await safeDbRemove(rateRef, 600);
  } catch (err) {
    // Ignored in fallback mode
  }
}
