// src/lib/tenantResolver.js
import { db } from "./firebase";
import { ref } from "firebase/database";
import { safeDbGet } from "./safeDb";
import { extractSession } from "./authSession";
import { redactSensitiveSecrets } from "./sanitizer";

/**
 * Strips dangerous characters to prevent Firebase Realtime Database path traversal.
 * Only allows lowercase alphanumeric characters, underscores, and hyphens.
 *
 * @param {string|any} id
 * @returns {string} Safe tenant identifier
 */
export function sanitizeTenantId(id) {
  if (!id || typeof id !== "string") return "default";
  return id.toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

/**
 * Public Routing Resolution: Resolves the tenant_id from incoming request headers,
 * query parameters, request body, or host domain for intentional public endpoints
 * (e.g. Chatbot widget, public token generation, cookie consent, widget config).
 *
 * NOTE: This is routing metadata ONLY and MUST NOT be used for operator authorization!
 *
 * @param {import('next').NextApiRequest} req
 * @returns {string} resolved tenant_id
 */
export function resolveTenantId(req) {
  if (!req) return "default";

  // 1. Direct header (e.g., set by widget SDK or API client)
  const headerTenant = req.headers ? req.headers["x-tenant-id"] : null;
  if (headerTenant && typeof headerTenant === "string" && headerTenant.trim()) {
    return sanitizeTenantId(headerTenant.trim());
  }

  // 2. Request body (for POST/PUT requests)
  if (req.body && typeof req.body === "object") {
    const bodyTenant = req.body.tenant_id || req.body.tenantId;
    if (bodyTenant && typeof bodyTenant === "string" && bodyTenant.trim()) {
      return sanitizeTenantId(bodyTenant.trim());
    }
  }

  // 3. Query string (e.g., /api/chat?tenant=brightstar_hvac)
  if (req.query) {
    const queryTenant = req.query.tenant || req.query.tenant_id;
    if (queryTenant && typeof queryTenant === "string" && queryTenant.trim()) {
      return sanitizeTenantId(queryTenant.trim());
    }
  }

  // 4. Host origin resolution (e.g., custom CNAME domain)
  const origin = req.headers ? (req.headers.origin || req.headers.referer) : null;
  if (origin) {
    try {
      const hostname = new URL(origin).hostname.toLowerCase();
      // Example: tenant1.closedesk.ai -> tenant1
      if (hostname.endsWith(".closedesk.ai") && hostname !== "app.closedesk.ai") {
        return sanitizeTenantId(hostname.replace(".closedesk.ai", ""));
      }
    } catch (_) {}
  }

  // Fallback to default tenant
  return "default";
}

/**
 * Authenticated Operator Resolution: Resolves and strictly authorizes tenant_id
 * for authenticated dashboard operations, data exports, logs, analytics, and leads.
 *
 * Guarantees:
 * - Unauthenticated callers are rejected with 401 Unauthorized.
 * - Tenant operators are strictly bound to their verified session.tenantId.
 * - Any cross-tenant spoofing attempt (e.g. Operator A passing x-tenant-id: tenant_b)
 *   is strictly rejected with 403 Forbidden.
 * - SuperAdmin sessions are permitted to access requested tenant or default.
 *
 * @param {import('next').NextApiRequest} req
 * @param {object} [options]
 * @returns {Promise<{ allowed: boolean, status?: number, error?: string, tenantId?: string, role?: string, session?: object }>}
 */
export async function resolveAuthenticatedTenantId(req, options = {}) {
  if (!req) {
    return {
      allowed: false,
      status: 401,
      error: "Authentication required. Request is missing.",
    };
  }

  // 1. Extract verified server session
  const session = req.session || (await extractSession(req));
  if (!session) {
    return {
      allowed: false,
      status: 401,
      error: "Authentication required. Active session missing or expired.",
    };
  }

  const role = session.role;
  const sessionTenant = sanitizeTenantId(session.tenantId || "default");

  // 2. Extract any client-supplied routing parameter
  let rawRequestedTenant = null;
  if (req.headers && req.headers["x-tenant-id"]) {
    rawRequestedTenant = req.headers["x-tenant-id"];
  } else if (req.query && (req.query.tenant || req.query.tenant_id)) {
    rawRequestedTenant = req.query.tenant || req.query.tenant_id;
  } else if (req.body && typeof req.body === "object" && (req.body.tenant_id || req.body.tenantId)) {
    rawRequestedTenant = req.body.tenant_id || req.body.tenantId;
  }

  const requestedTenant = rawRequestedTenant ? sanitizeTenantId(rawRequestedTenant) : null;

  // 3. Superadmin: authorized to access any tenant partition or default
  if (role === "superadmin") {
    return {
      allowed: true,
      tenantId: requestedTenant || "default",
      role: "superadmin",
      session,
    };
  }

  // 4. Tenant Operator: strictly bound to session tenant
  if (role === "tenant_operator") {
    if (requestedTenant && requestedTenant !== sessionTenant) {
      return {
        allowed: false,
        status: 403,
        error: `Cross-tenant access forbidden. Operator session is bound to tenant '${sessionTenant}', but requested tenant '${requestedTenant}'.`,
      };
    }

    return {
      allowed: true,
      tenantId: sessionTenant,
      role: "tenant_operator",
      session,
    };
  }

  // 5. Unknown or unhandled roles
  return {
    allowed: false,
    status: 403,
    error: "Access denied. Insufficient role permissions.",
  };
}

/**
 * Fetches the tenant configuration from Firebase RTDB.
 * Checks /tenants/{tenantId}/config first.
 * If not found or tenantId is "default", falls back to global settings.
 * All sensitive credentials and secrets are stripped before returning.
 *
 * @param {string} tenantId
 * @returns {Promise<{ tenantId: string, config: object, isMultiTenant: boolean }>}
 */
export async function getTenantConfig(tenantId = "default") {
  const safeId = sanitizeTenantId(tenantId);

  // If a specific tenant is requested, attempt to read their tenant partition
  if (safeId && safeId !== "default") {
    try {
      const [configSnap, appearSnap, botSnap, bizSnap, tenantRootSnap] = await Promise.all([
        safeDbGet(ref(db, `tenants/${safeId}/config`)).catch(() => null),
        safeDbGet(ref(db, `tenants/${safeId}/appearance`)).catch(() => null),
        safeDbGet(ref(db, `tenants/${safeId}/chatbot_config`)).catch(() => null),
        safeDbGet(ref(db, `tenants/${safeId}/business_profile`)).catch(() => null),
        safeDbGet(ref(db, `tenants/${safeId}/enabled`)).catch(() => null),
      ]);

      const exists = Boolean(
        (configSnap && configSnap.exists()) ||
        (appearSnap && appearSnap.exists()) ||
        (botSnap && botSnap.exists()) ||
        (bizSnap && bizSnap.exists()) ||
        (tenantRootSnap && tenantRootSnap.exists())
      );

      if (exists) {
        const configVal = configSnap && configSnap.exists() ? configSnap.val() : {};
        const appearVal = appearSnap && appearSnap.exists() ? appearSnap.val() : {};
        const botVal = botSnap && botSnap.exists() ? botSnap.val() : {};
        const bizVal = bizSnap && bizSnap.exists() ? bizSnap.val() : {};
        const isEnabled = tenantRootSnap && tenantRootSnap.exists()
          ? tenantRootSnap.val() === true
          : configVal.enabled !== false;

        return {
          tenantId: safeId,
          config: redactSensitiveSecrets(configVal),
          appearance: redactSensitiveSecrets(appearVal),
          chatbotConfig: redactSensitiveSecrets(botVal),
          businessProfile: redactSensitiveSecrets(bizVal),
          isMultiTenant: true,
          exists: true,
          enabled: isEnabled,
        };
      }

      // Explicit fail-close for non-existent tenant: NEVER fall back to default!
      return {
        tenantId: safeId,
        config: {},
        appearance: {},
        chatbotConfig: {},
        businessProfile: {},
        isMultiTenant: true,
        exists: false,
        enabled: false,
        error: `Tenant '${safeId}' does not exist or has been deleted.`,
      };
    } catch (err) {
      console.warn(`[TenantResolver] Failed to fetch tenant partition for ${safeId}:`, err.message);
      return {
        tenantId: safeId,
        config: {},
        appearance: {},
        chatbotConfig: {},
        businessProfile: {},
        isMultiTenant: true,
        exists: false,
        enabled: false,
        error: `Error resolving tenant partition '${safeId}': ${err.message}`,
      };
    }
  }

  // Fallback: Global / Single-tenant default configuration
  return {
    tenantId: "default",
    config: {},
    appearance: {},
    chatbotConfig: {},
    businessProfile: {},
    isMultiTenant: false,
    exists: true,
    enabled: true,
  };
}
