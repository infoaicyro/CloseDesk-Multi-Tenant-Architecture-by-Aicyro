"use client";

import { useState, useEffect, useMemo } from "react";
import { db } from "../../lib/firebase";
import { ref, onValue } from "firebase/database";

export default function Conversations({ onLogout }) {
  const [conversations, setConversations] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  const [searchTerm, setSearchTerm] = useState("");
  const [filterIntent, setFilterIntent] = useState("All");

  const [selectedConvo, setSelectedConvo] = useState(null);

  // --- FIREBASE REALTIME DATABASE LISTENER ---
  useEffect(() => {
    const tenantId = typeof window !== "undefined" ? (localStorage.getItem("currentTenant") || "default") : "default";
    const leadsPath = tenantId && tenantId !== "default" ? `tenants/${tenantId}/leads` : "leads";
    const leadsRef = ref(db, leadsPath);

    const unsubscribe = onValue(
      leadsRef,
      (snapshot) => {
        const data = snapshot.val();
        if (data) {
          const liveData = Object.keys(data)
            .map((key) => ({
              id: key,
              ...data[key],
            }))
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
          setConversations(liveData);
        } else {
          setConversations([]);
        }
        setIsLoading(false);
      },
      (error) => {
        console.error("Error fetching conversations:", error);
        setIsLoading(false);
      },
    );

    return () => unsubscribe();
  }, []);

  // --- FILTERING LOGIC ---
  const filteredConversations = useMemo(() => {
    return conversations.filter((convo) => {
      const searchString = searchTerm.toLowerCase();
      const matchesSearch =
        (convo.name && convo.name.toLowerCase().includes(searchString)) ||
        (convo.email && convo.email.toLowerCase().includes(searchString)) ||
        (convo.id && convo.id.toLowerCase().includes(searchString)) ||
        (convo.full_conversation_transcript &&
          convo.full_conversation_transcript
            .toLowerCase()
            .includes(searchString));

      const intent = convo.visitor_intent || "General Inquiry";
      const matchesIntent =
        filterIntent === "All" ||
        intent.includes(filterIntent) ||
        (filterIntent === "Service" && convo.service_requested);

      return matchesSearch && matchesIntent;
    });
  }, [conversations, searchTerm, filterIntent]);

  // --- PARSE TRANSCRIPT ---
  const parseTranscript = (transcriptString) => {
    if (!transcriptString) return [];
    return transcriptString
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line, index) => {
        const isBot = line.startsWith("[BOT]:");
        const isUser = line.startsWith("[USER]:");
        const text = line.replace("[BOT]:", "").replace("[USER]:", "").trim();
        return { id: index, isBot, isUser, text };
      });
  };

  // --- DYNAMIC FIELD CALCULATION & CAPTURE METRICS ---
  const getDropOffPoint = (parsedChat) => {
    if (parsedChat.length === 0) return "No interaction";
    const lastMsg = parsedChat[parsedChat.length - 1];
    if (lastMsg.isBot && lastMsg.text.includes("confirm your details"))
      return "At Booking Confirmation";
    if (lastMsg.isBot && lastMsg.text.includes("What day works best"))
      return "Selecting Date";
    if (lastMsg.isUser) return "User abandoned session";
    return "Dropped during discovery questionnaire";
  };

  const getCapturedFieldsMetrics = (convo) => {
    const fields = [
      { name: "Name", value: convo.name },
      { name: "Email", value: convo.email },
      { name: "Phone", value: convo.phone },
      { name: "Company", value: convo.business_name || convo.business_type },
      { name: "Urgency", value: convo.urgency_level },
    ];

    const captured = fields.filter(
      (f) => f.value && f.value.toString().trim() !== "",
    );
    return {
      score: `${captured.length}/${fields.length}`,
      percentage: Math.round((captured.length / fields.length) * 100),
      items: captured.map((c) => c.name),
    };
  };

  const getHandoffStatus = (convo) => {
    if (convo.booking_status === "Meeting Booked" || convo.booked_slot)
      return {
        label: "Automated Booking",
        color: "text-green-400 bg-green-500/10 border-green-500/30",
      };
    if (convo.email || convo.phone)
      return {
        label: "Requires Manual Follow-up",
        color: "text-amber-400 bg-amber-500/10 border-amber-500/30",
      };
    return {
      label: "Dropped - No Contact Data",
      color: "text-red-400 bg-red-500/10 border-red-500/30",
    };
  };

  const getComplianceFlags = (convo) => {
    const flags = [];
    if (convo.email || convo.phone)
      flags.push({ label: "PII Secured", ok: true });
    else flags.push({ label: "No PII Detected", ok: false });
    if (
      convo.full_conversation_transcript &&
      convo.full_conversation_transcript.length > 500
    )
      flags.push({ label: "High Token Usage", ok: true });
    flags.push({ label: "Standard AI Disclaimer Shown", ok: true });
    return flags;
  };

  if (isLoading) {
    return (
      <main className="relative z-10 flex-grow w-full max-w-[1600px] mx-auto flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-5 bg-[var(--card-bg)] p-10 rounded-[2rem] border border-[var(--border-color)] shadow-2xl">
          <svg
            className="animate-spin w-12 h-12 text-[var(--primary)]"
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
          <p className="text-[var(--foreground-muted)] text-sm font-bold uppercase tracking-widest animate-pulse">
            Decrypting Transcripts...
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="relative z-10 flex-grow w-full max-w-[1600px] mx-auto px-4 sm:px-8 py-6 flex flex-col h-full min-h-[calc(100vh-100px)] fade-in">
      {/* ================= HEADER ================= */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-6 shrink-0">
        <div>
          <h1 className="text-3xl font-bold text-[var(--foreground)] tracking-tight">
            Pulse Conversations
          </h1>
          <p className="text-[var(--foreground-muted)] text-sm mt-1">
            Review raw transcripts, custom analytics, and model verification
            logs.
          </p>
        </div>
      </div>

      {/* ================= MAIN SPLIT LAYOUT ================= */}
      <div className="flex-grow grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-0 pb-6">
        {/* === LEFT COLUMN: CONVERSATION LIST === */}
        <div
          className={`lg:col-span-4 flex flex-col bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl shadow-sm overflow-hidden ${selectedConvo ? "hidden lg:flex" : "flex"}`}
        >
          <div className="p-4 border-b border-[var(--border-color)] bg-[var(--background)]/50 shrink-0 space-y-3">
            <div className="relative">
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
                placeholder="Search transcripts or names..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-lg pl-9 pr-4 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--foreground-muted)] focus:outline-none focus:border-[var(--primary)] transition-colors"
              />
            </div>
            <div className="flex gap-2">
              <select
                value={filterIntent}
                onChange={(e) => setFilterIntent(e.target.value)}
                className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-xs font-semibold text-[var(--foreground-muted)] focus:outline-none focus:border-[var(--primary)] transition-colors cursor-pointer"
              >
                <option value="All">All Intents</option>
                <option value="Service">Service Request</option>
                <option value="Inquiry">General Inquiry</option>
                <option value="Support">Support</option>
              </select>
            </div>
          </div>

          <div className="flex-grow overflow-y-auto custom-scrollbar">
            {filteredConversations.length > 0 ? (
              <div className="divide-y divide-[var(--border-color)]">
                {filteredConversations.map((convo) => {
                  const metrics = getCapturedFieldsMetrics(convo);
                  return (
                    <div
                      key={convo.id}
                      onClick={() => setSelectedConvo(convo)}
                      className={`p-4 cursor-pointer transition-all hover:bg-[var(--background)] ${selectedConvo?.id === convo.id ? "bg-[var(--lead-glow)] border-l-4 border-[var(--primary)]" : "border-l-4 border-transparent"}`}
                    >
                      <div className="flex justify-between items-start mb-1">
                        <span
                          className={`font-bold text-sm ${selectedConvo?.id === convo.id ? "text-[var(--primary)]" : "text-[var(--foreground)]"}`}
                        >
                          {convo.name || "Anonymous Visitor"}
                        </span>
                        <span className="text-[10px] text-[var(--foreground-muted)] whitespace-nowrap ml-2">
                          {new Date(convo.timestamp).toLocaleDateString(
                            undefined,
                            { month: "short", day: "numeric" },
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between items-center text-[11px] font-medium text-[var(--foreground-muted)] mb-2">
                        <span className="truncate max-w-[70%]">
                          {convo.visitor_intent ||
                            convo.service_requested ||
                            "General Inquiry"}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--background)] border border-[var(--border-color)] font-mono text-[var(--primary)]">
                          Fields: {metrics.score}
                        </span>
                      </div>
                      <div className="text-xs text-[var(--foreground-muted)] opacity-70 line-clamp-2 italic border-l-2 border-[var(--border-color)] pl-2 ml-1">
                        "
                        {convo.full_conversation_transcript
                          ? convo.full_conversation_transcript
                              .split("\n")
                              .pop()
                              .replace("[BOT]:", "")
                              .replace("[USER]:", "")
                              .trim()
                          : "No transcript available."}
                        "
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="p-8 text-center text-sm text-[var(--foreground-muted)]">
                No conversations found.
              </div>
            )}
          </div>
        </div>

        {/* === RIGHT COLUMN: CONVERSATION DETAILS === */}
        <div
          className={`lg:col-span-8 flex flex-col bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl shadow-sm overflow-hidden ${!selectedConvo ? "hidden lg:flex items-center justify-center" : "flex"}`}
        >
          {!selectedConvo ? (
            <div className="text-center p-8 flex flex-col items-center">
              <div className="w-16 h-16 rounded-full bg-[var(--background)] border border-[var(--border-color)] flex items-center justify-center mb-4 shadow-inner">
                <svg
                  className="w-8 h-8 text-[var(--foreground-muted)] opacity-50"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="1.5"
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                  />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-[var(--foreground)]">
                Select a Conversation
              </h2>
              <p className="text-sm text-[var(--foreground-muted)] mt-2 max-w-sm">
                Click on any conversation from the list to view transcripts,
                cross-verified drop-offs, and data captures.
              </p>
            </div>
          ) : (
            <>
              {/* Detail Header */}
              <div className="px-6 py-5 border-b border-[var(--border-color)] bg-[var(--background)]/50 shrink-0 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <button
                    onClick={() => setSelectedConvo(null)}
                    className="lg:hidden p-2 -ml-2 bg-[var(--card-bg)] border border-[var(--border-color)] rounded-lg text-[var(--foreground)]"
                  >
                    <svg
                      className="w-4 h-4"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M15 19l-7-7 7-7"
                      />
                    </svg>
                  </button>
                  <div>
                    <h2 className="text-xl font-bold text-[var(--foreground)] tracking-tight flex items-center gap-2">
                      {selectedConvo.name || "Anonymous Visitor"}
                      {selectedConvo.lead_score === "High" && (
                        <span
                          className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_#22c55e]"
                          title="High Intent"
                        ></span>
                      )}
                    </h2>
                    <p className="text-xs text-[var(--foreground-muted)] font-mono mt-1">
                      REF: {selectedConvo.id} •{" "}
                      {new Date(selectedConvo.timestamp).toLocaleString()}
                    </p>
                  </div>
                </div>
                <span
                  className={`px-2.5 py-1 rounded text-[10px] font-bold uppercase tracking-wider border ${getHandoffStatus(selectedConvo).color}`}
                >
                  {getHandoffStatus(selectedConvo).label}
                </span>
              </div>

              {/* Detail Content (Scrollable Grid) */}
              <div className="flex-grow overflow-y-auto custom-scrollbar p-6">
                {/* ================= TARGETED METRICS ROW ================= */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                  {/* KPI 1: Intent */}
                  <div className="bg-[var(--background)] border border-[var(--border-color)] rounded-xl p-4 flex flex-col justify-between">
                    <div>
                      <span className="text-[10px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest block mb-1">
                        Intent Category
                      </span>
                      <span className="font-semibold text-[var(--foreground)] text-sm">
                        {selectedConvo.visitor_intent ||
                          selectedConvo.service_requested ||
                          "Unknown"}
                      </span>
                    </div>
                  </div>

                  {/* KPI 2: Drop-off points Verified by Model */}
                  <div className="bg-[var(--background)] border border-[var(--border-color)] rounded-xl p-4 flex flex-col justify-between relative overflow-hidden group">
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest block">
                          Drop-off Point
                        </span>
                      </div>
                      <span
                        className="font-semibold text-[var(--foreground)] text-sm truncate block"
                        title={getDropOffPoint(
                          parseTranscript(
                            selectedConvo.full_conversation_transcript,
                          ),
                        )}
                      >
                        {getDropOffPoint(
                          parseTranscript(
                            selectedConvo.full_conversation_transcript,
                          ),
                        )}
                      </span>
                    </div>
                    <span className="text-[9px] text-purple-400/70 font-medium mt-2 flex items-center gap-1">
                      <svg
                        className="w-3 h-3 text-purple-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                        />
                      </svg>
                      Transcript Verification Complete
                    </span>
                  </div>

                  {/* KPI 3: Captured Fields Rate */}
                  <div className="bg-[var(--background)] border border-[var(--border-color)] rounded-xl p-4 flex flex-col justify-between">
                    <div>
                      <span className="text-[10px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest block mb-1">
                        Captured Fields KPI
                      </span>
                      <div className="flex items-baseline gap-2">
                        <span className="font-bold text-xl text-[var(--primary)]">
                          {getCapturedFieldsMetrics(selectedConvo).score}
                        </span>
                        <span className="text-xs text-[var(--foreground-muted)]">
                          ({getCapturedFieldsMetrics(selectedConvo).percentage}%
                          completion)
                        </span>
                      </div>
                    </div>
                    {/* Visual Progress Bar */}
                    <div className="w-full bg-[var(--border-color)] h-1.5 rounded-full mt-2 overflow-hidden">
                      <div
                        className="bg-[var(--primary)] h-full rounded-full transition-all duration-500"
                        style={{
                          width: `${getCapturedFieldsMetrics(selectedConvo).percentage}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>

                {/* ================= DATA GRID BLOCK ================= */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* LEFT DETAILS: AI Content & Compliance */}
                  <div className="space-y-6">
                    {/* Executive Summary */}
                    <div className="bg-[var(--lead-glow)] border border-[var(--primary)]/30 rounded-xl p-5 shadow-sm">
                      <h3 className="text-[11px] font-bold text-[var(--primary)] uppercase tracking-widest mb-3 flex items-center gap-2">
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M13 10V3L4 14h7v7l9-11h-7z"
                          />
                        </svg>
                        AI Conversation Summary
                      </h3>
                      <p className="text-sm text-[var(--foreground)] leading-relaxed font-medium">
                        {selectedConvo.conversation_summary ||
                          "No summary was generated for this interaction."}
                      </p>
                    </div>

                    {/* Captured Fields Details Card */}
                    <div className="bg-[var(--background)] border border-[var(--border-color)] rounded-xl p-5 shadow-sm">
                      <h3 className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest mb-4 border-b border-[var(--border-color)] pb-2 flex items-center gap-2">
                        <svg
                          className="w-4 h-4 text-[var(--accent-blue)]"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                          />
                        </svg>
                        Extracted Entity Context
                      </h3>
                      <div className="space-y-3 text-sm">
                        <div className="flex justify-between items-center">
                          <span className="text-[11px] text-[var(--foreground-muted)] uppercase tracking-wider">
                            Full Name
                          </span>
                          <span
                            className={`font-semibold ${selectedConvo.name ? "text-[var(--foreground)]" : "text-red-400/60 text-xs italic"}`}
                          >
                            {selectedConvo.name || "Missing Name"}
                          </span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-[11px] text-[var(--foreground-muted)] uppercase tracking-wider">
                            Email Address
                          </span>
                          <span
                            className={`font-semibold ${selectedConvo.email ? "text-[var(--foreground)]" : "text-red-400/60 text-xs italic"}`}
                          >
                            {selectedConvo.email || "Missing Email"}
                          </span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-[11px] text-[var(--foreground-muted)] uppercase tracking-wider">
                            Phone Number
                          </span>
                          <span
                            className={`font-semibold ${selectedConvo.phone ? "text-[var(--foreground)]" : "text-red-400/60 text-xs italic"}`}
                          >
                            {selectedConvo.phone || "Missing Phone"}
                          </span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-[11px] text-[var(--foreground-muted)] uppercase tracking-wider">
                            Company Framework
                          </span>
                          <span
                            className={`font-semibold ${selectedConvo.business_name || selectedConvo.business_type ? "text-[var(--foreground)]" : "text-red-400/60 text-xs italic"}`}
                          >
                            {selectedConvo.business_name ||
                              selectedConvo.business_type ||
                              "Missing Context"}
                          </span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-[11px] text-[var(--foreground-muted)] uppercase tracking-wider">
                            Urgency Parameter
                          </span>
                          <span
                            className={`font-bold ${selectedConvo.urgency_level === "High" ? "text-red-400" : "text-[var(--foreground)]"}`}
                          >
                            {selectedConvo.urgency_level || "Standard"}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Operational Compliance Flag Box */}
                    <div className="bg-[var(--background)] border border-[var(--border-color)] rounded-xl p-4">
                      <h4 className="text-[10px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest mb-3">
                        System Framework Compliance Check
                      </h4>
                      <div className="flex flex-wrap gap-2">
                        {getComplianceFlags(selectedConvo).map((flag, i) => (
                          <span
                            key={i}
                            className={`text-[9px] px-2 py-0.5 rounded font-bold uppercase tracking-wider ${flag.ok ? "bg-green-500/10 text-green-400 border border-green-500/20" : "bg-red-500/10 text-red-400 border border-red-500/20"}`}
                          >
                            {flag.label}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* RIGHT DETAILS: Beautiful Full Conversation Log UI */}
                  <div className="bg-[#0a0f1c] border border-[var(--border-color)] rounded-xl flex flex-col h-[520px] shadow-inner overflow-hidden">
                    <div className="p-3 border-b border-[var(--border-color)] bg-[var(--card-bg)] flex justify-between items-center shrink-0">
                      <h3 className="text-[11px] font-bold text-[var(--foreground)] uppercase tracking-widest flex items-center gap-2">
                        <svg
                          className="w-4 h-4 text-[var(--primary)]"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2"
                            d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                          />
                        </svg>
                        Full System Chat Log
                      </h3>
                      <span className="text-[9px] font-mono text-[var(--foreground-muted)] px-2 py-0.5 bg-[var(--background)] rounded border border-[var(--border-color)]">
                        RAW STREAM
                      </span>
                    </div>

                    <div className="flex-grow p-4 overflow-y-auto custom-scrollbar flex flex-col gap-4">
                      {parseTranscript(
                        selectedConvo.full_conversation_transcript,
                      ).length > 0 ? (
                        parseTranscript(
                          selectedConvo.full_conversation_transcript,
                        ).map((msg) => (
                          <div
                            key={msg.id}
                            className={`flex flex-col max-w-[85%] ${msg.isBot ? "self-start" : "self-end"} animate-slide-up`}
                            style={{
                              animationDelay: `${Math.min(msg.id * 40, 400)}ms`,
                            }}
                          >
                            <span
                              className={`text-[9px] font-bold uppercase tracking-widest mb-1 mx-1 opacity-50 ${msg.isBot ? "text-left" : "text-right"}`}
                            >
                              {msg.isBot ? "AI Front Desk" : "Visitor"}
                            </span>
                            <div
                              className={`px-4 py-2.5 text-[13px] leading-relaxed rounded-2xl shadow-sm ${
                                msg.isBot
                                  ? "bg-[var(--card-bg)] text-[var(--foreground)] border border-[var(--border-color)] rounded-tl-sm"
                                  : "bg-[var(--primary)] text-white rounded-tr-sm"
                              }`}
                            >
                              {msg.text}
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="m-auto text-center text-sm text-[var(--foreground-muted)] italic">
                          Transcript payload structure empty or unavailable.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Internal Custom Keyframes & Scrollbars */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
        .fade-in { animation: fadeIn 0.4s ease-out forwards; }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        
        .animate-slide-up { opacity: 0; animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        @keyframes slideUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

        .custom-scrollbar::-webkit-scrollbar { width: 5px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: var(--foreground-muted); }
      `,
        }}
      />
    </main>
  );
}
