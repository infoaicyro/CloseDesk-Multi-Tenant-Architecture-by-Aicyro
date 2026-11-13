// src/lib/logger.js
import { processSmartAlert } from "./alertManager"; // 🔥 TICKET 21

export const LOG_LEVELS = {
  DEBUG: "DEBUG",
  INFO: "INFO",
  WARN: "WARN",
  ERROR: "ERROR",
  CRITICAL: "CRITICAL",
};
const LEVEL_PRIORITIES = {
  DEBUG: 10,
  INFO: 20,
  WARN: 30,
  ERROR: 40,
  CRITICAL: 50,
};

const ALLOWED_CONTEXT_FIELDS = [
  "tenant_id",
  "client_id",
  "user_id",
  "source",
  "endpoint",
  "source_path",
  "http_method",
  "status_code",
  "message",
  "error_code",
  "error_message",
  "duration_ms",
  "ai_model",
  "tool_name",
  "action_by",
  "target_id",
  "status",
  // 🚨 TICKET 22: Explicitly whitelist versioning fields so QA can filter by them
  "application_version",
  "build_id",
  "prompt_version",
  "knowledge_version",
  "configuration_version"
];

const REDACT_KEYS_SECRETS =
  /password|secret|token|api[_-]?key|authorization|bearer|credential|private[_-]?key|payment|cvv|credit[_-]?card/i;
const REDACT_KEYS_PII = /\b(email|phone|address|website)\b/i;
const REDACT_KEYS_TEXT = /\b(conversation|transcript)\b/i;

function sanitizeStringValues(str) {
  if (typeof str !== "string") return str;
  let s = str;
  s = s.replace(
    /(sk-[a-zA-Z0-9]{20,}|sk-proj-[a-zA-Z0-9_-]{20,})/g,
    "sk-[SECRET_REDACTED]",
  );
  s = s.replace(/Bearer\s+[A-Za-z0-9\-\._~+\/]+/gi, "Bearer [SECRET_REDACTED]");
  s = s.replace(/AIza[0-9A-Za-z\-_]{35}/g, "AIza[SECRET_REDACTED]");
  s = s.replace(/(:\/\/[^:]+:)[^@]+(@)/g, "$1[SECRET_REDACTED]$2");
  return s;
}

function sanitizePayload(obj, depth = 0) {
  if (depth > 10) return "[MAX_DEPTH_REACHED]";
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return sanitizeStringValues(obj);
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj))
    return obj.map((item) => sanitizePayload(item, depth + 1));
  const sanitizedObj = {};
  for (const [key, value] of Object.entries(obj)) {
    if (REDACT_KEYS_SECRETS.test(key)) sanitizedObj[key] = "[SECRET_REDACTED]";
    else if (REDACT_KEYS_PII.test(key)) sanitizedObj[key] = "[PII_REDACTED]";
    else if (REDACT_KEYS_TEXT.test(key)) sanitizedObj[key] = "[TEXT_REDACTED]";
    else sanitizedObj[key] = sanitizePayload(value, depth + 1);
  }
  return sanitizedObj;
}

function generateUUID() {
  if (typeof crypto !== "undefined" && crypto.randomUUID)
    return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export class CloseDeskLogger {
  constructor({
    service,
    component,
    environment = "development",
    minLevel = "DEBUG",
    defaultCorrelation = {},
    defaultContext = {},
  }) {
    this.service = service;
    this.component = component;
    this.environment = environment;
    this.minLevel = minLevel.toUpperCase();
    this.defaultCorrelation = defaultCorrelation;
    this.defaultContext = defaultContext;
  }

  child({ component, correlation = {}, context = {} } = {}) {
    return new CloseDeskLogger({
      service: this.service,
      component: component || this.component,
      environment: this.environment,
      minLevel: this.minLevel,
      defaultCorrelation: { ...this.defaultCorrelation, ...correlation },
      defaultContext: { ...this.defaultContext, ...context },
    });
  }

  startTimer() {
    const startTime =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    return () =>
      Math.round(
        (typeof performance !== "undefined" ? performance.now() : Date.now()) -
          startTime,
      );
  }

  _transmitToCentralDatabase(sanitizedEntry) {
    setTimeout(() => {
      try {
        const getBaseUrl = () => {
          if (typeof window !== "undefined") return "";
          if (process.env.NEXT_PUBLIC_APP_URL)
            return process.env.NEXT_PUBLIC_APP_URL;
          if (process.env.VERCEL_URL)
            return `https://${process.env.VERCEL_URL}`;
          return "http://localhost:3000";
        };
        fetch(`${getBaseUrl()}/api/app-state`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sanitizedEntry),
          keepalive: true,
        }).catch(() => {});
      } catch (e) {}
    }, 0);
  }

  _emit(level, event_type, event_name, payload = {}) {
    if (LEVEL_PRIORITIES[level] < LEVEL_PRIORITIES[this.minLevel]) return;

    let dynamicEnv = this.environment;
    let dynamicService = this.service;
    let currentPath = "Server";

    // 1. AUTO-DETECT ENVIRONMENT AND SOURCE PATH
    if (typeof window !== "undefined") {
      currentPath = window.location.pathname;

      if (
        window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1"
      ) {
        dynamicEnv = "development";
      } else {
        dynamicEnv = "production";
      }

      // Automatically tag Admin dashboard events as 'Pulse'
      if (currentPath.startsWith("/lg") || currentPath.startsWith("/logs")) {
        dynamicService = "Pulse";
      }
    } else if (process.env.NODE_ENV === "production") {
      dynamicEnv = "production";
    }

    const {
      correlation = {},
      context = {},
      error = null,
      duration_ms = null,
      metadata: payloadMetadata = {},
    } = payload;
    const mergedContext = {
      ...this.defaultContext,
      ...context,
      source_path: currentPath,
    };

    const correlationFields = {
      request_id: correlation.request_id || this.defaultCorrelation.request_id,
      correlation_id:
        correlation.correlation_id || this.defaultCorrelation.correlation_id,
      session_id: correlation.session_id || this.defaultCorrelation.session_id,
    };

    // 🚨 TICKET 22: Universally append versioning to every log (Client or Server)
    const contextFields = {
      application_version: process.env.NEXT_PUBLIC_APP_VERSION || "1.0.0",
      build_id: process.env.VERCEL_GIT_COMMIT_SHA || process.env.NEXT_PUBLIC_BUILD_ID || "local_build",
    };
    
    const metadata = { ...payloadMetadata };

    Object.keys(mergedContext).forEach((key) => {
      if (ALLOWED_CONTEXT_FIELDS.includes(key))
        contextFields[key] = mergedContext[key];
      else metadata[key] = mergedContext[key];
    });

    if (duration_ms !== null) contextFields.duration_ms = duration_ms;
    if (error) {
      contextFields.error_code = error.code || "UNKNOWN_ERROR";
      contextFields.error_message = error.message || String(error);
    }

    const cleanObject = (obj) =>
      Object.fromEntries(
        Object.entries(obj).filter(([_, v]) => v !== undefined),
      );

    const rawEntry = {
      timestamp: new Date().toISOString(),
      log_id: generateUUID(),
      level,
      environment: dynamicEnv,
      service: dynamicService,
      component: this.component,
      event_type,
      event_name,
      ...cleanObject(correlationFields),
      ...cleanObject(contextFields),
    };

    if (Object.keys(metadata).length > 0) rawEntry.metadata = metadata;
    const sanitizedEntry = sanitizePayload(rawEntry);

    // Output directly to browser console so you can see it working locally
    const output = JSON.stringify(sanitizedEntry);
    switch (level) {
      case LOG_LEVELS.DEBUG:
        console.debug ? console.debug(output) : console.log(output);
        break;
      case LOG_LEVELS.INFO:
        console.log(output);
        break;
      case LOG_LEVELS.WARN:
        console.warn(output);
        break;
      case LOG_LEVELS.ERROR:
      case LOG_LEVELS.CRITICAL:
        console.error(output);
        break;
      default:
        console.log(output);
    }

    this._transmitToCentralDatabase(sanitizedEntry);

    // 🔥 TICKET 21: Evaluate log for smart alerting in the background
    processSmartAlert(level, event_type, event_name, sanitizedEntry);
  }

  debug(type, name, payload) {
    this._emit(LOG_LEVELS.DEBUG, type, name, payload);
  }
  info(type, name, payload) {
    this._emit(LOG_LEVELS.INFO, type, name, payload);
  }
  warn(type, name, payload) {
    this._emit(LOG_LEVELS.WARN, type, name, payload);
  }
  error(type, name, payload) {
    this._emit(LOG_LEVELS.ERROR, type, name, payload);
  }
  critical(type, name, payload) {
    this._emit(LOG_LEVELS.CRITICAL, type, name, payload);
  }
}