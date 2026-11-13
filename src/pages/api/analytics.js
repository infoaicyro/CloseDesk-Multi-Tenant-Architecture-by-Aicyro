// src/pages/api/analytics.js
import { ref, runTransaction, push, update, set, get } from "firebase/database";
import { withApiLogger } from "../../lib/apiMiddleware";
import { db } from "../../lib/firebase";
import { resolveTenantId, resolveAuthenticatedTenantId } from "../../lib/tenantResolver";
import { safeDbGet } from "../../lib/safeDb";
import { sanitizeUntrustedTelemetry } from "../../lib/sanitizer";
import { validateRequestBodySize } from "../../lib/publicEndpointGuard";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '16kb',
    },
  },
};

async function handler(req, res, apiLogger) {
  // CORS Headers for cross-domain SDK embed requests
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-tenant-id, x-correlation-id, x-session-id");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // GET: Fetch analytics summary (Scoped by tenant or platform)
  // ──────────────────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    // 🚨 SECURITY: Operator session verification & cross-tenant spoofing prevention
    const authResult = await resolveAuthenticatedTenantId(req);
    if (!authResult.allowed) {
      apiLogger.warn("security", "unauthorized_analytics_fetch_blocked", {
        context: { error: authResult.error, status: authResult.status }
      });
      return res.status(authResult.status || 401).json({ error: authResult.error });
    }

    try {
      const tenantId = authResult.tenantId;
      const isTenant = tenantId && tenantId !== "default";

      // 🚨 SECURITY GATE: Block unauthorized or non-existent tenant data access
      if (isTenant) {
        try {
          const tenantSnap = await safeDbGet(ref(db, `tenants/${tenantId}`), 600);
          if (tenantSnap && !tenantSnap.exists()) {
            apiLogger.warn("security", "unauthorized_fake_tenant_analytics_access", {
              context: { tenantId }
            });
            return res.status(404).json({ error: `Tenant '${tenantId}' not found or unauthorized.` });
          }
        } catch (e) {
          // offline fallback
        }
      }

      const summaryPath = isTenant
        ? `tenants/${tenantId}/analytics/summary`
        : "analytics/summary";

      let snapshot = null;
      try {
        snapshot = await safeDbGet(ref(db, summaryPath), 600);
      } catch (e) {
        // offline fallback
      }

      if (!snapshot || !snapshot.exists()) {
        return res.status(200).json({
          total_website_visitors: 0,
          total_chatbot_opens: 0,
          total_conversations_started: 0,
          total_conversations: 0,
          total_leads_captured: 0,
        });
      }

      return res.status(200).json(snapshot.val());
    } catch (err) {
      apiLogger.error("Failed to fetch analytics summary:", err);
      return res.status(500).json({ error: "Failed to fetch analytics" });
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // POST: Record Tracking Event (Multi-Tenant Scoped)
  // ──────────────────────────────────────────────────────────────────────────
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" });
  }

  // 1. Enforce 16KB body size cap (returns 413)
  if (!validateRequestBodySize(req, res, 16384)) return;

  try {
    // 2. Untrusted Telemetry Isolation: Strip spoofed privilege claims
    req.body = sanitizeUntrustedTelemetry(req.body);
    const {
      event_type,
      anonId = "unknown_visitor",
      pagePath = "/",
      details = "",
      deviceName = "Unknown Device",
      username = "Visitor",
      hostUrl = "",
      referrer = "Direct",
    } = req.body || {};

    // 🛑 MASTER GUARD: Ignore internal iframe embed and admin routes ONLY for page_view events
    // Important: DO NOT ignore chatbot_opened or conversation_started events from /embed/chatbot!
    if (
      event_type === "page_view" &&
      (pagePath.startsWith("/embed") ||
        pagePath.startsWith("/lg") ||
        pagePath.startsWith("/logs"))
    ) {
      return res.status(200).json({ success: true, ignored: true, reason: "Internal route pageview" });
    }

    // 1. Resolve Tenant Context
    const tenantId = resolveTenantId(req) || req.body?.tenant_id || "default";
    const isTenantScoped = tenantId && tenantId !== "default";

    // 🛑 DEDUPLICATION GUARD: Prevent duplicate page_view entries within 3 seconds for the same visitor
    if (event_type === "page_view") {
      const metaPath = isTenantScoped
        ? `tenants/${tenantId}/analytics/visitors/${anonId}/profile`
        : `analytics/visitors/${anonId}/profile`;
      
      const existingMetaSnap = await get(ref(db, metaPath));
      if (existingMetaSnap.exists()) {
        const meta = existingMetaSnap.val();
        if (meta.lastVisitedPage === pagePath && meta.lastActiveAt) {
          const diffMs = Date.now() - new Date(meta.lastActiveAt).getTime();
          if (diffMs < 3000) {
            return res.status(200).json({ success: true, deduplicated: true });
          }
        }
      }
    }

    // 2. Map incoming event types
    let summaryField = "";
    let visitorCounterField = "";

    if (event_type === "page_view") {
      summaryField = "total_website_visitors";
      visitorCounterField = "visits_count";
    } else if (event_type === "chatbot_opened") {
      summaryField = "total_chatbot_opens";
      visitorCounterField = "chat_opens_count";
    } else if (event_type === "conversation_started") {
      summaryField = "total_conversations_started";
      visitorCounterField = "conversations_count";
    } else {
      return res.status(400).json({ error: "Invalid tracking event type" });
    }

    const now = new Date();
    const timestamp = now.toISOString();
    const date = now.toISOString().split("T")[0];
    const time = now.toTimeString().split(" ")[0];

    // ──────────────────────────────────────────────────────────────────────────
    // A. Update Tenant-Scoped Partition (If Multi-Tenant)
    // ──────────────────────────────────────────────────────────────────────────
    if (isTenantScoped) {
      // 1. Tenant Summary Counter
      const tenantSummaryRef = ref(
        db,
        `tenants/${tenantId}/analytics/summary/${summaryField}`
      );
      await runTransaction(tenantSummaryRef, (currentVal) => {
        return (currentVal || 0) + 1;
      });

      // 2. Tenant Visitor Chronological Event
      const tenantVisitorEventsRef = ref(
        db,
        `tenants/${tenantId}/analytics/visitors/${anonId}/events`
      );
      const tenantEventRef = push(tenantVisitorEventsRef);
      await set(tenantEventRef, {
        event_id: tenantEventRef.key,
        event_type,
        pagePath,
        hostUrl,
        referrer,
        details,
        timestamp,
        date,
        time,
        tenant_id: tenantId,
      });

      // 3. Tenant Visitor Individual Counter
      const tenantVisitorCounterRef = ref(
        db,
        `tenants/${tenantId}/analytics/visitors/${anonId}/summary/${visitorCounterField}`
      );
      await runTransaction(tenantVisitorCounterRef, (currentVal) => {
        return (currentVal || 0) + 1;
      });

      // 4. Tenant Visitor Profile Metadata
      const tenantVisitorMetaRef = ref(
        db,
        `tenants/${tenantId}/analytics/visitors/${anonId}/profile`
      );
      await update(tenantVisitorMetaRef, {
        anonId,
        username,
        deviceName,
        hostUrl,
        lastActiveAt: timestamp,
        lastVisitedPage: pagePath,
        tenant_id: tenantId,
      });
    }

    // ──────────────────────────────────────────────────────────────────────────
    // B. Update Global Platform Summary (Shared Cross-Tenant Metrics)
    // ──────────────────────────────────────────────────────────────────────────
    const globalSummaryRef = ref(db, `analytics/summary/${summaryField}`);
    await runTransaction(globalSummaryRef, (currentValue) => {
      return (currentValue || 0) + 1;
    });

    const globalVisitorEventsRef = ref(db, `analytics/visitors/${anonId}/events`);
    const newGlobalEventRef = push(globalVisitorEventsRef);
    await set(newGlobalEventRef, {
      event_id: newGlobalEventRef.key,
      event_type,
      pagePath,
      hostUrl,
      referrer,
      details,
      timestamp,
      date,
      time,
      tenant_id: tenantId,
    });

    const globalVisitorSummaryRef = ref(
      db,
      `analytics/visitors/${anonId}/summary/${visitorCounterField}`
    );
    await runTransaction(globalVisitorSummaryRef, (currentVal) => {
      return (currentVal || 0) + 1;
    });

    const globalVisitorMetaRef = ref(db, `analytics/visitors/${anonId}/profile`);
    await update(globalVisitorMetaRef, {
      anonId,
      username,
      deviceName,
      hostUrl,
      lastActiveAt: timestamp,
      lastVisitedPage: pagePath,
      tenant_id: tenantId,
    });

    return res.status(200).json({ success: true, tenant_id: tenantId });
  } catch (error) {
    apiLogger.error("Firebase Analytics Write Error:", error);
    return res.status(500).json({ error: "Internal tracking server error" });
  }
}

export default withApiLogger(handler, "Analytics-API");
