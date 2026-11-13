// src/lib/sanitizer.js

/**
 * Sanitizes a string to be safely used as a Firebase Realtime Database path segment or key.
 * Strictly prevents path traversal attacks (e.g. "../../superAdmin") and strips invalid RTDB characters (. # $ [ ] / \).
 *
 * @param {string|any} key
 * @param {string} fallbackPrefix
 * @returns {string} Safe database key
 */
export function sanitizeFirebaseKey(key, fallbackPrefix = "id") {
  if (!key || typeof key !== "string") {
    return `${fallbackPrefix}_${Date.now()}`;
  }

  // Remove path traversal sequences, slashes, and characters prohibited in Firebase keys
  const safe = key.replace(/(\.\.|\/|\\|[.#$\[\]])/g, "").trim();

  // If sanitized key is empty, return generated fallback
  if (!safe || safe.length === 0) {
    return `${fallbackPrefix}_${Date.now()}`;
  }

  // Truncate to reasonable maximum length (128 chars) to avoid key bloat
  return safe.slice(0, 128);
}

/**
 * Sanitizes an object to ensure no keys contain path traversal characters.
 * Replaces undefined with null to prevent Firebase SDK set() / update() crashes.
 *
 * @param {object} obj
 * @returns {object} Safe plain object
 */
export function sanitizeFirebasePayload(obj) {
  if (!obj || typeof obj !== "object") return {};

  const clean = {};
  for (const [key, value] of Object.entries(obj)) {
    const safeKey = key.replace(/(\.\.|\/|\\|[.#$\[\]])/g, "").trim();
    if (!safeKey) continue;

    if (value === undefined) {
      clean[safeKey] = null;
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      clean[safeKey] = sanitizeFirebasePayload(value);
    } else {
      clean[safeKey] = value;
    }
  }
  return clean;
}

const SENSITIVE_KEY_REGEX = /^(password|pass|smtppass|smtppassword|clientsecret|refreshtoken|accesstoken|privatekey|pin|totpsecret|secret|apikey|canary_.*)$/i;

/**
 * Deeply redacts sensitive credentials, passwords, tokens, and canary secrets
 * from API responses, export payloads, and log objects to prevent secret leakage.
 *
 * @param {any} data - Target object, array, or primitive
 * @param {object} [options]
 * @param {string} [options.mask="[REDACTED]"] - Replacement string for masked values
 * @returns {any} Cleaned copy of data with sensitive fields masked
 */
export function redactSensitiveSecrets(data, options = {}) {
  const mask = options.mask || "[REDACTED]";
  if (data === null || data === undefined) return data;

  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveSecrets(item, options));
  }

  if (typeof data === "object") {
    const clean = {};
    for (const [key, val] of Object.entries(data)) {
      if (SENSITIVE_KEY_REGEX.test(key)) {
        clean[key] = mask;
      } else if (typeof val === "object" && val !== null) {
        clean[key] = redactSensitiveSecrets(val, options);
      } else {
        clean[key] = val;
      }
    }
    return clean;
  }

  return data;
}

/**
 * Escapes HTML characters in a string to prevent XSS injection.
 *
 * @param {string|any} str
 * @returns {string} Safe HTML string
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export const sanitizeHtml = escapeHtml;

/**
 * Strips carriage returns and newlines from strings destined for email headers
 * (Subject, To, From, etc.) to strictly prevent CRLF / header injection attacks.
 *
 * @param {string|any} str
 * @returns {string} Sanitized header string
 */
export function sanitizeEmailHeader(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/[\r\n]+/g, " ").trim();
}

export const stripCrlf = sanitizeEmailHeader;

/**
 * Sanitizes a cell value for CSV export to strictly prevent CSV Formula Injection
 * (CWE-1236 / DDE Injection). If a string starts with `=`, `+`, `-`, `@`, `\t`, or `\r`
 * (including with leading whitespace), it is prefixed with a single quote `'` and wrapped in quotes.
 * Inner double quotes are escaped as `""` per RFC 4180.
 *
 * @param {any} val
 * @returns {string} Safe CSV cell
 */
export function sanitizeCsvCell(val) {
  if (val === null || val === undefined) return '""';
  let str = String(val);

  // If the cell begins with formula or command execution triggers, prefix with single quote (')
  if (/^[\s]*[=+\-@\t\r]/.test(str)) {
    str = "'" + str;
  }

  // Escape inner double quotes per RFC 4180
  const escaped = str.replace(/"/g, '""');
  return `"${escaped}"`;
}

/**
 * Formats an array of cell values into an RFC 4180 compliant CSV row
 * with formula injection protection applied to every cell.
 *
 * @param {Array<any>} cells
 * @returns {string} CSV line
 */
export function formatCsvRow(cells) {
  if (!Array.isArray(cells)) return "";
  return cells.map(sanitizeCsvCell).join(",");
}

/**
 * Strips privileged authority claims and audit forgery fields from untrusted public telemetry payloads.
 * Server-stamps the record with authoritative anonymous visitor attributes.
 *
 * @param {object} payload - Untrusted client-supplied JSON
 * @returns {object} Cleaned telemetry payload
 */
export function sanitizeUntrustedTelemetry(payload) {
  if (!payload || typeof payload !== "object") return {};

  const FORBIDDEN_CLIENT_KEYS = new Set([
    "actor",
    "role",
    "isSuperAdmin",
    "issuperadmin",
    "auditOutcome",
    "auditoutcome",
    "outcome",
    "permissions",
    "claims",
    "authenticated",
    "verified",
    "userId",
    "userid",
  ]);

  const clean = {};
  for (const [key, value] of Object.entries(payload)) {
    if (FORBIDDEN_CLIENT_KEYS.has(key)) {
      continue; // Quarantine / strip client-supplied privilege claims
    }
    clean[key] = value;
  }

  // Authoritatively stamp from server perspective
  clean.actor = "anonymous_visitor";
  clean.role = "public";
  clean.source = "untrusted_client";
  clean.verified_by_server = false;

  return clean;
}

