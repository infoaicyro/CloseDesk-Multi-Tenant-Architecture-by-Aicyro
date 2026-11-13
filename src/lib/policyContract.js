// src/lib/policyContract.js

/**
 * CloseDesk Policy and Truthful Service Promises Contract (CD08)
 *
 * Implements authoritative validation for:
 * - 5-Tier Policy Precedence
 * - IANA Timezone validation
 * - Business Operating Hours & Overnight Schedules
 * - Exceptional Closures / Holidays
 * - Service Area & Service Catalog validation
 * - Pricing & Quote Policy
 * - Server-side Tool Permission Registry
 */

export const COMMON_POLICY_VERSION = "2.15.0";
export const INDUSTRY_POLICY_VERSION = "1.2.0";

export const POLICY_LAYERS = Object.freeze({
  LAYER_1_COMMON: "common_platform_rules",
  LAYER_2_INDUSTRY: "industry_configuration",
  LAYER_3_TENANT: "tenant_business_configuration",
  LAYER_4_KNOWLEDGE: "tenant_knowledge",
  LAYER_5_TOOLS: "permitted_tools_and_apis",
});

export const OPERATING_STATUS = Object.freeze({
  OPEN: "open",
  CLOSED_AFTER_HOURS: "closed_after_hours",
  CLOSED_HOLIDAY: "closed_holiday",
  CLOSED_WEEKEND: "closed_weekend",
  UNKNOWN: "unknown",
});

export const SUPPORTED_INDUSTRIES = Object.freeze([
  "General",
  "HVAC",
  "Plumbing",
  "Restoration",
  "Roofing",
  "Pest Control",
  "Electrical",
]);

export const PERMITTED_ACTIONS = Object.freeze({
  SCHEDULE_CONSULTATION: "SCHEDULE_CONSULTATION",
  REQUEST_CALLBACK: "REQUEST_CALLBACK",
  REQUEST_QUOTE: "REQUEST_QUOTE",
  REQUEST_WEBSITE_AUDIT: "REQUEST_WEBSITE_AUDIT",
  HUMAN_HANDOFF: "HUMAN_HANDOFF",
  RECORD_PRIVACY: "RECORD_PRIVACY",
  DATA_DELETION: "DATA_DELETION",
  NONE: "NONE",
});

/**
 * Validates whether a timezone identifier is a recognized IANA timezone.
 */
export function isValidIanaTimezone(tz) {
  if (!tz || typeof tz !== "string") return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz.trim() });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Validates a single time string in 24-hour HH:mm format.
 */
export function isValidTimeFormat(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return false;
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(timeStr.trim());
}

/**
 * Parses "HH:mm" into minutes from start of day.
 */
export function timeToMinutes(timeStr) {
  if (!isValidTimeFormat(timeStr)) return 0;
  const [h, m] = timeStr.trim().split(":").map(Number);
  return h * 60 + m;
}

const DAYS_OF_WEEK = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/**
 * Validates an operating schedule map (Monday..Sunday).
 */
export function validateOperatingSchedule(schedule) {
  if (!schedule || typeof schedule !== "object") {
    return { valid: false, reason: "Schedule must be an object." };
  }

  for (const day of DAYS_OF_WEEK) {
    const dayConfig = schedule[day];
    if (dayConfig && typeof dayConfig === "object") {
      if (dayConfig.active) {
        if (!isValidTimeFormat(dayConfig.open) || !isValidTimeFormat(dayConfig.close)) {
          return {
            valid: false,
            reason: `Invalid time format for ${day}: open='${dayConfig.open}', close='${dayConfig.close}'. Must be HH:mm (24-hour).`,
          };
        }
      }
    }
  }

  return { valid: true };
}

/**
 * Evaluates whether a tenant is currently open based on validated timezone,
 * operating schedule, overnight hours crossing midnight, and holidays.
 *
 * @param {object} params
 * @param {object} params.schedule - Operating hours map by day of week
 * @param {string} params.timezone - IANA timezone (e.g. "America/New_York", "America/Chicago")
 * @param {string[]} [params.holidays] - Array of YYYY-MM-DD date strings
 * @param {Date|number|string} [params.currentTime] - Current reference time (defaults to Date.now())
 */
export function evaluateTenantOperatingStatus({
  schedule = {},
  timezone = "UTC",
  holidays = [],
  currentTime = Date.now(),
}) {
  const safeTimezone = isValidIanaTimezone(timezone) ? timezone.trim() : "UTC";
  const dateObj = new Date(currentTime);

  if (isNaN(dateObj.getTime())) {
    return {
      isOpen: false,
      status: OPERATING_STATUS.UNKNOWN,
      reason: "Invalid reference timestamp.",
      tenantLocalTime: null,
      timezone: safeTimezone,
    };
  }

  // Format parts in tenant timezone
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(dateObj);
  const getPart = (type) => parts.find((p) => p.type === type)?.value;

  const currentYear = getPart("year");
  const currentMonth = getPart("month");
  const currentDayNum = getPart("day");
  const currentWeekday = getPart("weekday"); // "Monday", "Tuesday", etc.
  const currentHour = parseInt(getPart("hour"), 10) || 0;
  const currentMinute = parseInt(getPart("minute"), 10) || 0;

  const localDateStr = `${currentYear}-${currentMonth}-${currentDayNum}`;
  const localTimeMinutes = currentHour * 60 + currentMinute;
  const localTimeString = `${String(currentHour).padStart(2, "0")}:${String(currentMinute).padStart(2, "0")}`;

  // 1. Holiday / Exceptional Closure Check
  if (Array.isArray(holidays) && holidays.includes(localDateStr)) {
    return {
      isOpen: false,
      status: OPERATING_STATUS.CLOSED_HOLIDAY,
      reason: `Tenant is closed for scheduled holiday/closure on ${localDateStr}.`,
      tenantLocalTime: `${localDateStr} ${localTimeString}`,
      timezone: safeTimezone,
    };
  }

  // 2. Schedule Check for Today
  const todayConfig = schedule[currentWeekday] || { active: false };

  // Calculate previous day for potential overnight shift crossing midnight
  const dayIndex = DAYS_OF_WEEK.indexOf(currentWeekday);
  const prevDayIndex = (dayIndex + 6) % 7;
  const prevWeekday = DAYS_OF_WEEK[prevDayIndex];
  const prevDayConfig = schedule[prevWeekday] || { active: false };

  // Check if previous day had an overnight schedule (open > close) that extends past midnight into today
  if (prevDayConfig.active && isValidTimeFormat(prevDayConfig.open) && isValidTimeFormat(prevDayConfig.close)) {
    const prevOpenMin = timeToMinutes(prevDayConfig.open);
    const prevCloseMin = timeToMinutes(prevDayConfig.close);

    if (prevOpenMin > prevCloseMin) {
      // Overnight schedule: e.g. Open 20:00 (prev day) -> Close 04:00 (today)
      if (localTimeMinutes < prevCloseMin) {
        return {
          isOpen: true,
          status: OPERATING_STATUS.OPEN,
          reason: `Active overnight schedule from ${prevWeekday} closing at ${prevDayConfig.close}.`,
          tenantLocalTime: `${localDateStr} ${localTimeString}`,
          timezone: safeTimezone,
          todaySchedule: prevDayConfig,
        };
      }
    }
  }

  // Evaluate today's schedule
  if (!todayConfig.active) {
    const isWeekend = currentWeekday === "Saturday" || currentWeekday === "Sunday";
    return {
      isOpen: false,
      status: isWeekend ? OPERATING_STATUS.CLOSED_WEEKEND : OPERATING_STATUS.CLOSED_AFTER_HOURS,
      reason: `Tenant is closed on ${currentWeekday}.`,
      tenantLocalTime: `${localDateStr} ${localTimeString}`,
      timezone: safeTimezone,
      todaySchedule: todayConfig,
    };
  }

  if (!isValidTimeFormat(todayConfig.open) || !isValidTimeFormat(todayConfig.close)) {
    return {
      isOpen: false,
      status: OPERATING_STATUS.UNKNOWN,
      reason: `Invalid hours configured for ${currentWeekday}.`,
      tenantLocalTime: `${localDateStr} ${localTimeString}`,
      timezone: safeTimezone,
    };
  }

  const openMin = timeToMinutes(todayConfig.open);
  const closeMin = timeToMinutes(todayConfig.close);

  if (openMin <= closeMin) {
    // Normal same-day shift (e.g. 09:00 to 17:00)
    if (localTimeMinutes >= openMin && localTimeMinutes < closeMin) {
      return {
        isOpen: true,
        status: OPERATING_STATUS.OPEN,
        reason: `Open during scheduled hours (${todayConfig.open} - ${todayConfig.close}).`,
        tenantLocalTime: `${localDateStr} ${localTimeString}`,
        timezone: safeTimezone,
        todaySchedule: todayConfig,
      };
    } else {
      return {
        isOpen: false,
        status: OPERATING_STATUS.CLOSED_AFTER_HOURS,
        reason: localTimeMinutes < openMin
          ? `Before opening hours (Opens at ${todayConfig.open}).`
          : `After closing hours (Closed at ${todayConfig.close}).`,
        tenantLocalTime: `${localDateStr} ${localTimeString}`,
        timezone: safeTimezone,
        todaySchedule: todayConfig,
      };
    }
  } else {
    // Overnight shift starting today (e.g. 20:00 to 04:00 next day)
    if (localTimeMinutes >= openMin) {
      return {
        isOpen: true,
        status: OPERATING_STATUS.OPEN,
        reason: `Open on overnight shift (${todayConfig.open} - ${todayConfig.close} next day).`,
        tenantLocalTime: `${localDateStr} ${localTimeString}`,
        timezone: safeTimezone,
        todaySchedule: todayConfig,
      };
    } else {
      return {
        isOpen: false,
        status: OPERATING_STATUS.CLOSED_AFTER_HOURS,
        reason: `Before overnight opening hours (Opens at ${todayConfig.open}).`,
        tenantLocalTime: `${localDateStr} ${localTimeString}`,
        timezone: safeTimezone,
        todaySchedule: todayConfig,
      };
    }
  }
}

/**
 * Validates whether a customer's location is within the tenant's approved service area.
 *
 * @param {string} customerLocation - Location string, ZIP code, or city
 * @param {string[]} approvedAreas - Array of approved ZIP codes or city names
 * @returns {{ covered: boolean, reason: string }}
 */
export function isLocationCovered(customerLocation, approvedAreas = []) {
  if (!customerLocation || typeof customerLocation !== "string" || !customerLocation.trim()) {
    return {
      covered: false,
      reason: "Location not provided or undetermined.",
      requiresConfirmation: true,
    };
  }

  if (!Array.isArray(approvedAreas) || approvedAreas.length === 0) {
    // Unrestricted or unconfigured
    return {
      covered: true,
      reason: "No service boundary restrictions configured.",
      requiresConfirmation: false,
    };
  }

  const cleanLoc = customerLocation.toLowerCase().trim();
  const normalizedApproved = approvedAreas.map((a) => String(a).toLowerCase().trim());

  // Check direct match or substring match (e.g. "Austin, TX" matching "Austin" or "78701")
  const isMatch = normalizedApproved.some(
    (area) => cleanLoc.includes(area) || area.includes(cleanLoc)
  );

  return {
    covered: isMatch,
    reason: isMatch
      ? `Location '${customerLocation}' is within confirmed service coverage.`
      : `Location '${customerLocation}' is outside confirmed service coverage area.`,
    requiresConfirmation: !isMatch,
  };
}

/**
 * Validates whether a requested job or service is supported by the tenant.
 *
 * @param {string} requestedService
 * @param {string[]} supportedServices
 * @param {string[]} unsupportedServices
 */
export function isServiceSupported(requestedService, supportedServices = [], unsupportedServices = []) {
  if (!requestedService || typeof requestedService !== "string" || !requestedService.trim()) {
    return { supported: true, reason: "No specific service requested." };
  }

  const cleanReq = requestedService.toLowerCase().trim();

  // 1. Check explicit unsupported list
  if (Array.isArray(unsupportedServices)) {
    const isExplicitlyUnsupported = unsupportedServices.some((s) => {
      const cleanS = String(s).toLowerCase().trim();
      return cleanReq.includes(cleanS) || cleanS.includes(cleanReq);
    });

    if (isExplicitlyUnsupported) {
      return {
        supported: false,
        reason: `Service '${requestedService}' is explicitly listed as unsupported by tenant policy.`,
        explicitlyUnsupported: true,
      };
    }
  }

  // 2. Check supported list if configured
  if (Array.isArray(supportedServices) && supportedServices.length > 0) {
    const isSupported = supportedServices.some((s) => {
      const cleanS = String(s).toLowerCase().trim();
      return cleanReq.includes(cleanS) || cleanS.includes(cleanReq);
    });

    if (!isSupported) {
      return {
        supported: false,
        reason: `Service '${requestedService}' is not in tenant's supported service catalog.`,
        explicitlyUnsupported: false,
      };
    }
  }

  return {
    supported: true,
    reason: `Service '${requestedService}' is supported.`,
  };
}

/**
 * Looks up approved pricing or returns quote policy for a service.
 */
export function getApprovedPriceOrQuotePolicy(serviceName, approvedPricing = []) {
  if (!serviceName || !Array.isArray(approvedPricing) || approvedPricing.length === 0) {
    return {
      hasPrice: false,
      price: null,
      policy: "Prices are not publicly listed or pre-set. A formal quote or callback is required.",
    };
  }

  const cleanSvc = String(serviceName).toLowerCase().trim();
  const matched = approvedPricing.find((item) => {
    if (!item) return false;
    const tier = String(item.tier || "").toLowerCase();
    const desc = String(item.description || "").toLowerCase();
    return cleanSvc.includes(tier) || tier.includes(cleanSvc) || desc.includes(cleanSvc);
  });

  if (matched && matched.price) {
    return {
      hasPrice: true,
      price: matched.price,
      tier: matched.tier,
      description: matched.description || "",
      policy: `Approved standard price: ${matched.price}.`,
    };
  }

  return {
    hasPrice: false,
    price: null,
    policy: "Pricing for this specific service is unlisted. An authorized on-site inspection or callback is required.",
  };
}
