import { db } from "./firebase";
import { ref, push } from "firebase/database";

// In-memory cache provides burst protection during serverless container lifecycles
const alertCache = new Map();
const THROTTLE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

const CRITICAL_EVENTS = [
  "lead_routing_failed",
  "booking_failed",
  "chatbot_engine_failure",
  "voice_service_unavailable",
  "database_unavailable",
  "cross_tenant_access_attempt"
];

export async function processSmartAlert(level, eventType, eventName, logEntry) {
  // 1. Identify Target Events
  const isCritical = 
    level === "CRITICAL" || 
    CRITICAL_EVENTS.includes(eventName) || 
    eventType === "security_audit";

  if (!isCritical) return;

  // 2. Grouping by Environment, Service, and Event
  const cacheKey = `${logEntry.environment}_${logEntry.service}_${eventName}`;
  const now = Date.now();
  const cached = alertCache.get(cacheKey) || { count: 0, lastSent: 0 };
  
  cached.count += 1;
  alertCache.set(cacheKey, cached);

  // 3. Alert Storm Prevention (Debouncing & High Error Rate Spikes)
  const isSpike = cached.count === 10; // Instantly trigger if 10 errors happen inside the suppressed window
  if (now - cached.lastSent < THROTTLE_WINDOW_MS && !isSpike) {
    return; // Suppress alert (but keep incrementing the count)
  }

  // 4. Construct Alert Payload
  const alertPayload = {
    title: isSpike ? `🚨 HIGH ERROR RATE: ${eventName}` : `⚠️ Critical System Alert: ${eventName}`,
    environment: logEntry.environment || "Unknown",
    service: logEntry.service || "Unknown",
    correlation_id: logEntry.correlation_id || "N/A",
    occurrences_in_window: cached.count,
    message: logEntry.error_message || logEntry.message || "System trace logged",
    timestamp: new Date().toISOString(),
    status: "UNACKNOWLEDGED"
  };

  try {
    // Push to a dedicated alerts queue (which can trigger webhooks, Slack, PagerDuty, or Email functions)
    await push(ref(db, "system_alerts"), alertPayload);
    
    // Reset the window timer and count after successfully sending
    alertCache.set(cacheKey, { count: 0, lastSent: now });
  } catch (error) {
    console.error("Alert Manager failed to queue critical alert:", error);
  }
}