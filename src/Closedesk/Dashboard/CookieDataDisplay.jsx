"use client";

import React, { useEffect, useState } from "react";
import { ref, onValue, remove, update } from "firebase/database";
import { db } from "../../lib/firebase";

import CookieMap from "./cookie/CookieMap";
import CookieGrid from "./cookie/CookieGrid";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const getRelativeTime = (timestamp, now) => {
  const diffInSeconds = Math.floor((now - new Date(timestamp).getTime()) / 1000);
  if (diffInSeconds < 30) return "Just now";
  if (diffInSeconds < 60) return `${diffInSeconds} sec ago`;
  if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)} min ago`;
  if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)} hr ago`;
  return new Date(timestamp).toLocaleDateString();
};

export default function CookieDataDisplay() {
  const [cookies, setCookies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());
  const [viewMode, setViewMode] = useState("active");

  const [selectedCookies, setSelectedCookies] = useState([]);
  const [activeMapMarker, setActiveMapMarker] = useState(null); 
  
  const [toast, setToast] = useState({ visible: false, message: "", type: "info" });
  const [confirmDialog, setConfirmDialog] = useState({ isOpen: false, title: "", message: "", onConfirm: null, confirmText: "Confirm", confirmColor: "bg-[var(--primary)]" });

  const [filters, setFilters] = useState({ device: "All", region: "All", language: "All", location: "All" });
  const [searchQuery, setSearchQuery] = useState(""); // 🔥 Search state added here

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);

  const getCookieDbPath = (subId = "") => {
    const tenantId = typeof window !== "undefined" ? (localStorage.getItem("currentTenant") || "default") : "default";
    const basePath = tenantId && tenantId !== "default" ? `tenants/${tenantId}/user_cookies` : "user_cookies";
    return subId ? `${basePath}/${subId}` : basePath;
  };

  useEffect(() => {
    const cookiesRef = ref(db, getCookieDbPath());

    const unsubscribe = onValue(
      cookiesRef,
      (snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.val();
          const currentTime = Date.now();
          const validData = [];
          Object.keys(data).forEach((key) => {
            const item = data[key];
            if (item.isArchived && item.archivedAt) {
              const archiveTime = new Date(item.archivedAt).getTime();
              if (currentTime - archiveTime >= THIRTY_DAYS_MS) {
                remove(ref(db, getCookieDbPath(key))).catch(console.error);
                return;
              }
            }
            validData.push({ id: key, ...item });
          });

          const formattedData = validData.sort((a, b) => {
            const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
            const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
            return timeB - timeA;
          });
          setCookies(formattedData);
        } else {
          setCookies([]);
        }
        setLoading(false);
      },
      (err) => {
        console.warn("RTDB direct cookie read restricted, falling back to server-mediated API:", err);
        const storedTenant = typeof window !== "undefined" ? localStorage.getItem("currentTenant") : null;
        fetch("/api/cookie-consent", {
          headers: storedTenant && storedTenant !== "default" ? { "x-tenant-id": storedTenant } : {},
        })
          .then((r) => r.json())
          .then((res) => {
            if (res && res.cookies) {
              const items = Object.entries(res.cookies).map(([id, val]) => ({ id, ...val }));
              setCookies(items);
            }
          })
          .catch(() => {})
          .finally(() => setLoading(false));
      }
    );

    return () => unsubscribe();
  }, []);

  const activeCookies = cookies.filter((c) => !c.isArchived);
  const archivedCookies = cookies.filter((c) => c.isArchived);
  let displayCookies = viewMode === "active" ? activeCookies : archivedCookies;

  // --- Apply Dropdown Filters ---
  if (filters.device !== "All") displayCookies = displayCookies.filter((c) => c.deviceName === filters.device);
  if (filters.region !== "All") displayCookies = displayCookies.filter((c) => c.timeZone === filters.region);
  if (filters.language !== "All") displayCookies = displayCookies.filter((c) => c.language === filters.language);
  if (filters.location !== "All") {
    displayCookies = displayCookies.filter((c) => {
      if (filters.location === "Captured") return c.location?.status === "allowed" && c.location?.lat;
      if (filters.location === "Denied") return c.location?.status === "rejected";
      if (filters.location === "Unsupported") return !c.location || c.location?.status === "unsupported";
      return true;
    });
  }

  // --- Apply Search Text Filter ---
  if (searchQuery.trim()) {
    const query = searchQuery.toLowerCase();
    displayCookies = displayCookies.filter((cookie) => {
      const nameMatch = cookie.username?.toLowerCase().includes(query);
      const regionMatch = cookie.timeZone?.toLowerCase().includes(query);
      const ipMatch = cookie.ipAddress?.toLowerCase().includes(query);
      const cityMatch = cookie.ipLocation?.city?.toLowerCase().includes(query);
      const countryMatch = cookie.ipLocation?.country?.toLowerCase().includes(query);
      return nameMatch || regionMatch || ipMatch || cityMatch || countryMatch;
    });
  }

  const mappedCookies = displayCookies.filter(
    (c) => c.location?.status === "allowed" && c.location?.lat && c.location?.lng,
  );

  const showToast = (message, type = "info") => {
    setToast({ visible: true, message, type });
    setTimeout(() => setToast((prev) => ({ ...prev, visible: false })), 4000);
  };

  const uniqueDevices = [...new Set(cookies.map((c) => c.deviceName).filter(Boolean))];
  const uniqueRegions = [...new Set(cookies.map((c) => c.timeZone).filter(Boolean))];
  const uniqueLanguages = [...new Set(cookies.map((c) => c.language).filter(Boolean))];

  useEffect(() => {
    if (viewMode === "archived" && archivedCookies.length === 0 && !loading) {
      setViewMode("active");
      setSelectedCookies([]);
    }
  }, [archivedCookies.length, viewMode, loading]);

  const toggleViewMode = () => {
    setViewMode((prev) => (prev === "active" ? "archived" : "active"));
    setSelectedCookies([]);
    setActiveMapMarker(null);
  };

  const handleFilterChange = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setSelectedCookies([]);
    setActiveMapMarker(null);
  };

  const clearFilters = () => {
    setFilters({ device: "All", region: "All", language: "All", location: "All" });
    setSearchQuery(""); // Clear search query as well
    setSelectedCookies([]);
    setActiveMapMarker(null);
  };

  const toggleSelection = (id) => {
    setSelectedCookies((prev) => prev.includes(id) ? prev.filter((cookieId) => cookieId !== id) : [...prev, id]);
  };

  const handleSelectAll = () => {
    if (selectedCookies.length === displayCookies.length && displayCookies.length > 0) {
      setSelectedCookies([]);
    } else {
      setSelectedCookies(displayCookies.map((c) => c.id));
    }
  };

  const handleArchiveSelected = () => {
    setConfirmDialog({
      isOpen: true,
      title: "Archive Sessions",
      message: `Are you sure you want to archive ${selectedCookies.length} session(s)?\n\nNote: Archived data will be permanently and automatically deleted after 30 days.`,
      confirmText: "Archive",
      confirmColor: "bg-indigo-500 hover:bg-indigo-600",
      onConfirm: async () => {
        try {
          const archivePromises = selectedCookies.map((id) =>
            update(ref(db, getCookieDbPath(id)), { isArchived: true, archivedAt: new Date().toISOString() })
          );
          await Promise.all(archivePromises);
          showToast(`Successfully archived ${selectedCookies.length} sessions.`, "success");
          setSelectedCookies([]);
        } catch (error) {
          console.error("Failed to archive cookies: ", error);
          showToast("Failed to archive selected sessions.", "error");
        }
        setConfirmDialog({ ...confirmDialog, isOpen: false });
      },
    });
  };

  const handleRestoreSelected = async () => {
    try {
      const restorePromises = selectedCookies.map((id) =>
        update(ref(db, getCookieDbPath(id)), { isArchived: false, archivedAt: null })
      );
      await Promise.all(restorePromises);
      showToast(`Restored ${selectedCookies.length} sessions.`, "success");
      setSelectedCookies([]);
    } catch (error) {
      console.error("Failed to restore cookies: ", error);
      showToast("Failed to restore selected sessions.", "error");
    }
  };

  const handleDeleteSelected = () => {
    setConfirmDialog({
      isOpen: true,
      title: "Delete Sessions Permanently",
      message: `Are you sure you want to completely delete ${selectedCookies.length} session(s)?\n\nThis action cannot be undone.`,
      confirmText: "Delete",
      confirmColor: "bg-red-500 hover:bg-red-600",
      onConfirm: async () => {
        try {
          const deletePromises = selectedCookies.map((id) => remove(ref(db, getCookieDbPath(id))));
          await Promise.all(deletePromises);
          showToast(`Deleted ${selectedCookies.length} sessions.`, "success");
          setSelectedCookies([]);
        } catch (error) {
          console.error("Failed to delete cookies: ", error);
          showToast("Failed to delete selected sessions.", "error");
        }
        setConfirmDialog({ ...confirmDialog, isOpen: false });
      },
    });
  };

  const activeCount = displayCookies.filter(
    (c) => now - new Date(c.updatedAt).getTime() < 60000,
  ).length;

  const hasActiveFilters = Object.values(filters).some((val) => val !== "All") || searchQuery.trim() !== "";

  if (loading) {
    return (
      <section className="w-full max-w-7xl mx-auto p-6">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-4 h-4 rounded-full bg-[var(--border-color)] animate-pulse" />
          <div className="h-8 w-48 bg-[var(--border-color)] animate-pulse rounded" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="theme-glass-card p-6 h-[280px] animate-pulse flex flex-col gap-4">
              <div className="flex justify-between">
                <div className="h-5 w-24 bg-[var(--border-color)] rounded" />
                <div className="h-5 w-16 bg-[var(--border-color)] rounded-full" />
              </div>
              <div className="h-4 w-32 bg-[var(--border-color)] rounded mt-2" />
              <div className="space-y-3 mt-4">
                <div className="h-3 w-full bg-[var(--border-color)] rounded" />
                <div className="h-3 w-4/5 bg-[var(--border-color)] rounded" />
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  const selectedPinCookie = activeMapMarker ? mappedCookies.find(c => c.id === activeMapMarker) : null;

  return (
    <section className="w-full max-w-7xl mx-auto p-6 fade-in">
      {/* Header */}
      <div className="mb-8 flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="relative flex h-3.5 w-3.5">
              <span className={`absolute inline-flex h-full w-full rounded-full opacity-75 ${viewMode === "active" ? "animate-ping bg-[var(--primary)]" : "bg-[var(--foreground-muted)]"}`}></span>
              <span className={`relative inline-flex rounded-full h-3.5 w-3.5 ${viewMode === "active" ? "bg-[var(--primary)] shadow-[0_0_10px_var(--primary)]" : "bg-[var(--foreground-muted)]"}`}></span>
            </div>
            <h2 className="text-3xl font-bold text-[var(--foreground)] tracking-tight">
              {viewMode === "active" ? "Visitor Data" : "Archived Sessions"}
            </h2>

            {archivedCookies.length > 0 && (
              <button onClick={toggleViewMode} className="ml-3 px-3 py-1.5 rounded-full text-xs font-bold tracking-wider uppercase border transition-all bg-[var(--background)] border-[var(--border-color)] text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:border-[var(--foreground-muted)]">
                {viewMode === "active" ? `View Archived (${archivedCookies.length})` : "View Active Sessions"}
              </button>
            )}
          </div>
          <p className="text-[var(--foreground-muted)] text-sm ml-6">
            {viewMode === "active" ? "Real-time tracking of active user sessions and consent states." : "Previously saved sessions moved out of the active view."}
          </p>
        </div>
      </div>

      {/* Action Toolbar */}
      {selectedCookies.length > 0 && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-2 sm:gap-3 animate-in slide-in-from-bottom-8 fade-in zoom-in-95 duration-300 bg-[var(--background)]/80 backdrop-blur-xl border border-[var(--border-color)] px-5 py-3 rounded-full shadow-2xl w-max max-w-[95vw] overflow-x-auto">
          <span className="text-sm font-medium text-[var(--foreground-muted)] mr-2 whitespace-nowrap">
            {selectedCookies.length} Selected
          </span>
          <button onClick={handleSelectAll} className="px-4 py-2 text-sm font-semibold rounded-full bg-[var(--background)] border border-[var(--border-color)] text-[var(--foreground)] hover:bg-[var(--primary)] hover:text-white hover:border-[var(--primary)] transition-colors shadow-sm whitespace-nowrap">
            {selectedCookies.length === displayCookies.length ? "Deselect All" : "Select All"}
          </button>
          {viewMode === "active" ? (
            <button onClick={handleArchiveSelected} className="px-4 py-2 text-sm font-semibold rounded-full bg-indigo-500/10 text-indigo-500 border border-indigo-500/20 hover:bg-indigo-500 hover:text-white transition-colors shadow-sm whitespace-nowrap">Archive</button>
          ) : (
            <button onClick={handleRestoreSelected} className="px-4 py-2 text-sm font-semibold rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 hover:bg-emerald-500 hover:text-white transition-colors shadow-sm whitespace-nowrap">Restore</button>
          )}
          <button onClick={handleDeleteSelected} className="px-4 py-2 text-sm font-semibold rounded-full bg-red-500/10 text-red-500 border border-red-500/20 hover:bg-red-500 hover:text-white transition-colors shadow-sm whitespace-nowrap">Delete</button>
        </div>
      )}

      {/* Map & Stats Card */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 mb-8">
        <CookieMap 
          mappedCookies={mappedCookies} 
          viewMode={viewMode} 
          now={now} 
          activeMapMarker={activeMapMarker}
          setActiveMapMarker={setActiveMapMarker}
        />

        {/* Stats Column - Swaps out when a pin is clicked */}
        <div className="flex flex-col gap-4">
          {selectedPinCookie ? (
            <>
              {/* Selected Pin Data View */}
              <div className="theme-glass-card p-5 flex flex-col justify-center flex-1 border-l-4 border-l-[var(--primary)] shadow-sm animate-in fade-in slide-in-from-right-4 duration-300">
                <div className="flex justify-between items-start mb-1">
                  <span className="text-[var(--foreground-muted)] text-xs uppercase tracking-wider font-mono">Selected Visitor</span>
                  <button onClick={() => setActiveMapMarker(null)} className="text-[10px] bg-[var(--background)] border border-[var(--border-color)] px-2 py-0.5 rounded-full hover:text-[var(--primary)] hover:border-[var(--primary)] transition-colors">Close</button>
                </div>
                <span className="text-xl font-bold text-[var(--foreground)] truncate mt-1" title={selectedPinCookie.username}>{selectedPinCookie.username}</span>
                <div className="flex flex-col gap-1 mt-1.5">
                  <span className="text-xs text-[var(--foreground-muted)] flex items-center gap-1.5">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
                    {selectedPinCookie.ipAddress || "Unknown IP"}
                  </span>
                  {selectedPinCookie.location?.lat && (
                    <a
                      href={`https://www.google.com/maps/search/?api=1&query=${selectedPinCookie.location.lat},${selectedPinCookie.location.lng}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-semibold text-[var(--primary)] hover:underline flex items-center gap-1 mt-0.5"
                    >
                      <span>📍 GPS: {Number(selectedPinCookie.location.lat).toFixed(4)}, {Number(selectedPinCookie.location.lng).toFixed(4)}</span>
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                    </a>
                  )}
                </div>
              </div>
              
              <div className="theme-glass-card p-5 flex flex-col justify-center flex-1 border-l-4 border-l-[var(--accent-blue)] shadow-sm animate-in fade-in slide-in-from-right-4 duration-300 delay-75">
                <span className="text-[var(--foreground-muted)] text-xs uppercase tracking-wider mb-1 font-mono">Device Details</span>
                <span className="text-lg font-bold text-[var(--foreground)] truncate mt-1" title={selectedPinCookie.deviceName}>{selectedPinCookie.deviceName}</span>
                <span className="text-xs text-[var(--foreground-muted)] mt-1.5 uppercase tracking-wide">{selectedPinCookie.language} • {selectedPinCookie.timeZone}</span>
              </div>

              <div className="theme-glass-card p-5 flex flex-col justify-center flex-1 border-l-4 border-l-emerald-500 shadow-sm animate-in fade-in slide-in-from-right-4 duration-300 delay-150">
                <span className="text-[var(--foreground-muted)] text-xs uppercase tracking-wider mb-1 font-mono">Status & Consent</span>
                <div className="flex items-center gap-2 mt-2">
                  <span className={`text-[10px] font-bold px-2 py-1 rounded-full uppercase tracking-widest border flex items-center gap-1.5 shadow-sm transition-colors ${selectedPinCookie.consentStatus === 'accepted' ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20" : "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"}`}>
                    <div className={`w-1.5 h-1.5 rounded-full ${selectedPinCookie.consentStatus === 'accepted' ? "bg-emerald-500" : "bg-amber-500"}`} />
                    {selectedPinCookie.consentStatus}
                  </span>
                </div>
                <span className="text-xs font-semibold text-[var(--foreground-muted)] mt-3">Active: <span className="text-[var(--foreground)]">{getRelativeTime(selectedPinCookie.updatedAt, now)}</span></span>
              </div>
            </>
          ) : (
            <>
              {/* Global Stats View (Default) */}
              <div className="theme-glass-card p-6 flex flex-col justify-center flex-1 border-l-4 border-l-[var(--foreground-muted)] hover:shadow-lg transition-all shadow-sm animate-in fade-in duration-300">
                <span className="text-[var(--foreground-muted)] text-xs uppercase tracking-wider mb-1 font-mono">{viewMode === "active" ? "Total Sessions" : "Archived Sessions"}</span>
                <span className="text-4xl font-bold text-[var(--foreground)]">{displayCookies.length}</span>
              </div>
              <div className="theme-glass-card p-6 flex flex-col justify-center flex-1 border-l-4 border-l-emerald-500 relative overflow-hidden hover:shadow-lg transition-all shadow-sm animate-in fade-in duration-300 delay-75">
                <div className="absolute -right-4 -top-4 w-16 h-16 bg-emerald-500/10 rounded-full blur-xl"></div>
                <span className="text-[var(--foreground-muted)] text-xs uppercase tracking-wider mb-1 font-mono">Active Now (60s)</span>
                <span className="text-4xl font-bold text-emerald-500">{activeCount}</span>
              </div>
              <div className="theme-glass-card p-6 flex flex-col justify-center flex-1 border-l-4 border-l-[var(--primary)] relative overflow-hidden hover:shadow-lg transition-all shadow-sm animate-in fade-in duration-300 delay-150">
                <div className="absolute -right-4 -top-4 w-16 h-16 bg-[var(--primary)]/10 rounded-full blur-xl"></div>
                <span className="text-[var(--foreground-muted)] text-xs uppercase tracking-wider mb-1 font-mono">Locations Tracked</span>
                <span className="text-4xl font-bold text-[var(--primary)]">{mappedCookies.length}</span>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Filters Bar with Search Input included */}
      {cookies.length > 0 && (
        <div className="mb-8 flex flex-wrap items-center gap-3 bg-[var(--card-bg)]/80 backdrop-blur-sm border border-[var(--border-color)] p-4 rounded-2xl shadow-sm">
          <div className="flex items-center gap-2 mr-2 shrink-0">
            <svg className="w-5 h-5 text-[var(--foreground-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" /></svg>
            <span className="text-sm font-semibold text-[var(--foreground)]">Filters:</span>
          </div>

          {/* New Search Input inside the Filter Bar */}
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <svg className="h-4 w-4 text-[var(--foreground-muted)]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            </div>
            <input
              type="text"
              placeholder="Search name, IP, location..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="block w-full pl-9 pr-8 py-2 border border-[var(--border-color)] rounded-lg leading-5 bg-[var(--background)] text-[var(--foreground)] placeholder-[var(--foreground-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)] focus:border-[var(--primary)] text-sm transition-colors shadow-sm"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery("")} className="absolute inset-y-0 right-0 pr-2.5 flex items-center text-[var(--foreground-muted)] hover:text-[var(--foreground)] outline-none">
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            )}
          </div>

          <select value={filters.device} onChange={(e) => handleFilterChange("device", e.target.value)} className="bg-[var(--background)] border border-[var(--border-color)] text-[var(--foreground)] text-sm rounded-lg px-3 py-2 outline-none focus:border-[var(--primary)] transition-colors cursor-pointer"><option value="All">All Devices</option>{uniqueDevices.map((d) => (<option key={d} value={d}>{d}</option>))}</select>
          <select value={filters.region} onChange={(e) => handleFilterChange("region", e.target.value)} className="bg-[var(--background)] border border-[var(--border-color)] text-[var(--foreground)] text-sm rounded-lg px-3 py-2 outline-none focus:border-[var(--primary)] transition-colors cursor-pointer"><option value="All">All Regions</option>{uniqueRegions.map((r) => (<option key={r} value={r}>{r}</option>))}</select>
          <select value={filters.language} onChange={(e) => handleFilterChange("language", e.target.value)} className="bg-[var(--background)] border border-[var(--border-color)] text-[var(--foreground)] text-sm rounded-lg px-3 py-2 outline-none focus:border-[var(--primary)] transition-colors cursor-pointer"><option value="All">All Languages</option>{uniqueLanguages.map((l) => (<option key={l} value={l} className="uppercase">{l}</option>))}</select>
          <select value={filters.location} onChange={(e) => handleFilterChange("location", e.target.value)} className="bg-[var(--background)] border border-[var(--border-color)] text-[var(--foreground)] text-sm rounded-lg px-3 py-2 outline-none focus:border-[var(--primary)] transition-colors cursor-pointer"><option value="All">All Locations</option><option value="Captured">Captured</option><option value="Denied">Permission Denied</option><option value="Unsupported">Unsupported</option></select>

          {hasActiveFilters && (<button onClick={clearFilters} className="text-sm font-medium text-red-500 hover:text-red-600 hover:underline transition-all ml-auto shrink-0">Clear Filters</button>)}
        </div>
      )}

      {/* Grid of Session Cards */}
      <CookieGrid
        displayCookies={displayCookies}
        now={now}
        viewMode={viewMode}
        selectedCookies={selectedCookies}
        toggleSelection={toggleSelection}
        hasActiveFilters={hasActiveFilters}
        clearFilters={clearFilters}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        onFocusMap={(id) => {
          setActiveMapMarker(id);
          const mapEl = document.getElementById("closedesk-radar-map");
          if (mapEl) {
            mapEl.scrollIntoView({ behavior: "smooth", block: "center" });
          }
        }}
      />

      {/* Confirmation Modal */}
      {confirmDialog.isOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm animate-in fade-in duration-200 p-4">
          <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-6 shadow-2xl max-w-sm w-full animate-in zoom-in-95 duration-200">
            <h3 className="text-xl font-bold text-[var(--foreground)] mb-2">{confirmDialog.title}</h3>
            <p className="text-[var(--foreground-muted)] text-sm mb-6 whitespace-pre-line">{confirmDialog.message}</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setConfirmDialog({ ...confirmDialog, isOpen: false })} className="px-4 py-2 text-sm font-semibold rounded-full bg-[var(--background)] border border-[var(--border-color)] text-[var(--foreground)] hover:bg-[var(--border-color)] transition-colors">Cancel</button>
              <button onClick={confirmDialog.onConfirm} className={`px-4 py-2 text-sm font-semibold rounded-full text-white shadow-sm transition-colors ${confirmDialog.confirmColor}`}>{confirmDialog.confirmText}</button>
            </div>
          </div>
        </div>
      )}

      {/* Toast Alert */}
      {toast.visible && (
        <div className="fixed top-6 right-6 z-[250] animate-in slide-in-from-top-5 fade-in duration-300">
          <div className={`flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border backdrop-blur-md ${toast.type === "error" ? "bg-red-500/10 border-red-500/20 text-red-500" : toast.type === "success" ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-500" : "bg-[var(--primary)]/10 border-[var(--primary)]/20 text-[var(--primary)]"}`}>
            {toast.type === "error" ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
            ) : toast.type === "success" ? (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            )}
            <span className="text-sm font-medium pr-2">{toast.message}</span>
            <button onClick={() => setToast({ ...toast, visible: false })} className="ml-2 opacity-50 hover:opacity-100 transition-opacity">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
          </div>
        </div>
      )}
    </section>
  );
}