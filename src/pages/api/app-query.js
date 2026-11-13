// src/pages/api/app-query.js
import { db } from "../../lib/firebase";
import { ref, get } from "firebase/database";
import { withApiLogger } from "../../lib/apiMiddleware";
import { extractSession } from "../../lib/authSession";
import { redactSensitiveSecrets } from "../../lib/sanitizer";
import { safeDbGet } from "../../lib/safeDb";

// The handler now receives (req, res, apiLogger) securely from the wrapper
async function handler(req, res, apiLogger) {
  // Method validation
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 🚨 SECURITY GATE 1: Authenticated Session Verification
  const session = req.session || (await extractSession(req));
  if (!session) {
    apiLogger.warn("security_audit", "unauthenticated_log_query_blocked", {
      context: {
        message: "Unauthenticated request attempted to hit the logs query API.",
      },
    });
    return res
      .status(401)
      .json({ error: "Unauthorized. Authentication required." });
  }

  let { role, userId, targetClientId, searchTerm } = req.body || {};

  // Map authenticated session to effective identity and role
  let effectiveRole = "CLIENT";
  let effectiveUserId = session.sub;

  if (session.role === "superadmin") {
    effectiveRole = role && ["SUPERADMIN", "DEVELOPER", "QA", "SUPPORT", "CLIENT"].includes(String(role).toUpperCase())
      ? String(role).toUpperCase()
      : "SUPERADMIN";
  } else if (session.role === "tenant_operator") {
    effectiveRole = "CLIENT";
    const sessionTenant = session.tenantId || "default";

    // 🚨 SECURITY GATE 2: Tenant Isolation Cross-Query Prevention
    if (targetClientId && targetClientId !== sessionTenant) {
      apiLogger.critical("security_audit", "cross_tenant_access_blocked", {
        context: {
          user_id: session.sub,
          message: `Operator bound to ${sessionTenant} attempted to view logs for tenant ${targetClientId}`,
        },
      });
      return res.status(403).json({
        error: `Cross-tenant access forbidden. Operator session is bound to tenant '${sessionTenant}', cannot query logs for '${targetClientId}'.`,
      });
    }

    targetClientId = sessionTenant;
  } else {
    return res.status(403).json({ error: "Unauthorized or invalid role" });
  }

  role = effectiveRole;
  userId = effectiveUserId;

  // 1. Fetch raw logs securely on the server
  let rawLogs = [];
  try {
    const logsRef = ref(db, "system_logs/structured_events");
    const snapshot = await safeDbGet(logsRef, 600);
    rawLogs = snapshot && snapshot.exists() ? Object.values(snapshot.val()) : [];
  } catch (e) {
    // offline fallback
  }

  try {
    const legacyRef = ref(db, "system_logs/activity_events");
    const legacySnap = await safeDbGet(legacyRef, 600);
    if (legacySnap && legacySnap.exists()) {
      const data = legacySnap.val();
      Object.keys(data).forEach((key) => {
        const node = data[key];
        if (node.log_id || node.timestamp) {
          rawLogs.push({ id: key, ...node });
        } else {
          Object.keys(node).forEach((eventId) =>
            rawLogs.push({ id: eventId, session_id: key, ...node[eventId] }),
          );
        }
      });
    }
  } catch (e) {
    // offline fallback
  }

  // 🔥 NEW: Capture the absolute total number of logs in the database before slicing
  const totalDatabaseLogs = rawLogs.length;

  // Sort newest first & limit to 1500 to keep the network payload fast
  rawLogs.sort(
    (a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0),
  );
  rawLogs = rawLogs.slice(0, 1500);

  let filteredLogs = [];

  // 2. Enforce Role-Based Access Control (RBAC) Filtering
  for (const log of rawLogs) {
    const svc = log.service || "Website";
    const lvl = log.level || (log.type === "click" ? "INFO" : "INFO");
    const logOwnerId =
      log.tenant_id || log.client_id || log.user_id || log.user || "unknown";

    if (role === "SUPERADMIN") {
      filteredLogs.push(log);
    } else if (role === "DEVELOPER") {
      if (svc !== "Pulse") filteredLogs.push(log);
    } else if (role === "QA") {
      if (["Website", "API", "AI", "Integrations"].includes(svc))
        filteredLogs.push(log);
    } else if (role === "SUPPORT") {
      if (lvl !== "DEBUG" && lvl !== "CRITICAL") filteredLogs.push(log);
    } else if (role === "CLIENT") {
      // 🚨 SECURITY GATE 3: Tenant Isolation Check
      if (logOwnerId !== "unknown" && logOwnerId !== targetClientId) {
        if (
          targetClientId &&
          searchTerm &&
          JSON.stringify(log).includes(searchTerm)
        ) {
          apiLogger.critical("security_audit", "cross_tenant_access_blocked", {
            context: {
              user_id: userId,
              message: `Client ${targetClientId} attempted to view logs for tenant ${logOwnerId}`,
            },
          });
        }
        continue;
      }

      if (lvl === "INFO" || lvl === "WARN") {
        // 🚨 SECURITY GATE 4: Sanitize and remove internal metadata
        const safeLog = { ...log };
        delete safeLog.metadata;
        delete safeLog.prompt_version;
        delete safeLog.ai_model;
        delete safeLog.stack;
        delete safeLog.error_code;
        filteredLogs.push(safeLog);
      }
    }
  }

  // 🚨 SECURITY GATE 5: Redact all sensitive credentials from returned logs
  filteredLogs = redactSensitiveSecrets(filteredLogs);

  // 🔥 Return the array of logs AND the total count.
  // The middleware automatically calculates the latency and logs a `request_completed` event with status 200!
  return res.status(200).json({
    logs: filteredLogs,
    totalLogs: totalDatabaseLogs,
  });
}

// Wrap the export with the middleware and give it a Component name
export default withApiLogger(handler, "LogQueryAPI");
