// src/pages/logs.jsx
"use client";

import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { fetchWithTrace, generateCorrelationId } from "../lib/tracer";
import { useRouter } from "next/router";

export default function SystemLogs() {
  const router = useRouter();

  // Auth & RBAC State
  const [authStatus, setAuthStatus] = useState("CHECKING");
  const [activeRole, setActiveRole] = useState("CLIENT");
  const [targetClientId, setTargetClientId] = useState("");
  const [isSuperAdminAuth, setIsSuperAdminAuth] = useState(false);

  const [logs, setLogs] = useState([]);
  const [totalDbLogs, setTotalDbLogs] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  // Live Mode State
  const [isLiveMode, setIsLiveMode] = useState(true);

  // General Filtering States
  const [filterService, setFilterService] = useState("ALL");
  const [filterComponent, setFilterComponent] = useState("ALL"); 
  const [filterLevel, setFilterLevel] = useState("ALL");
  const [filterEnvironment, setFilterEnvironment] = useState("ALL");
  const [searchTerm, setSearchTerm] = useState("");

  // Advanced Tracking Filters
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [filterSessionId, setFilterSessionId] = useState("");
  const [filterCorrelationId, setFilterCorrelationId] = useState("");
  const [filterLeadId, setFilterLeadId] = useState("");
  const [filterStatus, setFilterStatus] = useState("ALL");

  // Chronological Sorting State
  const [sortOrder, setSortOrder] = useState("DESC");

  // Expanded Row State
  const [expandedLogId, setExpandedLogId] = useState(null);

  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 50;
  const pollIntervalRef = useRef(null);

  useEffect(() => {
    const superAdminUser = localStorage.getItem("currentSuperAdmin");
    const standardUser = localStorage.getItem("currentUser");

    if (superAdminUser) {
      setIsSuperAdminAuth(true);
      setActiveRole("SUPERADMIN");
      setTargetClientId("ALL");
      setAuthStatus("AUTHORIZED");
    } else if (standardUser) {
      setIsSuperAdminAuth(false);
      setActiveRole("CLIENT");
      setTargetClientId(standardUser);
      setAuthStatus("AUTHORIZED");
    } else {
      setAuthStatus("DENIED");
      setIsLoading(false);
    }
  }, []);

  const fetchLogsSecurely = useCallback(async (isBackgroundPoll = false) => {
    if (authStatus !== "AUTHORIZED") return;

    try {
      const txId = generateCorrelationId();
      const response = await fetchWithTrace(
        "/api/app-query",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            role: activeRole,
            userId: localStorage.getItem("currentSuperAdmin") || localStorage.getItem("currentUser") || "anonymous",
            targetClientId: targetClientId,
            searchTerm: searchTerm,
          }),
        },
        txId,
      );

      if (response.ok) {
        const data = await response.json();
        if (data && data.logs) {
          setLogs(data.logs);
          setTotalDbLogs(data.totalLogs);
        } else if (Array.isArray(data)) {
          setLogs(data);
        }
      } else {
        console.error("Failed to fetch logs - Unauthorized or Server Error");
      }
    } catch (error) {
      console.error("Network error fetching logs:", error);
    } finally {
      if (!isBackgroundPoll) setIsLoading(false);
    }
  }, [authStatus, activeRole, targetClientId, searchTerm]);

  // Initial Data Load
  useEffect(() => {
    if (authStatus === "AUTHORIZED") {
      setIsLoading(true);
      fetchLogsSecurely(false);
    }
  }, [authStatus, activeRole, targetClientId]);

  // Live Tailing Poller
  useEffect(() => {
    if (authStatus === "AUTHORIZED" && isLiveMode) {
      pollIntervalRef.current = setInterval(() => {
        fetchLogsSecurely(true);
      }, 5000);
      return () => clearInterval(pollIntervalRef.current);
    }
  }, [authStatus, isLiveMode, fetchLogsSecurely]);

  const filteredLogs = useMemo(() => {
    if (!logs) return [];
    const lowerSearchTerm = searchTerm.toLowerCase().trim();

    let result = logs.filter((log) => {
      const svc = (log.service || "Website").toLowerCase();
      const comp = (log.component || "Activity Tracker").toLowerCase(); 
      const lvl = (log.level || (log.type === "click" ? "INFO" : "INFO")).toUpperCase();
      const env = (log.environment || "production").toLowerCase();

      if (filterService !== "ALL" && svc !== filterService.toLowerCase()) return false;
      if (filterComponent !== "ALL" && comp !== filterComponent.toLowerCase()) return false;
      if (filterLevel !== "ALL" && lvl !== filterLevel.toUpperCase()) return false;
      if (filterEnvironment !== "ALL" && env !== filterEnvironment.toLowerCase()) return false;
      if (filterStatus !== "ALL" && String(log.status_code) !== filterStatus && log.status !== filterStatus && log.metadata?.status !== filterStatus) return false;

      if (filterSessionId && !log.session_id?.toLowerCase().includes(filterSessionId.toLowerCase())) return false;
      if (filterCorrelationId && !log.correlation_id?.toLowerCase().includes(filterCorrelationId.toLowerCase())) return false;
      if (filterLeadId && !(log.lead_id || log.metadata?.lead_id)?.toLowerCase().includes(filterLeadId.toLowerCase())) return false;

      if (dateFrom && new Date(log.timestamp) < new Date(dateFrom)) return false;
      if (dateTo && new Date(log.timestamp) > new Date(dateTo)) return false;

      if (lowerSearchTerm) {
        // Includes every metadata field from Phases 1-5
        const searchTarget = [
          log.service, log.component, log.event_type, log.type, log.event_name, log.text,
          log.path, log.url, log.user_id, log.user, log.session_id, log.correlation_id,
          log.message, log.error_message, log.source_path, log.endpoint, log.http_method,
          log.status_code, log.build_id, log.application_version, log.prompt_version,
          log.knowledge_version, log.action_by, log.target_id,
          log.tool_name || log.metadata?.tool_name, log.lead_id || log.metadata?.lead_id,
          log.integration_name || log.metadata?.integration_name, log.error_stage || log.metadata?.error_stage
        ].filter(Boolean).join(" ").toLowerCase();

        if (!searchTarget.includes(lowerSearchTerm)) return false;
      }

      return true;
    });

    result.sort((a, b) => {
      const dateA = new Date(a.timestamp).getTime();
      const dateB = new Date(b.timestamp).getTime();
      return sortOrder === "DESC" ? dateB - dateA : dateA - dateB;
    });

    return result;

  }, [logs, filterService, filterComponent, filterLevel, filterEnvironment, searchTerm, dateFrom, dateTo, filterSessionId, filterCorrelationId, filterLeadId, filterStatus, sortOrder]);

  useEffect(() => { setCurrentPage(1); }, [filterService, filterComponent, filterLevel, filterEnvironment, searchTerm, dateFrom, dateTo, filterSessionId, filterCorrelationId, filterLeadId, filterStatus, sortOrder]);

  const totalPages = Math.ceil(filteredLogs.length / itemsPerPage);
  const paginatedLogs = filteredLogs.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  const getLevelColor = (level) => {
    switch (level) {
      case "ERROR":
      case "CRITICAL": return "bg-red-500/10 text-red-600 border-red-500/30";
      case "WARN": return "bg-yellow-500/10 text-yellow-600 border-yellow-500/30";
      case "DEBUG": return "bg-gray-500/10 text-gray-500 border-gray-500/30";
      default: return "bg-blue-500/10 text-blue-600 border-blue-500/30";
    }
  };

  const toggleRowExpansion = (id) => {
    setExpandedLogId(expandedLogId === id ? null : id);
  };

  const handleViewTrace = (correlationId) => {
    setFilterCorrelationId(correlationId);
    setSortOrder("ASC"); 
    setShowAdvancedFilters(true);
    setCurrentPage(1);
    setExpandedLogId(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Data Export Logic
  const handleExport = (format) => {
    if (activeRole === "CLIENT") {
      alert("Export permission is restricted to authorized administrative roles.");
      return;
    }

    if (filteredLogs.length === 0) {
      alert("No logs match the current filters.");
      return;
    }

    try {
      let exportData = "";
      let mimeType = "";
      let fileExtension = "";

      if (format === "JSON") {
        exportData = JSON.stringify(filteredLogs, null, 2);
        mimeType = "application/json";
        fileExtension = "json";
      } else if (format === "CSV") {
        const headers = [
          "timestamp", "level", "environment", "service", "component", 
          "event_type", "event_name", "session_id", "correlation_id", 
          "lead_id", "action_by", "target_id", "status_code", "duration_ms", 
          "message", "error_message", "application_version", "build_id"
        ];
        
        const rows = filteredLogs.map(log => {
          return headers.map(header => {
            let val = log[header] || log.metadata?.[header] || "";
            if (typeof val === "object") val = JSON.stringify(val);
            return `"${String(val).replace(/"/g, '""')}"`;
          }).join(",");
        });
        
        exportData = [headers.join(","), ...rows].join("\n");
        mimeType = "text/csv";
        fileExtension = "csv";
      }

      const blob = new Blob([exportData], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `system_logs_export_${new Date().toISOString().split('T')[0]}.${fileExtension}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

    } catch (error) {
      console.error("Export failed:", error);
      alert("Failed to generate export file. The dataset might be too large for browser memory.");
    }
  };

  if (authStatus === "DENIED") {
    return (
      <div className="min-h-screen bg-[var(--background)] flex flex-col items-center justify-center p-4">
        <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-3xl p-10 max-w-md w-full text-center shadow-2xl">
          <div className="w-16 h-16 bg-red-500/10 text-red-500 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
          </div>
          <h1 className="text-2xl font-black text-[var(--foreground)] mb-2">Access Denied</h1>
          <p className="text-[var(--foreground-muted)] text-sm font-medium mb-8">You must be logged into Aicyro Pulse or the Admin Portal to view system activity logs.</p>
          <button onClick={() => router.push("/lg")} className="w-full bg-[var(--primary)] text-white font-bold py-3.5 rounded-xl hover:scale-[1.02] transition-transform">Go to Login</button>
        </div>
      </div>
    );
  }

  if (authStatus === "CHECKING") {
    return <div className="min-h-screen bg-[var(--background)] flex items-center justify-center"><div className="w-8 h-8 border-4 border-[var(--primary)] border-t-transparent rounded-full animate-spin"></div></div>;
  }

  return (
    <div className="min-h-screen bg-[var(--background)] text-[var(--foreground)] font-sans flex flex-col items-center py-10 px-4 sm:px-8">
      <div className="w-full max-w-[1400px]">
        <header className="mb-6 flex justify-between items-end">
          <div>
            <h1 className="text-3xl font-black tracking-tight">System Pulse Logs</h1>
            <p className="text-[var(--foreground-muted)] font-medium text-sm mt-1">Live, searchable audit trail protected by RBAC.</p>
          </div>
          <div className="text-sm font-bold text-[var(--foreground-muted)] flex flex-col items-end gap-2">
            <span className="bg-[var(--card-bg)] border border-[var(--border-color)] px-3 py-1.5 rounded-lg shadow-sm">
              Showing <span className="text-[var(--primary)]">{filteredLogs.length}</span> / {totalDbLogs.toLocaleString()} Entries
            </span>

            {isSuperAdminAuth ? (
              <div className="flex items-center gap-2 bg-[var(--card-bg)] border border-[var(--border-color)] p-2 rounded-lg">
                <span className="text-xs uppercase text-[var(--accent-blue)]">Simulate Role:</span>
                <select value={activeRole} onChange={(e) => setActiveRole(e.target.value)} className="bg-[var(--background)] border border-[var(--border-color)] text-xs rounded px-2 py-1 font-bold focus:outline-none">
                  <option value="SUPERADMIN">Super Admin (Full Access)</option>
                  <option value="DEVELOPER">Developer (Technical)</option>
                  <option value="QA">QA (App & AI)</option>
                  <option value="SUPPORT">Support (Operational)</option>
                  <option value="CLIENT">Client (Restricted Redacted)</option>
                </select>
              </div>
            ) : (
              <div className="flex items-center gap-2 bg-[var(--primary)]/10 border border-[var(--primary)]/30 text-[var(--primary)] p-2 rounded-lg">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
                <span className="text-xs uppercase font-bold tracking-widest">Client View Active</span>
              </div>
            )}
          </div>
        </header>

        <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-4 shadow-sm mb-6 flex flex-col gap-4">
          <div className="flex flex-col md:flex-row items-center gap-3 w-full">
            <div className="relative flex-grow w-full min-w-0">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--foreground-muted)]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
              <input type="text" placeholder="Global search: endpoints, builds, errors, tool names..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:border-[var(--primary)] transition-colors" />
            </div>
            
            <div className="flex gap-2 w-full md:w-auto shrink-0 overflow-x-auto pb-1 md:pb-0 scrollbar-hide">
              
              <button 
                onClick={() => fetchLogsSecurely(false)} 
                disabled={isLiveMode}
                className={`p-2.5 border rounded-xl flex items-center justify-center transition-colors ${isLiveMode ? "opacity-50 cursor-not-allowed bg-[var(--background)] border-[var(--border-color)] text-[var(--foreground-muted)]" : "bg-[var(--background)] border-[var(--border-color)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"}`}
                title="Refresh Logs"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>

              <button 
                onClick={() => setIsLiveMode(!isLiveMode)} 
                className={`px-3 py-2.5 border rounded-xl text-xs font-bold flex flex-1 md:flex-none justify-center items-center gap-2 transition-colors whitespace-nowrap ${isLiveMode ? "bg-green-500/10 border-green-500/30 text-green-500 hover:bg-green-500/20" : "bg-[var(--background)] border-[var(--border-color)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"}`}
              >
                {isLiveMode ? (
                  <>
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                    </span>
                    Live
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    Paused
                  </>
                )}
              </button>

              <button 
                onClick={() => setSortOrder(prev => prev === "DESC" ? "ASC" : "DESC")} 
                className={`px-4 py-2.5 border rounded-xl text-xs font-bold flex flex-1 md:flex-none justify-center items-center gap-2 transition-colors whitespace-nowrap ${sortOrder === "ASC" ? "bg-purple-500/10 border-purple-500/30 text-purple-400" : "bg-[var(--background)] border-[var(--border-color)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"}`}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  {sortOrder === "DESC" ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" /> : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4" />}
                </svg>
                {sortOrder === "DESC" ? "Newest First" : "Chronological"}
              </button>

              <button 
                onClick={() => setShowAdvancedFilters(!showAdvancedFilters)} 
                className={`px-4 py-2.5 border rounded-xl text-xs font-bold flex flex-1 md:flex-none justify-center items-center gap-2 transition-colors whitespace-nowrap ${showAdvancedFilters ? "bg-[var(--primary)]/10 border-[var(--primary)]/30 text-[var(--primary)]" : "bg-[var(--background)] border-[var(--border-color)] text-[var(--foreground-muted)] hover:text-[var(--foreground)]"}`}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>
                Filters
              </button>

              {activeRole !== "CLIENT" && (
                <div className="flex gap-1 border-l border-[var(--border-color)] pl-2 ml-1">
                  <button 
                    onClick={() => handleExport("JSON")} 
                    className="px-3 py-2.5 bg-[var(--background)] border border-[var(--border-color)] rounded-lg text-xs font-bold text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors"
                    title="Export to JSON"
                  >
                    JSON
                  </button>
                  <button 
                    onClick={() => handleExport("CSV")} 
                    className="px-3 py-2.5 bg-[var(--background)] border border-[var(--border-color)] rounded-lg text-xs font-bold text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors"
                    title="Export to CSV"
                  >
                    CSV
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-3 w-full">
            <select value={filterLevel} onChange={(e) => setFilterLevel(e.target.value)} className="flex-1 min-w-[140px] bg-[var(--background)] border border-[var(--border-color)] text-sm rounded-lg px-3 py-2 font-semibold text-[var(--foreground-muted)] focus:outline-none focus:border-[var(--primary)]">
              <option value="ALL">Severity (All)</option><option value="INFO">INFO</option><option value="DEBUG">DEBUG</option><option value="WARN">WARN</option><option value="ERROR">ERROR</option><option value="CRITICAL">CRITICAL</option>
            </select>
            <select value={filterEnvironment} onChange={(e) => setFilterEnvironment(e.target.value)} className="flex-1 min-w-[140px] bg-[var(--background)] border border-[var(--border-color)] text-sm rounded-lg px-3 py-2 font-semibold text-[var(--foreground-muted)] focus:outline-none focus:border-[var(--primary)]">
              <option value="ALL">Environment (All)</option><option value="production">Production</option><option value="development">Development</option>
            </select>
            <select value={filterService} onChange={(e) => setFilterService(e.target.value)} className="flex-1 min-w-[140px] bg-[var(--background)] border border-[var(--border-color)] text-sm rounded-lg px-3 py-2 font-semibold text-[var(--foreground-muted)] focus:outline-none focus:border-[var(--primary)]">
              <option value="ALL">Service (All)</option><option value="Website">Website</option><option value="API">API</option><option value="AI">AI</option><option value="Voice">Voice</option><option value="Pulse">Pulse</option>
            </select>
            <select value={filterComponent} onChange={(e) => setFilterComponent(e.target.value)} className="flex-1 min-w-[180px] bg-[var(--background)] border border-[var(--border-color)] text-sm rounded-lg px-3 py-2 font-semibold text-[var(--foreground-muted)] focus:outline-none focus:border-[var(--primary)]">
              <option value="ALL">Component / API (All)</option>
              <optgroup label="Frontend Components">
                <option value="Activity Tracker">Activity Tracker</option><option value="ChatbotWidget">Chatbot Widget</option><option value="VoiceAgent">Voice Agent</option><option value="ClientManagement">Client Management</option>
              </optgroup>
              <optgroup label="Backend APIs">
                <option value="Generate-Audit-API">Generate-Audit-API</option><option value="Generate-Email-API">Generate-Email-API</option><option value="Lead-Terminal-API">Lead-Terminal-API</option><option value="Login-API">Login-API</option><option value="Text-Chat-API">Text-Chat-API</option><option value="Sync-Voice-API">Sync-Voice-API</option>
              </optgroup>
            </select>
          </div>

          {showAdvancedFilters && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 p-4 mt-2 bg-[var(--background)]/50 border border-[var(--border-color)] rounded-xl animate-acy-fade">
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-[var(--foreground-muted)] mb-1 block">Start Date</label>
                <input type="datetime-local" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-full bg-[var(--card-bg)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-xs text-[var(--foreground)] focus:outline-none focus:border-[var(--primary)]" />
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-[var(--foreground-muted)] mb-1 block">End Date</label>
                <input type="datetime-local" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-full bg-[var(--card-bg)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-xs text-[var(--foreground)] focus:outline-none focus:border-[var(--primary)]" />
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-[var(--foreground-muted)] mb-1 block">Session / Convo ID</label>
                <input type="text" placeholder="lead_12345..." value={filterSessionId} onChange={(e) => setFilterSessionId(e.target.value)} className="w-full bg-[var(--card-bg)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-xs text-[var(--foreground)] focus:outline-none focus:border-[var(--primary)]" />
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-[var(--foreground-muted)] mb-1 block">Correlation Trace ID</label>
                <input type="text" placeholder="req_..." value={filterCorrelationId} onChange={(e) => setFilterCorrelationId(e.target.value)} className="w-full bg-[var(--card-bg)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-xs text-[var(--foreground)] focus:outline-none focus:border-[var(--primary)]" />
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-[var(--foreground-muted)] mb-1 block">Lead ID</label>
                <input type="text" placeholder="Target Lead ID" value={filterLeadId} onChange={(e) => setFilterLeadId(e.target.value)} className="w-full bg-[var(--card-bg)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-xs text-[var(--foreground)] focus:outline-none focus:border-[var(--primary)]" />
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-[var(--foreground-muted)] mb-1 block">Status Code / State</label>
                <input type="text" placeholder="200, 500, success, failed..." value={filterStatus === "ALL" ? "" : filterStatus} onChange={(e) => setFilterStatus(e.target.value || "ALL")} className="w-full bg-[var(--card-bg)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-xs text-[var(--foreground)] focus:outline-none focus:border-[var(--primary)]" />
              </div>
              <div className="col-span-1 md:col-span-2 flex items-end justify-end gap-2">
                <button onClick={() => { setDateFrom(""); setDateTo(""); setFilterSessionId(""); setFilterCorrelationId(""); setFilterLeadId(""); setFilterStatus("ALL"); setSortOrder("DESC"); }} className="px-4 py-2 bg-[var(--card-bg)] border border-[var(--border-color)] text-[var(--foreground-muted)] hover:text-[var(--logo-politico-red)] text-xs font-bold rounded-lg transition-colors">Clear Advanced</button>
              </div>
            </div>
          )}
        </div>

        <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto min-h-[500px]">
            {isLoading && logs.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-[500px]">
                <p className="text-[var(--foreground-muted)] font-bold text-sm">Authenticating and fetching logs...</p>
              </div>
            ) : paginatedLogs.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-[500px] text-[var(--foreground-muted)]">
                <p className="text-sm font-medium">No events match your role permissions and criteria.</p>
              </div>
            ) : (
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead>
                  <tr className="bg-[var(--background)]/50 border-b border-[var(--border-color)] text-[10px] uppercase tracking-widest text-[var(--foreground-muted)] font-bold">
                    <th className="px-6 py-4 w-44">Timestamp & Env</th>
                    <th className="px-6 py-4 w-32">Level & Svc</th>
                    <th className="px-6 py-4">Event & Location</th>
                    <th className="px-6 py-4 w-48">Identifiers</th>
                    <th className="px-6 py-4 w-64">Outcome & Message</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-color)]">
                  {paginatedLogs.map((log, index) => {
                    const level = log.level || (log.type === "click" ? "INFO" : "INFO");
                    const service = log.service || "Website";
                    const eventName = log.event_name || (log.type === "click" ? `Clicked: ${log.text?.substring(0, 20)}` : log.type === "page_view" ? `Viewed: ${log.path}` : "System Event");
                    const eventType = log.event_type || log.type || "user_action";

                    const toolName = log.tool_name || log.metadata?.tool_name;
                    const leadId = log.lead_id || log.metadata?.lead_id;
                    const dbPath = log.path || log.metadata?.path;
                    const integration = log.integration_name || log.metadata?.integration_name;
                    const attemptNum = log.attempt_number || log.metadata?.attempt_number;
                    const maxAttempts = log.max_attempts || log.metadata?.max_attempts;
                    const isExpanded = expandedLogId === (log.log_id || log.id || index);

                    return (
                      <React.Fragment key={log.log_id || log.id || index}>
                        <tr onClick={() => toggleRowExpansion(log.log_id || log.id || index)} className="hover:bg-[var(--background)] transition-colors cursor-pointer group">
                          
                          <td className="px-6 py-4 flex flex-col gap-0.5">
                            <span className="text-xs font-mono text-[var(--foreground-muted)]">
                              {log.timestamp ? new Date(log.timestamp).toLocaleString() : "Unknown Time"}
                            </span>
                            <span className={`text-[10px] uppercase font-bold ${log.environment === "development" ? "text-orange-500" : "text-green-500"}`}>
                              {log.environment || "production"}
                            </span>
                          </td>

                          <td className="px-6 py-4">
                            <div className="flex flex-col items-start gap-1">
                              <span className={`inline-flex items-center px-2 py-1 rounded-md text-[10px] font-bold border ${getLevelColor(level)}`}>
                                {level}
                              </span>
                              <span className="text-xs font-bold text-[var(--foreground)]">{service}</span>
                            </div>
                          </td>

                          <td className="px-6 py-4">
                            <div className="flex flex-col gap-1 max-w-[250px] truncate">
                              <span className="text-xs font-semibold text-[var(--foreground)] truncate flex items-center gap-1.5" title={log.endpoint || eventName}>
                                {log.http_method && log.endpoint ? (
                                  <><span className={`text-[9px] font-black px-1.5 py-0.5 rounded uppercase tracking-wider ${log.http_method === "GET" ? "bg-blue-500/10 text-blue-500" : log.http_method === "POST" ? "bg-green-500/10 text-green-500" : "bg-gray-500/10 text-gray-500"}`}>{log.http_method}</span> <span className="truncate">{log.endpoint}</span></>
                                ) : ( <span>{eventName}</span> )}
                              </span>
                              <span className="text-[10px] uppercase text-[var(--foreground-muted)] tracking-wider truncate">{eventType} • {log.component || "Tracker"}</span>
                              {toolName && <span className="text-[9px] font-mono bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-1.5 py-0.5 rounded mt-1 w-max">Tool: {toolName}</span>}
                              {integration && <span className="text-[9px] bg-purple-500/10 text-purple-400 px-1.5 py-0.5 rounded mt-1 w-max">API: {integration}</span>}
                              {dbPath && <span className="text-[9px] bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 rounded mt-1 w-max truncate max-w-full">DB: {dbPath}</span>}
                            </div>
                          </td>

                          <td className="px-6 py-4">
                            <div className="flex flex-col gap-1 font-mono text-[10px]">
                              {log.session_id ? (
                                <span className="text-[var(--primary)] truncate max-w-[180px]" title={log.session_id}>Sess: {log.session_id.substring(0,18)}...</span>
                              ) : <span className="text-[var(--foreground-muted)]">No Session</span>}
                              
                              {log.correlation_id && (
                                <span className="text-[var(--accent-blue)] truncate max-w-[180px]" title={log.correlation_id}>Trace: {log.correlation_id.substring(0, 18)}...</span>
                              )}
                              
                              {leadId && <span className="text-emerald-500 truncate max-w-[180px]" title={leadId}>Lead: {leadId.substring(0,14)}...</span>}

                              {(log.action_by || log.target_id) && (
                                <div className="mt-1 flex flex-col font-sans">
                                  {log.action_by && <span><b className="text-[var(--foreground-muted)]">By:</b> <span className="text-[var(--foreground)]">{log.action_by}</span></span>}
                                  {log.target_id && <span><b className="text-[var(--foreground-muted)]">To:</b> <span className="text-[var(--foreground)] truncate max-w-[120px] inline-block align-bottom">{log.target_id}</span></span>}
                                </div>
                              )}
                            </div>
                          </td>

                          <td className="px-6 py-4">
                            <div className="flex flex-col gap-1 max-w-[250px] truncate">
                              
                              {(log.application_version || log.build_id) && (
                               <span className="text-[9px] font-mono text-[var(--foreground-muted)] mb-0.5">
                                 v{log.application_version || "1.0.0"} | Build: {log.build_id?.substring(0,7) || "local"}
                               </span>
                              )}
                              
                              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                {log.status_code && (
                                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${log.status_code >= 400 ? "bg-red-500/10 text-red-500 border-red-500/20" : "bg-green-500/10 text-green-500 border-green-500/20"}`}>
                                    {log.status_code}
                                  </span>
                                )}
                                {(log.status || log.metadata?.status) && (
                                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border uppercase ${(log.status || log.metadata?.status) === "failed" ? "bg-red-500/10 text-red-500 border-red-500/20" : "bg-green-500/10 text-green-500 border-green-500/20"}`}>
                                    {log.status || log.metadata?.status}
                                  </span>
                                )}
                                {log.duration_ms && (
                                  <span className="text-[10px] font-mono text-[var(--foreground-muted)]">⚡ {log.duration_ms}ms</span>
                                )}
                                {attemptNum && (
                                  <span className="text-[9px] bg-orange-500/10 text-orange-500 border border-orange-500/20 px-1.5 py-0.5 rounded">
                                    Attempt {attemptNum}/{maxAttempts || "?"}
                                  </span>
                                )}
                              </div>

                              {eventName === "turn_metrics_recorded" && log.metadata && (
                                <div className="flex gap-1.5 mt-1 overflow-hidden">
                                  {log.metadata.stt_latency_ms && <span className="text-[9px] bg-blue-500/10 text-blue-400 px-1 rounded">STT: {log.metadata.stt_latency_ms}ms</span>}
                                  {log.metadata.ai_latency_ms && <span className="text-[9px] bg-purple-500/10 text-purple-400 px-1 rounded">AI: {log.metadata.ai_latency_ms}ms</span>}
                                  {log.metadata.interrupted && <span className="text-[9px] bg-red-500/10 text-red-500 px-1 rounded font-bold">Interrupted</span>}
                                </div>
                              )}
                              
                              <span className="text-xs text-[var(--foreground)] truncate font-semibold mt-1" title={log.error_message || log.message}>
                                {log.error_message ? `Err: ${log.error_message}` : log.message || "Trace Logged"}
                              </span>

                              {log.metadata && activeRole === "SUPERADMIN" && <span className="text-[9px] text-yellow-500 font-bold uppercase mt-1">Has Hidden Metadata (Click)</span>}
                              {!log.metadata && activeRole === "CLIENT" && <span className="text-[9px] text-[var(--foreground-muted)] uppercase tracking-widest opacity-60 mt-1">Data Redacted</span>}
                            </div>
                          </td>
                        </tr>

                        {isExpanded && (
                          <tr className="bg-[var(--background)] border-b border-[var(--border-color)] shadow-inner">
                            <td colSpan="5" className="px-8 py-6">
                              <div className="flex flex-col gap-6">
                                
                                <div className="flex justify-between items-center">
                                  <h4 className="text-sm font-black text-[var(--foreground)] tracking-tight uppercase">Deep Trace Inspection</h4>
                                  <div className="flex gap-3 items-center">
                                    {log.correlation_id && (
                                      <button
                                        onClick={(e) => { e.stopPropagation(); handleViewTrace(log.correlation_id); }}
                                        className="flex items-center gap-2 px-4 py-2 bg-[var(--accent-blue)]/10 text-[var(--accent-blue)] border border-[var(--accent-blue)]/30 rounded-lg text-xs font-bold hover:bg-[var(--accent-blue)] hover:text-white transition-colors"
                                      >
                                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                                        View Entire Trace
                                      </button>
                                    )}
                                    <button onClick={(e) => { e.stopPropagation(); toggleRowExpansion(null); }} className="p-1 text-[var(--foreground-muted)] hover:text-[var(--logo-politico-red)] transition-colors">
                                      <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
                                    </button>
                                  </div>
                                </div>

                                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-5 bg-[var(--card-bg)] border border-[var(--border-color)] rounded-xl">
                                  <div><p className="text-[9px] uppercase font-bold text-[var(--foreground-muted)]">Timestamp</p><p className="text-xs font-mono text-[var(--foreground)] mt-1">{log.timestamp ? new Date(log.timestamp).toISOString() : "N/A"}</p></div>
                                  <div><p className="text-[9px] uppercase font-bold text-[var(--foreground-muted)]">Environment</p><p className="text-xs font-mono text-[var(--foreground)] mt-1">{log.environment} (v{log.application_version || "1.0"})</p></div>
                                  <div><p className="text-[9px] uppercase font-bold text-[var(--foreground-muted)]">Service / Component</p><p className="text-xs font-semibold text-[var(--foreground)] mt-1">{log.service} &rarr; {log.component}</p></div>
                                  <div><p className="text-[9px] uppercase font-bold text-[var(--foreground-muted)]">Performance</p><p className="text-xs font-mono text-[var(--foreground)] mt-1">{log.duration_ms ? `${log.duration_ms} ms` : "N/A"}</p></div>
                                  
                                  <div><p className="text-[9px] uppercase font-bold text-[var(--foreground-muted)]">Correlation Trace</p><p className="text-xs font-mono text-[var(--accent-blue)] mt-1">{log.correlation_id || "N/A"}</p></div>
                                  <div><p className="text-[9px] uppercase font-bold text-[var(--foreground-muted)]">Session ID</p><p className="text-xs font-mono text-[var(--foreground)] mt-1">{log.session_id || "N/A"}</p></div>
                                  <div><p className="text-[9px] uppercase font-bold text-[var(--foreground-muted)]">Lead ID</p><p className="text-xs font-mono text-[var(--foreground)] mt-1">{log.lead_id || log.metadata?.lead_id || "N/A"}</p></div>
                                  <div><p className="text-[9px] uppercase font-bold text-[var(--foreground-muted)]">Request ID</p><p className="text-xs font-mono text-[var(--foreground)] mt-1">{log.request_id || "N/A"}</p></div>
                                </div>

                                {(log.error_message || log.error_code || log.error) && (
                                  <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-xl">
                                    <h5 className="text-[10px] font-bold text-red-500 uppercase tracking-wider mb-2">Error Details</h5>
                                    <p className="text-xs text-red-400 font-mono mb-3">Code: {log.error_code || "N/A"} | Msg: {log.error_message || log.message}</p>
                                    {log.error && (
                                      <pre className="text-[10px] text-red-300 font-mono overflow-x-auto whitespace-pre-wrap bg-red-950/30 p-3 rounded-lg border border-red-500/20">
                                        {typeof log.error === 'object' ? JSON.stringify(log.error, null, 2) : log.error}
                                      </pre>
                                    )}
                                  </div>
                                )}

                                <div>
                                  <h5 className="text-[10px] font-bold text-[var(--foreground-muted)] uppercase tracking-wider mb-2">Raw JSON Payload</h5>
                                  {/* 🔥 Text color explicitly set to gray-200 for dark-mode terminal look */}
                                  <pre className="text-[11px] text-gray-200 bg-[#0f1115] border border-gray-800 p-4 rounded-xl overflow-x-auto font-mono whitespace-pre-wrap shadow-inner">
                                    {JSON.stringify(log, null, 2)}
                                  </pre>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {totalPages > 1 && (
            <div className="bg-[var(--background)]/50 border-t border-[var(--border-color)] px-6 py-4 flex items-center justify-between">
              <span className="text-xs font-medium text-[var(--foreground-muted)]">
                Showing {Math.min(filteredLogs.length, (currentPage - 1) * itemsPerPage + 1)} to {Math.min(filteredLogs.length, currentPage * itemsPerPage)} of {filteredLogs.length} logs
              </span>
              <div className="flex gap-2">
                <button onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-4 py-2 text-xs font-bold rounded-lg border border-[var(--border-color)] text-[var(--foreground)] disabled:opacity-30 transition-all hover:bg-[var(--card-bg)]">
                  Previous
                </button>
                <button onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className="px-4 py-2 text-xs font-bold rounded-lg border border-[var(--border-color)] text-[var(--foreground)] disabled:opacity-30 transition-all hover:bg-[var(--card-bg)]">
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}