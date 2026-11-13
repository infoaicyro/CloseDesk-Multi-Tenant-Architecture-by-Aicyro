// src/Closedesk/Dashboard/TerminalScreen.jsx
"use client";

import { useState, useEffect } from "react";
import { createPulseLogger } from "../../lib/loggerPresets";
import { recordAuditTrail } from "../../lib/auditTracer";

const pulseLogger = createPulseLogger("TerminalScreen");
const getStatusBadge = (lead) => {
  const status = (lead.lifecycle_status || lead.booking_status || "").toUpperCase();
  if (status.includes("PENDING")) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider bg-amber-500/10 border border-amber-500/30 text-amber-500">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
        Pending
      </span>
    );
  }
  if (status.includes("UNKNOWN")) {
    return (
      <span className="inline-flex items-center px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider bg-orange-500/10 border border-orange-500/30 text-orange-400">
        Unknown
      </span>
    );
  }
  if (status.includes("ABANDON")) {
    return (
      <span className="inline-flex items-center px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider bg-rose-500/10 border border-rose-500/30 text-rose-400">
        Abandoned
      </span>
    );
  }
  if (lead.booking_status === "Meeting Booked" || lead.booked_slot || lead.selected_date || status === "BOOKED") {
    return (
      <span className="inline-flex items-center px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider bg-[var(--lead-glow)] border border-[var(--primary)]/30 text-[var(--primary)]">
        Booked
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-1 rounded text-[10px] font-bold uppercase tracking-wider bg-[var(--foreground-muted)]/10 border border-[var(--border-color)] text-[var(--foreground-muted)] group-hover:border-[var(--foreground-muted)] transition-colors">
      Captured
    </span>
  );
};


export default function LeadScreen({ onLogout }) {
  const [leads, setLeads] = useState([]);
  const [isLoadingLeads, setIsLoadingLeads] = useState(true);

  const [selectedLead, setSelectedLead] = useState(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);

  const [searchTerm, setSearchTerm] = useState("");
  const [filterScore, setFilterScore] = useState("All");
  const [filterStatus, setFilterStatus] = useState("All");
  const [filterDate, setFilterDate] = useState("All");

  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [filterUrgency, setFilterUrgency] = useState("All");
  const [filterHasContact, setFilterHasContact] = useState(false);

  useEffect(() => {
    fetchLeads();
  }, []);

  const fetchLeads = async () => {
    setIsLoadingLeads(true);
    try {
      const storedTenant = typeof window !== "undefined" ? localStorage.getItem("currentTenant") : null;
      const url = storedTenant && storedTenant !== "default"
        ? `/api/leads?tenant=${encodeURIComponent(storedTenant)}`
        : "/api/leads";
      const headers = storedTenant && storedTenant !== "default"
        ? { "x-tenant-id": storedTenant }
        : {};
      const response = await fetch(url, { headers });
      const data = await response.json();

      const leadsObj = data.leads || data || {};
      let leadsArray = [];

      if (leadsObj && typeof leadsObj === "object") {
        leadsArray = Object.keys(leadsObj).map((key) => {
          const lead = leadsObj[key];

          let formattedScore = "Low";
          if (lead.lead_score) {
            formattedScore = lead.lead_score.charAt(0).toUpperCase() + lead.lead_score.slice(1).toLowerCase();
          }

          let formattedUrgency = "Low";
          if (lead.urgency_level) {
            formattedUrgency = lead.urgency_level.charAt(0).toUpperCase() + lead.urgency_level.slice(1).toLowerCase();
          }

          return {
            ...lead,
            id: lead.firebaseId || key,
            name: lead.name || "Anonymous",
            timestamp: lead.last_interaction_at || lead.conversation_started_at || null,
            deviceName: lead.deviceName || "Unknown Device",
            lead_score: formattedScore,
            visitor_intent: lead.visitor_intent || "Unknown",
            booking_status: lead.booking_status || "Captured",
            email: lead.email || "",
            phone: lead.phone || "",
            business_name: lead.business_name || "",
            business_type: lead.business_type || "",
            location: lead.location || "",
            urgency_level: formattedUrgency,
            conversation_summary: lead.conversation_summary || "",
            full_conversation_transcript: lead.full_conversation_transcript || "",
            last_inspected_image: lead.last_inspected_image || "", // 🔥 Fetched for the Transcript Image UI
          };
        });
      }

      leadsArray.sort((a, b) => {
        const dateA = new Date(a.timestamp || 0).getTime();
        const dateB = new Date(b.timestamp || 0).getTime();
        return dateB - dateA;
      });

      setLeads(leadsArray);
    } catch (error) {
      console.error("Failed to fetch leads", error);
      setLeads([]);
    } finally {
      setIsLoadingLeads(false);
    }
  };

  const openLeadDetails = (lead) => {
    setSelectedLead(lead);
    setIsPanelOpen(true);
  };

  const closeLeadDetails = () => {
    setIsPanelOpen(false);
    setTimeout(() => setSelectedLead(null), 300);
  };

  const clearAllFilters = () => {
    setSearchTerm("");
    setFilterScore("All");
    setFilterStatus("All");
    setFilterDate("All");
    setDateFrom("");
    setDateTo("");
    setFilterUrgency("All");
    setFilterHasContact(false);
  };

  const filteredLeads = leads.filter((lead) => {
    const searchString = searchTerm.toLowerCase();

    const matchesSearch =
      !searchTerm ||
      lead.name?.toLowerCase().includes(searchString) ||
      lead.email?.toLowerCase().includes(searchString) ||
      lead.phone?.toLowerCase().includes(searchString) ||
      lead.business_name?.toLowerCase().includes(searchString) ||
      lead.business_type?.toLowerCase().includes(searchString) ||
      lead.location?.toLowerCase().includes(searchString) ||
      lead.id?.toLowerCase().includes(searchString);

    const matchesScore = filterScore === "All" || lead.lead_score?.toLowerCase() === filterScore.toLowerCase();
    
    // Unified Booking Check
    const matchesStatus =
      filterStatus === "All"
        ? true
        : filterStatus === "Booked"
          ? lead.booking_status === "Meeting Booked" || !!lead.booked_slot || !!lead.selected_date
          : filterStatus === "Unbooked"
            ? lead.booking_status !== "Meeting Booked" && !lead.booked_slot && !lead.selected_date
            : true;

    const matchesUrgency = filterUrgency === "All" || lead.urgency_level?.toLowerCase() === filterUrgency.toLowerCase();
    const matchesContact = !filterHasContact || !!(lead.email || lead.phone);

    let matchesDate = true;
    if (!lead.timestamp) {
      if (filterDate !== "All" || dateFrom || dateTo) matchesDate = false;
    } else {
      const leadTime = new Date(lead.timestamp).getTime();

      if (dateFrom || dateTo) {
        if (dateFrom && leadTime < new Date(dateFrom).getTime()) matchesDate = false;
        if (dateTo && leadTime > new Date(dateTo).setHours(23, 59, 59, 999)) matchesDate = false;
      } else if (filterDate !== "All") {
        const today = new Date();
        today.setHours(0, 0, 0, 0); 
        const todayTime = today.getTime();
        const ONE_DAY = 24 * 60 * 60 * 1000;

        if (filterDate === "Today") {
          matchesDate = leadTime >= todayTime;
        } else if (filterDate === "3Days") {
          matchesDate = leadTime >= todayTime - 3 * ONE_DAY;
        } else if (filterDate === "7Days") {
          matchesDate = leadTime >= todayTime - 7 * ONE_DAY;
        } else if (filterDate === "30Days") {
          matchesDate = leadTime >= todayTime - 30 * ONE_DAY;
        }
      }
    }

    return matchesSearch && matchesScore && matchesStatus && matchesUrgency && matchesContact && matchesDate;
  });

  const totalLeads = filteredLeads.length;
  // Unified Booking Metric Calculation
  const bookedMeetings = filteredLeads.filter(
    (lead) => lead.booking_status === "Meeting Booked" || !!lead.booked_slot || !!lead.selected_date
  ).length;
  
  const highIntentLeads = filteredLeads.filter(
    (lead) => lead.lead_score === "High"
  ).length;
  
  const conversionRate = totalLeads > 0 ? Math.round((bookedMeetings / totalLeads) * 100) : 0;

  return (
    <main className="relative z-10 flex-grow w-full max-w-[1600px] mx-auto px-6 sm:px-12 py-8 fade-in">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-8">
        <div>
          <h1 className="text-3xl font-bold text-[var(--foreground)] tracking-tight">Lead Terminal</h1>
          <p className="text-[var(--foreground-muted)] text-sm mt-1">Review intercepted traffic, conversation logs, and captured intel.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {[
          { label: "Total Captures", value: totalLeads, highlight: false },
          { label: "Meetings Booked", value: bookedMeetings, highlight: true },
          { label: "High Intent", value: highIntentLeads, highlight: false },
          { label: "Booking Rate", value: `${conversionRate}%`, highlight: false },
        ].map((stat, i) => (
          <div key={i} className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-xl p-5 flex flex-col justify-between hover:border-[var(--foreground-muted)] transition-colors shadow-sm">
            <span className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">{stat.label}</span>
            <span className={`text-3xl font-semibold mt-3 ${stat.highlight ? "text-[var(--primary)]" : "text-[var(--foreground)]"}`}>{stat.value}</span>
          </div>
        ))}
      </div>

      <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-xl flex flex-col overflow-hidden relative shadow-sm mb-12">
        {isLoadingLeads && (
          <div className="absolute inset-0 z-20 bg-[var(--card-bg)]/80 backdrop-blur-sm flex flex-col items-center justify-center">
            <div className="w-8 h-8 border-2 border-[var(--border-color)] border-t-[var(--primary)] rounded-full animate-spin"></div>
          </div>
        )}

        <div className="px-6 py-4 border-b border-[var(--border-color)] bg-[var(--background)]/30 flex flex-col md:flex-row gap-4 items-center w-full">
          <div className="relative flex-grow w-full min-w-0">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--foreground-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
            </svg>
            <input type="text" placeholder="Search leads, emails, business, or locations..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl pl-10 pr-4 py-2.5 text-sm text-[var(--foreground)] placeholder:text-[var(--foreground-muted)] focus:outline-none focus:border-[var(--primary)] transition-colors"/>
          </div>

          <div className="flex gap-2 w-full md:w-auto shrink-0">
            <button onClick={() => setShowAdvancedFilters(!showAdvancedFilters)} className={`px-4 py-2.5 border rounded-xl text-xs font-bold flex flex-1 md:flex-none justify-center items-center gap-2 transition-colors whitespace-nowrap ${showAdvancedFilters ? "bg-[var(--primary)]/10 border-[var(--primary)]/30 text-[var(--primary)]" : "bg-[var(--background)] border-[var(--border-color)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"}`}>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>
              Advanced Filters
            </button>
            <button onClick={fetchLeads} className="px-4 py-2.5 border border-[var(--border-color)] bg-[var(--background)] rounded-xl text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors flex flex-1 md:flex-none justify-center items-center gap-2 text-xs font-bold">
              <svg className={`w-4 h-4 ${isLoadingLeads ? "animate-spin text-[var(--primary)]" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
              Refresh
            </button>
          </div>
        </div>

        {showAdvancedFilters && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 px-6 py-5 bg-[var(--background)]/50 border-b border-[var(--border-color)] animate-acy-fade shadow-inner">
            <div><label className="text-[10px] font-bold uppercase tracking-widest text-[var(--foreground-muted)] mb-1.5 block">Start Date</label><input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-full bg-[var(--card-bg)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-xs text-[var(--foreground)] focus:outline-none focus:border-[var(--primary)]" /></div>
            <div><label className="text-[10px] font-bold uppercase tracking-widest text-[var(--foreground-muted)] mb-1.5 block">End Date</label><input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-full bg-[var(--card-bg)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-xs text-[var(--foreground)] focus:outline-none focus:border-[var(--primary)]" /></div>
            <div><label className="text-[10px] font-bold uppercase tracking-widest text-[var(--foreground-muted)] mb-1.5 block">Urgency Level</label><select value={filterUrgency} onChange={(e) => setFilterUrgency(e.target.value)} className="w-full bg-[var(--card-bg)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-xs text-[var(--foreground)] focus:outline-none focus:border-[var(--primary)] cursor-pointer"><option value="All">All Urgency Levels</option><option value="High">High Urgency</option><option value="Medium">Medium Urgency</option><option value="Low">Low Urgency</option></select></div>
            <div className="flex flex-col justify-end"><label className="flex items-center gap-3 cursor-pointer p-2.5 border border-[var(--border-color)] rounded-lg bg-[var(--card-bg)] hover:border-[var(--primary)]/50 transition-colors"><input type="checkbox" checked={filterHasContact} onChange={(e) => setFilterHasContact(e.target.checked)} className="w-4 h-4 accent-[var(--primary)]" /><span className="text-xs font-bold text-[var(--foreground)]">Requires Contact Info</span></label></div>
            <div className="col-span-1 md:col-span-2 lg:col-span-4 flex justify-end mt-2"><button onClick={clearAllFilters} className="px-4 py-2 bg-[var(--card-bg)] border border-[var(--border-color)] text-[var(--foreground-muted)] hover:text-[var(--logo-politico-red)] text-xs font-bold rounded-lg transition-colors">Clear All Filters</button></div>
          </div>
        )}

        <div className="overflow-x-auto min-h-[500px]">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead>
              <tr className="border-b border-[var(--border-color)] bg-[var(--background)]/50 text-[var(--foreground-muted)] text-[10px] uppercase tracking-widest font-semibold">
                <th className="px-6 py-4 font-semibold">Prospect & Ref ID</th>
                <th className="px-6 py-4 font-semibold">Inquiry & Location</th>
                <th className="px-6 py-4 font-semibold">
                  <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="bg-transparent font-bold text-[var(--foreground-muted)] uppercase tracking-widest focus:outline-none cursor-pointer hover:text-[var(--foreground)] transition-colors">
                    <option className="bg-[var(--card-bg)] text-[var(--foreground)]" value="All">STATUS (ALL)</option>
                    <option className="bg-[var(--card-bg)] text-[var(--foreground)]" value="Booked">BOOKED</option>
                    <option className="bg-[var(--card-bg)] text-[var(--foreground)]" value="Unbooked">UNBOOKED</option>
                  </select>
                </th>
                <th className="px-6 py-4 font-semibold">
                  <select value={filterScore} onChange={(e) => setFilterScore(e.target.value)} className="bg-transparent font-bold text-[var(--foreground-muted)] uppercase tracking-widest focus:outline-none cursor-pointer hover:text-[var(--foreground)] transition-colors">
                    <option className="bg-[var(--card-bg)] text-[var(--foreground)]" value="All">SCORE (ALL)</option>
                    <option className="bg-[var(--card-bg)] text-[var(--foreground)]" value="High">HIGH INTENT</option>
                    <option className="bg-[var(--card-bg)] text-[var(--foreground)]" value="Medium">MEDIUM INTENT</option>
                    <option className="bg-[var(--card-bg)] text-[var(--foreground)]" value="Low">LOW INTENT</option>
                  </select>
                </th>
                <th className="px-6 py-4 font-semibold">
                  <select value={filterDate} onChange={(e) => { setFilterDate(e.target.value); if (e.target.value !== "All") { setDateFrom(""); setDateTo(""); } }} className={`bg-transparent font-bold uppercase tracking-widest focus:outline-none cursor-pointer transition-colors ${dateFrom || dateTo ? "text-[var(--primary)]" : "text-[var(--foreground-muted)] hover:text-[var(--foreground)]"}`}>
                    {dateFrom || dateTo ? (<option className="bg-[var(--card-bg)] text-[var(--primary)]" value="Custom">CUSTOM RANGE</option>) : (<><option className="bg-[var(--card-bg)] text-[var(--foreground)]" value="All">ALL TIME</option><option className="bg-[var(--card-bg)] text-[var(--foreground)]" value="Today">TODAY</option><option className="bg-[var(--card-bg)] text-[var(--foreground)]" value="3Days">LAST 3 DAYS</option><option className="bg-[var(--card-bg)] text-[var(--foreground)]" value="7Days">LAST 7 DAYS</option><option className="bg-[var(--card-bg)] text-[var(--foreground)]" value="30Days">LAST 30 DAYS</option></>)}
                  </select>
                </th>
                <th className="px-6 py-4 text-right font-semibold"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-color)]">
              {filteredLeads.map((lead, idx) => (
                <tr key={idx} onClick={() => openLeadDetails(lead)} className="hover:bg-[var(--background)] transition-colors cursor-pointer group">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded bg-[var(--background)] border border-[var(--border-color)] flex items-center justify-center text-[var(--foreground)] font-bold text-xs group-hover:border-[var(--primary)] group-hover:text-[var(--primary)] transition-colors shadow-inner">
                        {lead.name && lead.name !== "Anonymous" ? lead.name.charAt(0).toUpperCase() : "?"}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <div className="font-semibold text-[var(--foreground)] text-sm">{lead.name || "Anonymous"}</div>
                          {lead.id && <span className="text-[9px] font-mono text-[var(--foreground-muted)] bg-[var(--background)] border border-[var(--border-color)] px-1.5 py-0.5 rounded opacity-80 group-hover:border-[var(--primary)]/30 group-hover:text-[var(--primary)] transition-colors">{lead.id.substring(0, 8)}</span>}
                        </div>
                        <div className="text-[var(--foreground-muted)] text-[11px] mt-0.5">{lead.email || lead.phone || "No Contact Provided"}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-[var(--foreground)] text-sm font-medium truncate max-w-[180px]">{lead.business_name || lead.business_type || lead.service_requested || "General Inquiry"}</div>
                    <div className="text-[var(--foreground-muted)] text-[11px] truncate max-w-[180px] mt-0.5">{lead.location ? `${lead.location} • ` : ""}{lead.visitor_intent || "N/A"}</div>
                  </td>
                  <td className="px-6 py-4">
                    {getStatusBadge(lead)}
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <div className={`w-1.5 h-1.5 rounded-full ${lead.lead_score === "High" ? "bg-[var(--primary)] shadow-[0_0_8px_var(--primary)]" : lead.lead_score === "Medium" ? "bg-amber-400" : "bg-gray-400"}`}></div>
                      <div className="flex flex-col">
                        <span className="text-[var(--foreground)] text-xs font-semibold">{lead.lead_score || "N/A"}</span>
                        {lead.urgency_level && lead.urgency_level !== "Low" && <span className={`text-[9px] uppercase font-bold ${lead.urgency_level === "High" ? "text-red-500" : "text-amber-500"}`}>{lead.urgency_level} Urgency</span>}
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-[var(--foreground-muted)] text-xs font-mono">{lead.timestamp ? new Date(lead.timestamp).toLocaleDateString(undefined, { month: "short", day: "2-digit", year: "numeric" }) : "N/A"}</td>
                  <td className="px-6 py-4 text-right"><span className="text-[var(--primary)] text-xs font-semibold opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-end gap-1">View <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" /></svg></span></td>
                </tr>
              ))}

              {filteredLeads.length === 0 && !isLoadingLeads && (
                <tr>
                  <td colSpan="6" className="px-6 py-16 text-center">
                    <div className="inline-flex flex-col items-center justify-center text-[var(--foreground-muted)]">
                      <svg className="w-10 h-10 mb-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      <p className="text-sm font-semibold">No leads found matching your criteria.</p>
                      <button onClick={clearAllFilters} className="mt-3 text-xs text-[var(--primary)] hover:underline">Clear all filters</button>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className={`fixed inset-0 z-50 transition-opacity duration-300 ${isPanelOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}>
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={closeLeadDetails}></div>
        <div className={`absolute right-0 top-0 h-full mt-20 w-full max-w-xl bg-[var(--background)] shadow-[0_0_50px_rgba(0,0,0,0.5)] flex flex-col transform transition-transform duration-300 ease-out ${isPanelOpen ? "translate-x-0" : "translate-x-full"}`}>
          {selectedLead && (
            <>
              <div className="relative flex-shrink-0 px-8 py-8 border-b border-[var(--border-color)] overflow-hidden bg-gradient-to-br from-[var(--lead-from)] via-[var(--card-bg)] to-[var(--background)] z-10">
                <div className="absolute top-0 right-0 w-64 h-64 bg-[var(--primary)] blur-[100px] opacity-20 pointer-events-none"></div>
                <div className="relative z-10 flex justify-between items-start">
                  <div>
                    <div className="flex items-center gap-3 mb-2">
                      <span className={`px-2.5 py-1 rounded-md text-[9px] font-bold uppercase tracking-widest ${
                        selectedLead.booking_status === "Meeting Booked" || selectedLead.booked_slot || selectedLead.selected_date
                          ? "bg-[var(--primary)] text-[var(--background)] shadow-[0_0_10px_var(--lead-glow)]"
                          : selectedLead.booking_status?.toUpperCase().includes("PENDING")
                          ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                          : selectedLead.booking_status?.toUpperCase().includes("UNKNOWN")
                          ? "bg-orange-500/20 text-orange-400 border border-orange-500/30"
                          : "bg-[var(--foreground-muted)]/20 text-[var(--foreground-muted)] border border-[var(--border-color)]"
                      }`}>
                        {selectedLead.lifecycle_status || selectedLead.booking_status || "Captured"}
                      </span>
                      <span className="text-[var(--foreground-muted)] font-mono text-[10px] tracking-wider">REF: {selectedLead.id}</span>
                    </div>
                    <h2 className="text-3xl font-black text-[var(--foreground)] tracking-tight">{selectedLead.name || "Anonymous Prospect"}</h2>
                    {selectedLead.email && (
                      <a href={`mailto:${selectedLead.email}`} className="text-[var(--accent-blue)] text-sm font-medium hover:underline mt-1 inline-flex items-center gap-1.5">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
                        {selectedLead.email}
                      </a>
                    )}
                  </div>
                  <button onClick={closeLeadDetails} className="p-2 text-[var(--foreground)] hover:text-[var(--primary)] bg-[var(--background)]/50 backdrop-blur-md rounded-full border border-[var(--border-color)] transition-all hover:scale-110">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
              </div>

              <div className="flex-grow overflow-y-auto p-8 flex flex-col gap-6 custom-scrollbar bg-[var(--background)] relative z-0 pb-32">
                <section className="grid grid-cols-2 gap-5">
                  <div className="bg-gradient-to-b from-[var(--card-gradient-start)] to-[var(--card-gradient-end)] border border-[var(--border-color)] rounded-2xl p-5 shadow-lg relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-[var(--primary)] to-[var(--accent-blue)] opacity-60"></div>
                    <h3 className="text-[10px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest mb-4 border-b border-[var(--border-color)] pb-2">Client Profile</h3>
                    <div className="space-y-3 text-sm">
                      <div><span className="text-[var(--foreground-muted)] text-[11px] block uppercase tracking-wide">Phone</span> <span className="font-medium">{selectedLead.phone || "—"}</span></div>
                      <div><span className="text-[var(--foreground-muted)] text-[11px] block uppercase tracking-wide">Location</span> <span className="font-medium">{selectedLead.location || "—"}</span></div>
                      <div><span className="text-[var(--foreground-muted)] text-[11px] block uppercase tracking-wide">Company</span> <span className="font-medium">{selectedLead.business_name || selectedLead.business_type || "—"}</span></div>
                      <div><span className="text-[var(--foreground-muted)] text-[11px] block uppercase tracking-wide">Device</span> <span className="font-medium">{selectedLead.deviceName || "—"}</span></div>
                    </div>
                  </div>

                  <div className="bg-gradient-to-b from-[var(--card-gradient-start)] to-[var(--card-gradient-end)] border border-[var(--border-color)] rounded-2xl p-5 shadow-lg relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-[var(--primary)] to-[var(--accent-blue)] opacity-60"></div>
                    <h3 className="text-[10px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest mb-4 border-b border-[var(--border-color)] pb-2">System Metrics</h3>
                    <div className="space-y-3 text-sm">
                      <div><span className="text-[var(--foreground-muted)] text-[11px] block uppercase tracking-wide">Lead Score</span> <span className={`font-bold ${selectedLead.lead_score === "High" ? "text-[var(--primary)]" : ""}`}>{selectedLead.lead_score || "—"}</span></div>
                      <div><span className="text-[var(--foreground-muted)] text-[11px] block uppercase tracking-wide">Urgency</span> <span className={`font-medium ${selectedLead.urgency_level === "High" ? "text-red-500" : ""}`}>{selectedLead.urgency_level || "—"}</span></div>
                      <div><span className="text-[var(--foreground-muted)] text-[11px] block uppercase tracking-wide">Intent</span> <span className="font-medium">{selectedLead.visitor_intent || "—"}</span></div>
                      <div><span className="text-[var(--foreground-muted)] text-[11px] block uppercase tracking-wide">Target Meeting</span> <span className="font-bold text-[var(--accent-blue)]">{selectedLead.booked_slot || selectedLead.selected_date || selectedLead.display_time || "—"}</span></div>
                    </div>
                  </div>
                </section>

                <section className="bg-gradient-to-b from-[var(--card-gradient-start)] to-[var(--card-gradient-end)] border border-[var(--border-color)] rounded-2xl p-6 shadow-lg">
                  <h3 className="text-xs font-bold text-[var(--foreground-muted)] uppercase tracking-widest mb-4 flex items-center gap-2 border-b border-[var(--border-color)] pb-3">
                    <svg className="w-4 h-4 text-[var(--primary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
                    AI Conversation Summary
                  </h3>
                  <div className="bg-[var(--background)] border border-[var(--border-color)] rounded-xl p-5 text-[14px] text-[var(--foreground)] leading-relaxed shadow-inner">
                    {selectedLead.conversation_summary && selectedLead.conversation_summary !== "In progress..." ? selectedLead.conversation_summary : "No summary available for this lead yet."}
                  </div>
                </section>

                {/* 🔥 TICKET: Render Clean Transcript with Actual Firebase Storage Images */}
                <section className="bg-gradient-to-b from-[var(--card-gradient-start)] to-[var(--card-gradient-end)] border border-[var(--border-color)] rounded-2xl p-6 shadow-lg">
                  <h3 className="text-xs font-bold text-[var(--foreground-muted)] uppercase tracking-widest mb-4 flex items-center gap-2 border-b border-[var(--border-color)] pb-3">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/></svg>
                    Conversation Transcript
                  </h3>
                  <div className="bg-[var(--background)] border border-[var(--border-color)] rounded-xl p-5 font-mono text-[13px] text-[var(--foreground)] leading-loose overflow-x-auto shadow-inner">
                    {selectedLead.full_conversation_transcript
                      ? selectedLead.full_conversation_transcript.split("\n").map((line, i) => {
                          const isBot = line.startsWith("[BOT]");
                          const isUser = line.startsWith("[USER]");
                          
                          let displayText = line;
                          let renderImage = false;

                          // User Image Logic: Replace ugly text string and flag UI to render actual image
                          if (isUser && displayText.includes("📷 [Photo submitted for inspection]")) {
                            displayText = "[USER]: 📷 Image Uploaded";
                            renderImage = true;
                          }

                          // Bot Vision Logic: Strip model name (e.g. "(gpt-4o-mini)") and extra asterisks from inspection results
                          if (isBot && displayText.includes("🔍 **Inspection Result**")) {
                            displayText = displayText.replace(/\*\*Inspection Result\*\*\s*\([^)]+\):?/i, "Inspection Result:");
                          }

                          return (
                            <div key={i} className={`mb-2 ${isBot ? "text-[var(--primary)]" : isUser ? "text-[var(--foreground)]" : "text-[var(--foreground-muted)]"}`}>
                              <div className="whitespace-pre-wrap">{displayText}</div>
                              {renderImage && selectedLead.last_inspected_image && (
                                <div className="mt-2.5 mb-3">
                                  <img 
                                    src={selectedLead.last_inspected_image} 
                                    alt="User Inspected Defect" 
                                    className="w-full max-w-sm max-h-64 object-cover rounded-xl border border-[var(--border-color)] shadow-sm cursor-pointer hover:opacity-90 transition-opacity" 
                                    onClick={() => window.open(selectedLead.last_inspected_image, "_blank")}
                                  />
                                </div>
                              )}
                            </div>
                          );
                        })
                      : "Transcript unavailable."}
                  </div>
                </section>

                {selectedLead.generated_body && (
                  <section className="bg-gradient-to-b from-[var(--card-gradient-start)] to-[var(--card-gradient-end)] border border-[var(--border-color)] rounded-2xl p-6 shadow-lg mb-8">
                    <h3 className="text-xs font-bold text-[var(--foreground-muted)] uppercase tracking-widest mb-4 flex items-center gap-2 border-b border-[var(--border-color)] pb-3">
                      <svg className="w-4 h-4 text-[var(--accent-blue)]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
                      Automated Email Dispatch
                    </h3>
                    <div className="bg-[var(--background)] border border-[var(--border-color)] rounded-xl p-5 text-sm shadow-inner">
                      <div className="mb-4 pb-3 border-b border-[var(--border-color)] flex flex-col gap-1">
                        <span className="text-[10px] text-[var(--foreground-muted)] uppercase font-bold tracking-widest">Subject</span>
                        <span className="font-medium text-[var(--foreground)]">{selectedLead.generated_subject}</span>
                      </div>
                      <div className="whitespace-pre-wrap text-[var(--foreground-muted)] leading-relaxed">
                        {selectedLead.generated_body}
                      </div>
                    </div>
                  </section>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      <style dangerouslySetInnerHTML={{ __html: `.fade-in { animation: fadeIn 0.4s ease-out forwards; } @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } } .custom-scrollbar::-webkit-scrollbar { width: 5px; } .custom-scrollbar::-webkit-scrollbar-track { background: transparent; } .custom-scrollbar::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 4px; } .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: var(--foreground-muted); }`}} />
    </main>
  );
} 