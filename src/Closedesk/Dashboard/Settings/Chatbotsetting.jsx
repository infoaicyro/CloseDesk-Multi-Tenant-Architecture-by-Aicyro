// src/Closedesk/Dashboard/Settings/Chatbotsetting.jsx
"use client";

import { useState, useEffect } from "react";
import { db } from "../../../lib/firebase";
import { ref, set, get } from "firebase/database";

// 🔥 TICKET 14
import { createPulseLogger } from "../../../lib/loggerPresets";
import { recordAuditTrail } from "../../../lib/auditTracer";
const pulseLogger = createPulseLogger("ChatbotSettings");

const AVATAR_OPTIONS = [
  { id: "ai_spark", label: "AI Spark", src: "/avatars/ai-spark.svg" },
  { id: "bot_classic", label: "Classic Bot", src: "/avatars/bot-classic.svg" },
  { id: "human_agent", label: "Human Agent", src: "/avatars/human-agent.svg" },
  { id: "minimal_dot", label: "Minimalist", src: "/avatars/minimal-dot.svg" },
  { id: "custom", label: "Custom SVG", isCustom: true },
];

const InfoTooltip = ({ text }) => (
  <div className="group relative inline-flex items-center ml-2 cursor-help align-text-bottom">
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-[var(--foreground-muted)] hover:text-[var(--primary)] transition-colors"
    >
      <circle cx="12" cy="12" r="10"></circle>
      <path d="M12 16v-4"></path>
      <path d="M12 8h.01"></path>
    </svg>
    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block w-56 p-2.5 bg-[var(--card-bg)] border border-[var(--border-color)] text-[var(--foreground)] text-[11px] leading-relaxed rounded-lg shadow-xl z-50 normal-case tracking-normal text-center pointer-events-none">
      {text}
      <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-[var(--border-color)]"></div>
    </div>
  </div>
);

export default function ChatbotSettings({ onNavigate }) {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isPlayingTest, setIsPlayingTest] = useState(false);
  const [toast, setToast] = useState({
    show: false,
    message: "",
    type: "success",
  });

  const [config, setConfig] = useState({
    serviceCategory: "General", // <-- NEW: Added Service Category for dynamic flows
    botAvatar: "ai_spark",
    customAvatarSvg: "",
    botName: "Aicyro Front Desk",
    launcherText: "Chat with us",
    themeColor: "#10b981",
    greetingMessage: "Hi! I'm Aicyro's AI Assistant. How can I help you today?",
    botIdentity: "the 'AI Front Desk' for Aicyro",
    companyContext:
      "We provide automated AI business systems and digital products.",
    customRules:
      "Speak naturally. Use conversational filler words occasionally like 'Got it', 'I understand', or 'Sure thing!'. Keep it empathetic.",
    additionalConversationalRules:
      "1. Acknowledge user input before asking the next question.\n2. Keep responses brief but warm.",
    tone: "Warm, Conversational & Human-like",
    botVoice: "ash",
    basePrompt:
      "Act as a friendly, human-like concierge. Build rapport and naturally weave your questions into a conversational flow. Avoid sounding like a strict robotic form.",
    leadCaptureFields: ["Name", "Email", "Phone"],
    businessIntelligenceFields: [
      "Industry Type",
      "Primary Business Problem",
      "Current CRM/Software",
      "Meeting Preference",
      "Location",
      "Website",
    ],
    services: [""],
    faqs: [{ question: "", answer: "" }],
    qualificationQuestions: [""],
    escalationRule: "email_admin",
    bookingRule: "require_all",
    enableDirectBooking: true,
    calendarActive: true,
    unavailableBehavior: "collect_lead",
    aiModel: "gpt-4o-mini",
    temperature: 0.4, 
    strictValidation: false,
    voiceChatAgent: true,
    photoUploads: true,
    voiceEnabled: true,
  });

  const showToast = (message, type = "success") => {
    setToast({ show: true, message, type });
    setTimeout(
      () => setToast({ show: false, message: "", type: "success" }),
      3500,
    );
  };

  const [tenantId, setTenantId] = useState("default");

  useEffect(() => {
    const activeTenant = typeof window !== "undefined"
      ? (localStorage.getItem("currentTenant") || "default")
      : "default";
    setTenantId(activeTenant);
    const configPath = activeTenant && activeTenant !== "default"
      ? `tenants/${activeTenant}/chatbot_config`
      : "settings/chatbot_config";

    const fetchConfig = async () => {
      try {
        let snapshot = await get(ref(db, configPath));
        if (!snapshot.exists() && activeTenant !== "default") {
          snapshot = await get(ref(db, "settings/chatbot_config"));
        }
        if (snapshot.exists()) {
          const data = snapshot.val();
          const voiceVal = data.voiceChatAgent !== undefined ? data.voiceChatAgent : (data.voiceEnabled !== undefined ? data.voiceEnabled : true);
          const photoVal = data.photoUploads !== undefined ? data.photoUploads : (data.photoUploadsEnabled !== undefined ? data.photoUploadsEnabled : true);
          
          // Check if calendar integration exists
          const calendarExists = Boolean(
            data.calendarActive !== false &&
            (data.calendarIntegration || data.calendarActive || data.integrations?.calendar || data.integrations?.GoogleCalendar || data.integrations?.Make || data.bookingRule)
          );
          // If the tenant's booking setting defaults to false or null, enforce a fallback that allows booking if calendar integration exists
          const directBooking = (data.enableDirectBooking === false || data.enableDirectBooking === null)
            ? (calendarExists ? true : false)
            : (data.enableDirectBooking !== undefined ? data.enableDirectBooking : (calendarExists || true));
          const calActive = (data.calendarActive === false || data.calendarActive === null)
            ? (calendarExists ? true : false)
            : (data.calendarActive !== undefined ? data.calendarActive : true);

          setConfig((prev) => ({
            ...prev,
            ...data,
            enableDirectBooking: directBooking,
            calendarActive: calActive,
            voiceChatAgent: voiceVal,
            photoUploads: photoVal,
            voiceEnabled: voiceVal,
            leadCaptureFields: data.leadCaptureFields || prev.leadCaptureFields,
            businessIntelligenceFields:
              data.businessIntelligenceFields ||
              prev.businessIntelligenceFields,
          }));
        }
      } catch (error) {
        showToast("Failed to load settings.", "error");
      } finally {
        setIsLoading(false);
      }
    };
    fetchConfig();
  }, []);

  const handleInputChange = (e) => {
    const { name, value, type, checked } = e.target;
    const val = type === "checkbox" ? checked : value;
    setConfig((prev) => ({
      ...prev,
      [name]: val,
      ...(name === "voiceChatAgent" ? { voiceEnabled: val } : {}),
      ...(name === "voiceEnabled" ? { voiceChatAgent: val } : {}),
    }));
  };

  const handleAvatarSelect = (avatarId) => {
    setConfig((prev) => ({ ...prev, botAvatar: avatarId }));
  };

  const handleArrayChange = (index, field, value) => {
    const newArray = [...config[field]];
    newArray[index] = value;
    setConfig((prev) => ({ ...prev, [field]: newArray }));
  };

  const addArrayItem = (field, emptyValue = "") =>
    setConfig((prev) => ({ ...prev, [field]: [...prev[field], emptyValue] }));

  const removeArrayItem = (index, field) => {
    const newArray = config[field].filter((_, i) => i !== index);
    setConfig((prev) => ({
      ...prev,
      [field]: newArray.length ? newArray : [""],
    }));
  };

  const handleFaqChange = (index, key, value) => {
    const newFaqs = [...config.faqs];
    newFaqs[index][key] = value;
    setConfig((prev) => ({ ...prev, faqs: newFaqs }));
  };

  const handleSaveConfig = async () => {
    setIsSaving(true);
    const fallbackDefault = "General default information";

    const ensureValue = (val) => {
      if (val === undefined || val === null) return fallbackDefault;
      if (typeof val === "string" && val.trim() === "") return fallbackDefault;
      return val;
    };

    const ensureArray = (arr) => {
      if (!Array.isArray(arr) || arr.length === 0) return [fallbackDefault];
      const cleaned = arr
        .map((item) => (typeof item === "string" ? item.trim() : item))
        .filter((item) => item !== "" && item !== undefined && item !== null);
      return cleaned.length > 0 ? cleaned : [fallbackDefault];
    };

    const ensureFaqs = (faqs) => {
      if (!Array.isArray(faqs) || faqs.length === 0) {
        return [{ question: fallbackDefault, answer: fallbackDefault }];
      }
      const cleaned = faqs
        .map((f) => ({
          question: ensureValue(f?.question),
          answer: ensureValue(f?.answer),
        }))
        .filter((f) => f.question !== fallbackDefault || f.answer !== fallbackDefault);
      return cleaned.length > 0 ? cleaned : [{ question: fallbackDefault, answer: fallbackDefault }];
    };

    // Construct payload ensuring every input field is present and validated against null/empty
    const cleanedConfig = {
      serviceCategory: ensureValue(config.serviceCategory),
      botAvatar: ensureValue(config.botAvatar),
      customAvatarSvg: ensureValue(config.customAvatarSvg),
      botName: ensureValue(config.botName),
      launcherText: ensureValue(config.launcherText),
      themeColor: ensureValue(config.themeColor),
      greetingMessage: ensureValue(config.greetingMessage),
      botIdentity: ensureValue(config.botIdentity),
      companyContext: ensureValue(config.companyContext),
      customRules: ensureValue(config.customRules),
      additionalConversationalRules: ensureValue(config.additionalConversationalRules),
      tone: ensureValue(config.tone),
      botVoice: ensureValue(config.botVoice),
      basePrompt: ensureValue(config.basePrompt),
      leadCaptureFields: ensureArray(config.leadCaptureFields),
      businessIntelligenceFields: ensureArray(config.businessIntelligenceFields),
      services: ensureArray(config.services),
      faqs: ensureFaqs(config.faqs),
      qualificationQuestions: ensureArray(config.qualificationQuestions),
      escalationRule: ensureValue(config.escalationRule),
      bookingRule: ensureValue(config.bookingRule),
      unavailableBehavior: ensureValue(config.unavailableBehavior),
      aiModel: ensureValue(config.aiModel),
      temperature: typeof config.temperature === "number" ? config.temperature : (parseFloat(config.temperature) || 0.4),
      strictValidation: Boolean(config.strictValidation),
      voiceChatAgent: config.voiceChatAgent !== false,
      photoUploads: config.photoUploads !== false,
      voiceEnabled: config.voiceChatAgent !== false,
      enableDirectBooking: (() => {
        const calExists = Boolean(
          config.calendarActive !== false &&
          (config.calendarIntegration || config.calendarActive || config.integrations?.calendar || config.integrations?.GoogleCalendar || config.integrations?.Make || config.bookingRule)
        );
        return (config.enableDirectBooking === false || config.enableDirectBooking === null)
          ? (calExists ? true : false)
          : (config.enableDirectBooking !== undefined ? config.enableDirectBooking : (calExists || true));
      })(),
      calendarActive: (() => {
        const calExists = Boolean(
          config.calendarActive !== false &&
          (config.calendarIntegration || config.calendarActive || config.integrations?.calendar || config.integrations?.GoogleCalendar || config.integrations?.Make || config.bookingRule)
        );
        return (config.calendarActive === false || config.calendarActive === null)
          ? (calExists ? true : false)
          : (config.calendarActive !== undefined ? config.calendarActive : true);
      })(),
    };

    // Strict fallback validation: ensure no field remains null, undefined, or empty string
    Object.keys(cleanedConfig).forEach((key) => {
      const val = cleanedConfig[key];
      if (val === undefined || val === null || (typeof val === "string" && val.trim() === "")) {
        cleanedConfig[key] = fallbackDefault;
      }
    });

    const activeTenant = typeof window !== "undefined"
      ? (localStorage.getItem("currentTenant") || "default")
      : "default";
    const configPath = activeTenant && activeTenant !== "default"
      ? `tenants/${activeTenant}/chatbot_config`
      : "settings/chatbot_config";

    try {
      await set(ref(db, configPath), {
        ...cleanedConfig,
        updated_at: new Date().toISOString(),
      });
      
      // 🚨 TICKET 14: Log Configuration Change with Previous and New state
      recordAuditTrail(pulseLogger, "configuration_changed", {
        who: localStorage.getItem("currentSuperAdmin") || localStorage.getItem("currentUser") || "unknown",
        target: configPath,
        previousState: config, 
        newState: cleanedConfig 
      });
      
      setConfig(cleanedConfig);
      showToast("Chatbot settings updated successfully!", "success");
    } catch (error) {
      showToast("Failed to save changes.", "error");
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestVoice = async () => {
    if (!config.greetingMessage || !config.botVoice) return;

    if (window.currentTestAudio) {
      window.currentTestAudio.pause();
      window.currentTestAudio.currentTime = 0;
    }

    setIsPlayingTest(true);
    try {
      const cleanText = config.greetingMessage.replace(/[^\w\s,.!?]/gi, "");
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: cleanText,
          voiceId: config.botVoice,
        }),
      });

      if (!response.ok) throw new Error("TTS request failed");

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      window.currentTestAudio = audio;

      audio.onended = () => setIsPlayingTest(false);
      audio.onerror = () => setIsPlayingTest(false);

      audio.play();
    } catch (error) {
      console.error("Test voice error:", error);
      showToast("Failed to play voice test.", "error");
      setIsPlayingTest(false);
    }
  };

  if (isLoading)
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <p className="text-[var(--foreground-muted)] text-sm font-bold uppercase tracking-widest animate-pulse">
          Loading AI Config...
        </p>
      </div>
    );

  const getActiveAvatarSrc = () => {
    if (config.botAvatar === "custom") {
      if (
        config.customAvatarSvg &&
        config.customAvatarSvg.trim().startsWith("<svg")
      ) {
        return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(config.customAvatarSvg)}`;
      }
      return `data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 20h9'%3E%3C/path%3E%3Cpath d='M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z'%3E%3C/path%3E%3C/svg%3E`;
    }
    const selected = AVATAR_OPTIONS.find((a) => a.id === config.botAvatar);
    return selected?.src || AVATAR_OPTIONS[0].src;
  };

  const activeAvatarSrc = getActiveAvatarSrc();

  return (
    <main className="relative z-10 flex-grow w-full max-w-[1600px] mx-auto px-6 sm:px-12 py-8 fade-in">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-8 border-b border-[var(--border-color)] pb-6">
        <div>
          <h1 className="text-3xl font-bold text-[var(--foreground)] tracking-tight">
            Chatbot Settings
          </h1>
          <p className="text-[var(--foreground-muted)] text-sm mt-1">
            Configure your AI agent's branding, prompts, knowledge, and
            operational rules.
          </p>
        </div>
        <button
          onClick={handleSaveConfig}
          disabled={isSaving}
          className="flex items-center gap-2 px-6 py-3 bg-[var(--primary)] text-white text-xs font-bold uppercase tracking-wider rounded-xl shadow-[0_0_15px_var(--lead-glow)] transition-all disabled:opacity-50 hover:bg-[var(--secondary)]"
        >
          {isSaving ? "Saving..." : "Save AI Rules"}
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8 pb-10">
        {/* LEFT COLUMN (Identity & Persona) */}
        <div className="flex flex-col gap-8">
          <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-6 md:p-8 shadow-sm">
            <h2 className="text-lg font-bold text-[var(--foreground)] tracking-tight border-b border-[var(--border-color)] pb-4 mb-6">
              Display & Branding
            </h2>
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                    Chatbot Name
                    <InfoTooltip text="The public-facing name visitors will see at the top of the chat window." />
                  </label>
                  <input
                    name="botName"
                    value={config.botName}
                    onChange={handleInputChange}
                    className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm focus:border-[var(--primary)] outline-none"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                    Launcher Text
                    <InfoTooltip text="The text displayed next to the chat bubble before the user opens the widget." />
                  </label>
                  <input
                    name="launcherText"
                    value={config.launcherText}
                    onChange={handleInputChange}
                    className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm focus:border-[var(--primary)] outline-none"
                  />
                </div>
              </div>

              <div className="space-y-3 pt-4 border-t border-[var(--border-color)]">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                  Bot Avatar Graphic
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  {AVATAR_OPTIONS.map((avatar) => {
                    const isSelected = config.botAvatar === avatar.id;
                    let imgSrc = avatar.src;

                    if (avatar.isCustom) {
                      imgSrc =
                        config.customAvatarSvg &&
                        config.customAvatarSvg.trim().startsWith("<svg")
                          ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(config.customAvatarSvg)}`
                          : `data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 20h9'%3E%3C/path%3E%3Cpath d='M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z'%3E%3C/path%3E%3C/svg%3E`;
                    }

                    return (
                      <button
                        key={avatar.id}
                        type="button"
                        onClick={() => handleAvatarSelect(avatar.id)}
                        className={`flex flex-col items-center justify-center p-3 rounded-xl border transition-all duration-300 ${isSelected ? "border-[var(--primary)] bg-[var(--primary)]/10 shadow-[0_0_15px_var(--lead-glow)] scale-[1.02]" : "border-[var(--border-color)] bg-[var(--background)] hover:border-[var(--primary)]/50"}`}
                      >
                        <div className="mb-2 w-7 h-7 flex items-center justify-center">
                          <img
                            src={imgSrc}
                            alt={avatar.label}
                            className={`w-full h-full object-contain ${!isSelected ? "opacity-60 grayscale" : "opacity-100"}`}
                          />
                        </div>
                        <span
                          className={`text-[8px] text-center font-bold uppercase tracking-widest ${isSelected ? "text-[var(--primary)]" : "text-[var(--foreground-muted)]"}`}
                        >
                          {avatar.label}
                        </span>
                      </button>
                    );
                  })}
                </div>

                {config.botAvatar === "custom" && (
                  <div className="mt-4 p-4 border border-[var(--primary)] bg-[var(--primary)]/5 rounded-xl animate-fade-in">
                    <label className="text-[11px] font-bold text-[var(--foreground)] uppercase tracking-widest flex items-center justify-between">
                      Paste Custom SVG Code
                      <InfoTooltip text="Paste raw <svg>...</svg> code here. It will be saved directly to your database." />
                    </label>
                    <textarea
                      name="customAvatarSvg"
                      value={config.customAvatarSvg}
                      onChange={handleInputChange}
                      placeholder="<svg viewBox='0 0 24 24'>...</svg>"
                      rows="3"
                      className="mt-3 w-full bg-[var(--background)] border border-[var(--border-color)] rounded-lg px-4 py-3 text-xs font-mono focus:border-[var(--primary)] outline-none resize-y"
                    />
                  </div>
                )}
              </div>

              <div className="space-y-2 pt-4 border-t border-[var(--border-color)]">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                  Initial Greeting Message
                  <InfoTooltip text="The very first message the bot sends to engage the user when they open the chat." />
                </label>
                <textarea
                  name="greetingMessage"
                  value={config.greetingMessage}
                  onChange={handleInputChange}
                  rows="2"
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm focus:border-[var(--primary)] outline-none resize-none"
                />
              </div>

              <div className="space-y-2 pt-4 border-t border-[var(--border-color)]">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest flex items-center">
                    Bot Voice
                    <InfoTooltip text="The vocal identity used if the chatbot responds via audio." />
                  </label>
                  <button
                    type="button"
                    onClick={handleTestVoice}
                    disabled={isPlayingTest || !config.greetingMessage}
                    className="text-[10px] font-bold text-[var(--primary)] hover:text-[var(--secondary)] transition-colors disabled:opacity-50 flex items-center gap-1.5"
                  >
                    {isPlayingTest ? (
                      <>
                        <svg
                          className="w-4 h-4 animate-pulse"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth="2.5"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M11 5L6 9H2v6h4l5 4V5z"
                          />
                        </svg>
                        <span>PLAYING...</span>
                      </>
                    ) : (
                      <>
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth="2.5"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M11 5L6 9H2v6h4l5 4V5z"
                          />
                        </svg>
                        <span>TEST VOICE</span>
                      </>
                    )}
                  </button>
                </div>
                <select
                  name="botVoice"
                  value={config.botVoice}
                  onChange={handleInputChange}
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm focus:border-[var(--primary)] outline-none appearance-none cursor-pointer"
                >
                  <option value="ash">Ash (Balanced & Clear)</option>
                  <option value="Joanna">Joanna (Female, US)</option>
                  <option value="Matthew">Matthew (Male, US)</option>
                  <option value="Salli">Salli (Female, US)</option>
                  <option value="Justin">Justin (Male, US)</option>
                  <option value="Ruth">Ruth (Female, US)</option>
                  <option value="Stephen">Stephen (Male, US)</option>
                </select>
              </div>
            </div>
          </div>

          <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-6 md:p-8 shadow-sm">
            <h2 className="text-lg font-bold text-[var(--foreground)] tracking-tight border-b border-[var(--border-color)] pb-4 mb-6">
              Feature Toggles
            </h2>
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest flex items-center">
                    VoiceChatAgent
                    <InfoTooltip text="Enable or disable real-time AI voice conversation." />
                  </label>
                  <p className="text-xs text-[var(--foreground-muted)] mt-1">
                    Allow visitors to start a voice call with the AI agent.
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    name="voiceChatAgent"
                    checked={Boolean(config.voiceChatAgent)}
                    onChange={handleInputChange}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-[var(--border-color)] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all after:shadow-sm peer-checked:bg-[var(--primary)] transition-colors"></div>
                </label>
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-[var(--border-color)]">
                <div>
                  <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest flex items-center">
                    Photo Uploads
                    <InfoTooltip text="Enable or disable photo upload and camera snapshot capability." />
                  </label>
                  <p className="text-xs text-[var(--foreground-muted)] mt-1">
                    Allow visitors to capture or upload images for diagnostic analysis.
                  </p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    name="photoUploads"
                    checked={Boolean(config.photoUploads)}
                    onChange={handleInputChange}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-[var(--border-color)] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all after:shadow-sm peer-checked:bg-[var(--primary)] transition-colors"></div>
                </label>
              </div>
            </div>
          </div>

          <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-6 md:p-8 shadow-sm">
            <h2 className="text-lg font-bold text-[var(--foreground)] tracking-tight border-b border-[var(--border-color)] pb-4 mb-6">
              Prompt Engineering & Persona
            </h2>
            <div className="space-y-6">
              <div className="p-4 rounded-xl border border-[var(--border-color)] bg-[var(--background)] grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                    LLM Engine
                    <InfoTooltip text="Select the AI brain. 'mini' models are fast and cheap. Full models are smarter for complex tasks." />
                  </label>
                  <select
                    name="aiModel"
                    value={config.aiModel}
                    onChange={handleInputChange}
                    className="w-full bg-[var(--card-bg)] border border-[var(--border-color)] rounded-lg p-2 text-xs outline-none cursor-pointer"
                  >
                    <option value="gpt-4o-mini">gpt-4o-mini (Fastest)</option>
                    <option value="gpt-4o">gpt-4o (High Logic)</option>
                    <option value="gpt-4-turbo">gpt-4-turbo</option>
                    <option value="gpt-4">gpt-4 (Standard)</option>
                    <option value="gpt-3.5-turbo">
                      gpt-3.5-turbo (Legacy)
                    </option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                    Temperature ({config.temperature})
                    <InfoTooltip text="Lower values (0.1) make the bot strict. Higher values (0.7) make it creative." />
                  </label>
                  <input
                    type="range"
                    min="0.0"
                    max="0.9"
                    step="0.1"
                    name="temperature"
                    value={config.temperature}
                    onChange={handleInputChange}
                    className="w-full accent-[var(--primary)] cursor-pointer mt-2"
                  />
                </div>
                <div className="space-y-1 flex flex-col justify-center items-start pl-2">
                  <label className="text-[10px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      name="strictValidation"
                      checked={config.strictValidation}
                      onChange={handleInputChange}
                      className="accent-[var(--primary)] rounded"
                    />
                    Strict Formats
                    <InfoTooltip text="If checked, the AI rejects invalid emails/phone numbers. Uncheck to allow fluid, conversational data entry." />
                  </label>
                  <p className="text-[9px] text-[var(--foreground-muted)] mt-1">
                    Enforce regex checks.
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                  Core System Prompt Override
                  <InfoTooltip text="The fundamental instructions driving the AI. Tell it its ultimate goal." />
                </label>
                <textarea
                  name="basePrompt"
                  value={config.basePrompt}
                  onChange={handleInputChange}
                  rows="4"
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm focus:border-[var(--primary)] outline-none resize-none"
                />
              </div>

              <div className="space-y-2 pt-4 border-t border-[var(--border-color)]">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                  Bot Identity / Role
                  <InfoTooltip text="Who the AI thinks it is. Helps set context for the LLM." />
                </label>
                <input
                  name="botIdentity"
                  value={config.botIdentity}
                  onChange={handleInputChange}
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm focus:border-[var(--primary)] outline-none"
                />
              </div>

              {/* --- NEW SERVICE CATEGORY FIELD --- */}
              <div className="space-y-2 pt-4 border-t border-[var(--border-color)]">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                  Service Category (Industry)
                  <InfoTooltip text="Select your industry to load optimized AI chat flows and vision diagnostics." />
                </label>
                <select
                  name="serviceCategory"
                  value={config.serviceCategory || "General"}
                  onChange={handleInputChange}
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm focus:border-[var(--primary)] outline-none appearance-none cursor-pointer"
                >
                  <option value="General">General / Software</option>
                  <option value="HVAC">HVAC & Air Conditioning</option>
                  <option value="Plumbing">Plumbing</option>
                  <option value="Pest Control">Pest Control</option>
                  <option value="Electrical">Electrical</option>
                  <option value="Roofing">Roofing</option>
                  <option value="Appliance Repair">Appliance Repair</option>
                </select>
              </div>

              <div className="space-y-2 pt-4 border-t border-[var(--border-color)]">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                  Company Context
                  <InfoTooltip text="A brief description of your business. The AI uses this to answer general inquiries." />
                </label>
                <textarea
                  name="companyContext"
                  value={config.companyContext}
                  onChange={handleInputChange}
                  rows="3"
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm focus:border-[var(--primary)] outline-none resize-none"
                />
              </div>

              <div className="space-y-2 pt-4 border-t border-[var(--border-color)]">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                  Bot Tone
                  <InfoTooltip text="Dictates the vocabulary and conversational style of the AI." />
                </label>
                <select
                  name="tone"
                  value={config.tone}
                  onChange={handleInputChange}
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm focus:border-[var(--primary)] outline-none appearance-none cursor-pointer"
                >
                  <option value="Warm, Conversational & Human-like">
                    Warm, Conversational & Human-like
                  </option>
                  <option value="Friendly & Empathetic">
                    Friendly & Empathetic
                  </option>
                  <option value="Casual & Humorous">Casual & Humorous</option>
                  <option value="Professional & Direct">
                    Professional & Direct
                  </option>
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN (Rules, Flow & Data) */}
        <div className="flex flex-col gap-8">
          <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-6 md:p-8 shadow-sm flex flex-col items-center justify-center relative overflow-hidden">
            <h2 className="text-sm font-bold text-[var(--foreground-muted)] tracking-widest uppercase mb-6">
              See CloseDesk in action
            </h2>
            <div className="w-full max-w-sm bg-[var(--background)] border border-[var(--border-color)] rounded-2xl shadow-lg overflow-hidden flex flex-col">
              <div className="bg-[var(--card-bg)] p-4 border-b border-[var(--border-color)] flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[var(--background)] border border-[var(--primary)] flex items-center justify-center shadow-[0_0_10px_var(--lead-glow)] p-1.5 shrink-0 overflow-hidden">
                  <img
                    src={activeAvatarSrc}
                    alt="Selected Avatar"
                    className="w-full h-full object-contain"
                  />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-[var(--foreground)] leading-tight">
                    {config.botName || "Bot Name"}
                  </h3>
                  <p className="text-[10px] text-green-500 flex items-center gap-1 mt-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>{" "}
                    Online
                  </p>
                </div>
              </div>
              <div className="p-4 flex flex-col gap-3 min-h-[120px]">
                <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-xl rounded-tl-none p-3 text-xs text-[var(--foreground)] shadow-sm">
                  {config.greetingMessage || "Hello there!"}
                </div>
              </div>
            </div>
          </div>

          <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-6 md:p-8 shadow-sm">
            <h2 className="text-lg font-bold text-[var(--foreground)] tracking-tight border-b border-[var(--border-color)] pb-4 mb-6">
              Chat Flow & Rules
            </h2>
            <div className="space-y-6">
              <div className="space-y-3">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest flex justify-between items-center">
                  <span>
                    Lead Capture Fields
                    <InfoTooltip text="Contact details the AI should naturally try to collect during the conversation (without gatekeeping)." />
                  </span>
                  <button
                    onClick={() => addArrayItem("leadCaptureFields")}
                    className="text-[var(--primary)]"
                  >
                    + Add Field
                  </button>
                </label>
                <div className="space-y-2 max-h-40 overflow-y-auto custom-scrollbar pr-2">
                  {config.leadCaptureFields.map((field, index) => (
                    <div key={index} className="flex gap-2 items-center">
                      <span className="text-xs font-mono text-[var(--foreground-muted)] bg-[var(--background)] p-2 rounded">
                        {index + 1}.
                      </span>
                      <input
                        type="text"
                        value={field}
                        onChange={(e) =>
                          handleArrayChange(
                            index,
                            "leadCaptureFields",
                            e.target.value,
                          )
                        }
                        className="flex-grow bg-[var(--background)] border border-[var(--border-color)] rounded-lg px-4 py-2 text-sm focus:border-[var(--primary)] outline-none"
                      />
                      <button
                        onClick={() =>
                          removeArrayItem(index, "leadCaptureFields")
                        }
                        className="px-3 text-[var(--foreground-muted)] hover:text-red-400 bg-[var(--background)] border border-[var(--border-color)] rounded-lg transition-colors"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-3 pt-4 border-t border-[var(--border-color)]">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest flex justify-between items-center">
                  <span>
                    Business Intelligence Fields
                    <InfoTooltip text="Hidden details (like Industry or Budget) the AI silently listens for and extracts without aggressively asking." />
                  </span>
                  <button
                    onClick={() => addArrayItem("businessIntelligenceFields")}
                    className="text-[var(--primary)]"
                  >
                    + Add Field
                  </button>
                </label>
                <div className="space-y-2 max-h-40 overflow-y-auto custom-scrollbar pr-2">
                  {config.businessIntelligenceFields.map((field, index) => (
                    <div
                      key={`bi-${index}`}
                      className="flex gap-2 items-center"
                    >
                      <span className="text-xs font-mono text-[var(--foreground-muted)] bg-[var(--background)] p-2 rounded">
                        {index + 1}.
                      </span>
                      <input
                        type="text"
                        value={field}
                        onChange={(e) =>
                          handleArrayChange(
                            index,
                            "businessIntelligenceFields",
                            e.target.value,
                          )
                        }
                        className="flex-grow bg-[var(--background)] border border-[var(--border-color)] rounded-lg px-4 py-2 text-sm focus:border-[var(--primary)] outline-none"
                      />
                      <button
                        onClick={() =>
                          removeArrayItem(index, "businessIntelligenceFields")
                        }
                        className="px-3 text-[var(--foreground-muted)] hover:text-red-400 bg-[var(--background)] border border-[var(--border-color)] rounded-lg transition-colors"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-3 pt-4 border-t border-[var(--border-color)]">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest flex justify-between items-center">
                  <span>
                    Qualification Questions
                    <InfoTooltip text="Questions the AI should ask organically to determine if the lead is high quality." />
                  </span>
                  <button
                    onClick={() => addArrayItem("qualificationQuestions")}
                    className="text-[var(--primary)]"
                  >
                    + Add Question
                  </button>
                </label>
                <div className="space-y-2 max-h-40 overflow-y-auto custom-scrollbar pr-2">
                  {config.qualificationQuestions.map((q, index) => (
                    <div key={index} className="flex gap-2">
                      <input
                        type="text"
                        value={q}
                        onChange={(e) =>
                          handleArrayChange(
                            index,
                            "qualificationQuestions",
                            e.target.value,
                          )
                        }
                        className="flex-grow bg-[var(--background)] border border-[var(--border-color)] rounded-lg px-4 py-2 text-sm outline-none focus:border-[var(--primary)]"
                      />
                      <button
                        onClick={() =>
                          removeArrayItem(index, "qualificationQuestions")
                        }
                        className="px-3 text-[var(--foreground-muted)] hover:text-red-400 bg-[var(--background)] border border-[var(--border-color)] rounded-lg transition-colors"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-2 pt-4 border-t border-[var(--border-color)]">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                  Custom Behavioral Rules
                  <InfoTooltip text="General do's and don'ts. E.g., 'Never mention pricing. Keep answers under 2 sentences.'" />
                </label>
                <textarea
                  name="customRules"
                  value={config.customRules}
                  onChange={handleInputChange}
                  rows="3"
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm focus:border-[var(--primary)] outline-none resize-none"
                />
              </div>

              <div className="space-y-2 pt-4 border-t border-[var(--border-color)]">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                  Conversational Rules (Strict Flow)
                  <InfoTooltip text="Directives on how the AI should talk. E.g., 'Always end with a question' or 'Never use bullet points'." />
                </label>
                <textarea
                  name="additionalConversationalRules"
                  value={config.additionalConversationalRules}
                  onChange={handleInputChange}
                  placeholder="1. Always end with a question.&#10;2. Never use emojis."
                  rows="3"
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm focus:border-[var(--primary)] outline-none resize-none"
                />
              </div>
            </div>
          </div>

          <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-6 md:p-8 shadow-sm">
            <h2 className="text-lg font-bold text-[var(--foreground)] tracking-tight border-b border-[var(--border-color)] pb-4 mb-6">
              Knowledge & Routing
            </h2>
            <div className="space-y-6">
              <div className="space-y-3">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest flex justify-between items-center">
                  <span>
                    Services Offered
                    <InfoTooltip text="Keywords for your services. If a user asks what you offer, the AI references this list." />
                  </span>
                  <button
                    onClick={() => addArrayItem("services")}
                    className="text-[var(--primary)]"
                  >
                    + Add Service
                  </button>
                </label>
                <div className="space-y-2 max-h-40 overflow-y-auto custom-scrollbar pr-2">
                  {config.services.map((service, index) => (
                    <div key={index} className="flex gap-2">
                      <input
                        type="text"
                        value={service}
                        onChange={(e) =>
                          handleArrayChange(index, "services", e.target.value)
                        }
                        className="flex-grow bg-[var(--background)] border border-[var(--border-color)] rounded-lg px-4 py-2 text-sm focus:border-[var(--primary)] outline-none"
                      />
                      <button
                        onClick={() => removeArrayItem(index, "services")}
                        className="px-3 text-[var(--foreground-muted)] hover:text-red-400 bg-[var(--background)] border border-[var(--border-color)] rounded-lg transition-colors"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="space-y-3 pt-4 border-t border-[var(--border-color)]">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest flex justify-between items-center">
                  <span>
                    FAQs
                    <InfoTooltip text="Pre-feed exact answers to common questions. The AI will prioritize these over generating a random response." />
                  </span>
                  <button
                    onClick={() =>
                      addArrayItem("faqs", { question: "", answer: "" })
                    }
                    className="text-[var(--primary)]"
                  >
                    + Add FAQ
                  </button>
                </label>
                <div className="space-y-4 max-h-64 overflow-y-auto custom-scrollbar pr-2">
                  {config.faqs.map((faq, index) => (
                    <div
                      key={index}
                      className="flex flex-col gap-2 p-4 bg-[var(--background)] border border-[var(--border-color)] rounded-xl relative group/faq"
                    >
                      <button
                        onClick={() => removeArrayItem(index, "faqs")}
                        className="absolute top-2 right-2 p-1 text-[var(--foreground-muted)] hover:text-red-400 bg-[var(--card-bg)] rounded opacity-0 group-hover/faq:opacity-100 transition-opacity"
                      >
                        ✕
                      </button>
                      <input
                        type="text"
                        value={faq.question}
                        onChange={(e) =>
                          handleFaqChange(index, "question", e.target.value)
                        }
                        placeholder="Question"
                        className="w-full bg-[var(--card-bg)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm font-semibold outline-none pr-8 focus:border-[var(--primary)]"
                      />
                      <textarea
                        value={faq.answer}
                        onChange={(e) =>
                          handleFaqChange(index, "answer", e.target.value)
                        }
                        placeholder="Answer"
                        rows="2"
                        className="w-full bg-[var(--card-bg)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm outline-none resize-none focus:border-[var(--primary)]"
                      />
                    </div>
                  ))}
                </div>
              </div>

              <div className="h-px w-full bg-[var(--border-color)] my-6"></div>

              <div className="space-y-2">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                  Booking Calendar Rules
                  <InfoTooltip text="Controls when the bot is allowed to flag a conversation as 'ready_to_book'." />
                </label>
                <select
                  name="bookingRule"
                  value={config.bookingRule}
                  onChange={handleInputChange}
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm outline-none appearance-none focus:border-[var(--primary)] cursor-pointer"
                >
                  <option value="require_all">
                    Require Phone & Email before booking
                  </option>
                  <option value="require_email">Require Email only</option>
                  <option value="book_direct">
                    Allow direct booking immediately
                  </option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                  Escalation Behavior
                  <InfoTooltip text="What happens if the AI is asked something completely outside its knowledge base." />
                </label>
                <select
                  name="escalationRule"
                  value={config.escalationRule}
                  onChange={handleInputChange}
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm outline-none appearance-none focus:border-[var(--primary)] cursor-pointer"
                >
                  <option value="email_admin">
                    Take a message and email Admin
                  </option>
                  <option value="provide_phone">
                    Provide support phone number
                  </option>
                </select>
              </div>

              <div className="space-y-2">
                <label className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">
                  After-Hours Behavior
                  <InfoTooltip text="How the AI handles inquiries outside of standard 9-5 business hours." />
                </label>
                <select
                  name="unavailableBehavior"
                  value={config.unavailableBehavior}
                  onChange={handleInputChange}
                  className="w-full bg-[var(--background)] border border-[var(--border-color)] rounded-xl px-4 py-3 text-sm outline-none appearance-none focus:border-[var(--primary)] cursor-pointer"
                >
                  <option value="collect_lead">
                    Collect Email & Promise Next-Day Callback
                  </option>
                  <option value="standard">
                    Ignore hours and act normally
                  </option>
                </select>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        className={`fixed bottom-6 right-6 z-[100] transition-all duration-500 ease-out ${toast.show ? "translate-y-0 opacity-100" : "translate-y-10 opacity-0 pointer-events-none"}`}
      >
        <div className="app-toast border shadow-[0_10px_40px_rgba(0,0,0,0.3)] rounded-2xl p-4 pr-10 flex items-center gap-3 backdrop-blur-xl relative overflow-hidden">
          <div
            className={`w-1.5 h-full absolute left-0 top-0 ${toast.type === "error" ? "bg-red-500" : "bg-green-500"}`}
          ></div>
          <div>
            <p className="text-[10px] font-bold app-toast-label uppercase tracking-widest mb-0.5">
              System Notice
            </p>
            <p className="text-sm font-semibold">{toast.message}</p>
          </div>
        </div>
      </div>
    </main>
  );
}