// src/Closedesk/Dashboard/Report.jsx
"use client";

import { useState, useEffect, useMemo } from "react";
import { db } from "../../lib/firebase";
import { ref, onValue } from "firebase/database";

const REPORT_TYPES = [
  { id: "weekly_lead", label: "Lead Generation", icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" },
  { id: "monthly_perf", label: "Overall Performance", icon: "M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" },
  { id: "booked_appt", label: "Booked Appointments", icon: "M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" },
  { id: "missed_opp", label: "Missed Opportunities", icon: "M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" },
  { id: "after_hours", label: "After-Hours Leads", icon: "M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" },
  { id: "convo_insight", label: "Conversation Insights", icon: "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" },
  { id: "est_opp", label: "Estimated Opportunity", icon: "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
];

export default function Report({ onLogout }) {
  const [leads, setLeads] = useState([]);
  const [analytics, setAnalytics] = useState({ visitors: 0, opens: 0, convos: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [activeReport, setActiveReport] = useState(REPORT_TYPES[0]);
  const [isExporting, setIsExporting] = useState(null);
  const [dateRange, setDateRange] = useState("Last 7 Days");
  const [avgJobValue, setAvgJobValue] = useState(1200);

  const [toast, setToast] = useState({ show: false, message: "", type: "success" });
  const [hoveredBar, setHoveredBar] = useState(null);

  const showToast = (message, type = "success") => {
    setToast({ show: true, message, type });
    setTimeout(() => setToast({ show: false, message: "", type: "success" }), 3500);
  };

  useEffect(() => {
    const tenantId = typeof window !== "undefined" ? (localStorage.getItem("currentTenant") || "default") : "default";
    const isTenant = tenantId && tenantId !== "default";

    const leadsPath = isTenant ? `tenants/${tenantId}/leads` : "leads";
    const analyticsPath = isTenant ? `tenants/${tenantId}/analytics/summary` : "analytics/summary";
    const profilePath = isTenant ? `tenants/${tenantId}/business_profile/basic_info` : "settings/business_profile/basic_info";

    const leadsRef = ref(db, leadsPath);
    const analyticsRef = ref(db, analyticsPath);
    const profileRef = ref(db, profilePath);

    const unsubscribeLeads = onValue(leadsRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        const liveData = Object.keys(data).map((key) => {
          const item = data[key];
          
          let formattedScore = "Low";
          if (item.lead_score) {
            formattedScore = item.lead_score.charAt(0).toUpperCase() + item.lead_score.slice(1).toLowerCase();
          }

          return {
            id: key,
            ...item,
            timestamp: item.last_interaction_at || item.conversation_started_at || null,
            lead_score: formattedScore
          };
        });

        setLeads(liveData.filter((lead) => lead.timestamp).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()));
      } else {
        setLeads([]);
      }
      setIsLoading(false);
    }, (err) => {
      console.warn("Report: RTDB leads read restricted, falling back to server-mediated API:", err);
      const storedTenant = typeof window !== "undefined" ? localStorage.getItem("currentTenant") : null;
      fetch(storedTenant && storedTenant !== "default" ? `/api/leads?tenant=${encodeURIComponent(storedTenant)}` : "/api/leads", {
        headers: storedTenant && storedTenant !== "default" ? { "x-tenant-id": storedTenant } : {},
      })
        .then((r) => r.json())
        .then((data) => {
          const leadsObj = data.leads || data || {};
          const liveData = Object.keys(leadsObj).map((key) => {
            const item = leadsObj[key];
            let formattedScore = "Low";
            if (item.lead_score) {
              formattedScore = item.lead_score.charAt(0).toUpperCase() + item.lead_score.slice(1).toLowerCase();
            }
            return {
              id: key,
              ...item,
              timestamp: item.last_interaction_at || item.conversation_started_at || null,
              lead_score: formattedScore
            };
          });
          setLeads(liveData.filter((lead) => lead.timestamp).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()));
        })
        .catch(() => setLeads([]))
        .finally(() => setIsLoading(false));
    });

    const unsubscribeAnalytics = onValue(analyticsRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        setAnalytics({
          visitors: data.total_website_visitors || 0,
          opens: data.total_chatbot_opens || 0,
          convos: data.total_conversations_started || 0,
        });
      }
    });

    const unsubscribeProfile = onValue(profileRef, (snapshot) => {
      const data = snapshot.val();
      if (data && data.avgJobValue) {
        setAvgJobValue(Number(data.avgJobValue) || 1200);
      }
    });

    return () => {
      unsubscribeLeads();
      unsubscribeAnalytics();
      unsubscribeProfile();
    };
  }, []);

  const filteredLeads = useMemo(() => {
    const now = new Date();
    return leads.filter((lead) => {
      if (!lead.timestamp) return false;
      const leadDate = new Date(lead.timestamp);
      if (isNaN(leadDate.getTime())) return false;
      const diffMs = now.getTime() - leadDate.getTime();

      if (dateRange === "Last 24 Hours") return diffMs >= 0 && diffMs <= 24 * 60 * 60 * 1000;
      if (dateRange === "Last 7 Days") return diffMs >= 0 && diffMs <= 7 * 24 * 60 * 60 * 1000;
      if (dateRange === "Last 30 Days") return diffMs >= 0 && diffMs <= 30 * 24 * 60 * 60 * 1000;
      if (dateRange === "This Quarter") {
        const currentQuarter = Math.floor(now.getMonth() / 3);
        const leadQuarter = Math.floor(leadDate.getMonth() / 3);
        return leadDate.getFullYear() === now.getFullYear() && leadQuarter === currentQuarter;
      }
      if (dateRange === "Year to Date") return leadDate.getFullYear() === now.getFullYear();
      return true;
    });
  }, [leads, dateRange]);

  const reportData = useMemo(() => {
    let buckets = [];
    let mapToChart = () => {};
    const now = new Date();

    if (dateRange === "Last 24 Hours") {
      const nowHour = new Date();
      nowHour.setMinutes(0, 0, 0);
      for (let i = 23; i >= 0; i--) {
        const d = new Date(nowHour);
        d.setHours(d.getHours() - i);
        buckets.push({ label: d.toLocaleTimeString("en-US", { hour: "numeric", hour12: true }), matchKey: `${d.getDate()}-${d.getHours()}`, val: 0 });
      }
      mapToChart = (leadsToMap, valMultiplier = 1) => {
        leadsToMap.forEach((lead) => {
          if (!lead.timestamp) return;
          const ld = new Date(lead.timestamp);
          const b = buckets.find((x) => x.matchKey === `${ld.getDate()}-${ld.getHours()}`);
          if (b) b.val += valMultiplier;
        });
      };
    } else if (dateRange === "Last 7 Days" || dateRange === "Last 30 Days") {
      const days = dateRange === "Last 7 Days" ? 7 : 30;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        buckets.push({ label: days === 7 ? d.toLocaleDateString("en-US", { weekday: "short" }) : d.getDate().toString(), matchKey: d.toDateString(), val: 0 });
      }
      mapToChart = (leadsToMap, valMultiplier = 1) => {
        leadsToMap.forEach((lead) => {
          if (!lead.timestamp) return;
          const b = buckets.find((x) => x.matchKey === new Date(lead.timestamp).toDateString());
          if (b) b.val += valMultiplier;
        });
      };
    } else {
      const startMonth = dateRange === "This Quarter" ? Math.floor(now.getMonth() / 3) * 3 : 0;
      for (let i = startMonth; i <= now.getMonth(); i++) {
        const d = new Date(now.getFullYear(), i, 1);
        buckets.push({ label: d.toLocaleDateString("en-US", { month: "short" }), matchKey: `${d.getFullYear()}-${d.getMonth()}`, val: 0 });
      }
      mapToChart = (leadsToMap, valMultiplier = 1) => {
        leadsToMap.forEach((lead) => {
          if (!lead.timestamp) return;
          const ld = new Date(lead.timestamp);
          const b = buckets.find((x) => x.matchKey === `${ld.getFullYear()}-${ld.getMonth()}`);
          if (b) b.val += valMultiplier;
        });
      };
    }

    const filterRatio = leads.length > 0 ? filteredLeads.length / leads.length : 0;
    const scaledVisitors = Math.max(Math.round(analytics.visitors * filterRatio), filteredLeads.length);
    const scaledOpens = Math.max(Math.round(analytics.opens * filterRatio), filteredLeads.length);
    const scaledConvos = Math.max(Math.round(analytics.convos * filterRatio), filteredLeads.length);

    let summary = [];
    let processedLeads = [];

    switch (activeReport.id) {
      case "weekly_lead":
        processedLeads = filteredLeads;
        mapToChart(processedLeads);
        summary = [
          { label: "Total Leads Captured", val: processedLeads.length.toLocaleString() },
          { label: "High Intent", val: processedLeads.filter((l) => l.lead_score === "High").length.toLocaleString() },
          { label: "Conversion Rate", val: scaledConvos > 0 ? `${((processedLeads.length / scaledConvos) * 100).toFixed(1)}%` : "0%" },
        ];
        break;

      case "booked_appt":
        processedLeads = filteredLeads.filter((l) => l.booking_status === "Meeting Booked" || !!l.booked_slot || !!l.selected_date);
        mapToChart(processedLeads);
        summary = [
          { label: "Total Bookings", val: processedLeads.length.toLocaleString() },
          { label: "Booking Rate", val: filteredLeads.length > 0 ? `${((processedLeads.length / filteredLeads.length) * 100).toFixed(1)}%` : "0%" },
          { label: "Sync Success", val: processedLeads.filter((l) => l.calendar_sync !== "Failed").length.toLocaleString() },
        ];
        break;

      case "missed_opp":
        processedLeads = filteredLeads.filter((l) => l.booking_status !== "Meeting Booked" && !l.booked_slot && !l.selected_date);
        mapToChart(processedLeads);
        const qualifiedMissedLeads = processedLeads.filter((l) => l.lead_score === "High" || l.lead_score === "Medium").length;
        summary = [
          { label: "Unbooked Leads", val: processedLeads.length.toLocaleString() },
          { label: "Dropped Convos", val: Math.max(scaledConvos - filteredLeads.length, 0).toLocaleString() },
          { label: "Potential Lost Value", val: `$${(qualifiedMissedLeads * avgJobValue).toLocaleString()}` },
        ];
        break;

      case "after_hours":
        processedLeads = filteredLeads.filter((l) => l.after_hours_flag === true);
        mapToChart(processedLeads);
        summary = [
          { label: "After-Hours Captured", val: processedLeads.length.toLocaleString() },
          { label: "Pct of Total Leads", val: filteredLeads.length > 0 ? `${((processedLeads.length / filteredLeads.length) * 100).toFixed(1)}%` : "0%" },
          { label: "Saved Opportunity", val: `$${(processedLeads.filter((l) => l.lead_score === "High" || l.lead_score === "Medium").length * avgJobValue).toLocaleString()}` },
        ];
        break;

      case "est_opp":
        processedLeads = filteredLeads.filter((l) => l.lead_score === "High" || l.lead_score === "Medium");
        mapToChart(processedLeads, avgJobValue);
        const totalValue = processedLeads.length * avgJobValue;
        const bookedValue = filteredLeads.filter((l) => l.booking_status === "Meeting Booked" || !!l.booked_slot || !!l.selected_date).length * avgJobValue;
        summary = [
          { label: "Total Pipeline Value", val: `$${totalValue.toLocaleString()}` },
          { label: "Avg Appointment Value", val: `$${avgJobValue.toLocaleString()}` },
          { label: "Secured Revenue", val: `$${bookedValue.toLocaleString()}`, highlight: true },
        ];
        break;

      case "convo_insight":
      case "monthly_perf":
      default:
        processedLeads = filteredLeads;
        mapToChart(processedLeads);
        summary = [
          { label: "Website Visitors", val: scaledVisitors.toLocaleString() },
          { label: "Chatbot Opens", val: scaledOpens.toLocaleString() },
          { label: "Conversations Started", val: scaledConvos.toLocaleString() },
        ];
        break;
    }

    return { summary, chartBuckets: buckets, tableData: processedLeads };
  }, [activeReport, filteredLeads, analytics, avgJobValue, dateRange, leads.length]);

  const svgWidth = 800;
  const svgHeight = 260;
  const chartPaddingLeft = 40;
  const chartPaddingRight = 20;
  const chartPaddingTop = 30;
  const chartPaddingBottom = 40;

  const graphInnerWidth = svgWidth - chartPaddingLeft - chartPaddingRight;
  const graphInnerHeight = svgHeight - chartPaddingTop - chartPaddingBottom;
  const maxChartVal = Math.max(...reportData.chartBuckets.map((d) => d.val), 1);

  const executeCSVExport = () => {
    const escapeCSV = (str) => {
      if (str === null || str === undefined) return "";
      let s = String(str);
      if (/^[\s]*[=+\-@\t\r]/.test(s)) s = "'" + s;
      return s.replace(/"/g, '""');
    };
    const headers = ["Lead ID,Name,Email,Phone,Business Name,Service Requested,Status,Lead Score,Date"];
    const rows = reportData.tableData.map((l) => `"${escapeCSV(l.id)}","${escapeCSV(l.name || "")}","${escapeCSV(l.email || "")}","${escapeCSV(l.phone || "")}","${escapeCSV(l.business_name || "")}","${escapeCSV(l.service_requested || "")}","${escapeCSV(l.booking_status || "")}","${escapeCSV(l.lead_score || "")}","${l.timestamp ? new Date(l.timestamp).toLocaleDateString() : "N/A"}"`);
    const csvContent = "data:text/csv;charset=utf-8," + headers.concat(rows).join("\n");
    const link = document.createElement("a");
    link.setAttribute("href", encodeURI(csvContent));
    link.setAttribute("download", `Aicyro_${activeReport.id}_export.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const executeEmailExport = () => {
    const subject = encodeURIComponent(`Aicyro Pulse: ${activeReport.label} (${dateRange})`);
    const bodyText = `Report: ${activeReport.label}\nTimeframe: ${dateRange}\n\n--- SUMMARY ---\n${reportData.summary.map((s) => `${s.label}: ${s.val}`).join("\n")}\n\nTotal Records: ${reportData.tableData.length}\n\nPlease login to the Aicyro dashboard for full interactive details.`;
    window.location.href = `mailto:?subject=${subject}&body=${encodeURIComponent(bodyText)}`;
  };

  const handleExport = (type) => {
    setIsExporting(type);
    setTimeout(() => {
      try {
        if (type === "csv") executeCSVExport();
        if (type === "pdf") window.print();
        if (type === "email") executeEmailExport();
        showToast(`${activeReport.label} successfully generated as ${type.toUpperCase()}`, "success");
      } catch (e) {
        showToast(`Failed to export ${type.toUpperCase()}`, "error");
      }
      setIsExporting(null);
    }, 800);
  };

  if (isLoading) {
    return (
      <main className="relative z-10 flex-grow w-full max-w-[1600px] mx-auto flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-5 bg-[var(--card-bg)] p-10 rounded-[2rem] border border-[var(--border-color)] shadow-2xl">
          <svg className="animate-spin w-12 h-12 text-[var(--primary)] drop-shadow-[0_0_15px_var(--primary)]" fill="none" viewBox="0 0 24 24"><circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3"></circle><path className="opacity-100" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
          <p className="text-[var(--foreground-muted)] text-sm font-bold uppercase tracking-widest animate-pulse">Compiling Reports...</p>
        </div>
      </main>
    );
  }

  return (
    <main className="relative z-10 flex-grow w-full max-w-[1600px] mx-auto px-6 sm:px-12 py-8 fade-in printable-report-container">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-8 no-print">
        <div>
          <h1 className="text-3xl font-bold text-[var(--foreground)] tracking-tight">Pulse Reports</h1>
          <p className="text-[var(--foreground-muted)] text-sm mt-1">Generate, analyze, and export your lead and conversation data.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 h-auto lg:h-[calc(100vh-220px)] min-h-[600px]">
        <div className="lg:col-span-3 flex flex-col gap-4 no-print">
          <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-5 shadow-sm">
            <h2 className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest mb-4">Report Type</h2>
            <div className="flex flex-col gap-2">
              {REPORT_TYPES.map((report) => (
                <button key={report.id} onClick={() => setActiveReport(report)} className={`flex items-center gap-3 px-4 py-3.5 rounded-xl text-sm font-semibold transition-all duration-200 text-left ${activeReport.id === report.id ? "bg-[var(--primary)]/10 text-[var(--primary)] border border-[var(--primary)]/30 shadow-[0_0_15px_var(--lead-glow)]" : "bg-[var(--background)] text-[var(--foreground-muted)] border border-[var(--border-color)] hover:border-[var(--foreground-muted)] hover:text-[var(--foreground)]"}`}>
                  <svg className={`w-5 h-5 shrink-0 ${activeReport.id === report.id ? "text-[var(--primary)]" : "opacity-60"}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={report.icon} /></svg>
                  <span className="truncate">{report.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-5 shadow-sm mt-auto">
            <h2 className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest mb-4">Global Parameters</h2>
            <div className="relative">
              <select value={dateRange} onChange={(e) => setDateRange(e.target.value)} className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 pr-10 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--primary)] transition-all cursor-pointer appearance-none shadow-inner font-semibold">
                <option value="Last 24 Hours">Last 24 Hours</option>
                <option value="Last 7 Days">Last 7 Days</option>
                <option value="Last 30 Days">Last 30 Days</option>
                <option value="This Quarter">This Quarter</option>
                <option value="Year to Date">Year to Date</option>
              </select>
              <svg className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--foreground-muted)] pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" /></svg>
            </div>
          </div>
        </div>

        <div className="lg:col-span-9 bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl flex flex-col overflow-hidden shadow-sm relative printable-area">
          <div className="px-8 py-6 border-b border-[var(--border-color)] bg-[var(--background)]/30 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div>
              <h2 className="text-2xl font-bold text-[var(--foreground)] tracking-tight">{activeReport.label}</h2>
              <p className="text-[var(--foreground-muted)] text-sm mt-1">Data preview for {dateRange}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3 no-print">
              <button onClick={() => handleExport("csv")} disabled={isExporting !== null} className="flex items-center gap-2 px-4 py-2.5 bg-[var(--background)] border border-[var(--border-color)] hover:border-[var(--primary)] hover:text-[var(--primary)] text-[var(--foreground)] text-xs font-bold uppercase tracking-wider rounded-lg transition-all disabled:opacity-50">
                {isExporting === "csv" ? <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path></svg> : <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>}
                CSV
              </button>
              <button onClick={() => handleExport("pdf")} disabled={isExporting !== null} className="flex items-center gap-2 px-4 py-2.5 bg-[var(--background)] border border-[var(--border-color)] hover:border-red-400 hover:text-red-400 text-[var(--foreground)] text-xs font-bold uppercase tracking-wider rounded-lg transition-all disabled:opacity-50">
                {isExporting === "pdf" ? <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path></svg> : <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>}
                PDF
              </button>
              <button onClick={() => handleExport("email")} disabled={isExporting !== null} className="flex items-center gap-2 px-4 py-2.5 bg-[var(--primary)] hover:opacity-90 text-white text-xs font-bold uppercase tracking-wider rounded-lg shadow-[0_0_15px_var(--lead-glow)] transition-all disabled:opacity-50">
                {isExporting === "email" ? <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path></svg> : <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>}
                Email
              </button>
            </div>
          </div>

          <div className="flex-grow p-8 flex flex-col gap-8 overflow-y-auto custom-scrollbar">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
              {reportData.summary.map((card, i) => (
                <div key={`${activeReport.id}-${i}`} className={`border rounded-xl p-5 ${card.highlight ? "bg-[var(--lead-glow)] border-[var(--primary)]/30" : "bg-gradient-to-br from-[var(--background)] to-[var(--card-bg)] border-[var(--border-color)]"}`}>
                  <span className={`text-[10px] font-bold uppercase tracking-widest ${card.highlight ? "text-[var(--primary)]" : "text-[var(--foreground-muted)]"}`}>{card.label}</span>
                  <span className="block text-3xl font-black text-[var(--foreground)] mt-2">{card.val}</span>
                </div>
              ))}
            </div>

            <div className="bg-[var(--background)] border border-[var(--border-color)] rounded-2xl p-6 shadow-inner flex flex-col relative">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-sm font-bold text-[var(--foreground)]">Trend Visualization</h3>
                <span className="text-[10px] font-mono text-[var(--foreground-muted)] bg-[var(--card-bg)] border border-[var(--border-color)] px-2 py-1 rounded no-print">LIVE RUNTIME SCALING</span>
              </div>

              <div className="w-full relative h-[260px]">
                <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} className="w-full h-full overflow-visible">
                  {[0, 0.25, 0.5, 0.75, 1].map((ratio, i) => {
                    const yPos = chartPaddingTop + ratio * graphInnerHeight;
                    return (
                      <g key={i} className="opacity-10">
                        <line x1={chartPaddingLeft} y1={yPos} x2={svgWidth - chartPaddingRight} y2={yPos} stroke="var(--foreground)" strokeWidth="1" strokeDasharray="4 4" />
                        <text x={chartPaddingLeft - 10} y={yPos + 4} textAnchor="end" fill="var(--foreground)" className="text-[10px] font-mono font-bold">
                          {activeReport.id === "est_opp" ? `$${Math.round((1 - ratio) * maxChartVal).toLocaleString()}` : Math.round((1 - ratio) * maxChartVal).toLocaleString()}
                        </text>
                      </g>
                    );
                  })}
                  {reportData.chartBuckets.map((data, idx) => {
                    const totalBars = reportData.chartBuckets.length;
                    const barSpacing = graphInnerWidth / totalBars;
                    const barWidth = Math.max(barSpacing * 0.65, 2);
                    const barX = chartPaddingLeft + idx * barSpacing + (barSpacing - barWidth) / 2;
                    const barHeight = (data.val / maxChartVal) * graphInnerHeight;
                    const barY = svgHeight - chartPaddingBottom - barHeight;
                    const isDense = totalBars >= 24;
                    const showLabel = !isDense || idx % Math.ceil(totalBars / 6) === 0;

                    return (
                      <g key={idx} className="cursor-crosshair" onMouseEnter={() => setHoveredBar(idx)} onMouseLeave={() => setHoveredBar(null)}>
                        <rect x={chartPaddingLeft + idx * barSpacing} y={chartPaddingTop} width={barSpacing} height={graphInnerHeight} fill="transparent" />
                        <rect x={barX} y={barY} width={barWidth} height={barHeight} rx={Math.min(barWidth / 3, 4)} fill="url(#barGradient)" className="transition-all duration-500 ease-out shadow-[0_0_10px_var(--lead-glow)]" style={{ transitionProperty: "height, y" }} />
                        {showLabel && <text x={barX + barWidth / 2} y={svgHeight - chartPaddingBottom + 18} textAnchor="middle" fill="var(--foreground-muted)" className="text-[10px] font-bold uppercase tracking-wider">{data.label}</text>}
                      </g>
                    );
                  })}
                  <defs><linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--primary)" /><stop offset="100%" stopColor="var(--primary)" stopOpacity="0.2" /></linearGradient></defs>
                </svg>

                {hoveredBar !== null && reportData.chartBuckets[hoveredBar] && (
                  <div className="absolute bg-[var(--card-bg)] border border-[var(--border-color)] px-3 py-2 rounded-xl shadow-2xl text-xs pointer-events-none z-50 animate-acy-fade" style={{ left: `${(hoveredBar / reportData.chartBuckets.length) * 100}%`, top: "10%", transform: "translateX(-50%)" }}>
                    <p className="font-bold text-[var(--foreground-muted)] text-[10px] uppercase mb-0.5">{reportData.chartBuckets[hoveredBar].label}</p>
                    <p className="font-black text-[var(--foreground)] text-sm">
                      {activeReport.id === "est_opp" ? `$${reportData.chartBuckets[hoveredBar].val.toLocaleString()}` : `${reportData.chartBuckets[hoveredBar].val.toLocaleString()} Units`}
                    </p>
                  </div>
                )}
              </div>
            </div>

            <div>
              <h3 className="text-sm font-bold text-[var(--foreground)] mb-4 border-b border-[var(--border-color)] pb-2">Extracted Report Records</h3>
              <div className="space-y-2">
                {reportData.tableData.length > 0 ? (
                  reportData.tableData.slice(0, 8).map((lead) => (
                    <div key={lead.id} className="flex flex-col sm:flex-row sm:justify-between sm:items-center text-xs p-3 bg-[var(--background)] border border-[var(--border-color)] rounded-lg hover:border-[var(--primary)]/50 transition-colors">
                      <span className="text-[var(--foreground)] font-medium sm:w-1/4 truncate">{lead.name || "Unknown Visitor"}</span>
                      <span className="text-[var(--foreground-muted)] sm:w-1/4 truncate">{lead.service_requested || lead.visitor_intent || "General Inquiry"}</span>
                      <span className="text-[var(--foreground-muted)] sm:w-1/4 sm:text-center mt-2 sm:mt-0">{lead.timestamp ? new Date(lead.timestamp).toLocaleDateString() : "N/A"}</span>
                      <span className={`font-bold mt-2 sm:mt-0 text-right ${lead.booking_status === "Meeting Booked" || lead.booked_slot || lead.selected_date ? "text-green-400" : "text-[var(--primary)]"}`}>
                        {lead.booking_status === "Meeting Booked" || lead.booked_slot || lead.selected_date ? "Booked" : lead.lead_score === "High" ? "High Intent" : "Captured"}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-6 text-[var(--foreground-muted)] text-sm border border-dashed border-[var(--border-color)] rounded-xl bg-[var(--background)]">No data matching this report criteria for the selected timeframe.</div>
                )}
                {reportData.tableData.length > 8 && <div className="text-center pt-2 text-[10px] text-[var(--foreground-muted)] uppercase tracking-widest no-print">+ {reportData.tableData.length - 8} more records (Export to view all)</div>}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className={`fixed bottom-6 right-6 z-[100] transition-all duration-500 ease-out ${toast.show ? "translate-y-0 opacity-100" : "translate-y-10 opacity-0 pointer-events-none"}`}>
        <div className="app-toast border shadow-[0_10px_40px_rgba(0,0,0,0.3)] rounded-2xl p-4 pr-10 flex items-center gap-3 relative overflow-hidden backdrop-blur-xl">
          <div className={`absolute left-0 top-0 bottom-0 w-1.5 ${toast.type === "success" ? "bg-green-500" : "bg-red-500"}`}></div>
          <div className={`w-8 h-8 rounded-full flex items-center justify-center ${toast.type === "success" ? "app-toast-icon-circle-success" : "app-toast-icon-circle-error"}`}>
            {toast.type === "success" ? <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" /></svg> : <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>}
          </div>
          <div>
            <p className="text-[10px] font-bold app-toast-label uppercase tracking-widest mb-0.5">System Notification</p>
            <p className="text-sm font-semibold">{toast.message}</p>
          </div>
          <button onClick={() => setToast({ ...toast, show: false })} className="absolute right-3 top-1/2 -translate-y-1/2 app-toast-close">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `.fade-in { animation: fadeIn 0.4s ease-out forwards; } @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } } .animate-slide-up { opacity: 0; animation: slideUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards; } @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } } .custom-scrollbar::-webkit-scrollbar { width: 6px; } .custom-scrollbar::-webkit-scrollbar-track { background: transparent; } .custom-scrollbar::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 4px; } .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: var(--primary); } @media print { @page { size: landscape; margin: 0; } html, body { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; width: 100vw; height: 100vh; margin: 0; padding: 0; } body * { visibility: hidden; } .printable-report-container { padding: 0 !important; margin: 0 !important; } .printable-area, .printable-area * { visibility: visible; } .printable-area { position: absolute; left: 0; top: 0; width: 100vw; min-height: 100vh; border: none !important; box-shadow: none !important; background: var(--background) !important; } .no-print { display: none !important; } }` }} />
    </main>
  );
}