// // src/Closedesk/Essential/CookieConsentBanner.jsx
// import React, { useState, useEffect } from "react";
// import { ref, set } from "firebase/database";
// import { db } from "../../lib/firebase";
// import {
//   setStrictCookie,
//   getStrictCookie,
//   getOrCreateAnonId,
//   CONSENT_COOKIE_NAME,
// } from "../../lib/cookiePersonalization";

// // Implement the Website Logger and Tracer
// import { createWebsiteLogger } from "../../lib/loggerPresets";
// import { generateCorrelationId } from "../../lib/tracer";

// const baseLogger = createWebsiteLogger("CookieConsentBanner");

// /**
//  * Helper: Parses the browser environment into a clean, readable Device Name
//  */
// function getReadableDeviceName() {
//   if (typeof window === "undefined") return "Unknown Device";
//   const ua = navigator.userAgent;
//   let os = "Unknown OS";
//   let type = "Desktop";

//   if (/Windows/i.test(ua)) os = "Windows PC";
//   else if (/Macintosh|Mac OS X/i.test(ua)) os = "Macintosh";
//   else if (/Android/i.test(ua)) {
//     os = "Android";
//     type = "Mobile";
//   } else if (/iPhone|iPad|iPod/i.test(ua)) {
//     os = "iOS Device";
//     type = "Mobile";
//   } else if (/Linux/i.test(ua)) os = "Linux";

//   if (/Tablet|iPad/i.test(ua)) type = "Tablet";

//   return `${os} (${type})`;
// }

// /**
//  * Helper: Fetches the user's public IPv4 address AND location based on that IP.
//  */
// const getIpAndLocation = async (txLogger = baseLogger) => {
//   try {
//     const response = await fetch("https://ipinfo.io/json");
//     const data = await response.json();
//     let lat = null,
//       lng = null;

//     if (data.loc) {
//       const [parsedLat, parsedLng] = data.loc.split(",");
//       lat = parseFloat(parsedLat);
//       lng = parseFloat(parsedLng);
//     }

//     return {
//       ip: data.ip || "unknown",
//       city: data.city || "Unknown",
//       region: data.region || "Unknown",
//       country: data.country || "Unknown",
//       lat,
//       lng,
//     };
//   } catch (error) {
//     txLogger.warn("network_request", "ip_fetch_failed", { error });
//     return {
//       ip: "unknown",
//       city: "Unknown",
//       region: "Unknown",
//       country: "Unknown",
//       lat: null,
//       lng: null,
//     };
//   }
// };

// /**
//  * Helper: Requests the user's location via the browser's Geolocation API.
//  */
// const getUserLocation = (txLogger = baseLogger) => {
//   return new Promise((resolve) => {
//     if (typeof window === "undefined" || !navigator.geolocation) {
//       resolve({ status: "unsupported", lat: null, lng: null });
//       return;
//     }

//     navigator.geolocation.getCurrentPosition(
//       (position) =>
//         resolve({
//           status: "allowed",
//           lat: position.coords.latitude,
//           lng: position.coords.longitude,
//         }),
//       (error) => {
//         txLogger.debug("user_action", "geolocation_denied", {
//           error,
//           context: { error_message: error.message },
//         });
//         resolve({
//           status: "rejected",
//           error: error.message,
//           lat: null,
//           lng: null,
//         });
//       },
//       { timeout: 8000 }
//     );
//   });
// };

// /**
//  * Helper: Silent tracker that runs regardless of whether the banner is open or closed
//  */
// const executeSilentTracking = async (consentStatus) => {
//   const txId = generateCorrelationId();
//   const txLogger = baseLogger.child({ correlation: { correlation_id: txId } });

//   const anonId = getOrCreateAnonId();
//   const deviceName = getReadableDeviceName();
//   const storedAppUser =
//     typeof window !== "undefined" ? localStorage.getItem("aicyro_username") : null;
//   const username = storedAppUser || `Visitor_${anonId ? anonId.substring(0, 8) : "Guest"}`;

//   const [locationData, ipData] = await Promise.all([
//     getUserLocation(txLogger),
//     getIpAndLocation(txLogger),
//   ]);

//   const payload = {
//     username,
//     deviceName,
//     anonId: anonId || "unknown",
//     consentStatus: consentStatus,
//     ipAddress: ipData.ip,
//     ipLocation: ipData,
//     language: typeof window !== "undefined" ? navigator.language : "unknown",
//     timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
//     updatedAt: new Date().toISOString(),
//     rawUserAgent: typeof window !== "undefined" ? navigator.userAgent : "unknown",
//     location: locationData,
//   };

//   try {
//     if (db && anonId) {
//       const userCookieRef = ref(db, `user_cookies/${anonId}`);
//       await set(userCookieRef, payload);
//     }
//   } catch (error) {
//     txLogger.error("database", "tracking_save_failed", { error });
//   }
// };

// export default function CookieConsentBanner() {
//   const [showBanner, setShowBanner] = useState(false);
//   const [isSaving, setIsSaving] = useState(false);

//   useEffect(() => {
//     if (typeof window === "undefined") return;

//     // Do not ask for cookies or run tracking on the /lg page
//     if (window.location.pathname === "/lg" || window.location.pathname.startsWith("/lg/")) {
//       return;
//     }

//     const existingConsent = getStrictCookie(CONSENT_COOKIE_NAME);

//     // ONLY hide the banner if the user previously explicitly "accepted"
//     if (existingConsent && existingConsent.status === "accepted") {
//       executeSilentTracking(existingConsent.status);
//     } else {
//       setShowBanner(true);
//       document.body.style.overflow = "hidden";

//       baseLogger.info("ui_render", "banner_displayed", {
//         context: { message: "Cookie banner locked screen" },
//       });
//     }

//     return () => {
//       document.body.style.overflow = "auto";
//     };
//   }, []);

//   const closeBanner = () => {
//     document.body.style.overflow = "auto";
//     setShowBanner(false);
//   };

//   const handleDecision = async (status) => {
//     setIsSaving(true);

//     if (status === "accepted") {
//       setStrictCookie(CONSENT_COOKIE_NAME, { status, timestamp: Date.now() });
//     } else {
//       document.cookie = `${CONSENT_COOKIE_NAME}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
//     }

//     await executeSilentTracking(status);

//     setIsSaving(false);
//     closeBanner();
//   };

//   if (!showBanner) return null;

//   return (
//     <>
//       {/* Background Overlay */}
//       <div className="fixed inset-0 z-[9998] bg-black/60 backdrop-blur-sm select-none" />

//       {/* Banner */}
//       <div className="fixed top-4 left-4 right-4 md:right-auto md:w-[340px] z-[9999] bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-2xl shadow-2xl p-5 animate-in slide-in-from-top-5 slide-in-from-left-5 duration-300">
//         <div className="flex items-center gap-3 mb-3">
//           <div className="flex w-8 h-8 bg-primary/10 text-primary items-center justify-center rounded-full text-sm shrink-0">
//             🔒
//           </div>
//           <h2 className="text-base font-bold text-gray-900 dark:text-white leading-none">
//             Cookie & Location Policy
//           </h2>
//         </div>

//         <p className="text-sm text-gray-600 dark:text-gray-300 mb-5 leading-relaxed">
//           We use essential browser cookies and log basic device metrics
//           (including an optional location request) to secure our platform.
//           Please accept or reject to unlock the website.
//         </p>

//         <div className="flex flex-col gap-2">
//           <button
//             onClick={() => handleDecision("accepted")}
//             disabled={isSaving}
//             className="w-full py-2.5 px-4 rounded-xl font-bold text-sm text-white bg-primary hover:bg-primary/90 shadow hover:shadow-primary/25 transition-all disabled:opacity-50"
//           >
//             {isSaving ? "Awaiting Permissions..." : "Accept All Cookies"}
//           </button>

//           <button
//             onClick={() => handleDecision("rejected")}
//             disabled={isSaving}
//             className="w-full py-2.5 px-4 rounded-xl font-semibold text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white bg-gray-100 dark:bg-gray-900 hover:bg-gray-200 dark:hover:bg-gray-800 transition-all disabled:opacity-50"
//           >
//             {isSaving ? "Awaiting Permissions..." : "Reject Non-Essential"}
//           </button>
//         </div>
//       </div>
//     </>
//   );
// }

//
//
//
//
//
//
//
//
//
//
//

// src/Closedesk/Essential/CookieConsentBanner.jsx
import React, { useState, useEffect } from "react";
import { ref, set } from "firebase/database";
import { db } from "../../lib/firebase";
import {
  setStrictCookie,
  getStrictCookie,
  getOrCreateAnonId,
  CONSENT_COOKIE_NAME,
} from "../../lib/cookiePersonalization";

// Implement the Website Logger and Tracer
import { createWebsiteLogger } from "../../lib/loggerPresets";
import { generateCorrelationId } from "../../lib/tracer";

const baseLogger = createWebsiteLogger("CookieConsentBanner");

/**
 * Helper: Parses the browser environment into a clean, readable Device Name
 */
function getReadableDeviceName() {
  if (typeof window === "undefined") return "Unknown Device";
  const ua = navigator.userAgent;
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

/**
 * Helper: Fetches the user's public IPv4 address AND location based on that IP.
 */
const getIpAndLocation = async (txLogger = baseLogger) => {
  try {
    const response = await fetch("https://ipinfo.io/json");
    const data = await response.json();
    let lat = null,
      lng = null;

    if (data.loc) {
      const [parsedLat, parsedLng] = data.loc.split(",");
      lat = parseFloat(parsedLat);
      lng = parseFloat(parsedLng);
    }

    return {
      ip: data.ip || "unknown",
      city: data.city || "Unknown",
      region: data.region || "Unknown",
      country: data.country || "Unknown",
      lat,
      lng,
    };
  } catch (error) {
    txLogger.warn("network_request", "ip_fetch_failed", { error });
    return {
      ip: "unknown",
      city: "Unknown",
      region: "Unknown",
      country: "Unknown",
      lat: null,
      lng: null,
    };
  }
};

/**
 * Helper: Requests the user's location via the browser's Geolocation API.
 * UPDATED: Includes enableHighAccuracy to force actual GPS coordinates.
 */
const getUserLocation = (txLogger = baseLogger) => {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !navigator.geolocation) {
      resolve({ status: "unsupported", lat: null, lng: null });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          status: "allowed",
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        }),
      (error) => {
        txLogger.debug("user_action", "geolocation_denied", {
          error,
          context: { error_message: error.message },
        });
        resolve({
          status: "rejected",
          error: error.message,
          lat: null,
          lng: null,
        });
      },
      { 
        enableHighAccuracy: true, // Forces exact GPS location
        timeout: 15000,           // Give the GPS chip enough time to lock
        maximumAge: 0 
      }
    );
  });
};

/**
 * Helper: Silent tracker that runs regardless of whether the banner is open or closed
 */
const executeSilentTracking = async (consentStatus) => {
  const txId = generateCorrelationId();
  const txLogger = baseLogger.child({ correlation: { correlation_id: txId } });

  const anonId = getOrCreateAnonId();
  const deviceName = getReadableDeviceName();
  const storedAppUser =
    typeof window !== "undefined" ? localStorage.getItem("aicyro_username") : null;
  const username = storedAppUser || `Visitor_${anonId ? anonId.substring(0, 8) : "Guest"}`;

  const [locationData, ipData] = await Promise.all([
    getUserLocation(txLogger),
    getIpAndLocation(txLogger),
  ]);

  const payload = {
    username,
    deviceName,
    anonId: anonId || "unknown",
    consentStatus: consentStatus,
    ipAddress: ipData.ip,
    ipLocation: ipData,
    language: typeof window !== "undefined" ? navigator.language : "unknown",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    updatedAt: new Date().toISOString(),
    rawUserAgent: typeof window !== "undefined" ? navigator.userAgent : "unknown",
    location: locationData,
  };

  try {
    // If you are also sending this payload to your API route, you can place the fetch() call here.
    if (db && anonId) {
      const userCookieRef = ref(db, `user_cookies/${anonId}`);
      await set(userCookieRef, payload);
    }
  } catch (error) {
    txLogger.error("database", "tracking_save_failed", { error });
  }
};

export default function CookieConsentBanner() {
  const [showBanner, setShowBanner] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Do not ask for cookies or run tracking on the /lg page
    if (window.location.pathname === "/lg" || window.location.pathname.startsWith("/lg/")) {
      return;
    }

    const existingConsent = getStrictCookie(CONSENT_COOKIE_NAME);

    // ONLY hide the banner if the user previously explicitly "accepted"
    if (existingConsent && existingConsent.status === "accepted") {
      executeSilentTracking(existingConsent.status);
    } else {
      setShowBanner(true);
      document.body.style.overflow = "hidden";

      baseLogger.info("ui_render", "banner_displayed", {
        context: { message: "Cookie banner locked screen" },
      });
    }

    return () => {
      document.body.style.overflow = "auto";
    };
  }, []);

  const closeBanner = () => {
    document.body.style.overflow = "auto";
    setShowBanner(false);
  };

  const handleDecision = async (status) => {
    setIsSaving(true);

    if (status === "accepted") {
      setStrictCookie(CONSENT_COOKIE_NAME, { status, timestamp: Date.now() });
    } else {
      document.cookie = `${CONSENT_COOKIE_NAME}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;`;
    }

    await executeSilentTracking(status);

    setIsSaving(false);
    closeBanner();
  };

  if (!showBanner) return null;

  return (
    <>
      {/* Background Overlay */}
      <div className="fixed inset-0 z-[9998] bg-black/60 backdrop-blur-sm select-none" />

      {/* Banner */}
      <div className="fixed top-4 left-4 right-4 md:right-auto md:w-[340px] z-[9999] bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-2xl shadow-2xl p-5 animate-in slide-in-from-top-5 slide-in-from-left-5 duration-300">
        <div className="flex items-center gap-3 mb-3">
          <div className="flex w-8 h-8 bg-primary/10 text-primary items-center justify-center rounded-full text-sm shrink-0">
            🔒
          </div>
          <h2 className="text-base font-bold text-gray-900 dark:text-white leading-none">
            Cookie & Location Policy
          </h2>
        </div>

        <p className="text-sm text-gray-600 dark:text-gray-300 mb-5 leading-relaxed">
          We use essential browser cookies and log basic device metrics
          (including an optional location request) to secure our platform.
          Please accept or reject to unlock the website.
        </p>

        <div className="flex flex-col gap-2">
          <button
            onClick={() => handleDecision("accepted")}
            disabled={isSaving}
            className="w-full py-2.5 px-4 rounded-xl font-bold text-sm text-white bg-primary hover:bg-primary/90 shadow hover:shadow-primary/25 transition-all disabled:opacity-50"
          >
            {isSaving ? "Awaiting Permissions..." : "Accept All Cookies"}
          </button>

          <button
            onClick={() => handleDecision("rejected")}
            disabled={isSaving}
            className="w-full py-2.5 px-4 rounded-xl font-semibold text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white bg-gray-100 dark:bg-gray-900 hover:bg-gray-200 dark:hover:bg-gray-800 transition-all disabled:opacity-50"
          >
            {isSaving ? "Awaiting Permissions..." : "Reject Non-Essential"}
          </button>
        </div>
      </div>
    </>
  );
}