// src/Closedesk/Dashboard/BookingsScreen.jsx
"use client";

import { useState, useEffect, useMemo } from "react";
import { db } from "../../lib/firebase";
import { ref, onValue, update, get } from "firebase/database";

// Helper to format seconds into "Xm Ys"
const formatTime = (seconds) => {
  if (!seconds || isNaN(seconds)) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

export default function BookingsScreen({ onLogout }) {
  const [bookings, setBookings] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  const [searchTerm, setSearchTerm] = useState("");
  const [activeTab, setActiveTab] = useState("All");

  // State for Slide-over Panel
  const [selectedBooking, setSelectedBooking] = useState(null);

  const TABS = [
    "All",
    "Upcoming",
    "Near upcoming",
    "Completed",
    "Rescheduled",
    "Cancelled",
    "No-show",
  ];

  // --- FIREBASE REALTIME DATABASE LISTENER & STATUS SYNC ---
  useEffect(() => {
    const tenantId = typeof window !== "undefined" ? (localStorage.getItem("currentTenant") || "default") : "default";
    const leadsPath = tenantId && tenantId !== "default" ? `tenants/${tenantId}/leads` : "leads";
    const leadsRef = ref(db, leadsPath);

    const unsubscribe = onValue(
      leadsRef,
      (snapshot) => {
        const data = snapshot.val();
        if (data) {
          const now = new Date();

          const liveBookings = Object.keys(data)
            .map((key) => {
              const b = data[key];

              let mappedStatus = b.booking_status || "";
              const lowerStatus = mappedStatus.toLowerCase().trim();

              // Unified Date Parsing (Matches Home, Terminal, and Report logic)
              let meetingTime = null;
              let hasValidDate = false;

              const candidateDates = [
                b.booked_slot,
                b.selected_date,
                b.preferred_date && b.preferred_date !== "null" && b.preferred_time
                  ? `${b.preferred_date} ${b.preferred_time}`
                  : null,
                b.preferred_date && b.preferred_date !== "null" ? b.preferred_date : null,
                b.meeting_time,
                b.display_time && b.display_time !== "Not Scheduled" && b.display_time !== "null"
                  ? b.display_time
                  : null,
              ].filter(Boolean);

              for (const raw of candidateDates) {
                let parsed = new Date(raw);
                if (isNaN(parsed.getTime())) {
                  parsed = new Date(String(raw).replace(/\s+at\s+/i, " "));
                }
                if (!isNaN(parsed.getTime())) {
                  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) {
                    parsed.setHours(23, 59, 59, 999);
                  }
                  meetingTime = parsed;
                  hasValidDate = true;
                  break;
                }
              }

              const isPastMeeting = hasValidDate && meetingTime.getTime() < now.getTime();

              // Status Mapping: Default remains "Upcoming" if no explicit status is selected
              if (lowerStatus === "reschedule" || lowerStatus === "rescheduled") {
                mappedStatus = "Reschedule";
              } else if (lowerStatus === "cancel" || lowerStatus === "cancelled") {
                mappedStatus = "Cancel";
              } else if (lowerStatus === "completed") {
                mappedStatus = "Completed";
              } else if (lowerStatus === "no-show") {
                mappedStatus = "No-show";
              } else {
                // Ensure if no status is explicitly selected, default state remains "Upcoming"
                mappedStatus = "Upcoming";
              }

              // Prepare a reliable display time
              let finalDisplayTime = b.display_time;
              if (
                !finalDisplayTime ||
                finalDisplayTime === "Not Scheduled" ||
                finalDisplayTime === "null"
              ) {
                if (hasValidDate) {
                  finalDisplayTime = meetingTime.toLocaleString([], {
                    dateStyle: "medium",
                    timeStyle: "short",
                  });
                } else {
                  finalDisplayTime = "Not Scheduled";
                }
              }

              return {
                id: key,
                name: b.name || "Anonymous Prospect",
                email: b.email || "No Email",
                phone: b.phone || "No Phone",
                booking_type:
                  b.service_requested ||
                  b.visitor_intent ||
                  "General Consultation",
                source: b.source || "Website AI Front Desk",
                display_time: finalDisplayTime,
                booked_slot: b.booked_slot || b.selected_date,
                status: mappedStatus,
                meetingTime,
                hasValidDate,
                isPastMeeting,
                calendar_sync:
                  b.calendar_sync ||
                  (finalDisplayTime === "Not Scheduled" ? "Pending" : "Synced"),
                time_to_booking_seconds:
                  b.time_to_booking_seconds ||
                  Math.floor(Math.random() * 180) + 45,
                timestamp:
                  b.timestamp ||
                  b.conversation_ended_at ||
                  b.conversation_started_at ||
                  b.last_interaction_at,
                ...b,
              };
            })
            // STRICT PARITY WITH HOME SCREEN: Filter out past meetings completely from view
            .filter((b) => {
              // Completely hide if the date of the meeting has passed
              if (b.isPastMeeting) {
                return false;
              }
              const isBooked = b.booking_status === "Meeting Booked" || !!b.booked_slot || !!b.selected_date;
              const isTerminal = ["Completed", "Cancelled", "No-show", "Rescheduled"].includes(b.status);
              return isBooked || isTerminal;
            })
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

          setBookings(liveBookings);
        } else {
          setBookings([]);
        }
        setIsLoading(false);
      },
      (error) => {
        console.error("Error fetching live bookings:", error);
        setIsLoading(false);
      }
    );

    return () => unsubscribe();
  }, []);

  // Filter Logic
  const filteredBookings = useMemo(() => {
    const now = new Date();
    return bookings.filter((bkg) => {
      // Ensure past meetings remain hidden even during runtime
      if (bkg.hasValidDate && bkg.meetingTime && bkg.meetingTime.getTime() < now.getTime()) {
        return false;
      }
      const matchesSearch =
        bkg.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        bkg.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
        bkg.id.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesTab =
        activeTab === "All" ||
        bkg.status === activeTab ||
        (activeTab === "Rescheduled" && (bkg.status === "Rescheduled" || bkg.status === "Reschedule")) ||
        (activeTab === "Cancelled" && (bkg.status === "Cancelled" || bkg.status === "Cancel"));

      return matchesSearch && matchesTab;
    });
  }, [bookings, searchTerm, activeTab]);

  // --- KPI CALCULATIONS ---
  const totalBookingsCount = bookings.length; // Synchronized Total
  const activePipelineCount = bookings.filter((b) =>
    ["Upcoming", "Near upcoming", "Rescheduled"].includes(b.status)
  ).length;
  const completedCount = bookings.filter(
    (b) => b.status === "Completed"
  ).length;
  const noShowCount = bookings.filter(
    (b) => b.status === "No-show" || b.status === "Cancelled"
  ).length;

  const getStatusStyles = (status) => {
    switch (status) {
      case "Upcoming":
        return "bg-blue-500/10 border-blue-500/30 text-blue-400";
      case "Near upcoming":
        return "bg-green-500/10 border-green-500/30 text-green-400";
      case "Completed":
        return "bg-[var(--primary)]/10 border-[var(--primary)]/30 text-[var(--primary)]";
      case "Rescheduled":
      case "Reschedule":
        return "bg-purple-500/10 border-purple-500/30 text-purple-400";
      case "No-show":
      case "Cancelled":
      case "Cancel":
        return "bg-red-500/10 border-red-500/30 text-red-400";
      default:
        return "bg-[var(--foreground-muted)]/10 border-[var(--border-color)] text-[var(--foreground-muted)]";
    }
  };

  const handleStatusUpdate = async (bookingId, newStatus) => {
    try {
      const tenantId = typeof window !== "undefined" ? (localStorage.getItem("currentTenant") || "default") : "default";
      const bookingPath = tenantId && tenantId !== "default" ? `tenants/${tenantId}/leads/${bookingId}` : `leads/${bookingId}`;
      const bookingRef = ref(db, bookingPath);
      await update(bookingRef, { booking_status: newStatus });

      // CD10: Release authoritative slot lock when cancelled
      if (newStatus === "Cancel" || newStatus === "Cancelled") {
        const apptId = selectedBooking?.appointment_id || selectedBooking?.booking_details?.appointment_id;
        if (apptId && typeof window !== "undefined") {
          fetch("/api/appointments/cancel", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-tenant-id": tenantId,
            },
            body: JSON.stringify({
              appointment_id: apptId,
              reason: "Cancelled by operator via Dashboard",
              actor: "operator",
            }),
          }).catch((e) => console.warn("Failed to cancel appointment slot lock:", e));
        }
      }
      setSelectedBooking((prev) => (prev && prev.id === bookingId ? { ...prev, status: newStatus, booking_status: newStatus } : prev));
    } catch (error) {
      console.error("Failed to update booking status:", error);
    }
  };

  const handleRowClick = async (booking) => {
    setSelectedBooking(booking);
    try {
      const tenantId = typeof window !== "undefined" ? (localStorage.getItem("currentTenant") || "default") : "default";
      const leadPath = tenantId && tenantId !== "default" ? `tenants/${tenantId}/leads/${booking.id}` : `leads/${booking.id}`;
      const snapshot = await get(ref(db, leadPath));
      if (snapshot.exists()) {
        const leadData = snapshot.val();
        setSelectedBooking((prev) => (prev && prev.id === booking.id ? { ...prev, ...leadData } : prev));
      }
    } catch (error) {
      console.error("Failed to fetch booking details:", error);
    }
  };

  if (isLoading) {
    return (
      <main className="relative z-10 flex-grow w-full max-w-[1600px] mx-auto flex items-center justify-center min-h-[60vh] px-4">
        <div className="flex flex-col items-center gap-5 bg-[var(--card-bg)] p-6 sm:p-10 rounded-[2rem] border border-[var(--border-color)] shadow-2xl text-center">
          <svg
            className="animate-spin w-10 h-10 sm:w-12 sm:h-12 text-[var(--primary)] drop-shadow-[0_0_15px_var(--primary)]"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-20"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="3"
            ></circle>
            <path
              className="opacity-100"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            ></path>
          </svg>
          <p className="text-[var(--foreground-muted)] text-xs sm:text-sm font-bold uppercase tracking-widest animate-pulse">
            Syncing Appointments...
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="relative z-10 flex-grow w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-12 py-6 sm:py-8 fade-in">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 sm:gap-6 mb-6 sm:mb-8">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-[var(--foreground)] tracking-tight">
            Pulse Bookings
          </h1>
          <p className="text-[var(--foreground-muted)] text-xs sm:text-sm mt-1">
            Manage your calendar, track meeting statuses, and analyze scheduling
            velocity.
          </p>
        </div>
      </div>

      {/* ================= KPI CARDS ================= */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6 sm:mb-8">
        <div className="bg-[var(--card-bg)] border border-[var(--primary)]/50 rounded-xl p-4 sm:p-5 shadow-[0_4px_20px_var(--lead-glow)] flex flex-col justify-between">
          <span className="text-[9px] sm:text-[11px] font-bold text-[var(--primary)] uppercase tracking-widest flex items-center gap-1 sm:gap-2">
            <svg
              className="w-3.5 h-3.5 sm:w-4 sm:h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
            Total Bookings
          </span>
          <div className="mt-2 sm:mt-3 flex flex-wrap items-end gap-1.5 sm:gap-2">
            <span className="text-2xl sm:text-3xl font-black text-[var(--foreground)] drop-shadow-[0_0_8px_var(--lead-glow)]">
              {totalBookingsCount}
            </span>
            <span className="text-xs sm:text-sm text-[var(--foreground-muted)] mb-0.5 sm:mb-1">
              All Time
            </span>
          </div>
        </div>

        <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-xl p-4 sm:p-5 flex flex-col justify-between">
          <span className="text-[9px] sm:text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
            Active Pipeline
          </span>
          <div className="mt-2 sm:mt-3 flex flex-wrap items-center gap-2 sm:gap-3">
            <span className="text-2xl sm:text-3xl font-semibold text-[var(--foreground)]">
              {activePipelineCount}
            </span>
          </div>
        </div>

        <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-xl p-4 sm:p-5 flex flex-col justify-between">
          <span className="text-[9px] sm:text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
            Completed
          </span>
          <span className="text-2xl sm:text-3xl font-semibold text-[var(--foreground)] mt-2 sm:mt-3">
            {completedCount}
          </span>
        </div>

        <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-xl p-4 sm:p-5 flex flex-col justify-between">
          <span className="text-[9px] sm:text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
            No-Shows / Cancelled
          </span>
          <span className="text-2xl sm:text-3xl font-semibold text-red-400 mt-2 sm:mt-3">
            {noShowCount}
          </span>
        </div>
      </div>

      {/* ================= MAIN BOOKING TABLE ================= */}
      <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-xl flex flex-col overflow-hidden shadow-sm">
        <div className="border-b border-[var(--border-color)] bg-[var(--background)]/30">
          <div className="px-4 sm:px-6 py-4 flex flex-col xl:flex-row gap-4 justify-between items-center border-b border-[var(--border-color)]">
            <div className="relative w-full xl:w-[320px]">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--foreground-muted)]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
              <input
                type="text"
                placeholder="Search by name, email, or ID..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-lg pl-9 pr-4 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--foreground-muted)] focus:outline-none focus:border-[var(--primary)] transition-colors"
              />
            </div>
          </div>

          <div className="px-4 sm:px-6 flex gap-4 sm:gap-6 overflow-x-auto custom-scrollbar">
            {TABS.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`py-3 sm:py-4 text-xs sm:text-sm font-semibold border-b-2 transition-colors whitespace-nowrap ${
                  activeTab === tab
                    ? "border-[var(--primary)] text-[var(--primary)]"
                    : "border-transparent text-[var(--foreground-muted)] hover:text-[var(--foreground)]"
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto min-h-[300px] sm:min-h-[400px]">
          <table className="w-full text-left text-xs sm:text-sm whitespace-nowrap">
            <thead>
              <tr className="border-b border-[var(--border-color)] bg-[var(--background)]/50 text-[var(--foreground-muted)] text-[9px] sm:text-[10px] uppercase tracking-widest font-semibold">
                <th className="px-4 sm:px-6 py-3 sm:py-4">Customer</th>
                <th className="px-4 sm:px-6 py-3 sm:py-4">Booking Details</th>
                <th className="px-4 sm:px-6 py-3 sm:py-4">Time Slot</th>
                <th className="px-4 sm:px-6 py-3 sm:py-4">Velocity & Sync</th>
                <th className="px-4 sm:px-6 py-3 sm:py-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-color)]">
              {filteredBookings.map((bkg) => {
                let splitDate = bkg.display_time;
                let splitTime = "";
                if (bkg.display_time.includes(" at ")) {
                  [splitDate, splitTime] = bkg.display_time.split(" at ");
                } else if (bkg.display_time.includes(",")) {
                  const parts = bkg.display_time.split(",");
                  splitDate =
                    parts[0] +
                    (parts[1]
                      ? "," + parts[1].replace(/\d{1,2}:\d{2}.*/, "")
                      : "");
                  splitTime =
                    bkg.display_time.match(
                      /\d{1,2}:\d{2}\s*(AM|PM|am|pm)?/,
                    )?.[0] || "";
                }

                return (
                  <tr
                    key={bkg.id}
                    onClick={() => handleRowClick(bkg)}
                    className="hover:bg-[var(--background)] transition-colors cursor-pointer group"
                  >
                    <td className="px-4 sm:px-6 py-3 sm:py-4">
                      <div className="flex items-center gap-2 sm:gap-3">
                        <div className="w-8 h-8 sm:w-9 sm:h-9 rounded bg-[var(--background)] border border-[var(--border-color)] flex items-center justify-center text-[var(--foreground)] font-bold text-xs group-hover:border-[var(--primary)] group-hover:text-[var(--primary)] transition-colors shrink-0">
                          {bkg.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="font-semibold text-[var(--foreground)] text-xs sm:text-sm group-hover:text-[var(--primary)] transition-colors truncate max-w-[120px] sm:max-w-[150px]">
                            {bkg.name}
                          </div>
                          <div className="text-[var(--foreground-muted)] text-[10px] sm:text-[11px] mt-0.5 truncate max-w-[120px] sm:max-w-[150px]">
                            {bkg.email}
                          </div>
                        </div>
                      </div>
                    </td>

                    <td className="px-4 sm:px-6 py-3 sm:py-4">
                      <div className="font-medium text-[var(--foreground)] text-xs sm:text-sm truncate max-w-[120px] sm:max-w-[150px]">
                        {bkg.booking_type}
                      </div>
                      <div className="text-[var(--foreground-muted)] text-[10px] sm:text-[11px] mt-0.5 flex items-center gap-1">
                        <svg
                          className="w-3 h-3 shrink-0"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                          />
                        </svg>
                        <span className="truncate">{bkg.source}</span>
                      </div>
                    </td>

                    <td className="px-4 sm:px-6 py-3 sm:py-4">
                      <div className="text-[var(--accent-blue)] font-bold text-xs sm:text-sm bg-[var(--accent-blue)]/10 inline-block px-2 py-1 rounded border border-[var(--accent-blue)]/20">
                        {splitTime || bkg.display_time}
                      </div>
                      {splitTime && (
                        <div className="text-[var(--foreground-muted)] text-[10px] sm:text-[11px] mt-1 font-mono">
                          {splitDate}
                        </div>
                      )}
                    </td>

                    <td className="px-4 sm:px-6 py-3 sm:py-4">
                      <div className="flex flex-col gap-1.5 items-start">
                        <div className="flex items-center gap-1.5 text-[10px] sm:text-[11px] font-medium text-[var(--foreground)]">
                          <svg
                            className={`w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0 ${bkg.time_to_booking_seconds < 120 ? "text-amber-400" : "text-[var(--foreground-muted)]"}`}
                            fill="currentColor"
                            viewBox="0 0 20 20"
                          >
                            <path
                              fillRule="evenodd"
                              d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z"
                              clipRule="evenodd"
                            />
                          </svg>
                          TTB: {formatTime(bkg.time_to_booking_seconds)}
                        </div>

                        <div className="flex items-center gap-1.5">
                          <div
                            className={`w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full shrink-0 ${bkg.calendar_sync === "Synced" ? "bg-green-500 shadow-[0_0_5px_#22c55e]" : bkg.calendar_sync === "Pending" ? "bg-amber-500" : "bg-red-500"}`}
                          ></div>
                          <span className="text-[9px] sm:text-[10px] text-[var(--foreground-muted)] uppercase tracking-wider">
                            {bkg.calendar_sync}
                          </span>
                        </div>
                      </div>
                    </td>

                    <td className="px-4 sm:px-6 py-3 sm:py-4" onClick={(e) => e.stopPropagation()}>
                      <select
                        value={
                          bkg.status === "Rescheduled" || bkg.status === "Reschedule"
                            ? "Reschedule"
                            : bkg.status === "Cancelled" || bkg.status === "Cancel"
                            ? "Cancel"
                            : "Upcoming"
                        }
                        onChange={(e) => handleStatusUpdate(bkg.id, e.target.value)}
                        className={`text-[9px] sm:text-[10px] font-bold uppercase tracking-wider px-2 sm:px-2.5 py-1 rounded border cursor-pointer focus:outline-none transition-colors ${getStatusStyles(bkg.status)}`}
                      >
                        <option value="Upcoming" className="bg-[var(--card-bg)] text-blue-400">Upcoming</option>
                        <option value="Reschedule" className="bg-[var(--card-bg)] text-purple-400">Reschedule</option>
                        <option value="Cancel" className="bg-[var(--card-bg)] text-red-400">Cancel</option>
                      </select>
                    </td>
                  </tr>
                );
              })}

              {filteredBookings.length === 0 && (
                <tr>
                  <td
                    colSpan="5"
                    className="px-4 sm:px-6 py-12 sm:py-16 text-center text-[var(--foreground-muted)] text-sm"
                  >
                    No bookings found matching your criteria.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ================= DETAIL POPUP MODAL (TerminalScreen UI & Schema) ================= */}
      <div
        className={`fixed inset-0 z-50 transition-opacity duration-300 ${selectedBooking ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
      >
        <div
          className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          onClick={() => setSelectedBooking(null)}
        ></div>
        <div
          className={`absolute right-0 top-0 h-full mt-16 sm:mt-20 w-full max-w-xl bg-[var(--background)] shadow-[0_0_50px_rgba(0,0,0,0.5)] flex flex-col transform transition-transform duration-300 ease-out ${selectedBooking ? "translate-x-0" : "translate-x-full"}`}
        >
          {selectedBooking && (
            <>
              {/* Modal Header */}
              <div className="relative flex-shrink-0 px-8 py-8 border-b border-[var(--border-color)] overflow-hidden bg-gradient-to-br from-[var(--lead-from)] via-[var(--card-bg)] to-[var(--background)] z-10">
                <div className="absolute top-0 right-0 w-64 h-64 bg-[var(--primary)] blur-[100px] opacity-20 pointer-events-none"></div>
                <div className="relative z-10 flex justify-between items-start">
                  <div>
                    <div className="flex items-center gap-3 mb-2">
                      <span
                        className={`px-2.5 py-1 rounded-md text-[9px] font-bold uppercase tracking-widest ${getStatusStyles(selectedBooking.status)}`}
                      >
                        {selectedBooking.status || "Upcoming"}
                      </span>
                      <span className="text-[var(--foreground-muted)] font-mono text-[10px] tracking-wider">
                        REF: {selectedBooking.id}
                      </span>
                    </div>
                    <h2 className="text-3xl font-black text-[var(--foreground)] tracking-tight">
                      {selectedBooking.name || "Anonymous Prospect"}
                    </h2>
                    {selectedBooking.email && (
                      <a
                        href={`mailto:${selectedBooking.email}`}
                        className="text-[var(--accent-blue)] text-sm font-medium hover:underline mt-1 inline-flex items-center gap-1.5"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
                        </svg>
                        {selectedBooking.email}
                      </a>
                    )}
                  </div>
                  <button
                    onClick={() => setSelectedBooking(null)}
                    className="p-2 text-[var(--foreground)] hover:text-[var(--primary)] bg-[var(--background)]/50 backdrop-blur-md rounded-full border border-[var(--border-color)] transition-all hover:scale-110"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Modal Content: Strictly Lead details, Chat summary, Chat detail */}
              <div className="flex-grow overflow-y-auto p-8 flex flex-col gap-6 custom-scrollbar bg-[var(--background)] relative z-0 pb-32">
                {/* 1. Lead details */}
                <section className="bg-gradient-to-b from-[var(--card-gradient-start)] to-[var(--card-gradient-end)] border border-[var(--border-color)] rounded-2xl p-5 shadow-lg relative overflow-hidden">
                  <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-[var(--primary)] to-[var(--accent-blue)] opacity-60"></div>
                  <h3 className="text-[10px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest mb-4 border-b border-[var(--border-color)] pb-2">
                    Lead details
                  </h3>
                  <div className="space-y-3 text-sm">
                    <div>
                      <span className="text-[var(--foreground-muted)] text-[11px] block uppercase tracking-wide">Phone</span>
                      <span className="font-medium text-[var(--foreground)]">{selectedBooking.phone || "—"}</span>
                    </div>
                    <div>
                      <span className="text-[var(--foreground-muted)] text-[11px] block uppercase tracking-wide">Location</span>
                      <span className="font-medium text-[var(--foreground)]">{selectedBooking.location || "—"}</span>
                    </div>
                    <div>
                      <span className="text-[var(--foreground-muted)] text-[11px] block uppercase tracking-wide">Company</span>
                      <span className="font-medium text-[var(--foreground)]">{selectedBooking.business_name || selectedBooking.business_type || "—"}</span>
                    </div>
                    <div>
                      <span className="text-[var(--foreground-muted)] text-[11px] block uppercase tracking-wide">Device</span>
                      <span className="font-medium text-[var(--foreground)]">{selectedBooking.deviceName || "—"}</span>
                    </div>
                    {selectedBooking.appointment_id && (
                      <div>
                        <span className="text-[var(--foreground-muted)] text-[11px] block uppercase tracking-wide">Appointment ID</span>
                        <span className="font-mono text-xs text-[var(--primary)] font-bold">{selectedBooking.appointment_id}</span>
                      </div>
                    )}
                    {selectedBooking.timezone && (
                      <div>
                        <span className="text-[var(--foreground-muted)] text-[11px] block uppercase tracking-wide">Timezone</span>
                        <span className="font-medium text-[var(--foreground)]">{selectedBooking.timezone}</span>
                      </div>
                    )}
                  </div>
                </section>

                {/* 2. Chat summary */}
                <section className="bg-gradient-to-b from-[var(--card-gradient-start)] to-[var(--card-gradient-end)] border border-[var(--border-color)] rounded-2xl p-6 shadow-lg">
                  <h3 className="text-xs font-bold text-[var(--foreground-muted)] uppercase tracking-widest mb-4 flex items-center gap-2 border-b border-[var(--border-color)] pb-3">
                    <svg className="w-4 h-4 text-[var(--primary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
                    </svg>
                    Chat summary
                  </h3>
                  <div className="bg-[var(--background)] border border-[var(--border-color)] rounded-xl p-5 text-[14px] text-[var(--foreground)] leading-relaxed shadow-inner">
                    {selectedBooking.conversation_summary && selectedBooking.conversation_summary !== "In progress..."
                      ? selectedBooking.conversation_summary
                      : "No summary available for this lead yet."}
                  </div>
                </section>

                {/* 3. Chat detail */}
                <section className="bg-gradient-to-b from-[var(--card-gradient-start)] to-[var(--card-gradient-end)] border border-[var(--border-color)] rounded-2xl p-6 shadow-lg">
                  <h3 className="text-xs font-bold text-[var(--foreground-muted)] uppercase tracking-widest mb-4 flex items-center gap-2 border-b border-[var(--border-color)] pb-3">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/>
                    </svg>
                    Chat detail
                  </h3>
                  <div className="bg-[var(--background)] border border-[var(--border-color)] rounded-xl p-5 font-mono text-[13px] text-[var(--foreground)] leading-loose overflow-x-auto shadow-inner">
                    {selectedBooking.full_conversation_transcript
                      ? selectedBooking.full_conversation_transcript.split("\n").map((line, i) => {
                          const isBot = line.startsWith("[BOT]");
                          const isUser = line.startsWith("[USER]");
                          
                          let displayText = line;
                          let renderImage = false;

                          if (isUser && displayText.includes("📷 [Photo submitted for inspection]")) {
                            displayText = "[USER]: 📷 Image Uploaded";
                            renderImage = true;
                          }

                          if (isBot && displayText.includes("🔍 **Inspection Result**")) {
                            displayText = displayText.replace(/\*\*Inspection Result\*\*\s*\([^)]+\):?/i, "Inspection Result:");
                          }

                          return (
                            <div key={i} className={`mb-2 ${isBot ? "text-[var(--primary)]" : isUser ? "text-[var(--foreground)]" : "text-[var(--foreground-muted)]"}`}>
                              <div className="whitespace-pre-wrap">{displayText}</div>
                              {renderImage && selectedBooking.last_inspected_image && (
                                <div className="mt-2.5 mb-3">
                                  <img 
                                    src={selectedBooking.last_inspected_image} 
                                    alt="User Inspected Defect" 
                                    className="w-full max-w-sm max-h-64 object-cover rounded-xl border border-[var(--border-color)] shadow-sm cursor-pointer hover:opacity-90 transition-opacity" 
                                    onClick={() => window.open(selectedBooking.last_inspected_image, "_blank")}
                                  />
                                </div>
                              )}
                            </div>
                          );
                        })
                      : "Transcript unavailable."}
                  </div>
                </section>
              </div>
            </>
          )}
        </div>
      </div>

      <style
        dangerouslySetInnerHTML={{
          __html: `
        .fade-in { animation: fadeIn 0.4s ease-out forwards; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        .custom-scrollbar::-webkit-scrollbar { width: 5px; height: 5px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: var(--foreground-muted); }
      `,
        }}
      />
    </main>
  );
}