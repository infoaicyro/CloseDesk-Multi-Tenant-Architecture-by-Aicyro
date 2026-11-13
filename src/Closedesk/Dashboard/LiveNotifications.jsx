import React, { useState, useEffect, useRef } from "react";
import { db } from "../../lib/firebase";
import { ref, onValue } from "firebase/database";

const formatTimeAgo = (timestamp) => {
  if (!timestamp) return "Just now";
  const seconds = Math.floor((new Date() - new Date(timestamp)) / 1000);
  if (seconds < 60) return `${Math.max(1, seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

export default function LiveNotifications({ onNavigate }) {
  const [tenantId, setTenantId] = useState("default");
  const [notifications, setNotifications] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState("all"); // "all" | "unacknowledged" | "failed"
  const [actionInProgress, setActionInProgress] = useState({});
  const dropdownRef = useRef(null);

  useEffect(() => {
    const activeTenant = typeof window !== "undefined"
      ? (localStorage.getItem("currentTenant") || "default")
      : "default";
    setTenantId(activeTenant);

    // Initial fetch via authenticated API
    const fetchApiJobs = async () => {
      try {
        const token = typeof window !== "undefined" ? localStorage.getItem("cd_session_token") : null;
        const res = await fetch("/api/notifications", {
          headers: {
            "x-tenant-id": activeTenant,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.jobs)) {
            setNotifications(data.jobs);
            return;
          }
        }
      } catch (err) {
        console.warn("API notifications fetch failed, relying on realtime listener:", err);
      }
    };

    fetchApiJobs();

    // Realtime Database listener for live streaming updates (tenant-scoped)
    const jobsPath = activeTenant && activeTenant !== "default"
      ? `tenants/${activeTenant}/notification_jobs`
      : "notification_jobs";

    const jobsRef = ref(db, jobsPath);
    const unsubscribe = onValue(jobsRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val();
        const jobsList = Object.keys(data).map((key) => ({
          id: key,
          ...data[key],
        })).sort((a, b) => new Date(b.created_at || b.timestamp || 0) - new Date(a.created_at || a.timestamp || 0));

        setNotifications(jobsList);
      } else {
        // Fallback: Check root notifications for backwards compatibility
        const legacyRef = ref(db, "notifications");
        onValue(legacyRef, (legSnap) => {
          if (legSnap.exists()) {
            const legData = legSnap.val();
            const legacyList = Object.keys(legData).map((k) => ({
              id: k,
              ...legData[k],
              delivery_status: legData[k].delivery_status || "provider_accepted",
              acknowledgement_status: legData[k].unread ? "unacknowledged" : "acknowledged",
            })).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
            setNotifications(legacyList);
          } else {
            setNotifications([]);
          }
        }, { onlyOnce: true });
      }
    });

    return () => unsubscribe();
  }, []);

  // Close on outside click
  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Handle human acknowledgement (P0: CD07 requirement)
  const handleAcknowledge = async (jobId, e) => {
    if (e) e.stopPropagation();
    setActionInProgress((prev) => ({ ...prev, [jobId]: "acknowledging" }));

    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("cd_session_token") : null;
      const res = await fetch("/api/notifications/acknowledge", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-id": tenantId,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ job_id: jobId, notes: "Acknowledged via Dashboard UI" }),
      });

      if (res.ok) {
        setNotifications((prev) =>
          prev.map((n) =>
            n.id === jobId
              ? {
                  ...n,
                  acknowledgement_status: "acknowledged",
                  acknowledged_by: "you",
                  acknowledged_at: new Date().toISOString(),
                }
              : n
          )
        );
      }
    } catch (error) {
      console.error("Failed to acknowledge notification:", error);
    } finally {
      setActionInProgress((prev) => ({ ...prev, [jobId]: null }));
    }
  };

  // Handle safe manual replay (P0: CD07 requirement)
  const handleReplay = async (jobId, e) => {
    if (e) e.stopPropagation();
    setActionInProgress((prev) => ({ ...prev, [jobId]: "replaying" }));

    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("cd_session_token") : null;
      const res = await fetch("/api/notifications/replay", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-id": tenantId,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ job_id: jobId }),
      });

      if (res.ok) {
        setNotifications((prev) =>
          prev.map((n) =>
            n.id === jobId
              ? {
                  ...n,
                  delivery_status: "queued",
                  attempts: (n.attempts || 0),
                }
              : n
          )
        );
      }
    } catch (error) {
      console.error("Failed to replay notification:", error);
    } finally {
      setActionInProgress((prev) => ({ ...prev, [jobId]: null }));
    }
  };

  const unacknowledgedCount = notifications.filter(
    (n) => n.acknowledgement_status === "unacknowledged" || (n.unread && !n.acknowledgement_status)
  ).length;

  const filteredNotifications = notifications.filter((item) => {
    if (filter === "unacknowledged") {
      return item.acknowledgement_status === "unacknowledged" || (item.unread && !item.acknowledgement_status);
    }
    if (filter === "failed") {
      return item.delivery_status === "failed" || item.delivery_status === "unknown";
    }
    return true;
  });

  const getDeliveryBadge = (status) => {
    switch (status) {
      case "provider_accepted":
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-600 border border-emerald-500/20">Delivered</span>;
      case "failed":
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-rose-500/10 text-rose-600 border border-rose-500/20">Failed</span>;
      case "unknown":
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-amber-500/10 text-amber-600 border border-amber-500/20">Unknown</span>;
      case "claimed":
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-indigo-500/10 text-indigo-600 border border-indigo-500/20">Dispatching</span>;
      case "queued":
      default:
        return <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-blue-500/10 text-blue-600 border border-blue-500/20">Queued</span>;
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      {/* Bell Icon Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2.5 rounded-xl bg-[var(--card-bg)] border border-[var(--border-color)] text-[var(--foreground)] hover:text-[var(--primary)] hover:border-[var(--primary)] transition-all shadow-sm"
        title="Live Lead Notifications"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
          />
        </svg>

        {/* Live Unacknowledged Badge */}
        {unacknowledgedCount > 0 && (
          <span className="absolute top-0 right-0 inline-flex items-center justify-center w-4 h-4 text-[10px] font-bold text-white bg-amber-500 rounded-full transform translate-x-1/4 -translate-y-1/4 ring-2 ring-[var(--background)] animate-pulse">
            {unacknowledgedCount > 99 ? "99+" : unacknowledgedCount}
          </span>
        )}
      </button>

      {/* Dropdown Panel */}
      {isOpen && (
        <div className="absolute right-0 mt-3 w-88 sm:w-[420px] bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl shadow-[0_10px_40px_rgba(0,0,0,0.2)] overflow-hidden z-50 animate-in fade-in slide-in-from-top-4 duration-200">
          {/* Header */}
          <div className="px-4 py-3 border-b border-[var(--border-color)] bg-[var(--background)] flex flex-col gap-2">
            <div className="flex justify-between items-center">
              <h3 className="text-sm font-bold text-[var(--foreground)] flex items-center gap-2">
                Handoff Notifications
                {notifications.length > 0 && (
                  <span className="bg-[var(--primary)]/10 text-[var(--primary)] py-0.5 px-2 rounded-full text-[10px] font-semibold">
                    {notifications.length}
                  </span>
                )}
              </h3>
              <span className="text-[10px] font-mono text-[var(--foreground-muted)] uppercase">
                {tenantId}
              </span>
            </div>

            {/* Filter Pills */}
            <div className="flex gap-1.5 pt-1">
              <button
                onClick={() => setFilter("all")}
                className={`text-[11px] font-semibold px-2.5 py-1 rounded-lg transition-colors ${
                  filter === "all"
                    ? "bg-[var(--primary)] text-white"
                    : "bg-[var(--card-bg)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
                }`}
              >
                All
              </button>
              <button
                onClick={() => setFilter("unacknowledged")}
                className={`text-[11px] font-semibold px-2.5 py-1 rounded-lg transition-colors flex items-center gap-1.5 ${
                  filter === "unacknowledged"
                    ? "bg-amber-500 text-white"
                    : "bg-[var(--card-bg)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
                }`}
              >
                Action Needed
                {unacknowledgedCount > 0 && (
                  <span className={`text-[9px] px-1.5 py-0.2 rounded-full ${filter === "unacknowledged" ? "bg-white/20 text-white" : "bg-amber-500/20 text-amber-600"}`}>
                    {unacknowledgedCount}
                  </span>
                )}
              </button>
              <button
                onClick={() => setFilter("failed")}
                className={`text-[11px] font-semibold px-2.5 py-1 rounded-lg transition-colors ${
                  filter === "failed"
                    ? "bg-rose-500 text-white"
                    : "bg-[var(--card-bg)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
                }`}
              >
                Delivery Issues
              </button>
            </div>
          </div>

          {/* Notification List */}
          <div className="max-h-[380px] overflow-y-auto custom-scrollbar flex flex-col divide-y divide-[var(--border-color)]">
            {filteredNotifications.length > 0 ? (
              filteredNotifications.map((item) => {
                const isUnacknowledged = item.acknowledgement_status === "unacknowledged" || (item.unread && !item.acknowledgement_status);
                const isFailedOrUnknown = item.delivery_status === "failed" || item.delivery_status === "unknown";

                return (
                  <div
                    key={item.id}
                    className={`p-4 transition-colors flex flex-col gap-2 ${
                      isUnacknowledged ? "bg-amber-500/[0.03]" : "hover:bg-[var(--background)]"
                    }`}
                  >
                    {/* Header: Title + Time */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="text-xs font-bold text-[var(--foreground)]">
                          {item.title || "Inbound Lead Notification"}
                        </h4>
                        {getDeliveryBadge(item.delivery_status)}
                        {item.acknowledgement_status === "acknowledged" ? (
                          <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-gray-500/10 text-gray-500 border border-gray-500/20">
                            ✓ Handled
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/15 text-amber-600 border border-amber-500/30 animate-pulse">
                            Needs Action
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] text-[var(--foreground-muted)] whitespace-nowrap shrink-0">
                        {formatTimeAgo(item.created_at || item.timestamp)}
                      </span>
                    </div>

                    {/* Lead Content */}
                    <p className="text-xs text-[var(--foreground-muted)] leading-relaxed line-clamp-2">
                      {item.message || (item.lead_data ? `Lead: ${item.lead_data.name || item.lead_data.email}` : "New contact captured")}
                    </p>

                    {/* Metadata Pill Row */}
                    <div className="flex items-center justify-between text-[10px] text-[var(--foreground-muted)] pt-1 flex-wrap gap-1">
                      <span className="truncate max-w-[200px]" title={item.recipient}>
                        To: <span className="font-mono text-[var(--foreground)]">{item.recipient || "Unconfigured"}</span>
                      </span>
                      <span>
                        Attempts: <span className="font-semibold">{item.attempts || 0}/{item.max_attempts || 3}</span>
                      </span>
                    </div>

                    {/* Failure details if any */}
                    {item.last_error && (
                      <div className="text-[11px] bg-rose-500/10 text-rose-600 px-2 py-1 rounded border border-rose-500/20 font-mono break-words">
                        {item.last_error}
                      </div>
                    )}

                    {/* Acknowledged info if present */}
                    {item.acknowledged_by && (
                      <div className="text-[10px] text-gray-400 italic">
                        Acknowledged by <span className="font-semibold text-gray-600">{item.acknowledged_by}</span> at {formatTimeAgo(item.acknowledged_at)}
                      </div>
                    )}

                    {/* Action Bar */}
                    <div className="flex items-center justify-end gap-2 pt-1 border-t border-[var(--border-color)]/50 mt-1">
                      {isFailedOrUnknown && (
                        <button
                          onClick={(e) => handleReplay(item.id, e)}
                          disabled={actionInProgress[item.id] === "replaying"}
                          className="px-2.5 py-1 text-[11px] font-semibold text-rose-600 hover:bg-rose-500/10 rounded-lg transition-colors border border-rose-500/20 disabled:opacity-50"
                        >
                          {actionInProgress[item.id] === "replaying" ? "Replaying..." : "↺ Retry Delivery"}
                        </button>
                      )}

                      {isUnacknowledged && (
                        <button
                          onClick={(e) => handleAcknowledge(item.id, e)}
                          disabled={actionInProgress[item.id] === "acknowledging"}
                          className="px-3 py-1 text-[11px] font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors shadow-sm disabled:opacity-50"
                        >
                          {actionInProgress[item.id] === "acknowledging" ? "Marking..." : "✓ Acknowledge Lead"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="p-8 text-center flex flex-col items-center justify-center">
                <div className="w-10 h-10 rounded-full bg-[var(--background)] border border-[var(--border-color)] flex items-center justify-center mb-2">
                  <svg className="w-5 h-5 text-[var(--foreground-muted)] opacity-60" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2-2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                  </svg>
                </div>
                <span className="text-xs font-semibold text-[var(--foreground)]">No notifications</span>
                <span className="text-[11px] text-[var(--foreground-muted)] mt-0.5">
                  {filter === "all" ? "Queue is clean." : `No ${filter} items found.`}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
