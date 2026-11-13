// src/lib/loggerPresets.js
import { CloseDeskLogger } from "./logger";
import { getOrCreateAnonId } from "./cookiePersonalization";

const getClientSessionId = () => {
  if (typeof window !== "undefined") return getOrCreateAnonId();
  return undefined;
};

// 🚨 TICKET 3 & 22: Automatically attach browser/device/build context
const getClientContext = () => {
  if (typeof window === "undefined") return {};

  const ua = navigator.userAgent;
  let browser = "Unknown";
  if (ua.includes("Chrome")) browser = "Chrome";
  else if (ua.includes("Firefox")) browser = "Firefox";
  else if (ua.includes("Safari") && !ua.includes("Chrome")) browser = "Safari";
  else if (ua.includes("Edge")) browser = "Edge";

  let device_type = "Desktop";
  if (/Mobile|Android|iP(hone|od)/.test(ua)) device_type = "Mobile";
  else if (/Tablet|iPad/.test(ua)) device_type = "Tablet";

  return {
    browser,
    device_type,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    page_url: window.location.href,
    // 🚨 TICKET 22: Fallbacks mapping for client-side environments
    application_version: process.env.NEXT_PUBLIC_APP_VERSION || "1.0.0", 
    build_id: process.env.NEXT_PUBLIC_BUILD_ID || "local_build",
  };
};

export const createWebsiteLogger = (component, context = {}) =>
  new CloseDeskLogger({
    service: "Website",
    component,
    defaultCorrelation: { session_id: getClientSessionId() },
    defaultContext: { ...getClientContext(), ...context },
  });

export const createApiLogger = (component, context = {}) =>
  new CloseDeskLogger({ service: "API", component, defaultContext: context });

export const createAiLogger = (component, context = {}) =>
  new CloseDeskLogger({
    service: "AI",
    component,
    defaultCorrelation: { session_id: getClientSessionId() },
    defaultContext: { ...getClientContext(), ...context },
  });

export const createVoiceLogger = (component, context = {}) =>
  new CloseDeskLogger({
    service: "Voice",
    component,
    defaultCorrelation: { session_id: getClientSessionId() },
    defaultContext: { ...getClientContext(), ...context },
  });

export const createPulseLogger = (component, context = {}) =>
  new CloseDeskLogger({ service: "Pulse", component, defaultContext: context });