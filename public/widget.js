/**
 * CloseDesk Universal Embeddable Widget SDK
 * Allows embedding the CloseDesk Multimodal AI Front-Desk on ANY website.
 *
 * Features:
 * - Exact Cookie & Location Policy Screen-Lock Banner & Background Blur Overlay
 * - Automatic Host Website Visit Tracking (page_view) scoped to tenant_id
 * - Real-Time Geolocation & IP Resolution for Google Radar Map Pins (/lg)
 * - Shared Visitor UUID across host page and chatbot iframe
 * - Full-Duplex WebRTC Voice & Multimodal Camera inspection
 * - Responsive auto-sizing (Pill launcher -> full-screen modal)
 * - 100% transparent iframe rendering without background blocking
 *
 * Usage:
 * <script src="https://YOUR_DOMAIN/widget.js" data-tenant="brightstar_hvac" defer></script>
 */
(function () {
  if (typeof window === "undefined") return;
  if (window.__CLOSEDESK_INITIALIZED__) return;
  window.__CLOSEDESK_INITIALIZED__ = true;

  // Never run widget or banner inside the Pulse Dashboard (/lg)
  if (
    window.location.pathname === "/lg" ||
    window.location.pathname.startsWith("/lg/")
  ) {
    return;
  }

  // 1. Locate the current script tag and extract tenant configuration
  const currentScript =
    document.currentScript ||
    document.querySelector('script[src*="widget.js"]');
  const tenantId =
    (currentScript && currentScript.getAttribute("data-tenant")) ||
    window.__CLOSEDESK_TENANT_ID__ ||
    "default";

  // 2. Derive base URL from the script source
  let baseUrl = window.__CLOSEDESK_BASE_URL__ || "";
  if (!baseUrl && currentScript && currentScript.src) {
    try {
      const parsed = new URL(currentScript.src, window.location.href);
      baseUrl = parsed.origin;
    } catch (_) {}
  }
  if (!baseUrl) {
    baseUrl = window.location.origin;
  }

  // 3. Persistent Anonymous Visitor Identifier
  function getAnonVisitorId() {
    try {
      let id = localStorage.getItem("closedesk_anon_id");
      if (!id) {
        id =
          "vis_" +
          Date.now() +
          "_" +
          Math.random().toString(36).substring(2, 9);
        localStorage.setItem("closedesk_anon_id", id);
      }
      return id;
    } catch (_) {
      return "vis_" + Date.now();
    }
  }

  const anonId = getAnonVisitorId();

  // 4. Device Identification
  function getReadableDeviceName() {
    const ua = navigator.userAgent || "";
    let os = "Unknown OS";
    let type = "Desktop";

    if (/Windows/i.test(ua)) os = "Windows PC";
    else if (/Macintosh|Mac OS X/i.test(ua)) os = "Macintosh";
    else if (/Android/i.test(ua)) {
      os = "Android";
      type = "Mobile";
    } else if (/iPhone|iPad|iPod/i.test(ua)) {
      os = "iOS Device";
      type = "Mobile";
    } else if (/Linux/i.test(ua)) os = "Linux";

    if (/Tablet|iPad/i.test(ua)) type = "Tablet";

    return `${os} (${type})`;
  }

  // 5. Host Website Visit Tracking (Multi-Tenant Scoped with Session Deduplication)
  function trackHostVisit() {
    try {
      const pageKey = window.location.pathname + window.location.search;
      const dedupeKey = "closedesk_visit_logged_" + pageKey;
      if (sessionStorage.getItem(dedupeKey)) {
        return; // Already tracked this page in current session tab
      }
      sessionStorage.setItem(dedupeKey, String(Date.now()));

      const payload = {
        event_type: "page_view",
        tenant_id: tenantId,
        anonId: anonId,
        username: "Visitor_" + anonId.substring(4, 12),
        deviceName: getReadableDeviceName(),
        pagePath: window.location.pathname + window.location.search,
        hostUrl: window.location.origin,
        referrer: document.referrer || "Direct",
        details: document.title || "Host Website Page",
      };

      fetch(baseUrl + "/api/analytics", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-id": tenantId,
        },
        body: JSON.stringify(payload),
        keepalive: true,
        mode: "cors",
      }).catch(function () {});
    } catch (_) {}
  }

  trackHostVisit();

  // ──────────────────────────────────────────────────────────────────────────
  // 6. Geolocation & IP Telemetry Services
  // ──────────────────────────────────────────────────────────────────────────

  function getUserLocation() {
    return new Promise(function (resolve) {
      if (typeof window === "undefined" || !navigator.geolocation) {
        resolve({ status: "unsupported", lat: null, lng: null });
        return;
      }

      navigator.geolocation.getCurrentPosition(
        function (position) {
          resolve({
            status: "allowed",
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
          });
        },
        function (error) {
          resolve({
            status: "rejected",
            error: error ? error.message : "denied",
            lat: null,
            lng: null,
          });
        },
        { timeout: 8000 }
      );
    });
  }

  function getIpAndLocation() {
    return new Promise(function (resolve) {
      const controller =
        typeof AbortController !== "undefined" ? new AbortController() : null;
      const timeoutId = setTimeout(function () {
        if (controller) controller.abort();
        resolve({
          ip: "unknown",
          city: "Unknown",
          region: "Unknown",
          country: "Unknown",
          lat: null,
          lng: null,
        });
      }, 4000);

      fetch("https://ipinfo.io/json", {
        signal: controller ? controller.signal : undefined,
      })
        .then(function (res) {
          if (!res.ok) throw new Error("ipinfo error");
          return res.json();
        })
        .then(function (data) {
          clearTimeout(timeoutId);
          let lat = null,
            lng = null;
          if (data && data.loc) {
            const parts = data.loc.split(",");
            lat = parseFloat(parts[0]);
            lng = parseFloat(parts[1]);
          }
          resolve({
            ip: (data && data.ip) || "unknown",
            city: (data && data.city) || "Unknown",
            region: (data && data.region) || "Unknown",
            country: (data && data.country) || "Unknown",
            lat: isNaN(lat) ? null : lat,
            lng: isNaN(lng) ? null : lng,
          });
        })
        .catch(function () {
          fetch("https://freeipapi.com/api/json", {
            signal: controller ? controller.signal : undefined,
          })
            .then(function (res) {
              if (!res.ok) throw new Error("freeipapi error");
              return res.json();
            })
            .then(function (fallback) {
              clearTimeout(timeoutId);
              resolve({
                ip: fallback.ipAddress || "unknown",
                city: fallback.cityName || "Unknown",
                region: fallback.regionName || "Unknown",
                country: fallback.countryName || "Unknown",
                lat: fallback.latitude ? parseFloat(fallback.latitude) : null,
                lng: fallback.longitude ? parseFloat(fallback.longitude) : null,
              });
            })
            .catch(function () {
              clearTimeout(timeoutId);
              resolve({
                ip: "unknown",
                city: "Unknown",
                region: "Unknown",
                country: "Unknown",
                lat: null,
                lng: null,
              });
            });
        });
    });
  }

  function sendCookieConsentPayload(consentStatus, locationData, ipData) {
    try {
      const effectiveLat =
        locationData && locationData.lat != null
          ? Number(locationData.lat)
          : ipData && ipData.lat != null
          ? Number(ipData.lat)
          : null;

      const effectiveLng =
        locationData && locationData.lng != null
          ? Number(locationData.lng)
          : ipData && ipData.lng != null
          ? Number(ipData.lng)
          : null;

      const effectiveStatus =
        consentStatus === "accepted"
          ? effectiveLat != null
            ? "allowed"
            : locationData && locationData.status
            ? locationData.status
            : "unsupported"
          : "rejected";

      const payload = {
        anonId: anonId,
        username: "Visitor_" + anonId.substring(4, 12),
        deviceName: getReadableDeviceName(),
        consentStatus: consentStatus,
        ipAddress: (ipData && ipData.ip) || "unknown",
        ipLocation: ipData || {},
        location: {
          status: effectiveStatus,
          lat: effectiveLat,
          lng: effectiveLng,
        },
        language: navigator.language || "en-US",
        timeZone:
          Intl && Intl.DateTimeFormat
            ? Intl.DateTimeFormat().resolvedOptions().timeZone
            : "UTC",
        rawUserAgent: navigator.userAgent || "unknown",
        hostUrl: window.location.origin,
        pagePath: window.location.pathname + window.location.search,
        tenant_id: tenantId,
      };

      const endpoint = baseUrl + "/api/cookie-consent";

      fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-id": tenantId,
        },
        body: JSON.stringify(payload),
        keepalive: true,
        mode: "cors",
      }).catch(function () {
        try {
          if (navigator.sendBeacon) {
            const blob = new Blob([JSON.stringify(payload)], {
              type: "application/json",
            });
            navigator.sendBeacon(endpoint, blob);
          }
        } catch (_) {}
      });
    } catch (_) {}
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 7. Cookie Consent Banner UI (Exact Replica of CookieConsentBanner.jsx)
  // ──────────────────────────────────────────────────────────────────────────

  const CONSENT_STORAGE_KEY = "closedesk_cookie_consent";

  function getStoredConsent() {
    try {
      const stored = localStorage.getItem(CONSENT_STORAGE_KEY);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (_) {}
    return null;
  }

  function setStoredConsent(status) {
    try {
      const data = { status: status, timestamp: Date.now() };
      localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(data));
      if (status === "accepted") {
        document.cookie = `closedesk_cookie_consent=${encodeURIComponent(
          status
        )}; max-age=31536000; path=/; SameSite=Lax`;
      } else {
        document.cookie = "closedesk_cookie_consent=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
      }
    } catch (_) {}
  }

  function injectBannerStyles() {
    if (document.getElementById("closedesk-cookie-exact-styles")) return;
    const style = document.createElement("style");
    style.id = "closedesk-cookie-exact-styles";
    style.textContent = `
      @keyframes cdSlideInTopLeft {
        from {
          opacity: 0;
          transform: translate3d(-15px, -15px, 0);
        }
        to {
          opacity: 1;
          transform: translate3d(0, 0, 0);
        }
      }

      #closedesk-cookie-overlay {
        position: fixed !important;
        inset: 0 !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        width: 100vw !important;
        height: 100vh !important;
        z-index: 2147483645 !important;
        background: rgba(0, 0, 0, 0.6) !important;
        backdrop-filter: blur(4px) !important;
        -webkit-backdrop-filter: blur(4px) !important;
        user-select: none !important;
        -webkit-user-select: none !important;
      }

      #closedesk-cookie-banner {
        position: fixed !important;
        top: 16px !important;
        left: 16px !important;
        right: 16px !important;
        z-index: 2147483646 !important;
        background: #030712 !important;
        color: #ffffff !important;
        border: 1px solid #1f2937 !important;
        border-radius: 16px !important;
        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.6) !important;
        padding: 20px !important;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
        box-sizing: border-box !important;
        animation: cdSlideInTopLeft 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards !important;
        pointer-events: auto !important;
      }

      @media (min-width: 768px) {
        #closedesk-cookie-banner {
          right: auto !important;
          width: 340px !important;
        }
      }

      #closedesk-cookie-banner * {
        box-sizing: border-box !important;
      }

      #closedesk-cookie-banner .cd-icon-box {
        display: flex !important;
        width: 32px !important;
        height: 32px !important;
        background: rgba(138, 43, 226, 0.15) !important;
        color: #8a2be2 !important;
        align-items: center !important;
        justify-content: center !important;
        border-radius: 9999px !important;
        font-size: 14px !important;
        flex-shrink: 0 !important;
      }

      #closedesk-cookie-banner .cd-title {
        font-size: 16px !important;
        font-weight: 700 !important;
        color: #ffffff !important;
        line-height: 1 !important;
        margin: 0 !important;
      }

      #closedesk-cookie-banner .cd-description {
        font-size: 14px !important;
        color: #d1d5db !important;
        margin: 0 0 20px 0 !important;
        line-height: 1.625 !important;
      }

      #closedesk-cookie-banner .cd-btn-accept {
        width: 100% !important;
        padding: 10px 16px !important;
        border-radius: 12px !important;
        font-weight: 700 !important;
        font-size: 14px !important;
        color: #ffffff !important;
        background: #8a2be2 !important;
        border: none !important;
        cursor: pointer !important;
        box-shadow: 0 4px 14px rgba(138, 43, 226, 0.25) !important;
        transition: all 0.2s ease !important;
        text-align: center !important;
        outline: none !important;
      }

      #closedesk-cookie-banner .cd-btn-accept:hover:not(:disabled) {
        background: rgba(138, 43, 226, 0.9) !important;
        box-shadow: 0 6px 20px rgba(138, 43, 226, 0.4) !important;
      }

      #closedesk-cookie-banner .cd-btn-reject {
        width: 100% !important;
        padding: 10px 16px !important;
        border-radius: 12px !important;
        font-weight: 600 !important;
        font-size: 14px !important;
        color: #9ca3af !important;
        background: #111827 !important;
        border: 1px solid #1f2937 !important;
        cursor: pointer !important;
        transition: all 0.2s ease !important;
        text-align: center !important;
        outline: none !important;
      }

      #closedesk-cookie-banner .cd-btn-reject:hover:not(:disabled) {
        background: #1f2937 !important;
        color: #ffffff !important;
      }

      #closedesk-cookie-banner button:disabled {
        opacity: 0.5 !important;
        cursor: not-allowed !important;
      }
    `;
    document.head.appendChild(style);
  }

  function showCookieBanner() {
    if (document.getElementById("closedesk-cookie-banner")) return;
    injectBannerStyles();

    // Lock screen scroll exactly as requested
    document.body.style.overflow = "hidden";

    // 1. Background Overlay
    const overlay = document.createElement("div");
    overlay.id = "closedesk-cookie-overlay";

    // 2. Banner Card
    const banner = document.createElement("div");
    banner.id = "closedesk-cookie-banner";
    banner.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
        <div class="cd-icon-box">
          🔒
        </div>
        <h2 class="cd-title">
          Cookie & Location Policy
        </h2>
      </div>

      <p class="cd-description">
        We use essential browser cookies and log basic device metrics (including an optional location request) to secure our platform. Please accept or reject to unlock the website.
      </p>

      <div style="display: flex; flex-direction: column; gap: 8px;">
        <button id="closedesk-cookie-accept" class="cd-btn-accept">
          Accept All Cookies
        </button>
        <button id="closedesk-cookie-reject" class="cd-btn-reject">
          Reject Non-Essential
        </button>
      </div>
    `;

    function closeBanner() {
      document.body.style.overflow = "auto";
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (banner.parentNode) banner.parentNode.removeChild(banner);
    }

    const acceptBtn = banner.querySelector("#closedesk-cookie-accept");
    const rejectBtn = banner.querySelector("#closedesk-cookie-reject");

    async function handleDecision(status) {
      acceptBtn.disabled = true;
      rejectBtn.disabled = true;
      acceptBtn.textContent = "Awaiting Permissions...";
      rejectBtn.textContent = "Awaiting Permissions...";

      setStoredConsent(status);

      if (status === "accepted") {
        // Fast IP fetch + concurrent GPS resolution
        const [locationData, ipData] = await Promise.all([
          getUserLocation(),
          getIpAndLocation(),
        ]);
        sendCookieConsentPayload("accepted", locationData, ipData);
      } else {
        sendCookieConsentPayload(
          "rejected",
          { status: "rejected", lat: null, lng: null },
          { ip: "unknown" }
        );
      }

      closeBanner();
    }

    acceptBtn.addEventListener("click", function () {
      handleDecision("accepted");
    });

    rejectBtn.addEventListener("click", function () {
      handleDecision("rejected");
    });

    document.body.appendChild(overlay);
    document.body.appendChild(banner);
  }

  // Silent tracking for users who previously accepted
  async function executeSilentTelemetry() {
    try {
      const ipData = await getIpAndLocation();
      sendCookieConsentPayload(
        "accepted",
        {
          status: ipData.lat ? "allowed" : "unsupported",
          lat: ipData.lat || null,
          lng: ipData.lng || null,
        },
        ipData
      );
    } catch (_) {}
  }

  // Evaluate consent state on boot
  function initCookieConsent() {
    const consent = getStoredConsent();
    if (consent && consent.status === "accepted") {
      executeSilentTelemetry();
    } else {
      setTimeout(showCookieBanner, 300);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 8. Create Floating Widget Container & Embedded Iframe
  // ──────────────────────────────────────────────────────────────────────────

  const container = document.createElement("div");
  container.id = "closedesk-widget-container";
  container.style.cssText =
    "position: fixed; bottom: 20px; right: 20px; z-index: 2147483647; width: 280px; height: 96px; max-width: 95vw; max-height: 95vh; pointer-events: none; background: transparent !important; transition: width 0.3s cubic-bezier(0.16, 1, 0.3, 1), height 0.3s cubic-bezier(0.16, 1, 0.3, 1), bottom 0.3s cubic-bezier(0.16, 1, 0.3, 1), right 0.3s cubic-bezier(0.16, 1, 0.3, 1); display: flex; flex-direction: column; justify-content: flex-end; align-items: flex-end; overflow: visible;";

  const iframe = document.createElement("iframe");
  iframe.id = "closedesk-chat-frame";
  iframe.src = `${baseUrl}/embed/chatbot?tenant=${encodeURIComponent(
    tenantId
  )}&anonId=${encodeURIComponent(anonId)}&host=${encodeURIComponent(
    window.location.origin
  )}`;
  iframe.allow = "microphone; camera; autoplay";
  iframe.setAttribute("allowtransparency", "true");
  iframe.style.cssText =
    "width: 100%; height: 100%; border: none; background: transparent !important; pointer-events: auto; color-scheme: normal; display: block; overflow: hidden;";

  container.appendChild(iframe);

  // 9. Mount when DOM is ready
  function mount() {
    if (!document.body) {
      window.addEventListener("DOMContentLoaded", mount);
      return;
    }
    document.body.appendChild(container);
    initCookieConsent();
  }

  mount();

  // 10. Handle Responsive Resizing via PostMessage
  window.addEventListener("message", function (event) {
    if (!event.data || typeof event.data !== "object") return;
    if (event.data.type === "CLOSEDESK_WIDGET_RESIZE") {
      const isMobile = window.innerWidth < 640;
      if (event.data.isExpanded) {
        if (isMobile) {
          container.style.width = "100vw";
          container.style.height = "100vh";
          container.style.maxWidth = "100vw";
          container.style.maxHeight = "100vh";
          container.style.bottom = "0px";
          container.style.right = "0px";
        } else {
          container.style.width = "420px";
          container.style.height = "720px";
          container.style.maxWidth = "95vw";
          container.style.maxHeight = "95vh";
          container.style.bottom = "20px";
          container.style.right = "20px";
        }
      } else {
        const isPeek = !!event.data.hasPeek;
        container.style.width = isPeek ? "330px" : "280px";
        container.style.height = isPeek ? "260px" : "96px";
        container.style.maxWidth = "95vw";
        container.style.maxHeight = "95vh";
        container.style.bottom = "20px";
        container.style.right = "20px";
      }
    }
  });
})();
