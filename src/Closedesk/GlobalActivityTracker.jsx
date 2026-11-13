// src/Closedesk/GlobalActivityTracker.jsx
"use client";

import { useEffect } from "react";
import { createWebsiteLogger } from "../lib/loggerPresets";

const trackerLogger = createWebsiteLogger("GlobalActivityTracker");

export default function GlobalActivityTracker() {
  useEffect(() => {
    // 🚨 TICKET 3: Capture Javascript Errors and Resource Load Failures
    const handleGlobalError = (event) => {
      // Differentiate between a JS execution error and a failed resource (like an image/script 404)
      if (
        event.target &&
        (event.target.tagName === "IMG" ||
          event.target.tagName === "SCRIPT" ||
          event.target.tagName === "LINK")
      ) {
        trackerLogger.error("system_event", "resource_load_failure", {
          context: {
            message: `Failed to load resource: ${event.target.src || event.target.href}`,
          },
        });
      } else {
        // Standard JS Error
        trackerLogger.error("system_event", "javascript_error", {
          error: event.error,
          context: { error_message: event.message },
        });
      }
    };

    // 🚨 TICKET 3: Capture Unhandled Promise Rejections (e.g., failed async functions)
    const handleUnhandledRejection = (event) => {
      trackerLogger.error("system_event", "unhandled_exception", {
        error: event.reason,
        context: { error_message: String(event.reason) },
      });
    };

    // Also track standard user clicks globally (already requested previously)
    const handleGlobalClick = (e) => {
      const target = e.target.closest(
        "button, a, input[type='submit'], [role='button']",
      );
      if (!target) return;

      const text =
        target.innerText ||
        target.value ||
        target.getAttribute("aria-label") ||
        target.alt ||
        "Icon/Element";
      trackerLogger.debug("user_action", "click", {
        context: {
          message: `Clicked: ${text.substring(0, 30)}`,
          html_tag: target.tagName.toLowerCase(),
          css_class: target.className || "none",
        },
      });
    };

    window.addEventListener("error", handleGlobalError, true); // Use capture phase for resources
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    document.addEventListener("click", handleGlobalClick);

    return () => {
      window.removeEventListener("error", handleGlobalError, true);
      window.removeEventListener(
        "unhandledrejection",
        handleUnhandledRejection,
      );
      document.removeEventListener("click", handleGlobalClick);
    };
  }, []);

  return null; // Silent component
}
