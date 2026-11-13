// src/lib/publicEndpointGuard.js
import crypto from "crypto";
import { db } from "./firebase.js";
import { ref, get, set, runTransaction } from "firebase/database";
import { safeDbGet, safeDbSet } from "./safeDb.js";
import { checkRateLimit } from "./persistentRateLimiter.js";

// ============================================================================
// IN-MEMORY SHARED STATE (Provides serverless persistence resilience + offline tests)
// ============================================================================
const inMemoryConcurrency = new Map(); // tenantId -> activeCount
const inMemoryBudgets = new Map();     // tenantId -> { windowStart, consumedTokens, reservedTokens, budgetLimit, inFlightAllowance }
const inMemoryLeadHashes = new Map();  // leadHash -> { timestamp, tenantId }
const inMemoryLeadCounters = new Map();// sessionOrIp -> { count, windowStart }

// Configurable defaults for tenant quotas
export const DEFAULT_TENANT_CONCURRENCY_LIMIT = 10;
export const DEFAULT_TENANT_TOKEN_BUDGET = 100000;
export const DEFAULT_EXPLICIT_IN_FLIGHT_ALLOWANCE = 2500; // Explicit bounded in-flight burst allowance
export const DEFAULT_BUDGET_WINDOW_MS = 60 * 60 * 1000;  // 1-hour rolling window

// Helper for resetting state in testing fixtures
export function _resetEndpointGuardState() {
  inMemoryConcurrency.clear();
  inMemoryBudgets.clear();
  inMemoryLeadHashes.clear();
  inMemoryLeadCounters.clear();
}

/**
 * Normalizes and extracts tenant identifier safely without path traversal.
 */
export function getSafeTenantId(rawTenant) {
  if (!rawTenant || typeof rawTenant !== "string") return "default";
  const clean = rawTenant.replace(/(\.\.|\/|\\|[.#$\[\]])/g, "").trim();
  return clean || "default";
}

// ============================================================================
// 1. HTTP METHOD & PAYLOAD SIZE VALIDATION
// ============================================================================

/**
 * Enforces strict HTTP method validation.
 *
 * @param {object} req - HTTP request
 * @param {object} res - HTTP response
 * @param {string[]} allowedMethods - e.g. ["POST"]
 * @returns {boolean} True if allowed; false if rejected with 405
 */
export function validateRequestMethod(req, res, allowedMethods = ["POST"]) {
  if (!allowedMethods.includes(req.method)) {
    res.setHeader("Allow", allowedMethods.join(", "));
    res.status(405).json({
      error: `Method ${req.method} not allowed. Supported methods: ${allowedMethods.join(", ")}`,
      code: "METHOD_NOT_ALLOWED",
    });
    return false;
  }
  return true;
}

/**
 * Validates request body size against strict byte-length ceilings.
 * Returns 413 Payload Too Large if limit exceeded, preventing RAM exhaustion / DoS.
 *
 * @param {object} req - HTTP request
 * @param {object} res - HTTP response
 * @param {number} maxBytes - Maximum permitted body bytes (e.g. 32768 for 32KB)
 * @returns {boolean} True if within size cap; false if rejected with 413
 */
export function validateRequestBodySize(req, res, maxBytes = 32768) {
  // 1. Check Content-Length header if present
  const headerLen = req.headers?.["content-length"];
  if (headerLen) {
    const parsedLen = parseInt(headerLen, 10);
    if (!isNaN(parsedLen) && parsedLen > maxBytes) {
      res.status(413).json({
        error: `Payload too large. Header length (${parsedLen} bytes) exceeds maximum of ${maxBytes} bytes.`,
        code: "PAYLOAD_TOO_LARGE",
        maxBytes,
      });
      return false;
    }
  }

  // 2. Measure serialized payload byte length
  if (req.body !== undefined && req.body !== null) {
    let actualBytes = 0;
    if (Buffer.isBuffer(req.body)) {
      actualBytes = req.body.length;
    } else if (typeof req.body === "string") {
      actualBytes = Buffer.byteLength(req.body, "utf8");
    } else if (typeof req.body === "object") {
      try {
        actualBytes = Buffer.byteLength(JSON.stringify(req.body), "utf8");
      } catch (_) {
        actualBytes = maxBytes + 1; // trigger rejection on unstringifiable circular structures
      }
    }

    if (actualBytes > maxBytes) {
      res.status(413).json({
        error: `Payload too large. Request body (${actualBytes} bytes) exceeds limit of ${maxBytes} bytes.`,
        code: "PAYLOAD_TOO_LARGE",
        maxBytes,
        actualBytes,
      });
      return false;
    }
  }

  return true;
}

/**
 * Validates JSON payload structure and field types without stack-trace leakage.
 *
 * @param {object} req - HTTP request
 * @param {object} res - HTTP response
 * @param {Function} [customValidator] - Optional callback returning { valid: boolean, error?: string }
 * @returns {boolean} True if valid; false if rejected with 400
 */
export function validateJsonStructure(req, res, customValidator = null) {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    res.status(400).json({
      error: "Invalid request payload format. Request body must be a valid JSON object.",
      code: "INVALID_PAYLOAD",
    });
    return false;
  }

  if (typeof customValidator === "function") {
    const result = customValidator(body);
    if (result && !result.valid) {
      res.status(400).json({
        error: result.error || "Malformed or invalid payload fields.",
        code: "INVALID_PAYLOAD",
      });
      return false;
    }
  }

  return true;
}

// ============================================================================
// 2. ACTIVE IN-FLIGHT CONCURRENCY MANAGEMENT
// ============================================================================

/**
 * Acquires an in-flight concurrency slot for a tenant.
 * Rejects with 429 when concurrency ceiling is reached.
 *
 * @param {string} rawTenantId
 * @param {number} [maxConcurrency=10]
 * @returns {{ allowed: boolean, activeCount: number, release: Function }}
 */
export function acquireConcurrencySlot(rawTenantId, maxConcurrency = DEFAULT_TENANT_CONCURRENCY_LIMIT) {
  const tenantId = getSafeTenantId(rawTenantId);
  const current = inMemoryConcurrency.get(tenantId) || 0;

  if (current >= maxConcurrency) {
    return {
      allowed: false,
      activeCount: current,
      tenantId,
      error: `Concurrency limit exceeded for tenant '${tenantId}' (${current}/${maxConcurrency} active).`,
      release: () => {},
    };
  }

  const nextCount = current + 1;
  inMemoryConcurrency.set(tenantId, nextCount);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const c = inMemoryConcurrency.get(tenantId) || 1;
    const updated = Math.max(0, c - 1);
    if (updated === 0) {
      inMemoryConcurrency.delete(tenantId);
    } else {
      inMemoryConcurrency.set(tenantId, updated);
    }
  };

  return {
    allowed: true,
    activeCount: nextCount,
    tenantId,
    release,
  };
}

// ============================================================================
// 3. PERSISTENT TENANT BUDGET QUOTA & RESERVATION PATTERN
// ============================================================================

/**
 * Sets or updates the budget configuration for a tenant (used in setup or test fixtures).
 *
 * @param {string} rawTenantId
 * @param {object} config - { budgetLimit, inFlightAllowance, windowMs }
 */
export function configureTenantBudget(rawTenantId, config = {}) {
  const tenantId = getSafeTenantId(rawTenantId);
  const existing = inMemoryBudgets.get(tenantId) || {
    windowStart: Date.now(),
    consumedTokens: 0,
    reservedTokens: 0,
    budgetLimit: DEFAULT_TENANT_TOKEN_BUDGET,
    inFlightAllowance: DEFAULT_EXPLICIT_IN_FLIGHT_ALLOWANCE,
    windowMs: DEFAULT_BUDGET_WINDOW_MS,
  };

  inMemoryBudgets.set(tenantId, {
    ...existing,
    budgetLimit: config.budgetLimit !== undefined ? config.budgetLimit : existing.budgetLimit,
    inFlightAllowance: config.inFlightAllowance !== undefined ? config.inFlightAllowance : existing.inFlightAllowance,
    windowMs: config.windowMs !== undefined ? config.windowMs : existing.windowMs,
    ...(config.consumedTokens !== undefined ? { consumedTokens: config.consumedTokens } : {}),
    ...(config.reservedTokens !== undefined ? { reservedTokens: config.reservedTokens } : {}),
  });
}

/**
 * Checks and atomically reserves estimated tokens against the tenant's budget.
 * Enforces bounded in-flight burst allowance: total (consumed + reserved) cannot exceed
 * (budgetLimit + inFlightAllowance).
 *
 * @param {string} rawTenantId
 * @param {number} [estimatedTokens=500]
 * @returns {{ allowed: boolean, consumedTokens: number, reservedTokens: number, commit: Function }}
 */
export function checkAndReserveBudget(rawTenantId, estimatedTokens = 500) {
  const tenantId = getSafeTenantId(rawTenantId);
  const now = Date.now();

  let state = inMemoryBudgets.get(tenantId);
  if (!state) {
    state = {
      windowStart: now,
      consumedTokens: 0,
      reservedTokens: 0,
      budgetLimit: DEFAULT_TENANT_TOKEN_BUDGET,
      inFlightAllowance: DEFAULT_EXPLICIT_IN_FLIGHT_ALLOWANCE,
      windowMs: DEFAULT_BUDGET_WINDOW_MS,
    };
    inMemoryBudgets.set(tenantId, state);
  }

  // Check rolling window expiration
  if (now - state.windowStart > state.windowMs) {
    state.windowStart = now;
    state.consumedTokens = 0;
    state.reservedTokens = 0;
  }

  const effectiveTotal = state.consumedTokens + state.reservedTokens;
  const maxAllowable = state.budgetLimit + state.inFlightAllowance;

  // Strict Bounded In-Flight Ceiling check
  if (effectiveTotal + estimatedTokens > maxAllowable) {
    return {
      allowed: false,
      tenantId,
      consumedTokens: state.consumedTokens,
      reservedTokens: state.reservedTokens,
      budgetLimit: state.budgetLimit,
      inFlightAllowance: state.inFlightAllowance,
      error: `Tenant '${tenantId}' has exhausted its AI budget for the current window (${effectiveTotal}/${state.budgetLimit} tokens).`,
      code: "BUDGET_EXCEEDED",
      commit: () => {},
    };
  }

  // Atomically increment reserved in-flight tokens
  state.reservedTokens += estimatedTokens;

  let committed = false;
  const commit = (actualTokens = null) => {
    if (committed) return;
    committed = true;
    state.reservedTokens = Math.max(0, state.reservedTokens - estimatedTokens);
    if (typeof actualTokens === "number" && actualTokens > 0) {
      state.consumedTokens += actualTokens;
    } else {
      // Conservative estimate when actual usage is "unknown"
      state.consumedTokens += estimatedTokens;
    }
  };

  return {
    allowed: true,
    tenantId,
    consumedTokens: state.consumedTokens,
    reservedTokens: state.reservedTokens,
    budgetLimit: state.budgetLimit,
    inFlightAllowance: state.inFlightAllowance,
    commit,
  };
}

// ============================================================================
// 4. ANTI-SPAM LEAD IDEMPOTENCY & REPLAY DEFENSE
// ============================================================================

/**
 * Computes a deterministic identity hash for lead submission deduplication.
 */
export function computeLeadContentHash(payload, tenantId) {
  const parts = [
    getSafeTenantId(tenantId),
    String(payload.name || "").trim().toLowerCase(),
    String(payload.email || "").trim().toLowerCase(),
    String(payload.phone || "").trim(),
    String(payload.service_requested || payload.service || "").trim().toLowerCase(),
  ];
  return crypto.createHash("sha256").update(parts.join(":")).digest("hex");
}

/**
 * Checks whether a lead submission is an identical replay within the deduplication window,
 * and enforces per-session/IP submission caps.
 *
 * @param {object} payload - Lead submission body
 * @param {string} tenantId - Resolved tenant partition
 * @param {string} sessionOrIp - Session ID or client IP
 * @param {number} [windowMs=60000] - Deduplication window in ms (default 60s)
 * @returns {{ allowed: boolean, isDuplicate: boolean, isRateLimited: boolean, leadHash: string, reason?: string }}
 */
export function checkLeadSubmissionIdempotency(payload, tenantId, sessionOrIp = "default", windowMs = 60000) {
  const now = Date.now();
  const leadHash = computeLeadContentHash(payload, tenantId);

  // 1. Content Hash Idempotency Check
  const existingHash = inMemoryLeadHashes.get(leadHash);
  if (existingHash && now - existingHash.timestamp < windowMs) {
    return {
      allowed: false,
      isDuplicate: true,
      isRateLimited: false,
      leadHash,
      reason: "Exact duplicate lead submission received within deduplication window.",
    };
  }

  // 2. Per-Session/IP Submission Rate Cap (Max 5 leads per 10 minutes)
  const counterKey = String(sessionOrIp || "unknown");
  let counter = inMemoryLeadCounters.get(counterKey);
  const COUNTER_WINDOW_MS = 10 * 60 * 1000;
  const MAX_LEADS_PER_WINDOW = 5;

  if (!counter || now - counter.windowStart > COUNTER_WINDOW_MS) {
    counter = { count: 1, windowStart: now };
    inMemoryLeadCounters.set(counterKey, counter);
  } else {
    counter.count++;
    if (counter.count > MAX_LEADS_PER_WINDOW) {
      return {
        allowed: false,
        isDuplicate: false,
        isRateLimited: true,
        leadHash,
        reason: "Lead submission rate limit exceeded for this session. Please wait before submitting another lead.",
      };
    }
  }

  // Record valid submission hash
  inMemoryLeadHashes.set(leadHash, { timestamp: now, tenantId });

  return {
    allowed: true,
    isDuplicate: false,
    isRateLimited: false,
    leadHash,
  };
}

// ============================================================================
// 5. UNIFIED PUBLIC ENDPOINT GUARD HELPER
// ============================================================================

/**
 * Full-spectrum guard wrapper for public endpoints.
 * Enforces method checks, request body size limits, client IP rate limits,
 * active in-flight concurrency caps, and tenant token budget reservations.
 *
 * @param {object} req - HTTP request
 * @param {object} res - HTTP response
 * @param {object} options
 * @param {string[]} [options.allowedMethods=["POST"]]
 * @param {number} [options.maxBodyBytes=32768]
 * @param {number} [options.estimatedTokens=500]
 * @param {number} [options.maxConcurrency=10]
 * @param {Function} [options.customValidator]
 * @returns {Promise<{ allowed: boolean, cleanup: Function, tenantId: string }>}
 */
export async function guardPublicEndpoint(req, res, options = {}) {
  const {
    allowedMethods = ["POST"],
    maxBodyBytes = 32768,
    estimatedTokens = 500,
    maxConcurrency = DEFAULT_TENANT_CONCURRENCY_LIMIT,
    customValidator = null,
  } = options;

  // 1. Strict Method Check
  if (!validateRequestMethod(req, res, allowedMethods)) {
    return { allowed: false, cleanup: () => {}, tenantId: "unknown" };
  }

  // 2. Request Body Size Limit Check (Returns 413)
  if (!validateRequestBodySize(req, res, maxBodyBytes)) {
    return { allowed: false, cleanup: () => {}, tenantId: "unknown" };
  }

  // 3. JSON Structure & Field Type Validation (Returns 400)
  if (!validateJsonStructure(req, res, customValidator)) {
    return { allowed: false, cleanup: () => {}, tenantId: "unknown" };
  }

  // 4. Resolve Tenant
  const rawTenant = req.headers?.["x-tenant-id"] || req.query?.tenant_id || req.body?.tenant_id || "default";
  const tenantId = getSafeTenantId(rawTenant);

  // 5. Per-Session / Client IP Rate Limiting Check
  const clientIp = (req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "unknown_ip")
    .split(",")[0]
    .trim();
  const sessionId = req.body?.session_id || req.headers?.["x-session-id"] || clientIp;
  const rateKey = `pub_route_${tenantId}_${sessionId}`;

  const rateCheck = await checkRateLimit(rateKey, { maxAttempts: 30, windowMs: 60000, lockoutMs: 60000 });
  if (!rateCheck.allowed) {
    res.setHeader("Retry-After", String(rateCheck.retryAfter || 60));
    res.status(429).json({
      error: "Rate limit exceeded. Too many requests. Please wait a moment.",
      code: "RATE_LIMIT_EXCEEDED",
      retryAfter: rateCheck.retryAfter || 60,
    });
    return { allowed: false, cleanup: () => {}, tenantId };
  }

  // 6. Concurrency Check (Returns 429)
  const concurrency = acquireConcurrencySlot(tenantId, maxConcurrency);
  if (!concurrency.allowed) {
    res.status(429).json({
      error: concurrency.error,
      code: "CONCURRENCY_LIMIT_EXCEEDED",
      tenantId,
    });
    return { allowed: false, cleanup: () => {}, tenantId };
  }

  // 7. Budget Quota Reservation Check (Returns 429)
  const budget = checkAndReserveBudget(tenantId, estimatedTokens);
  if (!budget.allowed) {
    concurrency.release();
    res.status(429).json({
      error: budget.error,
      code: budget.code,
      tenantId,
    });
    return { allowed: false, cleanup: () => {}, tenantId };
  }

  // Cleanup handler that commits budget and releases concurrency slot
  let cleanedUp = false;
  const cleanup = (actualTokens = null) => {
    if (cleanedUp) return;
    cleanedUp = true;
    budget.commit(actualTokens);
    concurrency.release();
  };

  // Intercept response finish/close to guarantee release
  res.on?.("finish", () => cleanup());
  res.on?.("close", () => cleanup());

  return {
    allowed: true,
    cleanup,
    tenantId,
  };
}
