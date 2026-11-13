// src/lib/activityTracker.js
import { getOrCreateAnonId } from "./cookiePersonalization";

let lastTrackedPage = "";
let lastTrackedTime = 0;

function getReadableDeviceName() {
  if (typeof window === "undefined") return "Unknown Device";
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "Windows PC";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Macintosh";
  if (/iPhone|iPad/i.test(ua)) return "iOS Device";
  if (/Android/i.test(ua)) return "Android Mobile";
  return "Desktop PC";
}

function resolveClientTenantId(explicitTenantId) {
  if (explicitTenantId && typeof explicitTenantId === "string" && explicitTenantId.trim()) {
    return explicitTenantId.trim();
  }
  if (typeof window !== "undefined") {
    if (window.__CLOSEDESK_TENANT_ID__) return window.__CLOSEDESK_TENANT_ID__;
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const queryTenant = urlParams.get("tenant") || urlParams.get("tenant_id");
      if (queryTenant) return queryTenant;
      const storedTenant = localStorage.getItem("currentTenant");
      if (storedTenant && storedTenant !== "default") return storedTenant;
    } catch (_) {}
  }
  return "default";
}

async function sendAnalyticsEvent(eventType, payload = {}) {
  if (typeof window === "undefined") return;

  const currentPath = window.location.pathname;

  // 🛑 MASTER GUARD: Completely disable tracking on admin /lg and observability /logs
  if (
    currentPath === "/lg" ||
    currentPath.startsWith("/lg/") ||
    currentPath === "/logs" ||
    currentPath.startsWith("/logs/")
  ) {
    return;
  }

  // 🛑 ONLY block page_view on embedded chatbot iframe, NEVER block chatbot_opened or conversation_started!
  if (
    eventType === "page_view" &&
    (currentPath === "/embed" || currentPath.startsWith("/embed/"))
  ) {
    return;
  }

  const urlParams =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : null;
  const hostParam = urlParams ? urlParams.get("host") : null;
  const anonIdParam = urlParams ? urlParams.get("anonId") : null;

  const anonId =
    payload.anonId ||
    anonIdParam ||
    (typeof window !== "undefined" &&
      (localStorage.getItem("closedesk_anon_id") ||
        localStorage.getItem("aicyro_anonymous_id"))) ||
    getOrCreateAnonId() ||
    "unknown";

  const storedUsername = localStorage.getItem("aicyro_username");
  const username = storedUsername || `Visitor_${anonId.substring(0, 8)}`;
  const tenantId = resolveClientTenantId(payload.tenant_id);
  const hostUrl =
    payload.hostUrl ||
    hostParam ||
    (typeof document !== "undefined" ? document.referrer || window.location.origin : "");

  try {
    await fetch("/api/analytics", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-tenant-id": tenantId,
      },
      body: JSON.stringify({
        event_type: eventType,
        tenant_id: tenantId,
        anonId,
        deviceName: getReadableDeviceName(),
        username,
        pagePath: payload.pagePath || currentPath,
        hostUrl: payload.hostUrl || hostUrl,
        referrer: typeof document !== "undefined" ? document.referrer || "Direct" : "Direct",
        ...payload,
      }),
      keepalive: true,
    });
  } catch (err) {
    console.warn("Analytics log error:", err);
  }
}

/**
 * 1. Track Website Visit (With Exclusion Guard, Multi-Tenant Support & 3-Second Deduplication Lock)
 */
export function trackVisit(pagePath = "/", txId = null, tenantId = null) {
  // 🛑 Skip tracking immediately if navigating to admin views, logs, or embedded iframe
  if (
    pagePath === "/lg" ||
    pagePath.startsWith("/lg/") ||
    pagePath === "/logs" ||
    pagePath.startsWith("/logs/") ||
    pagePath === "/embed" ||
    pagePath.startsWith("/embed/")
  ) {
    return;
  }

  const now = Date.now();
  // Prevent duplicate logs if the same page mounts twice within 3 seconds
  if (lastTrackedPage === pagePath && now - lastTrackedTime < 3000) {
    return;
  }
  lastTrackedPage = pagePath;
  lastTrackedTime = now;

  sendAnalyticsEvent("page_view", {
    pagePath,
    correlation_id: txId,
    tenant_id: tenantId,
  });
}

/**
 * 2. Track Chatbot Opened (Multi-Tenant Scoped)
 */
export function trackChatOpened(tenantId = null) {
  sendAnalyticsEvent("chatbot_opened", {
    details: "Expanded AI Front Desk Widget",
    tenant_id: tenantId,
  });
}

/**
 * 3. Track Conversation Started (Multi-Tenant Scoped)
 */
export function trackConversationStarted(messageSnippet = "", tenantId = null) {
  sendAnalyticsEvent("conversation_started", {
    details: messageSnippet.substring(0, 100),
    tenant_id: tenantId,
  });
}
