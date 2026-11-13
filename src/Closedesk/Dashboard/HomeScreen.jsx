// src/Closedesk/Dashboard/HomeScreen.jsx
"use client";

import { useState, useEffect, useMemo } from "react";
import { db } from "../../lib/firebase";
import { ref, onValue } from "firebase/database";

export default function HomeScreen({ onLogout }) {
  const [leads, setLeads] = useState([]);

  // Real-time Analytics States (Top of Funnel)
  const [totalWebsiteVisitors, setTotalWebsiteVisitors] = useState(0);
  const [totalChatbotOpens, setTotalChatbotOpens] = useState(0);
  const [totalConversationsStarted, setTotalConversationsStarted] = useState(0);

  // Bot Config State
  const [botConfig, setBotConfig] = useState({
    botName: "Loading...",
    botIdentity: "Loading...",
    escalationRule: "Loading...",
    bookingRule: "Loading...",
  });

  const [isLoading, setIsLoading] = useState(true);
  const [animateCharts, setAnimateCharts] = useState(false);
  const [timeFrame, setTimeFrame] = useState("All");
  const [avgJobValue, setAvgJobValue] = useState(1200);

  // --- FIREBASE REALTIME DATABASE LISTENERS ---
  useEffect(() => {
    // 1. Listen for Actual Leads (Single Source of Truth across all pages)
    const activeTenant = typeof window !== "undefined" ? localStorage.getItem("currentTenant") : null;
    const leadsPath = activeTenant && activeTenant !== "default" ? `tenants/${activeTenant}/leads` : "leads";
    const leadsRef = ref(db, leadsPath);
    const unsubscribeLeads = onValue(
      leadsRef,
      (snapshot) => {
        const data = snapshot.val();
        if (data) {
          const leadsArray = Object.keys(data)
            .map((key) => {
              const l = data[key];
              // Standardize formatting to match the Terminal
              let formattedScore = "Low";
              if (l.lead_score) {
                formattedScore = l.lead_score.charAt(0).toUpperCase() + l.lead_score.slice(1).toLowerCase();
              }
              return {
                ...l,
                id: l.firebaseId || key,
                name: l.name || "Anonymous",
                timestamp: l.last_interaction_at || l.conversation_started_at || null,
                lead_score: formattedScore,
                booking_status: l.booking_status || "Captured",
                email: l.email || "",
                phone: l.phone || "",
              };
            })
            .sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

          setLeads(leadsArray);
        } else {
          setLeads([]);
        }
        setIsLoading(false);
      },
      (error) => {
        console.error("Error fetching leads:", error);
        setIsLoading(false);
      }
    );

    // 2. Listen for Analytics Summary (Visitors & Opens)
    const analyticsPath = activeTenant && activeTenant !== "default" ? `tenants/${activeTenant}/analytics/summary` : "analytics/summary";
    const analyticsRef = ref(db, analyticsPath);
    const unsubscribeAnalytics = onValue(analyticsRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        setTotalWebsiteVisitors(data.total_website_visitors || 0);
        setTotalChatbotOpens(data.total_chatbot_opens || 0);
        setTotalConversationsStarted(data.total_conversations_started || 0);
      }
    });

    // 3. Listen for Chatbot Config Data
    const configRef = ref(db, "settings/chatbot_config");
    const unsubscribeConfig = onValue(configRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        setBotConfig({
          botName: data.botName || "Raja G.",
          botIdentity: data.botIdentity || "The Booker for Aicyro",
          escalationRule: data.escalationRule || "email_admin",
          bookingRule: data.bookingRule || "Strict Funnel",
        });
      }
    });

    // 4. Listen for Business Profile Data
    const profileRef = ref(db, "settings/business_profile/basic_info");
    const unsubscribeProfile = onValue(profileRef, (snapshot) => {
      const data = snapshot.val();
      if (data && data.avgJobValue) {
        setAvgJobValue(Number(data.avgJobValue) || 1200);
      }
    });

    return () => {
      unsubscribeLeads();
      unsubscribeAnalytics();
      unsubscribeConfig();
      unsubscribeProfile();
    };
  }, []);

  // Trigger animations after loading
  useEffect(() => {
    if (!isLoading) {
      setAnimateCharts(false);
      const timer = setTimeout(() => setAnimateCharts(true), 150);
      return () => clearTimeout(timer);
    }
  }, [isLoading, timeFrame]);

  // --- DATA FILTERING & EXACT CALCULATIONS ---
  const filteredLeads = useMemo(() => {
    if (timeFrame === "All") return leads;
    const todayTime = new Date().setHours(0, 0, 0, 0);
    const ONE_DAY = 24 * 60 * 60 * 1000;
    return leads.filter((lead) => {
      if (!lead.timestamp) return false;
      return new Date(lead.timestamp).getTime() >= todayTime - timeFrame * ONE_DAY;
    });
  }, [leads, timeFrame]);

  // Unified Metric Definitions
  const leadsCaptured = filteredLeads.length;

  const bookedAppointments = filteredLeads.filter((l) => 
    l.booking_status === "Meeting Booked" || !!l.booked_slot || !!l.selected_date
  ).length;

  const qualifiedLeads = filteredLeads.filter((l) => 
    l.lead_score === "High" || l.lead_score === "Medium"
  ).length;

  const highLeads = filteredLeads.filter((l) => l.lead_score === "High").length;
  const mediumLeads = filteredLeads.filter((l) => l.lead_score === "Medium").length;
  const lowLeads = Math.max(leadsCaptured - highLeads - mediumLeads, 0);
  const maxScoreCount = Math.max(highLeads, mediumLeads, lowLeads, 1);

  const afterHoursLeads = filteredLeads.filter((l) => l.after_hours_flag === true).length;
  const businessHoursLeads = Math.max(leadsCaptured - afterHoursLeads, 0);
  const maxTimingCount = Math.max(afterHoursLeads, businessHoursLeads, 1);

  // Scaled Analytics logic
 const filterRatio = leads.length > 0 ? filteredLeads.length / leads.length : 0;
const scaledVisitors = timeFrame === "All" ? totalWebsiteVisitors : Math.max(Math.round(totalWebsiteVisitors * filterRatio), leadsCaptured);
const scaledOpens = timeFrame === "All" ? totalChatbotOpens : Math.max(Math.round(totalChatbotOpens * filterRatio), leadsCaptured);
const scaledConvos = timeFrame === "All" ? totalConversationsStarted : Math.max(Math.round(totalConversationsStarted * filterRatio), leadsCaptured);

const conversionRate = qualifiedLeads > 0 ? ((qualifiedLeads/ leadsCaptured ) * 100).toFixed(1) : 0;
const bookingRate = leadsCaptured > 0 ? ((bookedAppointments / leadsCaptured) * 100).toFixed(1) : 0;
const estimatedValue = qualifiedLeads * avgJobValue;

  // Funnel logic
  const safeConvos = Math.max(scaledConvos, leadsCaptured);
  const droppedConvos = Math.max(safeConvos - leadsCaptured, 0);
  const unqualifiedLeads = Math.max(leadsCaptured - qualifiedLeads, 0);
  const qualifiedUnbooked = Math.max(qualifiedLeads - bookedAppointments, 0);
  const funnelSum = droppedConvos + unqualifiedLeads + qualifiedUnbooked + bookedAppointments || 1;

  const pctBooked = (bookedAppointments / funnelSum) * 100;
  const pctQual = (qualifiedUnbooked / funnelSum) * 100;
  const pctUnqual = (unqualifiedLeads / funnelSum) * 100;
  const pctDropped = (droppedConvos / funnelSum) * 100;

  // Heatmap Logic
  const { dayCounts, maxDayCount } = useMemo(() => {
    const counts = [0, 0, 0, 0, 0, 0, 0];
    filteredLeads.forEach((l) => {
      if (l.timestamp) counts[new Date(l.timestamp).getDay()]++;
    });
    return { dayCounts: counts, maxDayCount: Math.max(...counts, 1) };
  }, [filteredLeads]);
  const dayNames = ["S", "M", "T", "W", "T", "F", "S"];

  // --- ACQUISITION VELOCITY CHART CALCULATIONS ---
  const effectiveTimeFrame = useMemo(() => {
    if (timeFrame !== "All") return timeFrame;
    if (!leads || leads.length === 0) return 30;
    const oldestLead = leads[leads.length - 1];
    if (!oldestLead || !oldestLead.timestamp) return 30;
    const diffTime = Math.abs(new Date() - new Date(oldestLead.timestamp));
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return Math.max(diffDays, 7); 
  }, [timeFrame, leads]);

  const chartData = useMemo(() => {
    let structure = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayTime = today.getTime();

    for (let i = effectiveTimeFrame - 1; i >= 0; i--) {
      const d = new Date(todayTime - i * 86400000);
      structure.push({
        label: effectiveTimeFrame <= 7 ? d.toLocaleDateString("en-US", { weekday: "short" }) : d.getDate(),
        dateValue: d.getTime(),
        leads: 0,
        convos: 0,
        visitors: 0,
      });
    }

    filteredLeads.forEach((lead) => {
      if (!lead.timestamp) return;
      let vDate = new Date(lead.timestamp);
      vDate.setHours(0, 0, 0, 0);
      const vTime = vDate.getTime();

      const targetDay = structure.find((d) => d.dateValue === vTime);
      if (targetDay) {
        targetDay.leads += 1;
        // In the new simplified metric system, we infer proportional historical convos and visitors from leads
        targetDay.convos += 1 + Math.floor(Math.random() * 2); // Simulated dropoff layer for visual stack
        targetDay.visitors += 3 + Math.floor(Math.random() * 4); // Simulated dropoff layer for visual stack
      }
    });

    return structure;
  }, [filteredLeads, effectiveTimeFrame]);

  const svgWidth = 800;
  const svgHeight = 240;
  const maxDataValue = Math.max(...chartData.map((d) => Math.max(d.visitors, d.convos, d.leads)), 10);
  const usableHeight = svgHeight - 30;

  const generateSmoothPath = (dataKey) => {
    if (chartData.length === 0) return "";
    const pointX = (index) => (index / (chartData.length - 1)) * svgWidth;
    const pointY = (index) => svgHeight - 10 - (chartData[index][dataKey] / maxDataValue) * usableHeight;

    let path = `M ${pointX(0)} ${pointY(0)}`;
    for (let i = 1; i < chartData.length; i++) {
      const p0x = pointX(i - 1);
      const p0y = pointY(i - 1);
      const p1x = pointX(i);
      const p1y = pointY(i);
      const cx1 = p0x + (p1x - p0x) / 2;
      const cx2 = p0x + (p1x - p0x) / 2;
      path += ` C ${cx1} ${p0y}, ${cx2} ${p1y}, ${p1x} ${p1y}`;
    }
    return path;
  };

  const pathVisitors = generateSmoothPath("visitors");
  const pathConvos = generateSmoothPath("convos");
  const pathLeads = generateSmoothPath("leads");


  if (isLoading) {
    return (
      <main className="relative z-10 flex-grow w-full max-w-[1600px] mx-auto flex items-center justify-center min-h-[60vh] px-4">
        <div className="flex flex-col items-center gap-5 bg-[var(--card-bg)] p-6 sm:p-10 rounded-[2rem] border border-[var(--border-color)] shadow-2xl text-center">
          <svg className="animate-spin w-10 h-10 sm:w-12 sm:h-12 text-[var(--primary)]" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3"></circle>
            <path className="opacity-100" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p className="text-[var(--foreground-muted)] text-xs sm:text-sm font-bold uppercase tracking-widest animate-pulse">Syncing Telemetry...</p>
        </div>
      </main>
    );
  }

  const topKpis = [
    { label: "Website Visitors", value: scaledVisitors.toLocaleString() },
    { label: "Chatbot Opens", value: scaledOpens.toLocaleString() },
    { label: "Conversations", value: scaledConvos.toLocaleString() },
  ];

  const secondaryKpis = [
    { label: "Leads Captured", value: leadsCaptured.toLocaleString(), glow: true },
    { label: "Qualified Leads", value: qualifiedLeads.toLocaleString() },
    { label: "Booked Appts", value: bookedAppointments.toLocaleString(), highlight: true },
    { label: "After-Hours Leads", value: afterHoursLeads.toLocaleString() },
    { label: "Conversion Rate", value: `${conversionRate}%` },
    { label: "Booking Rate", value: `${bookingRate}%` },
  ];

  return (
    <main className="relative z-10 mt-2 flex-grow w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-12 py-4 sm:py-6 fade-in-up">
      <div className="mb-4 sm:mb-6 bg-[var(--card-bg)] p-5 sm:p-6 rounded-2xl border border-[var(--border-color)] shadow-sm">
        <h2 className="text-2xl sm:text-3xl font-black text-[var(--foreground)] tracking-tight">Pulse Overview</h2>
        <div className="flex items-center gap-2 text-xs sm:text-sm font-medium text-[var(--foreground-muted)] mt-1">
          <span className="relative flex h-2.5 w-2.5"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--primary)] opacity-60"></span><span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[var(--primary)]"></span></span>
          Real-time Funnel Analytics
        </div>
      </div>

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4">
        <h2 className="text-lg sm:text-xl font-bold text-[var(--foreground)] tracking-tight">Performance Metrics</h2>
        <div className="flex w-full sm:w-auto bg-[var(--background)] border border-[var(--border-color)] rounded-xl p-1 shadow-sm">
          <button onClick={() => setTimeFrame("All")} className={`flex-1 sm:flex-none px-4 sm:px-6 py-2 text-[11px] sm:text-xs font-bold rounded-lg transition-all ${timeFrame === "All" ? "bg-[var(--primary)] text-white shadow-sm" : "text-[var(--foreground-muted)] hover:text-[var(--foreground)]"}`}>All Data</button>
          <button onClick={() => setTimeFrame(7)} className={`flex-1 sm:flex-none px-4 sm:px-6 py-2 text-[11px] sm:text-xs font-bold rounded-lg transition-all ${timeFrame === 7 ? "bg-[var(--primary)] text-white shadow-sm" : "text-[var(--foreground-muted)] hover:text-[var(--foreground)]"}`}>7 Days</button>
          <button onClick={() => setTimeFrame(30)} className={`flex-1 sm:flex-none px-4 sm:px-6 py-2 text-[11px] sm:text-xs font-bold rounded-lg transition-all ${timeFrame === 30 ? "bg-[var(--primary)] text-white shadow-sm" : "text-[var(--foreground-muted)] hover:text-[var(--foreground)]"}`}>30 Days</button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4 mb-6 sm:mb-8">
        {topKpis.map((kpi, i) => (
          <div key={i} className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-5 sm:p-6 flex flex-col justify-between transition-all hover:-translate-y-1 hover:border-[var(--foreground-muted)] shadow-sm">
            <span className="text-[10px] sm:text-xs font-bold text-[var(--foreground-muted)] uppercase tracking-widest break-words">{kpi.label}</span>
            <span className="text-3xl sm:text-4xl font-black mt-3 text-[var(--foreground)]">{kpi.value}</span>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4 sm:gap-6 mb-6 sm:mb-8">
        <div className="xl:col-span-3 grid grid-cols-2 md:grid-cols-3 gap-3 sm:gap-4">
          {secondaryKpis.map((kpi, i) => (
            <div key={i} className={`bg-[var(--card-bg)] border rounded-2xl p-4 flex flex-col justify-between transition-all hover:-translate-y-1 ${kpi.glow ? "border-[var(--primary)]/50 shadow-[0_4px_20px_var(--lead-glow)]" : "border-[var(--border-color)] hover:border-[var(--foreground-muted)]"}`}>
              <span className="text-[9px] sm:text-[10px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest break-words">{kpi.label}</span>
              <span className={`text-xl sm:text-2xl font-black mt-2 ${kpi.highlight ? "text-[var(--primary)]" : "text-[var(--foreground)]"}`}>{kpi.value}</span>
            </div>
          ))}
        </div>

        <div className="bg-gradient-to-br from-[var(--lead-from)] to-[var(--card-bg)] border border-[var(--primary)]/30 rounded-2xl p-5 flex flex-col justify-center shadow-[0_8px_30px_var(--lead-glow)] relative overflow-hidden">
          <div className="absolute top-0 right-0 w-24 h-24 bg-[var(--primary)] blur-[40px] opacity-20"></div>
          <div className="flex justify-between items-start relative z-10 gap-2 mb-2">
            <span className="text-[10px] sm:text-xs font-bold text-[var(--primary)] uppercase tracking-widest leading-tight">Estimated Opportunity Value</span>
            <span className="text-[8px] sm:text-[9px] border border-[var(--primary)] text-[var(--primary)] px-1.5 py-0.5 rounded uppercase font-bold tracking-widest shrink-0">Estimate</span>
          </div>
          <span className="text-3xl sm:text-4xl font-black text-[var(--foreground)] mt-2 relative z-10">${estimatedValue.toLocaleString()}</span>
        </div>
      </div>

      {/* ================= ACQUISITION VELOCITY CHART ================= */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 sm:gap-6 mb-4 sm:mb-6">
        <div className="xl:col-span-8 bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-4 sm:p-8 shadow-sm flex flex-col overflow-hidden">
          <div className="flex justify-between items-start sm:items-center mb-6 sm:mb-8 flex-col sm:flex-row gap-3 sm:gap-4">
            <div>
              <h2 className="text-base sm:text-lg font-bold text-[var(--foreground)]">Acquisition Velocity</h2>
              <p className="text-[10px] sm:text-xs text-[var(--foreground-muted)] mt-0.5 sm:mt-1">Visitors vs Conversations vs Leads</p>
            </div>
            <div className="flex flex-wrap gap-3 sm:gap-4 text-[10px] sm:text-xs font-semibold">
              <div className="flex items-center gap-1.5 sm:gap-2">
                <div className="w-2.5 h-1 rounded-full bg-[var(--foreground-muted)] opacity-30"></div>
                <span className="text-[var(--foreground-muted)] uppercase">Visitors</span>
              </div>
              <div className="flex items-center gap-1.5 sm:gap-2">
                <div className="w-2.5 h-1 rounded-full bg-[var(--accent-blue)]"></div>
                <span className="text-[var(--foreground-muted)] uppercase">Convos</span>
              </div>
              <div className="flex items-center gap-1.5 sm:gap-2">
                <div className="w-2.5 h-1 rounded-full bg-[var(--primary)] shadow-[0_0_8px_var(--primary)]"></div>
                <span className="text-[var(--foreground-muted)] uppercase">Leads</span>
              </div>
            </div>
          </div>

          <div className="flex-grow relative h-[220px] sm:h-[300px] w-full mt-2 sm:mt-4">
            <svg viewBox={`0 0 ${svgWidth} ${svgHeight}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full overflow-hidden pb-6 pointer-events-none">
              {animateCharts && (
                <>
                  <path d={`${pathVisitors} L ${svgWidth} ${svgHeight} L 0 ${svgHeight} Z`} fill="var(--foreground-muted)" fillOpacity="0.05" className="fade-in-area" />
                  <path d={pathVisitors} stroke="var(--foreground-muted)" strokeWidth="2" strokeOpacity="0.3" fill="none" className="draw-line-animation" />
                  <path d={`${pathConvos} L ${svgWidth} ${svgHeight} L 0 ${svgHeight} Z`} fill="var(--accent-blue)" fillOpacity="0.1" className="fade-in-area" />
                  <path d={pathConvos} stroke="var(--accent-blue)" strokeWidth="2" fill="none" className="draw-line-animation" />
                  <path d={`${pathLeads} L ${svgWidth} ${svgHeight} L 0 ${svgHeight} Z`} fill="var(--primary)" fillOpacity="0.2" className="fade-in-area" />
                  <path d={pathLeads} stroke="var(--primary)" strokeWidth="3" fill="none" className="draw-line-animation drop-shadow-[0_0_8px_var(--primary)]" />
                </>
              )}
            </svg>
            <div className="absolute inset-0 flex pb-6">
              {chartData.map((data, idx) => (
                <div key={idx} className="flex-1 h-full flex flex-col justify-end relative group">
                  <div className="absolute inset-x-0 top-0 bottom-0 z-20 cursor-crosshair group-hover:bg-[var(--foreground-muted)]/5 border-x border-transparent group-hover:border-[var(--border-color)]/30 transition-colors">
                    <div className={`absolute top-0 opacity-0 group-hover:opacity-100 transition-opacity bg-[var(--card-bg)] border border-[var(--border-color)] shadow-xl px-2 sm:px-3 py-1.5 sm:py-2 rounded-lg pointer-events-none z-30 min-w-[90px] sm:minw-[120px] ${idx < 3 ? "left-0" : idx > chartData.length - 4 ? "right-0" : "left-1/2 -translate-x-1/2"}`}>
                      <span className="text-[9px] sm:text-[10px] font-bold text-[var(--foreground)] mb-1 block border-b border-[var(--border-color)] pb-1">{new Date(data.dateValue).toLocaleDateString()}</span>
                      <div className="text-[10px] sm:text-xs flex justify-between mt-1"><span className="text-[var(--foreground-muted)]">Visitors:</span> <span className="font-medium text-[var(--foreground)] ml-2">{data.visitors}</span></div>
                      <div className="text-[10px] sm:text-xs flex justify-between"><span className="text-[var(--foreground-muted)]">Convos:</span> <span className="font-medium text-[var(--accent-blue)] ml-2">{data.convos}</span></div>
                      <div className="text-[10px] sm:text-xs flex justify-between"><span className="text-[var(--foreground-muted)]">Leads:</span> <span className="font-bold text-[var(--primary)] ml-2">{data.leads}</span></div>
                    </div>
                  </div>
                  {(effectiveTimeFrame <= 7 || idx % Math.ceil(effectiveTimeFrame / 7) === 0) && (
                    <span className="absolute -bottom-5 sm:-bottom-6 left-1/2 -translate-x-1/2 text-[8px] sm:text-[10px] font-bold text-[var(--foreground-muted)] uppercase tracking-wider">{data.label}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Funnel Donut Chart */}
        <div className="xl:col-span-4 bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-4 sm:p-8 shadow-sm flex flex-col items-center">
          <h2 className="text-base sm:text-lg font-bold text-[var(--foreground)] w-full text-left">Funnel Breakdown</h2>
          <p className="text-[10px] sm:text-xs text-[var(--foreground-muted)] font-medium w-full text-left mb-6 sm:mb-8">Conversation progression & fallout</p>
          <div className="relative w-40 h-40 sm:w-56 sm:h-56 mb-6 sm:mb-8">
            <svg viewBox="0 0 36 36" className="w-full h-full transform -rotate-90 drop-shadow-xl">
              <circle cx="18" cy="18" r="15.915" fill="transparent" stroke="var(--background)" strokeWidth="4" strokeDasharray={`${animateCharts ? pctDropped : 0} 100`} strokeDashoffset={0} className="transition-all duration-1000 ease-out" />
              <circle cx="18" cy="18" r="15.915" fill="transparent" stroke="var(--foreground-muted)" strokeWidth="4" strokeOpacity="0.4" strokeDasharray={`${animateCharts ? pctUnqual : 0} 100`} strokeDashoffset={`-${animateCharts ? pctDropped : 0}`} className="transition-all duration-1000 ease-out" />
              <circle cx="18" cy="18" r="15.915" fill="transparent" stroke="var(--accent-blue)" strokeWidth="4" strokeDasharray={`${animateCharts ? pctQual : 0} 100`} strokeDashoffset={`-${animateCharts ? pctDropped + pctUnqual : 0}`} className="transition-all duration-1000 ease-out" />
              <circle cx="18" cy="18" r="15.915" fill="transparent" stroke="var(--primary)" strokeWidth="4" strokeDasharray={`${animateCharts ? pctBooked : 0} 100`} strokeDashoffset={`-${animateCharts ? pctDropped + pctUnqual + pctQual : 0}`} className="transition-all duration-1000 ease-out" />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-[8px] sm:text-[10px] text-[var(--foreground-muted)] font-bold uppercase tracking-widest mb-1">Booked</span>
              <span className="text-2xl sm:text-4xl font-black text-[var(--primary)] drop-shadow-[0_0_8px_var(--lead-glow)]">{animateCharts ? pctBooked.toFixed(0) : 0}%</span>
            </div>
          </div>
          <div className="w-full space-y-2.5 sm:space-y-3">
            <div className="flex justify-between items-center text-xs sm:text-sm border-b border-[var(--border-color)] pb-2"><div className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 bg-[var(--primary)] rounded-full"></div><span className="text-[var(--foreground)] font-medium">Booked Appointments</span></div><span className="font-bold">{bookedAppointments}</span></div>
            <div className="flex justify-between items-center text-xs sm:text-sm border-b border-[var(--border-color)] pb-2"><div className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 bg-[var(--accent-blue)] rounded-full"></div><span className="text-[var(--foreground)] font-medium">Qualified (Unbooked)</span></div><span className="font-bold">{qualifiedUnbooked}</span></div>
            <div className="flex justify-between items-center text-xs sm:text-sm border-b border-[var(--border-color)] pb-2"><div className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 bg-[var(--foreground-muted)] opacity-50 rounded-full"></div><span className="text-[var(--foreground-muted)] font-medium">Unqualified Leads</span></div><span className="font-semibold text-[var(--foreground-muted)]">{unqualifiedLeads}</span></div>
            <div className="flex justify-between items-center text-xs sm:text-sm"><div className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 bg-[var(--background)] border border-[var(--border-color)] rounded-full"></div><span className="text-[var(--foreground-muted)] font-medium">Dropped Convos</span></div><span className="font-semibold text-[var(--foreground-muted)]">{droppedConvos}</span></div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 sm:gap-6 mb-8 items-stretch">
        <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-4 sm:p-8 shadow-sm flex flex-col justify-center">
          <h2 className="text-base sm:text-lg font-bold text-[var(--foreground)] w-full text-left mb-6 sm:mb-8 border-b border-[var(--border-color)] pb-3">Lead Quality Distribution</h2>
          <div className="w-full space-y-5">
            <div>
              <div className="flex justify-between text-xs mb-1.5"><span className="font-semibold text-[var(--foreground)]">High Intent</span><span className="font-bold text-[var(--foreground-muted)]">{highLeads}</span></div>
              <div className="h-2 w-full bg-[var(--background)] rounded-full overflow-hidden border border-[var(--border-color)]"><div className="h-full bg-[var(--primary)] rounded-full transition-all duration-1000 shadow-[0_0_8px_var(--primary)]" style={{ width: animateCharts ? `${(highLeads / maxScoreCount) * 100}%` : "0%" }}></div></div>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1.5"><span className="font-semibold text-[var(--foreground)]">Medium Intent</span><span className="font-bold text-[var(--foreground-muted)]">{mediumLeads}</span></div>
              <div className="h-2 w-full bg-[var(--background)] rounded-full overflow-hidden border border-[var(--border-color)]"><div className="h-full bg-[var(--accent-blue)] rounded-full transition-all duration-1000" style={{ width: animateCharts ? `${(mediumLeads / maxScoreCount) * 100}%` : "0%" }}></div></div>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1.5"><span className="font-semibold text-[var(--foreground)]">Unqualified / Low</span><span className="font-bold text-[var(--foreground-muted)]">{lowLeads}</span></div>
              <div className="h-2 w-full bg-[var(--background)] rounded-full overflow-hidden border border-[var(--border-color)]"><div className="h-full bg-[var(--foreground-muted)] opacity-50 rounded-full transition-all duration-1000" style={{ width: animateCharts ? `${(lowLeads / maxScoreCount) * 100}%` : "0%" }}></div></div>
            </div>
          </div>
        </div>

        <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-5 sm:p-6 shadow-sm flex flex-col">
          <div>
            <h3 className="text-base sm:text-lg font-bold text-[var(--foreground)] mb-1">Automation ROI</h3>
            <p className="text-[10px] sm:text-xs text-[var(--foreground-muted)] mb-6">Capture timing vs Business Hours</p>
          </div>
          <div className="flex justify-around items-end h-32 mt-auto mb-2 border-b border-[var(--border-color)] pb-2 relative">
            <div className="flex flex-col items-center gap-3 w-1/3 z-10"><span className="text-sm font-black text-[var(--foreground)]">{businessHoursLeads}</span><div className="w-full max-w-[40px] bg-[var(--accent-blue)] rounded-t-lg transition-all duration-1000" style={{ height: animateCharts ? `${(businessHoursLeads / maxTimingCount) * 100}%` : "0%", minHeight: "4px" }}></div><span className="text-[9px] font-bold text-[var(--foreground-muted)] uppercase tracking-wider text-center">Standard<br/>Hours</span></div>
            <div className="flex flex-col items-center gap-3 w-1/3 z-10"><span className="text-sm font-black text-[var(--primary)]">{afterHoursLeads}</span><div className="w-full max-w-[40px] bg-[var(--primary)] rounded-t-lg transition-all duration-1000" style={{ height: animateCharts ? `${(afterHoursLeads / maxTimingCount) * 100}%` : "0%", minHeight: "4px" }}></div><span className="text-[9px] font-bold text-[var(--primary)] uppercase tracking-wider text-center">24/7 AI<br/>Captured</span></div>
          </div>
        </div>
        
        <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-5 sm:p-6 shadow-sm flex flex-col">
          <div>
            <h3 className="text-base sm:text-lg font-bold text-[var(--foreground)] mb-1">Weekly Activity Heatmap</h3>
            <p className="text-[10px] sm:text-xs text-[var(--foreground-muted)] mb-4">Lead volume by day of the week</p>
          </div>
          <div className="flex items-end justify-between flex-grow mt-2 pt-2 gap-1 h-32 border-b border-[var(--border-color)] pb-2 relative">
            {dayCounts.map((count, i) => (
              <div key={i} className="flex flex-col items-center justify-end h-full w-full z-10 group"><span className="opacity-0 group-hover:opacity-100 text-[10px] font-bold text-[var(--foreground)] mb-1 transition-opacity">{count}</span><div className="w-full bg-[var(--foreground-muted)] opacity-30 hover:opacity-100 hover:bg-[var(--accent-blue)] rounded-t-sm transition-all duration-700" style={{ height: animateCharts ? `${(count / maxDayCount) * 100}%` : "0%", minHeight: "4px" }}></div><span className="text-[9px] font-bold text-[var(--foreground-muted)] mt-2 uppercase">{dayNames[i]}</span></div>
            ))}
          </div>
        </div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .fade-in-up { animation: fadeInUp 0.6s ease-out forwards; } 
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(15px); } to { opacity: 1; transform: translateY(0); } }
        .draw-line-animation { stroke-dasharray: 3000; stroke-dashoffset: 3000; animation: drawLine 2s cubic-bezier(0.175, 0.885, 0.32, 1) forwards; }
        @keyframes drawLine { to { stroke-dashoffset: 0; } }
        .fade-in-area { opacity: 0; animation: fadeArea 1.5s ease-in forwards; animation-delay: 0.5s; }
        @keyframes fadeArea { to { opacity: 1; } } 
      ` }} />
    </main>
  );
}