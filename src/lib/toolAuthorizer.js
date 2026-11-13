// src/lib/toolAuthorizer.js
import { isServiceSupported, isLocationCovered, PERMITTED_ACTIONS } from "./policyContract";
import { sanitizeFirebaseKey } from "./sanitizer";

/**
 * Server-Side Tool and Side-Effect Authorization Gate (CD08)
 *
 * Guarantees that model-generated tool calls and prompt-injected requests
 * cannot execute unauthorized side effects, book unsupported services,
 * or bypass tenant configuration boundaries.
 */

export async function authorizeToolAction({
  tenantId = "default",
  action,
  toolArgs = {},
  customerConfirmed = true,
  tenantConfig = {},
  prospectData = {},
}) {
  const cleanTenant = String(tenantId).toLowerCase().trim().replace(/[^a-z0-9_-]/g, "") || "default";

  // 1. Cross-Tenant Spoofing Check
  if (toolArgs.tenant_id && String(toolArgs.tenant_id).toLowerCase().trim() !== cleanTenant) {
    return {
      allowed: false,
      statusCode: 403,
      reason: `Cross-tenant tool execution forbidden. Context tenant is '${cleanTenant}', but tool payload requested '${toolArgs.tenant_id}'.`,
      action,
    };
  }

  // 2. Privilege Escalation Prevention in Arguments
  // Reject arguments attempting to inject credentials, bypasses, or roles
  const dangerousKeys = ["admin_override", "bypass_auth", "role", "permissions", "smtp_password", "token"];
  for (const key of dangerousKeys) {
    if (toolArgs[key] !== undefined) {
      return {
        allowed: false,
        statusCode: 403,
        reason: `Privilege escalation attempt detected in tool argument '${key}'. Operation blocked.`,
        action,
      };
    }
  }

  const cleanAction = String(action || "").toUpperCase().trim();

  // 3. Action-Specific Authorization Matrix
  switch (cleanAction) {
    case PERMITTED_ACTIONS.SCHEDULE_CONSULTATION:
    case "REQUEST_CONSULTATION": {
      // Permission check: Direct booking feature flag
      if (tenantConfig.enableDirectBooking === false || tenantConfig.calendarActive === false) {
        return {
          allowed: false,
          statusCode: 403,
          reason: `Direct calendar booking is disabled by policy for tenant '${cleanTenant}'. Offer a callback instead.`,
          action: cleanAction,
          fallbackAction: PERMITTED_ACTIONS.REQUEST_CALLBACK,
        };
      }

      // Check requested service
      const requestedService = toolArgs.service || toolArgs.service_requested || prospectData.context_patch?.business_context?.service_requested;
      if (requestedService) {
        const serviceCheck = isServiceSupported(
          requestedService,
          tenantConfig.supportedServices,
          tenantConfig.unsupportedServices
        );
        if (!serviceCheck.supported) {
          return {
            allowed: false,
            statusCode: 400,
            reason: `Cannot book consultation: ${serviceCheck.reason}`,
            action: cleanAction,
            isUnsupportedService: true,
          };
        }
      }

      // Check service area
      const location = toolArgs.location || toolArgs.zip || toolArgs.city || prospectData.context_patch?.business_context?.location;
      if (location && Array.isArray(tenantConfig.serviceArea) && tenantConfig.serviceArea.length > 0) {
        const areaCheck = isLocationCovered(location, tenantConfig.serviceArea);
        if (!areaCheck.covered) {
          return {
            allowed: false,
            statusCode: 400,
            reason: `Cannot book consultation: ${areaCheck.reason}`,
            action: cleanAction,
            isOutOfArea: true,
          };
        }
      }

      // Customer contact requirement
      const contact = prospectData.context_patch?.contact_info || {};
      const hasContact = Boolean((toolArgs.email || contact.email) || (toolArgs.phone || contact.phone));
      if (!hasContact) {
        return {
          allowed: false,
          statusCode: 422,
          reason: "Consultation booking requires customer contact details (email or phone).",
          action: cleanAction,
        };
      }

      return {
        allowed: true,
        statusCode: 200,
        reason: "Consultation booking authorized.",
        action: cleanAction,
        sanitizedArgs: {
          preferred_date: toolArgs.preferred_date || null,
          preferred_time: toolArgs.preferred_time || null,
          service: requestedService || null,
        },
      };
    }

    case PERMITTED_ACTIONS.REQUEST_CALLBACK:
    case "REQUEST_CALLBACK": {
      const phone = toolArgs.phone || toolArgs.phone_number || prospectData.context_patch?.contact_info?.phone;
      if (!phone || typeof phone !== "string" || !/^[\d\+\-\(\)\s]{7,20}$/.test(phone.trim())) {
        return {
          allowed: false,
          statusCode: 422,
          reason: "Callback request requires a valid phone number.",
          action: cleanAction,
        };
      }

      return {
        allowed: true,
        statusCode: 200,
        reason: "Callback request authorized.",
        action: cleanAction,
        sanitizedArgs: { phone: phone.trim() },
      };
    }

    case PERMITTED_ACTIONS.REQUEST_QUOTE:
    case "REQUEST_QUOTE": {
      const requestedService = toolArgs.service || prospectData.context_patch?.business_context?.service_requested;
      if (requestedService) {
        const serviceCheck = isServiceSupported(
          requestedService,
          tenantConfig.supportedServices,
          tenantConfig.unsupportedServices
        );
        if (serviceCheck.explicitlyUnsupported) {
          return {
            allowed: false,
            statusCode: 400,
            reason: `Cannot quote: ${serviceCheck.reason}`,
            action: cleanAction,
          };
        }
      }

      return {
        allowed: true,
        statusCode: 200,
        reason: "Quote request authorized.",
        action: cleanAction,
        sanitizedArgs: { service: requestedService || "General" },
      };
    }

    case PERMITTED_ACTIONS.REQUEST_WEBSITE_AUDIT:
    case "REQUEST_WEBSITE_AUDIT": {
      const url = toolArgs.website_url || toolArgs.website || prospectData.context_patch?.business_context?.website;
      if (!url || typeof url !== "string" || !/^[^\s]+\.[^\s]+$/.test(url.trim())) {
        return {
          allowed: false,
          statusCode: 422,
          reason: "Website audit requires a valid URL.",
          action: cleanAction,
        };
      }

      return {
        allowed: true,
        statusCode: 200,
        reason: "Website audit request authorized.",
        action: cleanAction,
        sanitizedArgs: { website_url: url.trim() },
      };
    }

    case PERMITTED_ACTIONS.HUMAN_HANDOFF:
    case "HUMAN_HANDOFF":
    case "ESCALATE_HUMAN": {
      return {
        allowed: true,
        statusCode: 200,
        reason: "Human handoff authorized.",
        action: cleanAction,
        sanitizedArgs: { reason: toolArgs.reason || "Customer requested live representative." },
      };
    }

    case PERMITTED_ACTIONS.RECORD_PRIVACY:
    case "RECORD_PRIVACY_PREFERENCE": {
      const refused = Array.isArray(toolArgs.refused_fields) ? toolArgs.refused_fields : [];
      return {
        allowed: true,
        statusCode: 200,
        reason: "Privacy preference recording authorized.",
        action: cleanAction,
        sanitizedArgs: { refused_fields: refused },
      };
    }

    case PERMITTED_ACTIONS.DATA_DELETION:
    case "REQUEST_DATA_DELETION":
    case "TRIGGER_DATA_DELETION": {
      return {
        allowed: true,
        statusCode: 200,
        reason: "Data deletion authorized.",
        action: cleanAction,
        sanitizedArgs: {},
      };
    }

    case PERMITTED_ACTIONS.NONE:
    case "NONE":
    case "": {
      return {
        allowed: true,
        statusCode: 200,
        reason: "No action required.",
        action: "NONE",
        sanitizedArgs: {},
      };
    }

    default: {
      return {
        allowed: false,
        statusCode: 403,
        reason: `Unrecognized or unauthorized tool action '${cleanAction}'. Blocked by server-side policy.`,
        action: cleanAction,
      };
    }
  }
}
