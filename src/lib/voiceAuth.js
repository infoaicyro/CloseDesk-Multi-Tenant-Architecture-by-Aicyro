// src/lib/voiceAuth.js
import { ref, get, set } from "firebase/database";
import { db } from "./firebase";
import { sanitizeFirebaseKey } from "./sanitizer";

const MAX_EVENT_AGE_MS = 5 * 60 * 1000; // 5 minutes freshness window

function resolveDbOps(dbInstance, dbOps) {
  return {
    get: async (dbPath) => {
      if (dbOps?.get) return await dbOps.get(dbPath);
      if (typeof dbInstance?.get === "function") {
        const res = await dbInstance.get(dbPath);
        return res && typeof res.val === "function" ? res.val() : res;
      }
      const dbRef = ref(dbInstance || db, dbPath);
      const snap = await get(dbRef);
      return snap && snap.exists() ? snap.val() : null;
    },
    set: async (dbPath, val) => {
      if (dbOps?.set) return await dbOps.set(dbPath, val);
      if (typeof dbInstance?.set === "function") return await dbInstance.set(dbPath, val);
      const dbRef = ref(dbInstance || db, dbPath);
      await set(dbRef, val);
    },
  };
}

/**
 * Validates authenticity, freshness, and replay protection for voice events.
 */
export async function validateVoiceEvent(req, tenantId = "default", dbInstance = db, dbOps = null) {
  const cleanTenant = tenantId ? String(tenantId).toLowerCase().trim() : "default";
  const ops = resolveDbOps(dbInstance, dbOps);

  // 1. Authenticity check: Header token or signature validation
  const voiceToken = req.headers["x-voice-token"] || (req.headers.authorization && req.headers.authorization.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : null);
  const expectedSecret = process.env.VOICE_WEBHOOK_SECRET;

  if (expectedSecret && voiceToken !== expectedSecret) {
    return {
      allowed: false,
      status: 401,
      error: "Unauthorized: Invalid voice event authentication token.",
    };
  }

  // 2. Timestamp Freshness Window
  const rawTimestamp = req.headers["x-voice-timestamp"] || req.body?.timestamp;
  if (rawTimestamp) {
    const eventTime = new Date(rawTimestamp).getTime();
    if (isNaN(eventTime)) {
      return {
        allowed: false,
        status: 400,
        error: "Malformed voice event timestamp.",
      };
    }

    const age = Math.abs(Date.now() - eventTime);
    if (age > MAX_EVENT_AGE_MS) {
      return {
        allowed: false,
        status: 400,
        error: `Stale voice event rejected: Event age (${Math.round(age / 1000)}s) exceeds max threshold (${MAX_EVENT_AGE_MS / 1000}s).`,
      };
    }
  }

  // 3. Replay Protection via Nonce / Event ID
  const nonce = req.headers["x-voice-nonce"] || req.body?.event_id || req.body?.nonce;
  if (nonce) {
    const cleanNonce = sanitizeFirebaseKey(String(nonce), "nonce");
    const noncePath = cleanTenant && cleanTenant !== "default"
      ? `tenants/${cleanTenant}/voice_nonces/${cleanNonce}`
      : `voice_nonces/${cleanNonce}`;
    
    const existingNonce = await ops.get(noncePath);

    if (existingNonce) {
      return {
        allowed: false,
        status: 409,
        error: `Replay attack detected: Voice event with nonce '${cleanNonce}' has already been processed.`,
      };
    }

    // Record seen nonce
    await ops.set(noncePath, {
      received_at: new Date().toISOString(),
      session_id: req.body?.session_id || "unknown",
    });
  }

  return { allowed: true };
}
