"use client";

import React, { useState, memo, useEffect, useCallback, useRef } from "react";
import { APIProvider, Map, AdvancedMarker, useMap } from "@vis.gl/react-google-maps";

// Cached reverse geocodes to prevent duplicate network calls
const geocodeCache = {};

async function reverseGeocodeCoords(lat, lng) {
  const key = `${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
  if (geocodeCache[key]) return geocodeCache[key];

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1&accept-language=en`,
      { headers: { "User-Agent": "CloseDesk-Pulse/2.1" } }
    );
    if (res.ok) {
      const data = await res.json();
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
      const result = [locality, country].filter(Boolean).join(", ");
      if (result) {
        geocodeCache[key] = result;
        return result;
      }
    }
  } catch (_) {}

  const fallback = `Lat: ${Number(lat).toFixed(4)}, Lng: ${Number(lng).toFixed(4)}`;
  geocodeCache[key] = fallback;
  return fallback;
}

// Controller component to reliably control Google Maps camera using useMap()
function MapCameraController({ markers, activeMarkerId, mapCenter, mapZoom }) {
  const map = useMap();
  const hasAutoCentered = useRef(false);

  // 1. Pan & Zoom directly to active marker when selected
  useEffect(() => {
    if (!map || !activeMarkerId) return;
    const target = markers.find((m) => m.id === activeMarkerId);
    if (target && target.location?.lat && target.location?.lng) {
      map.panTo({
        lat: Number(target.location.lat),
        lng: Number(target.location.lng),
      });
      map.setZoom(15);
    }
  }, [map, activeMarkerId, markers]);

  // 2. Automatically center on initial load or when markers arrive
  useEffect(() => {
    if (!map || !markers || markers.length === 0) return;

    if (markers.length === 1) {
      const single = markers[0];
      if (single.location?.lat && single.location?.lng && !hasAutoCentered.current) {
        hasAutoCentered.current = true;
        map.setCenter({
          lat: Number(single.location.lat),
          lng: Number(single.location.lng),
        });
        map.setZoom(14);
      }
    } else if (!hasAutoCentered.current) {
      const bounds = new google.maps.LatLngBounds();
      let hasValidCoords = false;
      markers.forEach((m) => {
        if (m.location?.lat && m.location?.lng) {
          bounds.extend({
            lat: Number(m.location.lat),
            lng: Number(m.location.lng),
          });
          hasValidCoords = true;
        }
      });
      if (hasValidCoords) {
        hasAutoCentered.current = true;
        map.fitBounds(bounds, { top: 60, right: 60, bottom: 60, left: 60 });
      }
    }
  }, [map, markers]);

  return null;
}

// High-Tech Custom Marker with Sonar Radar Wave Rings
const CustomGoogleMarker = memo(({ cookie, isJustNow, isActive, onMarkerClick }) => {
  const lat = Number(cookie.location?.lat);
  const lng = Number(cookie.location?.lng);

  const [placeName, setPlaceName] = useState(
    cookie.ipLocation?.city
      ? `${cookie.ipLocation.city}, ${cookie.ipLocation.country || ""}`.replace(/,\s*$/, "")
      : ""
  );

  useEffect(() => {
    if (isNaN(lat) || isNaN(lng)) return;
    let isMounted = true;

    reverseGeocodeCoords(lat, lng).then((resolvedName) => {
      if (isMounted && resolvedName) {
        setPlaceName(resolvedName);
      }
    });

    return () => {
      isMounted = false;
    };
  }, [lat, lng]);

  if (isNaN(lat) || isNaN(lng)) return null;

  return (
    <AdvancedMarker
      position={{ lat, lng }}
      onClick={() => onMarkerClick(cookie.id, cookie.location)}
      zIndex={isActive ? 100 : isJustNow ? 50 : 1}
    >
      <div className="relative flex flex-col items-center justify-center cursor-pointer select-none">
        {/* Multi-layered Sonar Radar Beacon Effect for Active/New Devices */}
        {isJustNow && (
          <div className="absolute top-[12px] left-[12px] -translate-x-1/2 -translate-y-1/2 pointer-events-none w-0 h-0 flex items-center justify-center">
            <div className="sonar-beacon-core" />
            <div className="sonar-wave sonar-delay-1" />
            <div className="sonar-wave sonar-delay-2" />
            <div className="sonar-wave sonar-delay-3" />
          </div>
        )}

        {/* Marker Icon Pin */}
        <div className="relative group/pin transition-transform duration-200 hover:scale-125 z-10">
          <svg width="28" height="28" viewBox="0 0 24 24" className="drop-shadow-lg">
            <path
              d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"
              fill="var(--primary)"
              stroke="#ffffff"
              strokeWidth="1.5"
            />
          </svg>
          {isJustNow && (
            <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500 border border-white dark:border-black"></span>
            </span>
          )}
        </div>

        {/* Selected Marker Detail Card */}
        {isActive && (
          <div className="absolute bottom-[36px] flex flex-col items-center pointer-events-none bg-white text-gray-900 px-3.5 py-2 rounded-xl shadow-2xl border border-gray-200 min-w-max animate-in fade-in zoom-in-95 duration-200 z-50">
            <span className="text-xs font-bold text-gray-900 tracking-wide leading-tight">{cookie.username}</span>
            <span className="text-[11px] font-semibold text-[var(--primary)] leading-tight mt-1">
              {placeName || `Lat: ${lat.toFixed(4)}, Lng: ${lng.toFixed(4)}`}
            </span>
            <span className="text-[9px] text-gray-500 font-mono mt-0.5">
              ({lat.toFixed(4)}, {lng.toFixed(4)})
            </span>
            <div className="w-2.5 h-2.5 bg-white border-r border-b border-gray-200 rotate-45 absolute -bottom-1.5 left-1/2 -translate-x-1/2"></div>
          </div>
        )}
      </div>
    </AdvancedMarker>
  );
});

export default function CookieMap({
  mappedCookies,
  viewMode,
  now,
  activeMapMarker,
  setActiveMapMarker,
}) {
  // Derive default initial center from latest visitor if available
  const initialCenter =
    mappedCookies.length > 0 &&
    mappedCookies[0].location?.lat &&
    mappedCookies[0].location?.lng
      ? {
          lat: Number(mappedCookies[0].location.lat),
          lng: Number(mappedCookies[0].location.lng),
        }
      : { lat: 33.6378, lng: 73.067 }; // Default region

  const [mapCenter, setMapCenter] = useState(initialCenter);
  const [mapZoom, setMapZoom] = useState(mappedCookies.length > 0 ? 12 : 4);

  const handleZoomIn = (e) => {
    e.stopPropagation();
    setMapZoom((prev) => Math.min(prev + 1, 18));
  };
  const handleZoomOut = (e) => {
    e.stopPropagation();
    setMapZoom((prev) => Math.max(prev - 1, 2));
  };

  const handleResetMap = (e) => {
    if (e) e.stopPropagation();
    setActiveMapMarker(null);
    if (mappedCookies.length > 0 && mappedCookies[0].location?.lat) {
      setMapCenter({
        lat: Number(mappedCookies[0].location.lat),
        lng: Number(mappedCookies[0].location.lng),
      });
      setMapZoom(13);
    } else {
      setMapZoom(4);
      setMapCenter(initialCenter);
    }
  };

  const handleMarkerClick = useCallback(
    (id, location) => {
      setActiveMapMarker((prev) => (prev === id ? null : id));
      if (location && location.lat && location.lng) {
        setMapCenter({
          lat: Number(location.lat),
          lng: Number(location.lng),
        });
        setMapZoom(15);
      }
    },
    [setActiveMapMarker]
  );

  return (
    <div
      id="closedesk-radar-map"
      className="lg:col-span-3 theme-glass-card border border-[var(--border-color)] rounded-3xl relative overflow-hidden flex items-center justify-center min-h-[440px] shadow-sm group bg-[var(--card-bg)]"
    >
      {/* High-Tech Sonar Ripple Animations Scoped styles */}
      <style>{`
        @keyframes sonarWave {
          0% { width: 14px; height: 14px; opacity: 0.95; box-shadow: 0 0 10px 2px var(--primary); }
          50% { opacity: 0.45; }
          100% { width: 110px; height: 110px; opacity: 0; box-shadow: 0 0 25px 6px var(--primary); }
        }
        @keyframes beaconCoreBreath {
          0%, 100% { transform: scale(0.9); opacity: 0.8; }
          50% { transform: scale(1.4); opacity: 1; box-shadow: 0 0 18px 4px var(--primary); }
        }
        .sonar-beacon-core {
          position: absolute; width: 12px; height: 12px; border-radius: 9999px;
          background: var(--primary); box-shadow: 0 0 10px 2px var(--primary);
          animation: beaconCoreBreath 2s ease-in-out infinite;
        }
        .sonar-wave {
          position: absolute; border-radius: 9999px; border: 1.5px solid var(--primary);
          background: radial-gradient(circle, var(--primary) 0%, transparent 60%);
          animation: sonarWave 2.8s cubic-bezier(0.1, 0.7, 0.3, 1) infinite;
          pointer-events: none;
        }
        .sonar-delay-1 { animation-delay: 0s; }
        .sonar-delay-2 { animation-delay: 0.9s; }
        .sonar-delay-3 { animation-delay: 1.8s; }
        .gmnoprint, .gm-style-cc { display: none !important; }
      `}</style>

      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,var(--primary)_0%,transparent_70%)] opacity-[0.04] pointer-events-none z-[5]"></div>

      <div className="absolute top-6 left-6 z-30 pointer-events-none bg-[var(--background)]/85 backdrop-blur-md border border-[var(--border-color)] px-4 py-3 rounded-2xl shadow-sm">
        <h3 className="text-sm font-bold text-[var(--foreground)] flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          {viewMode === "active" ? "Live Global Tracker" : "Archived Global Tracker"}
        </h3>
        <p className="text-[10px] text-[var(--foreground-muted)] mt-1 font-mono uppercase tracking-wider">
          {mappedCookies.length} nodes active
        </p>
      </div>

      <div className="absolute inset-0 z-[10]">
        <APIProvider apiKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY}>
          <Map
            mapId={process.env.NEXT_PUBLIC_GOOGLE_MAP_ID}
            zoom={mapZoom}
            center={mapCenter}
            onCameraChanged={(ev) => {
              setMapZoom(ev.detail.zoom);
              setMapCenter(ev.detail.center);
            }}
            onClick={() => setActiveMapMarker(null)}
            disableDefaultUI={true}
            gestureHandling="greedy"
          >
            <MapCameraController
              markers={mappedCookies}
              activeMarkerId={activeMapMarker}
              mapCenter={mapCenter}
              mapZoom={mapZoom}
            />

            {mappedCookies.map((c) => {
              const isJustNow = now - new Date(c.updatedAt).getTime() < 60000;
              return (
                <CustomGoogleMarker
                  key={c.id}
                  cookie={c}
                  isJustNow={isJustNow}
                  isActive={activeMapMarker === c.id}
                  onMarkerClick={handleMarkerClick}
                />
              );
            })}
          </Map>
        </APIProvider>
      </div>

      {/* Map Controls */}
      <div className="absolute bottom-6 right-6 flex items-center bg-[var(--background)]/85 backdrop-blur-md border border-[var(--border-color)] rounded-full z-30 shadow-lg p-1">
        <button
          onClick={handleZoomIn}
          title="Zoom In"
          className="w-8 h-8 flex items-center justify-center text-[var(--foreground)] rounded-full hover:bg-[var(--card-bg)] hover:text-[var(--primary)] transition-colors cursor-pointer"
        >
          <svg className="w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
          </svg>
        </button>
        <div className="w-[1px] h-4 bg-[var(--border-color)] mx-1"></div>
        <button
          onClick={handleZoomOut}
          title="Zoom Out"
          className="w-8 h-8 flex items-center justify-center text-[var(--foreground)] rounded-full hover:bg-[var(--card-bg)] hover:text-[var(--primary)] transition-colors cursor-pointer"
        >
          <svg className="w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 12H4" />
          </svg>
        </button>
        <div className="w-[1px] h-4 bg-[var(--border-color)] mx-1"></div>
        <button
          onClick={handleResetMap}
          title="Reset to Active Nodes"
          className="w-8 h-8 flex items-center justify-center text-[var(--foreground)] rounded-full hover:bg-[var(--card-bg)] hover:text-[var(--primary)] transition-colors cursor-pointer"
        >
          <svg className="w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
