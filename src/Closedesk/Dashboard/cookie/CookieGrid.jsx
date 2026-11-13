"use client";

import React, { useEffect, useState } from "react";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const getRelativeTime = (timestamp, now) => {
  const diffInSeconds = Math.floor((now - new Date(timestamp).getTime()) / 1000);
  if (diffInSeconds < 30) return "Just now";
  if (diffInSeconds < 60) return `${diffInSeconds} sec ago`;
  if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)} min ago`;
  if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)} hr ago`;
  return new Date(timestamp).toLocaleDateString();
};

const getArchiveTimeLeft = (archivedAt, now) => {
  if (!archivedAt) return "Pending 30-day cycle";
  const expiryTime = new Date(archivedAt).getTime() + THIRTY_DAYS_MS;
  const diffInSeconds = Math.floor((expiryTime - now) / 1000);

  if (diffInSeconds <= 0) return "Deleting momentarily...";
  if (diffInSeconds < 60) return `${diffInSeconds} sec left`;
  if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)} min left`;
  if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)} hr left`;
  return `${Math.floor(diffInSeconds / 86400)} days left`;
};

// Global cache for geocodes
const gridGeocodeCache = {};

const LocationRenderer = ({ location }) => {
  const lat = Number(location?.lat);
  const lng = Number(location?.lng);
  const [placeName, setPlaceName] = useState("");

  useEffect(() => {
    if (location?.status !== "allowed" || isNaN(lat) || isNaN(lng)) return;

    const cacheKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (gridGeocodeCache[cacheKey]) {
      setPlaceName(gridGeocodeCache[cacheKey]);
      return;
    }

    let isMounted = true;
    fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1&accept-language=en`,
      { headers: { "User-Agent": "CloseDesk-Pulse/2.1" } }
    )
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => {
        if (!isMounted) return;
        const addr = data.address || {};
        const locality =
          addr.suburb ||
          addr.neighbourhood ||
          addr.city ||
          addr.town ||
          addr.village ||
          addr.county ||
          "";
        const country = addr.country || "";
        const formatted = [locality, country].filter(Boolean).join(", ");
        if (formatted) {
          gridGeocodeCache[cacheKey] = formatted;
          setPlaceName(formatted);
        }
      })
      .catch(() => {});

    return () => {
      isMounted = false;
    };
  }, [location?.status, lat, lng]);

  if (location?.status === "rejected") return <span>Permission Denied</span>;
  if (location?.status === "unsupported") return <span>Unsupported</span>;
  if (location?.status !== "allowed" || isNaN(lat) || isNaN(lng)) return <span>Not Captured</span>;

  return (
    <a
      href={`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="text-[var(--primary)] hover:underline flex items-center gap-1.5 transition-all truncate w-full"
      title={placeName ? `${placeName} (${lat.toFixed(4)}, ${lng.toFixed(4)})` : `${lat.toFixed(4)}, ${lng.toFixed(4)}`}
    >
      <span className="truncate">
        {placeName ? <span className="font-medium mr-1">{placeName}</span> : ""}
        <span className="text-[10px] opacity-75">({lat.toFixed(4)}, {lng.toFixed(4)})</span>
      </span>
      <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
      </svg>
    </a>
  );
};

export default function CookieGrid({
  displayCookies,
  now,
  viewMode,
  selectedCookies,
  toggleSelection,
  hasActiveFilters,
  clearFilters,
  onFocusMap,
}) {
  if (displayCookies.length === 0) {
    return (
      <div className="text-center py-20 theme-glass-card border-dashed">
        <p className="text-[var(--foreground-muted)] font-medium">
          {hasActiveFilters
            ? "No sessions match your current filters."
            : viewMode === "active"
            ? "No active sessions found."
            : "No archived sessions found."}
        </p>
        {hasActiveFilters && (
          <button onClick={clearFilters} className="mt-4 text-sm text-[var(--primary)] hover:underline">
            Clear filters
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {displayCookies.map((cookie) => {
        const isJustNow = now - new Date(cookie.updatedAt).getTime() < 60000;
        const consentAccepted = cookie.consentStatus === "accepted";
        const isSelected = selectedCookies.includes(cookie.id);
        const hasCoords = cookie.location?.lat && cookie.location?.lng;

        return (
          <div
            key={cookie.id}
            onClick={() => toggleSelection(cookie.id)}
            className={`theme-glass-card p-6 group relative overflow-hidden flex flex-col justify-between transition-all duration-300 cursor-pointer hover:-translate-y-1 hover:shadow-xl
              ${
                isSelected
                  ? "border-[var(--primary)] bg-[var(--primary)]/5 shadow-[0_8px_30px_rgb(0,0,0,0.12)] ring-2 ring-[var(--primary)] ring-offset-2 ring-offset-[var(--background)]"
                  : "hover:border-[var(--primary)]/50"
              } 
              ${isJustNow && !isSelected && viewMode === "active" ? "ring-1 ring-[var(--primary)]/30 ring-offset-1 ring-offset-[var(--background)]" : ""}
              ${viewMode === "archived" ? "opacity-80 hover:opacity-100 grayscale-[0.3]" : ""}
            `}
          >
            <div className="absolute -top-10 -right-10 w-32 h-32 bg-[var(--primary)] opacity-0 blur-[40px] group-hover:opacity-20 transition-opacity duration-700 pointer-events-none"></div>

            <div className="flex justify-between items-start mb-5 pb-4 border-b border-[var(--border-color)] relative z-10">
              <div className="flex flex-col gap-1">
                <span className="text-[var(--foreground)] font-bold text-base tracking-wide flex items-center gap-2">
                  {isSelected && (
                    <span className="flex items-center justify-center w-5 h-5 rounded-full bg-[var(--primary)] text-white shadow-[0_0_8px_var(--primary)] animate-in zoom-in-75 duration-200">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" />
                      </svg>
                    </span>
                  )}
                  {cookie.username}
                  {isJustNow && !isSelected && viewMode === "active" && (
                    <span className="text-[8px] uppercase tracking-wider bg-[var(--primary)] text-white px-1.5 py-0.5 rounded shadow-[0_0_8px_var(--primary)] animate-pulse">
                      Active
                    </span>
                  )}
                </span>
                <span className="text-xs font-medium text-[var(--foreground-muted)] flex items-center gap-1.5 mt-0.5">
                  <svg className="w-3.5 h-3.5 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  {getRelativeTime(cookie.updatedAt, now)}
                </span>
                {viewMode === "archived" && (
                  <span className="text-[10px] font-bold text-red-400 mt-1.5 flex items-center gap-1.5 animate-in fade-in duration-500 bg-red-500/10 w-fit px-2 py-0.5 rounded border border-red-500/20">
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                    {getArchiveTimeLeft(cookie.archivedAt, now)}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                {hasCoords && onFocusMap && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onFocusMap(cookie.id);
                    }}
                    title="Focus on Radar Map"
                    className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-[var(--primary)]/10 text-[var(--primary)] border border-[var(--primary)]/20 hover:bg-[var(--primary)] hover:text-white transition-all flex items-center gap-1"
                  >
                    <span>📍</span> Map
                  </button>
                )}

                <span
                  className={`text-[10px] font-bold px-3 py-1.5 rounded-full uppercase tracking-widest border flex items-center gap-1.5 shadow-sm transition-colors ${
                    consentAccepted
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
                      : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"
                  }`}
                >
                  <div
                    className={`w-1.5 h-1.5 rounded-full ${
                      consentAccepted ? "bg-emerald-500" : "bg-amber-500"
                    }`}
                  />
                  {cookie.consentStatus}
                </span>
              </div>
            </div>

            <div className="space-y-3 text-sm relative z-10">
              <p className="flex items-center gap-3">
                <span className="flex items-center justify-center w-7 h-7 shrink-0 rounded-lg bg-[var(--background)] border border-[var(--border-color)] text-[var(--primary)]">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2-2v10a2 2 0 002 2z"
                    />
                  </svg>
                </span>
                <strong className="text-[var(--foreground)] w-20 shrink-0">Device</strong>
                <span className="text-[var(--foreground-muted)] truncate flex-1">{cookie.deviceName}</span>
              </p>
              <p className="flex items-center gap-3">
                <span className="flex items-center justify-center w-7 h-7 shrink-0 rounded-lg bg-[var(--background)] border border-[var(--border-color)] text-[var(--primary)]">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </span>
                <strong className="text-[var(--foreground)] w-20 shrink-0">Region</strong>
                <span className="text-[var(--foreground-muted)] truncate flex-1">{cookie.timeZone}</span>
              </p>
              <p className="flex items-center gap-3">
                <span className="flex items-center justify-center w-7 h-7 shrink-0 rounded-lg bg-[var(--background)] border border-[var(--border-color)] text-[var(--primary)]">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129"
                    />
                  </svg>
                </span>
                <strong className="text-[var(--foreground)] w-20 shrink-0">Language</strong>
                <span className="text-[var(--foreground-muted)] truncate flex-1 uppercase">
                  {cookie.language}
                </span>
              </p>
              <p className="flex items-center gap-3">
                <span className="flex items-center justify-center w-7 h-7 shrink-0 rounded-lg bg-[var(--background)] border border-[var(--border-color)] text-[var(--primary)]">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                    />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </span>
                <strong className="text-[var(--foreground)] w-20 shrink-0">GPS Location</strong>
                <span className="text-[var(--foreground-muted)] truncate flex-1 flex items-center">
                  <LocationRenderer location={cookie.location} />
                </span>
              </p>
              <p className="flex items-center gap-3">
                <span className="flex items-center justify-center w-7 h-7 shrink-0 rounded-lg bg-[var(--background)] border border-[var(--border-color)] text-[var(--primary)]">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                    />
                  </svg>
                </span>
                <strong className="text-[var(--foreground)] w-20 shrink-0">IP Address</strong>
                <span className="text-[var(--foreground-muted)] truncate flex-1">
                  {cookie.ipAddress || "Unknown"}
                </span>
              </p>
              <p className="flex items-center gap-3">
                <span className="flex items-center justify-center w-7 h-7 shrink-0 rounded-lg bg-[var(--background)] border border-[var(--border-color)] text-[var(--primary)]">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                </span>
                <strong className="text-[var(--foreground)] w-20 shrink-0">IP Location</strong>
                <span className="text-[var(--foreground-muted)] truncate flex-1">
                  {cookie.ipLocation?.city
                    ? `${cookie.ipLocation.city}, ${cookie.ipLocation.country || ""}`
                    : "Unknown"}
                </span>
              </p>
            </div>

            <div className="mt-5 pt-4 border-t border-[var(--border-color)] relative z-10">
              <div className="flex items-center justify-between mb-2">
                <strong className="text-xs text-[var(--foreground)] flex items-center gap-1.5">
                  <svg className="w-3.5 h-3.5 text-[var(--foreground-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                  </svg>
                  Host Origin
                </strong>
                <span className="text-[10px] text-[var(--primary)] font-mono font-medium truncate max-w-[160px]">
                  {cookie.hostUrl || "Direct"}
                </span>
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between text-[9px] text-[var(--foreground-muted)] font-mono relative z-10">
              <span className="opacity-50">ID</span>
              <span className="opacity-60 truncate pl-4">{cookie.anonId}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
