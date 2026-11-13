// src/Closedesk/Chatbot/AicyroChatbot.jsx
"use client";

import { useState, useEffect, useRef } from "react";
import { logToFirebase, queueEmailAlert } from "../../lib/notificationHelper";
import { db, storage } from "../../lib/firebase";
import { ref, get } from "firebase/database";
import { ref as storageRef, uploadString, getDownloadURL } from "firebase/storage";
import { trackChatOpened, trackConversationStarted } from "../../lib/activityTracker";
import { getOrCreateAnonId } from "../../lib/cookiePersonalization";

import { createAiLogger, createVoiceLogger } from "../../lib/loggerPresets";
import { generateCorrelationId, fetchWithTrace } from "../../lib/tracer";

const uiLogger = createAiLogger("ChatbotWidget");
const voiceLogger = createVoiceLogger("VoiceAgent");

const AVATAR_MAP = {
  ai_spark: "/avatars/ai-spark.svg", bot_classic: "/avatars/bot-classic.svg",
  human_agent: "/avatars/human-agent.svg", minimal_dot: "/avatars/minimal-dot.svg",
};

const INDUSTRY_DEMOS = {
  Plumbing: { service: "Plumbing repair", scenario: "Someone has a leaking pipe." },
  HVAC: { service: "AC repair", scenario: "Someone's AC stopped working." },
  Electrical: { service: "Electrical repair", scenario: "Someone has an electrical fault or safety concern." },
  "Pest Control": { service: "Pest inspection", scenario: "Someone needs pest treatment or an inspection." },
  Roofing: { service: "Roof inspection", scenario: "Someone has storm damage or a roof leak." },
  Restoration: { service: "Water damage restoration", scenario: "Someone has water damage or flooding." },
  "Garage Door": { service: "Garage door repair", scenario: "Someone's garage door is stuck or broken." },
  "Appliance Repair": { service: "Appliance repair", scenario: "Someone's refrigerator or washer broke down." },
  "Wellness / Fitness": { service: "Session booking", scenario: "Someone wants to book a session or consultation." },
  "Sauna / Recovery": { service: "Recovery session", scenario: "Someone wants to book a sauna or recovery session." },
  "Med Spa / IV Therapy": { service: "Treatment booking", scenario: "Someone wants to book an IV therapy or spa treatment." },
  Other: { service: "Service inquiry", scenario: "Someone needs help with your service." },
};

function getReadableDeviceName() {
  if (typeof window === "undefined") return "Unknown Device";
  const ua = navigator.userAgent;
  let os = "Unknown OS", type = "Desktop";
  if (/Windows/i.test(ua)) os = "Windows PC";
  else if (/Macintosh|Mac OS X/i.test(ua)) os = "Macintosh";
  else if (/Android/i.test(ua)) { os = "Android"; type = "Mobile"; } 
  else if (/iPhone|iPad|iPod/i.test(ua)) { os = "iOS Device"; type = "Mobile"; } 
  else if (/Linux/i.test(ua)) os = "Linux";
  if (/Tablet|iPad/i.test(ua)) type = "Tablet";
  return `${os} (${type})`;
}

function getNextWeekdays() {
  const dates = [];
  let d = new Date(), daysFound = 0;
  while (daysFound < 6) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0) {
      dates.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }));
      daysFound++;
    }
  }
  return dates;
}

const generateTimeSlots = () => {
  const slots = [];
  for (let i = 9; i <= 17; i++) {
    const hour = i > 12 ? i - 12 : i;
    const ampm = i >= 12 ? "PM" : "AM";
    slots.push(`${hour < 10 ? `0${hour}` : hour}:00 ${ampm}`);
  }
  return slots;
};

// Client-side image compression
async function compressImage(file, maxDimension = 1024, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > maxDimension) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          }
        } else {
          if (height > maxDimension) {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
    };
    reader.onerror = reject;
  });
}

const STEPS = {
  WELCOME: "WELCOME", AI_CHAT_MODE: "AI_CHAT_MODE", CHOOSE_PATH: "CHOOSE_PATH",
  SELECT_DATE: "SELECT_DATE", SELECT_TIME: "SELECT_TIME", CONFIRM_BOOKING: "CONFIRM_BOOKING", FINAL_CTA: "FINAL_CTA",
};

const TypewriterBubble = ({ msg, onButtonClick, scrollRef, isProcessing, onSpeak, isMuted, agentMode, setAnimatingIds }) => {
  const [displayedText, setDisplayedText] = useState(msg.instant ? msg.text : "");
  const [isTypingText, setIsTypingText] = useState(!msg.instant);
  const hasSpoken = useRef(false);
  const isMutedRef = useRef(isMuted);
  const onSpeakRef = useRef(onSpeak);

  useEffect(() => { isMutedRef.current = isMuted; onSpeakRef.current = onSpeak; }, [isMuted, onSpeak]);
  useEffect(() => { uiLogger.info("ui_render", "widget_loaded", { context: { message: "Chatbot initialized" } }); }, []);
  useEffect(() => { if (msg.instant) setDisplayedText(msg.text); }, [msg.text, msg.instant]);

  useEffect(() => {
    const handleGlobalError = (event) => {
      uiLogger.critical("system_event", "frontend_javascript_error", {
        error: { message: event.message, filename: event.filename, lineno: event.lineno, colno: event.colno },
        context: { message: "Uncaught frontend exception detected" }
      });
    };
    const handleUnhandledRejection = (event) => {
      uiLogger.critical("system_event", "frontend_promise_rejection", {
        error: { message: String(event.reason) },
        context: { message: "Unhandled promise rejection detected" }
      });
    };

    window.addEventListener("error", handleGlobalError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);
    return () => {
      window.removeEventListener("error", handleGlobalError);
      window.removeEventListener("unhandledrejection", handleUnhandledRejection);
    };
  }, []);

  useEffect(() => {
    if (msg.instant) {
      setIsTypingText(false);
      if (!msg.spoken && !isMutedRef.current && onSpeakRef.current && !hasSpoken.current && agentMode === "text") {
        hasSpoken.current = true; onSpeakRef.current(msg.text);
      }
      setTimeout(() => scrollRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
      return;
    }
    
    let i = 0;
    setIsTypingText(true);
    setAnimatingIds?.((prev) => [...prev, msg.id]);
    setDisplayedText("");
    
    const timer = setInterval(() => {
      setDisplayedText(msg.text.slice(0, i + 1));
      i++;
      scrollRef.current?.scrollIntoView();
      if (i >= msg.text.length) {
        clearInterval(timer);
        setIsTypingText(false);
        setAnimatingIds?.((prev) => prev.filter((id) => id !== msg.id));
        
        if (!msg.spoken && !isMutedRef.current && onSpeakRef.current && !hasSpoken.current && agentMode === "text") {
          hasSpoken.current = true; onSpeakRef.current(msg.text);
        }
        setTimeout(() => scrollRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
      }
    }, 15);
    
    return () => {
      clearInterval(timer);
      setAnimatingIds?.((prev) => prev.filter((id) => id !== msg.id));
    };
  }, [msg.id, agentMode, msg.text, msg.instant]);

  return (
    <div className="flex flex-col gap-1.5 max-w-[85%] self-start animate-acy-fade">
      <div className="relative group px-4 py-3 text-[14px] leading-relaxed whitespace-pre-wrap bg-[var(--card-bg)] text-[var(--foreground)] rounded-2xl rounded-bl-sm border border-[var(--border-color)] shadow-sm">
        {displayedText}
        {isTypingText && <span className="inline-block w-1.5 h-3.5 ml-1 bg-[var(--primary)] animate-pulse align-middle" />}
        {!isTypingText && msg.isLastChunk !== false && (
          <button onClick={() => onSpeak(msg.fullText || msg.text)} className="ml-2 inline-flex items-center text-xs opacity-60 hover:opacity-100 transition-opacity outline-none rounded" title="Read Aloud" type="button">🔊</button>
        )}
      </div>
      {!isTypingText && msg.buttons?.length > 0 && (
        <div className="flex flex-col gap-2 mt-1.5 w-full animate-acy-fade">
          {msg.buttons.map((btn) => {
            const isCTA = btn.value === "path_book" || btn.value === "path_demo" || btn.value === "confirm_yes" || btn.value.startsWith("date_") || btn.value.startsWith("time_");
            return (
              <button
                key={btn.value} onClick={() => onButtonClick(btn.value, btn.label)} disabled={isProcessing}
                className={`text-[13px] font-semibold px-4 py-2.5 rounded-xl transition-all duration-200 text-center border focus-visible:ring-2 focus-visible:ring-[var(--primary)] outline-none ${isProcessing ? "opacity-50 cursor-not-allowed " : "hover:scale-[1.02] active:scale-95"} ${isCTA ? "bg-[var(--primary)] border-transparent text-white shadow-[0_0_15px_var(--lead-glow)] hover:shadow-[0_0_20px_var(--lead-glow)]" : "bg-[var(--background)] border-[var(--border-color)] text-[var(--foreground)] hover:bg-[var(--card-bg)]"}`}
              >
                {btn.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default function AicyroChatbot({ tenantId: propTenantId } = {}) {
  const tenantId = propTenantId 
    || (typeof window !== "undefined" && (window.__CLOSEDESK_TENANT_ID__ || new URLSearchParams(window.location.search).get("tenant") || new URLSearchParams(window.location.search).get("tenant_id")))
    || "default";
  const [isOpen, setIsOpen] = useState(false);
  const [showPeek, setShowPeek] = useState(false);
  const [hasAutoOpened, setHasAutoOpened] = useState(false);
  const isInIframe = typeof window !== "undefined" && window.self !== window.top;

  useEffect(() => {
    if (typeof window !== "undefined" && window.parent && window.parent !== window) {
      window.parent.postMessage(
        { 
          type: "CLOSEDESK_WIDGET_RESIZE", 
          isExpanded: isOpen,
          hasPeek: showPeek
        }, 
        "*"
      );
    }
  }, [isOpen, showPeek]);
  const [step, setStep] = useState(STEPS.WELCOME);
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [animatingIds, setAnimatingIds] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [firebaseDbId] = useState(() => `lead_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`);
  const firebaseDbIdRef = useRef(firebaseDbId);
  const [agentMode, setAgentMode] = useState("text");

  const hasSentStartAlertRef = useRef(false);
  const hasSentBasicInfoAlertRef = useRef(false);
  const hasSentMeetingAlertRef = useRef(false);
  const hasSentUrgentCallbackAlertRef = useRef(false);
  const [voiceState, setVoiceState] = useState("IDLE");
  const voiceCallRef = useRef(null);
  const activeResponseRef = useRef(false);
  const [isListening, setIsListening] = useState(false);
  const [isMuted, setIsMuted] = useState(true);

  // 🔥 Vision / WebRTC Camera States
  const [showImagePicker, setShowImagePicker] = useState(false);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [showWebcam, setShowWebcam] = useState(false);
  
  const fileGalleryInputRef = useRef(null);
  const videoRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const imagePickerRef = useRef(null); // Ref for closing the picker when clicking outside
  
  const recognitionRef = useRef(null);
  const abortControllerRef = useRef(null);
  const baseInputRef = useRef("");
  const telemetryRef = useRef({ versions: null });
  const turnMetricsRef = useRef(null);

  useEffect(() => {
    if (voiceCallRef.current && voiceCallRef.current.audioEl) voiceCallRef.current.audioEl.muted = isMuted;
    if (isMuted) stopSpeech();
  }, [isMuted]);

  // --- Click Outside to Close Image Picker ---
  useEffect(() => {
    function handleClickOutside(event) {
      if (imagePickerRef.current && !imagePickerRef.current.contains(event.target)) {
        setShowImagePicker(false);
      }
    }
    if (showImagePicker) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showImagePicker]);

  // --- WebRTC Camera Setup for "Take a Photo" ---
  const openWebcam = async () => {
    if (!botConfig.photoUploads) return;
    setShowImagePicker(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: "environment" } 
      });
      cameraStreamRef.current = stream;
      setShowWebcam(true);
    } catch (err) {
      uiLogger.error("camera", "permission_denied", { error: err });
      alert("Camera access denied or unavailable. Please check your browser permissions to take a photo.");
    }
  };

  const closeWebcam = () => {
    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach(track => track.stop());
      cameraStreamRef.current = null;
    }
    setShowWebcam(false);
  };

  useEffect(() => {
    if (showWebcam && videoRef.current && cameraStreamRef.current) {
      videoRef.current.srcObject = cameraStreamRef.current;
    }
  }, [showWebcam]);

  const capturePhotoFromWebcam = () => {
    if (!videoRef.current) return;
    const canvas = document.createElement("canvas");
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
    const base64Data = canvas.toDataURL("image/jpeg", 0.75);

    closeWebcam();
    processBase64Image(base64Data);
  };
  // ---------------------------------------------

  // --- Shared Vision Processing Logic ---
  const processBase64Image = async (base64Jpeg) => {
    if (!botConfig.photoUploads) return;
    setIsUploadingImage(true);
    setIsProcessing(true);

    try {
      setMessages((prev) => [
        ...prev,
        {
          role: "user",
          text: "📷 Image Uploaded",
          imageUrl: base64Jpeg,
          id: Date.now(),
        }
      ]);

      const imagePath = `chat_images/${firebaseDbIdRef.current}/${Date.now()}.jpg`;
      const fileRef = storageRef(storage, imagePath);
      await uploadString(fileRef, base64Jpeg, "data_url");
      const downloadURL = await getDownloadURL(fileRef);

      const txId = generateCorrelationId();
      const response = await fetchWithTrace(
        "/api/analyze-image",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-id": tenantId },
          body: JSON.stringify({
            session_id: firebaseDbIdRef.current,
            image_url: downloadURL,
            user_prompt: "Identify the problem, severity, and recommend next steps."
          }),
        },
        txId
      );

      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || "Vision analysis failed");

      const visionData = result.data;

      // 🔥 ONLY update lead state if the image was actually relevant
      if (!visionData.is_irrelevant) {
        setLeadData((prev) => ({
          ...prev,
          business_problem: visionData.identified_issue || prev.business_problem,
          urgency_level: visionData.urgency_level || prev.urgency_level,
        }));
      }

      const shortcuts = (visionData.suggested_shortcuts || ["Book Inspection", "Request Callback"]).map((s) => ({
        label: s,
        value: `shortcut_${s}`
      }));

      addBotMessage(visionData.reply, shortcuts);

    } catch (err) {
      uiLogger.error("ai_vision", "client_upload_failed", { error: err });
      addBotMessage("Sorry, I had trouble processing that image. Please try uploading again or describe the issue in text.", []);
    } finally {
      setIsUploadingImage(false);
      setIsProcessing(false);
      if (fileGalleryInputRef.current) fileGalleryInputRef.current.value = "";
    }
  };

  const handleGallerySelected = async (e) => {
    if (!botConfig.photoUploads) return;
    const file = e.target.files?.[0];
    if (!file) return;
    setShowImagePicker(false);
    const base64Jpeg = await compressImage(file);
    processBase64Image(base64Jpeg);
  };
  // ---------------------------------------------

  const resetTurnMetrics = () => {
    turnMetricsRef.current = { turn_id: Date.now().toString(), speech_start: null, speech_stop: null, response_created: null, stt_completed: null, first_audio: null, response_done: null, interrupted: false, tools: [] };
  };

  const flushTurnTelemetry = () => {
    if (!turnMetricsRef.current) return;
    const m = turnMetricsRef.current;
    if (m.response_created) {
      const txId = generateCorrelationId();
      const payload = {
        session_id: firebaseDbId, action: "log_telemetry",
        telemetry_data: {
          turn_id: m.turn_id, recording_duration: m.speech_stop && m.speech_start ? m.speech_stop - m.speech_start : null,
          stt_latency: m.stt_completed && m.speech_stop ? m.stt_completed - m.speech_stop : null, ai_latency: m.response_created && m.stt_completed ? m.response_created - m.stt_completed : null,
          first_audio_latency: m.first_audio && m.response_created ? m.first_audio - m.response_created : null, total_turn_latency: m.response_done && m.speech_start ? m.response_done - m.speech_start : null,
          interrupted: m.interrupted, tools: m.tools, versions: telemetryRef.current.versions,
        }
      };
      fetchWithTrace("/api/sync-voice", { method: "POST", headers: { "Content-Type": "application/json", "x-tenant-id": tenantId }, body: JSON.stringify(payload) }, txId)
        .catch((err) => voiceLogger.error("telemetry", "sync_failed", { error: err }));
    }
    turnMetricsRef.current = null;
  };

  const [botConfig, setBotConfig] = useState({
    botName: "Aicyro Front Desk", launcherText: "Need help?", greetingMessage: "Hi! I'm Aicyro's AI Assistant. How can I help you today?",
    botAvatar: "ai_spark", customAvatarSvg: "", botVoice: "Joanna", voiceEnabled: true,
    voiceChatAgent: true, photoUploads: true,
    enableDirectBooking: true, calendarActive: true,
  });

  const logVoiceError = (stage, message, rawError = null) => {
    const txId = generateCorrelationId();
    voiceLogger.error("webrtc", stage.toLowerCase(), { context: { error_message: message }, error: rawError, correlation: { correlation_id: txId } });
    fetchWithTrace("/api/sync-voice", { method: "POST", headers: { "Content-Type": "application/json", "x-tenant-id": tenantId }, body: JSON.stringify({ session_id: firebaseDbIdRef.current, action: "log_error", error_stage: stage, error_message: message, raw_error: rawError ? String(rawError) : null }) }, txId).catch(() => {});
  };

  useEffect(() => {
    return () => {
      if (voiceCallRef.current) {
        const { pc, stream, audioEl, dc } = voiceCallRef.current;
        if (dc) dc.close(); if (pc) pc.close();
        if (stream) stream.getTracks().forEach((track) => track.stop());
        if (audioEl) { audioEl.pause(); audioEl.srcObject = null; }
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = false; recognition.interimResults = true; recognition.lang = "en-US";
        recognition.onresult = (event) => {
          let currentTranscript = "";
          for (let i = event.resultIndex; i < event.results.length; i++) currentTranscript += event.results[i][0].transcript;
          setInputValue(baseInputRef.current + currentTranscript);
        };
        recognition.onerror = (event) => { uiLogger.warn("speech_recognition", "recognition_error", { error: event.error }); setIsListening(false); };
        recognition.onend = () => setIsListening(false);
        recognitionRef.current = recognition;
      }
    }
  }, []);

  const toggleListening = () => {
    if (!recognitionRef.current) { alert("Speech recognition is not supported in this browser."); return; }
    if (isListening) { recognitionRef.current.stop(); setIsListening(false); } 
    else {
      stopSpeech();
      try {
        const currentText = inputRef.current ? inputRef.current.value : inputValue;
        baseInputRef.current = currentText ? currentText.endsWith(" ") ? currentText : currentText + " " : "";
        recognitionRef.current.start(); setIsListening(true);
      } catch (err) { uiLogger.error("speech_recognition", "start_failed", { error: err }); }
    }
  };

  const handleInputInteraction = () => { if (isListening && recognitionRef.current) { recognitionRef.current.stop(); setIsListening(false); } };

  const handleStartVoiceCall = async () => {
    if (!hasTrackedConvo) {
      trackConversationStarted("Voice session initiated", tenantId);
      setHasTrackedConvo(true);
    }
    if (!botConfig.voiceChatAgent || !botConfig.voiceEnabled) return;
    const txId = generateCorrelationId();
    const callLogger = voiceLogger.child({ correlation: { correlation_id: txId } });

    callLogger.info("voice_lifecycle", "voice_session_requested", { context: { session_id: firebaseDbId }});

    setVoiceState("REQUESTING_PERMISSION");
    let localStream;

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("UNSUPPORTED_BROWSER");
      localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      callLogger.info("voice_lifecycle", "mic_permission_granted");
    } catch (error) {
      setVoiceState("PERMISSION_DENIED");
      callLogger.error("voice_lifecycle", "mic_permission_denied", { error });
      logVoiceError("MIC_PERMISSION", "Microphone access denied or failed", error.message || error.name);
      return;
    }

    setVoiceState("PROCESSING");
    try {
      const tokenResponse = await fetchWithTrace("/api/openai-token", { method: "POST", headers: { "Content-Type": "application/json", "x-tenant-id": tenantId }, body: JSON.stringify({ session_id: firebaseDbId }) }, txId);
      const data = await tokenResponse.json();

      if (!tokenResponse.ok) {
        logVoiceError("TOKEN_FETCH", "Failed to fetch OpenAI token", data.error);
        throw new Error(data.error || "Failed to fetch session token.");
      }

      const EPHEMERAL_KEY = data.client_secret?.value || data.value;
      if (data.versions) telemetryRef.current.versions = data.versions;

      const pc = new RTCPeerConnection();
      const audioEl = new Audio();
      audioEl.autoplay = true; audioEl.muted = isMuted;
      pc.ontrack = (e) => {
        audioEl.srcObject = e.streams[0];
        audioEl.play().catch((err) => { setIsMuted(true); callLogger.warn("audio", "playback_blocked", { error: err }); });
      };
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

      const dataChannel = pc.createDataChannel("oai-events");
      dataChannel.onopen = () => {
        setVoiceState("LISTENING");
        callLogger.info("voice_lifecycle", "voice_session_started", { context: { session_id: firebaseDbId }});
        if (!hasSentStartAlertRef.current) {
          hasSentStartAlertRef.current = true;
          queueEmailAlert("New Voice Call Started", "A visitor has connected to the AI Voice Agent.", leadDataRef.current, "start");
        }
      };

      dataChannel.onclose = () => {
        setVoiceState((prev) => (prev === "ERROR" ? "ERROR" : "IDLE"));
        activeResponseRef.current = false;
        flushTurnTelemetry();
      };

      dataChannel.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          
          if (event.type === "response.created") {
            setVoiceState("PROCESSING"); activeResponseRef.current = true;
            callLogger.info("voice_lifecycle", "ai_processing_started");
            if (turnMetricsRef.current) turnMetricsRef.current.response_created = Date.now();
          } 
          else if (event.type === "response.done" || event.type === "response.cancelled" || event.type === "response.failed") {
            setVoiceState("LISTENING"); activeResponseRef.current = false;
            if (event.type === "response.done") callLogger.info("voice_lifecycle", "audio_response_completed");
            if (event.type === "response.cancelled") callLogger.warn("voice_lifecycle", "response_interrupted");
            if (turnMetricsRef.current) {
              turnMetricsRef.current.response_done = Date.now();
              if (event.type === "response.cancelled") turnMetricsRef.current.interrupted = true;
              flushTurnTelemetry();
            }
          } 
          else if (event.type === "error") {
            setVoiceState("ERROR"); activeResponseRef.current = false;
            flushTurnTelemetry();
            logVoiceError("REALTIME_API", "OpenAI Realtime API error", JSON.stringify(event.error));
          }

          if (event.type === "input_audio_buffer.speech_started") {
            setVoiceState((prev) => prev === "SPEAKING" ? "INTERRUPTED" : "LISTENING");
            if (activeResponseRef.current) callLogger.warn("voice_lifecycle", "barge_in", { context: { message: "User interrupted the AI" }});
            else callLogger.info("voice_lifecycle", "speech_started");
            if (turnMetricsRef.current && activeResponseRef.current) { turnMetricsRef.current.interrupted = true; flushTurnTelemetry(); }
            resetTurnMetrics(); turnMetricsRef.current.speech_start = Date.now();
          } 
          else if (event.type === "input_audio_buffer.speech_stopped") {
            setVoiceState("PROCESSING"); callLogger.info("voice_lifecycle", "speech_stopped");
            if (turnMetricsRef.current) turnMetricsRef.current.speech_stop = Date.now();
          } 
          else if (event.type === "response.audio.delta") {
            setVoiceState("SPEAKING");
            if (turnMetricsRef.current && !turnMetricsRef.current.first_audio) { turnMetricsRef.current.first_audio = Date.now(); callLogger.info("voice_lifecycle", "audio_response_started"); }
          }

          if (event.type === "conversation.item.input_audio_transcription.completed") {
            callLogger.info("voice_lifecycle", "transcription_completed");
            if (turnMetricsRef.current) turnMetricsRef.current.stt_completed = Date.now();
            const cleanTranscript = event.transcript ? event.transcript.replace(/[^\w\s]/gi, "").trim() : "";
            if (!cleanTranscript) {
              if (event.item_id) dataChannel.send(JSON.stringify({ type: "conversation.item.delete", item_id: event.item_id }));
              setVoiceState("LISTENING"); turnMetricsRef.current = null;
              return;
            }
            if (event.transcript.trim()) setMessages((prev) => [...prev, { role: "user", text: event.transcript, id: Date.now() + Math.random(), channel: "voice" }]);
          }

          if (event.type === "response.function_call_arguments.done") {
            const toolStart = Date.now();
            const toolTxId = generateCorrelationId();
            let parsedArgs;
            try {
              parsedArgs = JSON.parse(event.arguments);
            } catch (parseError) {
              uiLogger.error("ai_tool", "tool_call_failed", { error: parseError, context: { tool_name: event.name, tool_call_id: event.call_id, result_status: "invalid_parameters" }, metadata: { raw_args_snippet: String(event.arguments).substring(0, 50) + "..." } });
              dataChannel.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: event.call_id, output: JSON.stringify({ error: "Invalid JSON Schema" }) } }));
              dataChannel.send(JSON.stringify({ type: "response.create" }));
              return;
            }

            uiLogger.info("ai_tool", "tool_call_started", { context: { tool_name: event.name, tool_call_id: event.call_id }, metadata: { args: parsedArgs } });

            fetchWithTrace("/api/sync-voice", { method: "POST", headers: { "Content-Type": "application/json", "x-tenant-id": tenantId }, body: JSON.stringify({ session_id: firebaseDbId, tool_name: event.name, tool_args: parsedArgs }) }, toolTxId)
              .then((res) => res.json())
              .then((result) => {
                const duration_ms = Date.now() - toolStart;
                uiLogger.info("ai_tool", "tool_call_success", { context: { tool_name: event.name, tool_call_id: event.call_id, result_status: "success" }, duration_ms });
                if (turnMetricsRef.current) turnMetricsRef.current.tools.push({ name: event.name, duration_ms });
                dataChannel.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: event.call_id, output: JSON.stringify(result) } }));
                dataChannel.send(JSON.stringify({ type: "response.create" }));
              })
              .catch((err) => {
                const duration_ms = Date.now() - toolStart;
                uiLogger.error("ai_tool", "tool_call_failed", { error: err, context: { tool_name: event.name, tool_call_id: event.call_id, result_status: "failed" }, duration_ms });
                dataChannel.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: event.call_id, output: JSON.stringify({ success: false, error: "Backend error" }) } }));
                dataChannel.send(JSON.stringify({ type: "response.create" }));
              });
          }

          if (event.type === "response.audio_transcript.delta" || event.type === "response.output_audio_transcript.delta") {
            setMessages((prev) => {
              const lastMsg = prev[prev.length - 1];
              if (lastMsg && lastMsg.role === "bot" && lastMsg.isVoiceStream && lastMsg.itemId === event.item_id) {
                const updated = [...prev]; updated[updated.length - 1] = { ...lastMsg, text: lastMsg.text + event.delta }; return updated;
              } else {
                return [...prev, { role: "bot", text: event.delta, id: Date.now() + Math.random(), itemId: event.item_id, instant: true, spoken: true, isVoiceStream: true }];
              }
            });
          }
        } catch (err) { callLogger.error("webrtc", "data_channel_parse_error", { error: err }); }
      };

      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", { method: "POST", body: offer.sdp, headers: { Authorization: `Bearer ${EPHEMERAL_KEY}`, "Content-Type": "application/sdp" } });

      if (!sdpResponse.ok) { logVoiceError("WEBRTC_NEGOTIATION", "Failed to negotiate WebRTC connection", await sdpResponse.text()); throw new Error("WebRTC negotiation failed"); }

      const answer = { type: "answer", sdp: await sdpResponse.text() };
      await pc.setRemoteDescription(answer);
      voiceCallRef.current = { pc, stream: localStream, audioEl, dc: dataChannel };
    } catch (error) {
      setVoiceState("ERROR"); activeResponseRef.current = false;
      if (localStream) localStream.getTracks().forEach((track) => track.stop());
    }
  };

  const handleEndVoiceCall = () => {
    try {
      if (voiceCallRef.current) {
        const { pc, stream, audioEl, dc } = voiceCallRef.current;
        if (dc) dc.close(); if (pc) pc.close();
        if (stream) stream.getTracks().forEach((track) => track.stop());
        if (audioEl) { audioEl.pause(); audioEl.srcObject = null; }
        voiceCallRef.current = null;
      }
      setVoiceState("IDLE"); activeResponseRef.current = false;
      voiceLogger.info("voice_lifecycle", "voice_session_ended", { context: { session_id: firebaseDbId }});
      logToFirebase("Call Ended", "Voice connection disconnected.", leadDataRef.current);
      submitLead({ ...leadDataRef.current, last_interaction_at: new Date().toISOString() });
    } catch (error) { voiceLogger.error("webrtc", "end_call_failed", { error }); setVoiceState("IDLE"); }
  };

  const handleToggleMode = async () => {
    const transitionEvent = agentMode === "text" ? "text_to_voice_switch" : "voice_to_text_switch";
    uiLogger.info("voice_lifecycle", transitionEvent, { context: { session_id: firebaseDbId }});

    stopSpeech();
    if (agentMode === "text") { if (!botConfig.voiceChatAgent || !botConfig.voiceEnabled) return; setAgentMode("voice"); } 
    else {
      if (voiceState !== "IDLE" && voiceState !== "ERROR") handleEndVoiceCall();
      setAgentMode("text");
      try {
        const snap = await get(ref(db, `prospects/${firebaseDbId}`));
        if (snap.exists()) {
          const pData = snap.val(); const cp = pData.context_patch || {}; const ci = cp.contact_info || {}; const bc = cp.business_context || {};
          setLeadData((prev) => ({
            ...prev, name: ci.name || prev.name, email: ci.email || prev.email, phone: ci.phone || prev.phone,
            website: bc.website || prev.website, business_type: bc.industry || prev.business_type,
            business_name: bc.industry || prev.business_name, service_requested: bc.interested_capability || prev.service_requested,
            conversation_summary: pData.factual_summary || prev.conversation_summary,
          }));
        }
      } catch (err) { uiLogger.error("state", "mode_switch_sync_failed", { error: err }); }
    }
  };

  const speakText = async (text) => {
    if (typeof window === "undefined" || isMuted || !text) return;
    if (abortControllerRef.current) abortControllerRef.current.abort();
    abortControllerRef.current = new AbortController();

    if (window.currentAudio) { window.currentAudio.pause(); window.currentAudio.currentTime = 0; }

    try {
      const txId = generateCorrelationId();
      const cleanText = text.replace(/[^\w\s,.!?]/gi, "");
      const response = await fetchWithTrace("/api/tts", { method: "POST", headers: { "Content-Type": "application/json", "x-tenant-id": tenantId }, body: JSON.stringify({ text: cleanText, voiceId: botConfig.botVoice || "Joanna" }), signal: abortControllerRef.current.signal }, txId);

      if (!response.ok) throw new Error("TTS request failed");
      const blob = await response.blob();
      if (abortControllerRef.current.signal.aborted) return;

      const url = URL.createObjectURL(blob); const audio = new Audio(url); window.currentAudio = audio;
      audio.play().catch((err) => { uiLogger.warn("audio", "playback_blocked", { error: err }); setIsMuted(true); });
    } catch (error) { if (error.name !== "AbortError") uiLogger.error("tts", "polly_error", { error }); }
  };

  const stopSpeech = () => {
    if (abortControllerRef.current) abortControllerRef.current.abort();
    if (window.currentAudio) { window.currentAudio.pause(); window.currentAudio.currentTime = 0; window.currentAudio = null; }
  };

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const snapshot = await get(ref(db, "settings/chatbot_config"));
        if (snapshot.exists()) {
          const data = snapshot.val();
          const voiceState = data.voiceChatAgent !== undefined
            ? data.voiceChatAgent !== false
            : (data.voiceEnabled !== false);
          const photoState = data.photoUploads !== undefined
            ? data.photoUploads !== false
            : (data.photoUploadsEnabled !== undefined ? data.photoUploadsEnabled !== false : true);

          const calExists = Boolean(
            data.calendarActive !== false &&
            (data.calendarIntegration || data.calendarActive || data.integrations?.calendar || data.integrations?.GoogleCalendar || data.integrations?.Make || data.bookingRule)
          );
          const directBooking = (data.enableDirectBooking === false || data.enableDirectBooking === null)
            ? (calExists ? true : false)
            : (data.enableDirectBooking !== undefined ? data.enableDirectBooking : (calExists || true));
          const calActive = (data.calendarActive === false || data.calendarActive === null)
            ? (calExists ? true : false)
            : (data.calendarActive !== undefined ? data.calendarActive : true);

          setBotConfig({
            botName: data.botName || "Aicyro Front Desk", launcherText: data.launcherText || "Need help?",
            greetingMessage: data.greetingMessage || "Hi! I'm Aicyro's AI Assistant. How can I help you today?",
            botAvatar: data.botAvatar || "ai_spark", customAvatarSvg: data.customAvatarSvg || "",
            botVoice: data.botVoice || "Joanna", voiceEnabled: voiceState,
            voiceChatAgent: voiceState,
            photoUploads: photoState,
            enableDirectBooking: directBooking,
            calendarActive: calActive,
          });
          if (!voiceState) {
            setAgentMode("text");
          }
        }
      } catch (err) { uiLogger.error("config", "load_failed", { error: err }); }
    };
    fetchConfig();
  }, []);

  const [sessionStartTime] = useState(new Date().toISOString());
  const [hasTrackedOpen, setHasTrackedOpen] = useState(false);
  const [hasTrackedConvo, setHasTrackedConvo] = useState(false);
  const [avatarEffect, setAvatarEffect] = useState("");
  const [speechText, setSpeechText] = useState("");
  const [isHovered, setIsHovered] = useState(false);

  const [leadData, setLeadData] = useState({
    name: "", phone: "", email: "", business_name: "", business_type: "", business_problem: "",
    website: "", service_requested: "", location: "", visitor_intent: "", urgency_level: "",
    preferred_date: "", preferred_time: "", selected_date: "", conversation_summary: "",
    lead_score: "Low", booking_status: "In Progress", after_hours_flag: false, source_page: "",
  });

  const messagesEndRef = useRef(null); const inputRef = useRef(null);
  const leadDataRef = useRef(leadData); const messagesRef = useRef(messages);
  useEffect(() => { firebaseDbIdRef.current = firebaseDbId; }, [firebaseDbId]);
  const hasFiredUnload = useRef(false);
  useEffect(() => { leadDataRef.current = leadData; }, [leadData]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  useEffect(() => {
    const handleUnload = () => {
      if (hasFiredUnload.current) return;
      const currentLead = leadDataRef.current; const currentMessages = messagesRef.current;
      if (currentMessages.length > 1 && currentLead.booking_status !== "Meeting Booked") {
        hasFiredUnload.current = true;
        const currentTranscript = currentMessages.map((m) => `[${m.role.toUpperCase()}]: ${m.text || m.content || "Interaction"}`).join("\n");
        const payload = {
          source: "Website AI Front Desk", source_page: typeof window !== "undefined" ? window.location.href : "Unknown",
          anonId: getOrCreateAnonId() || "unknown", deviceName: getReadableDeviceName(), full_conversation_transcript: currentTranscript,
          conversation_started_at: sessionStartTime, last_interaction_at: new Date().toISOString(), conversation_ended_at: new Date().toISOString(),
          firebaseId: firebaseDbIdRef.current, ...currentLead, is_abandoned: true, booking_status: "Abandoned Mid-Conversation",
        };
        const sanitizedPayload = Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, v === undefined || v === null ? "" : v]));
        fetchWithTrace("/api/leads", { method: "POST", headers: { "Content-Type": "application/json", "x-tenant-id": tenantId }, body: JSON.stringify(sanitizedPayload), keepalive: true }, generateCorrelationId()).catch(() => {});
      }
    };
    const handleVisibilityChange = () => { if (document.visibilityState === "hidden") handleUnload(); };
    window.addEventListener("beforeunload", handleUnload); document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => { window.removeEventListener("beforeunload", handleUnload); document.removeEventListener("visibilitychange", handleVisibilityChange); };
  }, [sessionStartTime]);

  const getActiveAvatarSrc = () => {
    if (botConfig.botAvatar === "custom") {
      if (botConfig.customAvatarSvg && botConfig.customAvatarSvg.trim().startsWith("<svg")) { return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(botConfig.customAvatarSvg)}`; }
      return `data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M12 20h9'%3E%3C/path%3E%3Cpath d='M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z'%3E%3C/path%3E%3C/svg%3E`;
    }
    return AVATAR_MAP[botConfig.botAvatar] || AVATAR_MAP.ai_spark;
  };
  const currentAvatarSrc = getActiveAvatarSrc();

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, isTyping]);
  useEffect(() => { const timer = setTimeout(() => { if (!hasAutoOpened) { setShowPeek(true); setHasAutoOpened(true); } }, 6000); return () => clearTimeout(timer); }, [hasAutoOpened]);

  useEffect(() => {
    if (isOpen && messages.length === 0) { setStep(STEPS.AI_CHAT_MODE); addBotMessage(botConfig.greetingMessage, [], true); }
  }, [isOpen, messages.length, botConfig.greetingMessage]);

  useEffect(() => {
    if (isOpen && !isProcessing && [STEPS.AI_CHAT_MODE].includes(step) && agentMode === "text" && inputRef.current) { const timer = setTimeout(() => { inputRef.current?.focus(); }, 50); return () => clearTimeout(timer); }
  }, [isOpen, isProcessing, step, agentMode]);

  const handleAvatarHover = () => { setIsHovered(true); if (!avatarEffect) setSpeechText(["Beep boop! ⚡", "I capture leads 24/7!", "Let's maximize revenue!", "Need a fast demo? 👇"][Math.floor(Math.random() * 4)]); };
  const handleAvatarLeave = () => { setIsHovered(false); };
  const handleAvatarClick = (e) => { e.stopPropagation(); if (avatarEffect) return; setAvatarEffect("animate-avatar-flip"); setSpeechText("Whoa! 🚀"); setTimeout(() => { setAvatarEffect(""); if (isHovered) setSpeechText("Ready for action!"); }, 1000); };

// ==========================================
  // 🔥 HUMAN-LIKE MESSAGE CHUNKING SYSTEM
  // ==========================================
  async function addBotMessage(text, buttons = [], isInstant = false) {
    if (!text) return;
    
    // Strip out Markdown bolding asterisks just in case the AI sends them
    const cleanText = text.replace(/\*\*/g, "");
    
    // BULLETPROOF SPLIT: Split the text by the | delimiter OR by any newlines (\n)
    const chunks = cleanText.split(/[|\n]+/).map(t => t.trim()).filter(Boolean);
    const fullMessageText = chunks.join(" "); // Combine for the TTS reader
    
    // If it's an instant message (like loading history or a fallback error), dump them all at once
    if (isInstant) {
      setMessages((prev) => [
        ...prev,
        ...chunks.map((chunk, index) => ({
          role: "bot",
          text: chunk,
          fullText: fullMessageText,
          buttons: index === chunks.length - 1 ? buttons : [], // Only last chunk gets buttons
          instant: true,
          spoken: false,
          id: Date.now() + Math.random() + index,
          isLastChunk: index === chunks.length - 1 // Fixes speaker bug
        }))
      ]);
      return;
    }

    // Otherwise, simulate a human typing multiple separate bubbles
    setIsTyping(true);
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const isLast = i === chunks.length - 1;
      
      // Calculate dynamic delay before this bubble appears
      const prevTypingTime = i === 0 ? 0 : chunks[i - 1].length * 15;
      const humanPause = i === 0 ? 600 : 800; 
      const delay = prevTypingTime + humanPause;
      
      await new Promise((resolve) => setTimeout(resolve, delay));
      
      setMessages((prev) => [
        ...prev, 
        { 
          role: "bot", 
          text: chunk, 
          fullText: fullMessageText,
          buttons: isLast ? buttons : [], 
          instant: false, 
          spoken: false, 
          id: Date.now() + Math.random(),
          isLastChunk: isLast
        }
      ]);
      
      if (isLast) setIsTyping(false);
    }
  }
  // ==========================================

  
  function addUserMessage(text) {
    setMessages((prev) => {
      const cleanedMessages = prev.map((m) => m.role === "bot" && m.buttons?.length > 0 ? { ...m, buttons: m.buttons.filter((b) => !b.value.startsWith("shortcut_")) } : m);
      return [...cleanedMessages, { role: "user", text, id: Date.now() + Math.random() }];
    });
  }

  function openChat() {
    setShowPeek(false);
    setIsOpen(true);
    uiLogger.info("chatbot_ui", "widget_opened", {
      context: { message: "User manually opened chatbot UI" },
    });
    if (!hasTrackedOpen) {
      setHasTrackedOpen(true);
      trackChatOpened(tenantId);
    }
  }

  function handleCloseChat() { uiLogger.info("user_action", "widget_closed"); stopSpeech(); if (voiceState !== "IDLE" && voiceState !== "ERROR") handleEndVoiceCall(); submitLead({ ...leadDataRef.current, conversation_ended_at: new Date().toISOString() }); setMessages((prev) => prev.map((m) => ({ ...m, instant: true, spoken: true }))); setIsOpen(false); }

  function triggerConfirmation(finalData) {
    setStep(STEPS.CONFIRM_BOOKING);
    uiLogger.info("booking_lifecycle", "booking_requested", { context: { session_id: firebaseDbId, target_time: finalData.display_time }});
    addBotMessage(
      `Great! Before I lock this in, please confirm your details: | • Name: ${finalData.name || "N/A"}\n• Email: ${finalData.email || "N/A"}\n• Phone: ${finalData.phone || "N/A"}\n• Meeting: ${finalData.display_time} | Does everything look correct?`,
      [{ label: "Yes, Confirm Booking", value: "confirm_yes" }, { label: "No, Edit Details", value: "confirm_no" }],
    );
  }

  async function generateAndSendWebhook(data, timeText) {
    const txId = generateCorrelationId();
    const startTime = Date.now();
    
    uiLogger.info("ai_tool", "tool_call_started", { context: { tool_name: "create_booking_and_email", tool_call_id: txId }, metadata: { args: { data, timeText } }});
    uiLogger.info("booking_lifecycle", "booking_creation_started", { context: { session_id: firebaseDbId, target_time: timeText }});

    // Default Fallback Email Content (Used if the webhook fails)
    let emailSubject = "Your Demo is Confirmed!";
    let emailBody = `Hi ${data.name || "there"},\n\nYour meeting is confirmed for ${timeText}. We look forward to speaking with you!`;
    let bookingId = `bk_${txId.substring(0,8)}`;

    try {
      // Attempt to hit the Make.com webhook
      const response = await fetchWithTrace(
        "/api/generate-email",
        { method: "POST", headers: { "Content-Type": "application/json", "x-tenant-id": tenantId }, body: JSON.stringify({ name: data.name, business_type: data.business_type, time: timeText }) },
        txId,
      );
      
      if (response.ok) {
        const generatedEmail = await response.json();
        emailSubject = generatedEmail.subject || emailSubject;
        emailBody = generatedEmail.body || emailBody;
        bookingId = generatedEmail.messageId || bookingId;
      } else {
        uiLogger.warn("ai_tool", "email_generation_warning", { context: { message: `Webhook returned status ${response.status}. Using fallback email content.` }});
      }
    } catch (error) {
      uiLogger.warn("ai_tool", "email_generation_network_error", { context: { message: "Could not reach email generation API. Using fallback email content." }, error });
    }

    try {
      // 🔥 Proceed with the booking regardless of the email webhook's success
      uiLogger.info("ai_tool", "tool_call_success", { context: { tool_name: "create_booking_and_email", tool_call_id: txId, result_status: "success" }, duration_ms: Date.now() - startTime });
      uiLogger.info("booking_lifecycle", "booking_created", { context: { session_id: firebaseDbId, booking_id: bookingId, target_time: timeText }, duration_ms: Date.now() - startTime });

      if (!hasSentMeetingAlertRef.current) {
        hasSentMeetingAlertRef.current = true;
        queueEmailAlert("Meeting Booked! 📅", `${data.name || "A visitor"} confirmed a meeting for ${timeText}.`, data, "end", { visitorEmail: data.email, subject: emailSubject, body: emailBody });
      }

      submitLead({ ...data, booking_status: "Meeting Booked", requested_action: "Meeting Booked", generated_subject: emailSubject, generated_body: emailBody, conversation_ended_at: new Date().toISOString() });
      setIsProcessing(false);
      addBotMessage(`✅ Contact Confirmed! | Your demo is officially booked for ${timeText}. We have securely saved your details and sent a calendar invite to ${data.email || "your email"}.`, [{ label: "Close Chat", value: "close" }], true);
    
    } catch (dbError) {
      // Only throw a fatal Booking Error if the actual database submission fails
      uiLogger.error("booking_lifecycle", "booking_failed_fatal", { error: dbError, context: { session_id: firebaseDbId, target_time: timeText }});
      
      setIsProcessing(false);
      addBotMessage(`⚠️ Booking Error | Sorry, I couldn't secure that calendar slot due to a network error. Please try selecting a different time or contact us directly.`, [], true);
      setStep(STEPS.AI_CHAT_MODE); 
    }
  }

  async function submitLead(data) {
    const txId = generateCorrelationId();
    const startTime = Date.now();
    uiLogger.info("ai_tool", "tool_call_started", { context: { tool_name: "submit_lead", tool_call_id: txId }, metadata: { args: data } });

    try {
      const currentTranscript = messagesRef.current.map((m) => `[${m.role.toUpperCase()}]: ${m.text || m.content || "Interaction"}`).join("\n");
      const payload = {
        source: "Website AI Front Desk", source_page: typeof window !== "undefined" ? window.location.href : "Unknown",
        anonId: getOrCreateAnonId() || "unknown", deviceName: getReadableDeviceName(), full_conversation_transcript: currentTranscript,
        conversation_started_at: sessionStartTime, last_interaction_at: new Date().toISOString(), ...(!firebaseDbId && { timestamp: new Date().toISOString() }),
        firebaseId: firebaseDbId, ...data,
      };
      const sanitizedPayload = Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, v === undefined || v === null ? "" : v]));

      const res = await fetchWithTrace("/api/leads", { method: "POST", headers: { "Content-Type": "application/json", "x-tenant-id": tenantId }, body: JSON.stringify(sanitizedPayload), keepalive: true }, txId);
      if (!res.ok) throw new Error(`Server status: ${res.status}`);
      
      uiLogger.info("ai_tool", "tool_call_success", { context: { tool_name: "submit_lead", tool_call_id: txId, result_status: "success" }, duration_ms: Date.now() - startTime });
    } catch (err) {
      uiLogger.error("ai_tool", "tool_call_failed", { error: err, context: { tool_name: "submit_lead", tool_call_id: txId, result_status: "failed" }, duration_ms: Date.now() - startTime });
      uiLogger.error("lead_capture", "submission_failed", { error: err, correlation: { correlation_id: txId } });
    }
  }

  async function processUserMessage(val) {
    if (isProcessing || !val.trim()) return;
    stopSpeech();
    if (isListening && recognitionRef.current) { recognitionRef.current.stop(); setIsListening(false); }

    addUserMessage(val);
    if (!hasTrackedConvo) { trackConversationStarted(val, tenantId); setHasTrackedConvo(true); uiLogger.info("user_action", "chat_started", { context: { message: "First message sent by user" } }); }

    if (!hasSentStartAlertRef.current) { hasSentStartAlertRef.current = true; queueEmailAlert("New Text Chat Started", `A visitor just started a chat: "${val}"`, leadData, "start"); }

    if (step === STEPS.AI_CHAT_MODE) {
      setIsProcessing(true);
      const txId = generateCorrelationId();
      uiLogger.info("chat", "user_message_received", { correlation: { correlation_id: txId } });

      const aiHistory = messagesRef.current.filter((m) => m.role === "user" || m.role === "bot").map((m) => ({ role: m.role === "bot" ? "assistant" : "user", content: m.text || "User interacted" }));
      aiHistory.push({ role: "user", content: val });

      try {
        const isBookingToolActive = Boolean(botConfig.enableDirectBooking !== false && botConfig.calendarActive !== false);
        const bookingToolDefinition = isBookingToolActive ? {
          type: "function",
          function: {
            name: "schedule_calendar_meeting",
            description: "Directly triggers the calendar booking tool when user asks to book a meeting and provides Name, Email, and Phone.",
            parameters: {
              type: "object",
              properties: {
                name: { type: "string" },
                email: { type: "string" },
                phone: { type: "string" },
                preferred_date: { type: "string" },
                preferred_time: { type: "string" }
              },
              required: ["name", "email", "phone"]
            }
          }
        } : null;

        const response = await fetchWithTrace("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-id": tenantId },
          body: JSON.stringify({
            session_id: firebaseDbId,
            current_lead_data: {
              ...leadData,
              enableDirectBooking: botConfig.enableDirectBooking,
              calendarActive: botConfig.calendarActive,
            },
            messages: aiHistory,
            enableDirectBooking: botConfig.enableDirectBooking,
            calendarActive: botConfig.calendarActive,
            booking_tool_active: isBookingToolActive,
            tools: bookingToolDefinition ? [bookingToolDefinition] : [],
          })
        }, txId);

        if (!response.ok) throw new Error(`API returned status ${response.status}`);
        const data = await response.json();

        const dynamicButtons = (data.suggested_shortcuts || []).map((shortcut) => ({ label: shortcut, value: `shortcut_${shortcut}` }));
        addBotMessage(data.reply, dynamicButtons);

        const contextPatch = data.context_patch || {}; const contactInfo = contextPatch.contact_info || {}; const businessContext = contextPatch.business_context || {}; const bookingReq = contextPatch.booking_request || {}; const extracted = data.extracted_data || {};

        const preferredDate = bookingReq.preferred_date || leadData.preferred_date; const preferredTime = bookingReq.preferred_time || leadData.preferred_time;
        let currentBookingStatus = leadData.booking_status || "In Progress"; let requestedAction = leadData.requested_action || "In Progress";

        const explicitBookingIntent = /\b(book|schedule|appointment|meeting|demo|calendar|consultation)\b/i.test(val);
        const hasContactInfoForBooking = Boolean((contactInfo.name || leadData.name) && (contactInfo.email || leadData.email) && (contactInfo.phone || leadData.phone));
        const shouldTriggerDirectBooking = (data.next_action === "SCHEDULE_CONSULTATION" || data.ready_to_book === true || extracted.ready_to_book === true) ||
          (isBookingToolActive && explicitBookingIntent && hasContactInfoForBooking);

        const isCallbackTrigger = !shouldTriggerDirectBooking && (data.next_action === "REQUEST_CALLBACK" || data.flags?.includes("TRIGGER_CALLBACK"));
        if (isCallbackTrigger) { currentBookingStatus = "Callback Requested"; requestedAction = "Callback Requested"; }

        const updatedLeadData = {
          ...leadData, name: contactInfo.name || extracted.name || leadData.name, email: contactInfo.email || extracted.email || leadData.email,
          phone: contactInfo.phone || extracted.phone || leadData.phone, website: businessContext.website || extracted.website || leadData.website,
          business_name: businessContext.industry || extracted.business_name || leadData.business_name, business_type: businessContext.industry || extracted.business_type || leadData.business_type,
          business_problem: businessContext.business_problem || leadData.business_problem, service_requested: businessContext.interested_capability || extracted.service_requested || leadData.service_requested,
          location: extracted.location || leadData.location, visitor_intent: (data.intent_object && data.intent_object.join(", ")) || data.visitor_intent || leadData.visitor_intent || "Unknown",
          urgency_level: data.urgency_level || leadData.urgency_level || "Unknown", preferred_date: preferredDate, preferred_time: preferredTime, booking_status: currentBookingStatus, requested_action: requestedAction,
          conversation_summary: data.factual_summary || data.conversation_summary || leadData.conversation_summary || "In progress...", lead_score: data.lead_temperature || data.lead_score || leadData.lead_score || "Low",
          after_hours_flag: data.after_hours_flag !== undefined ? data.after_hours_flag : leadData.after_hours_flag,
        };

        setLeadData(updatedLeadData);

        const textMentionsUrgent = /\burgent\b/i.test(val);
        const markedHighUrgency = data.urgency_level?.toLowerCase() === "high" || updatedLeadData.urgency_level?.toLowerCase() === "high";

        if (isCallbackTrigger && (textMentionsUrgent || markedHighUrgency) && !hasSentUrgentCallbackAlertRef.current) {
          hasSentUrgentCallbackAlertRef.current = true;
          const timeNotice = preferredTime ? `for ${preferredTime}${preferredDate ? ` on ${preferredDate}` : ""}` : "as soon as possible";
          queueEmailAlert("URGENT Callback Requested! 🚨", `${contactInfo.name || updatedLeadData.name || "A visitor"} requested an urgent callback ${timeNotice}. Phone: ${contactInfo.phone || updatedLeadData.phone || "Not provided"}`, updatedLeadData, "end");
        }

        const hasAllBasicInfo = Boolean(updatedLeadData.name && updatedLeadData.email && updatedLeadData.phone);
        if (hasAllBasicInfo && !hasSentBasicInfoAlertRef.current) {
          hasSentBasicInfoAlertRef.current = true;
          queueEmailAlert("Lead Contact Info Captured 🎯", `${updatedLeadData.name} has provided their name, email, and phone number.`, updatedLeadData, "end");
        }

        if (updatedLeadData.name || updatedLeadData.email || updatedLeadData.phone || updatedLeadData.business_name || updatedLeadData.service_requested) {
          submitLead({ ...updatedLeadData, booking_status: isCallbackTrigger ? "Callback Requested" : (shouldTriggerDirectBooking ? "In Progress - Booking Calendar" : "Lead Captured - Unbooked"), requested_action: isCallbackTrigger ? "Callback Requested" : (shouldTriggerDirectBooking ? "Scheduling Meeting" : "Lead Captured - Unbooked") });
        }

        if ((shouldTriggerDirectBooking || data.next_action === "SCHEDULE_CONSULTATION" || data.ready_to_book === true || extracted.ready_to_book === true) && updatedLeadData.name && updatedLeadData.email) {
          setTimeout(() => {
            if (updatedLeadData.preferred_date && updatedLeadData.preferred_time) {
              const exactTimeText = `${updatedLeadData.preferred_date} at ${updatedLeadData.preferred_time}`;
              const finalLeadData = { ...updatedLeadData, display_time: exactTimeText };
              setLeadData(finalLeadData); triggerConfirmation(finalLeadData);
            } else if (updatedLeadData.preferred_date && !updatedLeadData.preferred_time) {
              setLeadData({ ...updatedLeadData, selected_date: updatedLeadData.preferred_date }); setStep(STEPS.SELECT_TIME);
              addBotMessage(`Great, ${updatedLeadData.preferred_date}. | What time works for you?`, generateTimeSlots().map((t) => ({ label: t, value: `time_${t}` })));
            } else {
              setStep(STEPS.SELECT_DATE); addBotMessage("Please select a date for your meeting:", getNextWeekdays().map((d) => ({ label: d, value: `date_${d}` })));
            }
          }, 1000);
        }
      } catch (error) {
        uiLogger.error("chat", "api_failed", { error, correlation: { correlation_id: txId } });
        addBotMessage("Network error trying to reach AI. Please try again.", []);
      } finally { setIsProcessing(false); }
    }
  }

  async function handleButtonClick(value, label) {
    if (isProcessing) return; stopSpeech();
    uiLogger.info("user_action", "chatbot_button_clicked", { context: { message: `Clicked: ${label}` } });
    
    if (value.startsWith("shortcut_")) { handleTextInput({ preventDefault: () => {} }, label); return; }

    if (!hasTrackedConvo) {
      trackConversationStarted(label, tenantId);
      setHasTrackedConvo(true);
      uiLogger.info("user_action", "chat_started", { context: { message: "First message sent by user via button" } });
    }

    addUserMessage(label);
    switch (step) {
      case STEPS.CHOOSE_PATH:
        if (value === "path_book") { uiLogger.info("lead_capture", "consultation_requested"); setStep(STEPS.SELECT_DATE); addBotMessage("Please select a date for your meeting:", getNextWeekdays().map((d) => ({ label: d, value: `date_${d}` }))); } 
        else if (value === "path_demo") { uiLogger.info("lead_capture", "demo_requested"); showMiniDemo(leadData.business_type || "Other"); }
        break;
      case STEPS.SELECT_DATE:
        if (value.startsWith("date_")) {
          const chosenDate = value.replace("date_", ""); setLeadData((d) => ({ ...d, selected_date: chosenDate })); setStep(STEPS.SELECT_TIME);
          addBotMessage(`Great, ${chosenDate}. | What time works for you?`, generateTimeSlots().map((t) => ({ label: t, value: `time_${t}` })));
        }
        break;
      case STEPS.SELECT_TIME:
        if (value.startsWith("time_")) {
          const chosenTime = value.replace("time_", ""); const exactTimeText = `${leadData.selected_date} at ${chosenTime}`; let isoDateSlot = exactTimeText;
          try { const parsedDate = new Date(`${leadData.selected_date} ${chosenTime}`); if (!isNaN(parsedDate)) isoDateSlot = parsedDate.toISOString(); } catch (e) {}
          const finalLeadData = { ...leadData, booked_slot: isoDateSlot, display_time: exactTimeText };
          setLeadData(finalLeadData); triggerConfirmation(finalLeadData);
        }
        break;
      case STEPS.CONFIRM_BOOKING:
        if (value === "confirm_yes") { setStep(STEPS.FINAL_CTA); setIsProcessing(true); generateAndSendWebhook({ ...leadData, requested_action: "Meeting Booked" }, leadData.display_time); } 
        else if (value === "confirm_no") { setStep(STEPS.AI_CHAT_MODE); addBotMessage("No problem. | Just tell me what needs to be changed (e.g., 'Change my email to xyz@test.com')."); }
        break;
      case STEPS.FINAL_CTA:
        if (value === "close") handleCloseChat(); break;
      default: break;
    }
  }

  function showMiniDemo(businessType) {
    const demo = INDUSTRY_DEMOS[businessType] || INDUSTRY_DEMOS["Other"];
    addBotMessage(`Here's how it works! | Imagine a visitor comes to your site and says: '${demo.scenario}' | Aicyro checks urgency, captures their info instantly, and pushes them to call or book 24/7.`, []);
    setTimeout(() => {
      setMessages((prev) => [...prev, { role: "bot", type: "demo_card", demo, id: Date.now() + Math.random(), instant: true, spoken: true }]);
      setTimeout(() => {
        setStep(STEPS.SELECT_DATE); addBotMessage("Pretty cool, right? | Let's get a free demo booked so you can see it in action on your own site. | What day works best?", getNextWeekdays().map((d) => ({ label: d, value: `date_${d}` })));
      }, 1500);
    }, 1500);
  }

  async function handleTextInput(e, shortcutValue = null) {
    if (e?.preventDefault) e.preventDefault(); const val = shortcutValue || inputValue.trim(); if (!val) return;
    uiLogger.info("user_action", "message_submitted", { context: { message: "Text input submitted" } });
    setInputValue("");
    
    if (agentMode === "voice" && voiceCallRef.current?.dc && voiceCallRef.current.dc.readyState === "open") {
      setVoiceState("PROCESSING"); addUserMessage(val);
      voiceCallRef.current.dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: val }] } }));
      voiceCallRef.current.dc.send(JSON.stringify({ type: "response.create" }));
      return;
    }
    processUserMessage(val);
  }

  return (
    <div className={`fixed ${isInIframe ? "bottom-2 right-2" : "bottom-4 right-4 sm:bottom-6 sm:right-6"} z-[99999] flex flex-col items-end gap-2 font-sans`}>
      <style>{`
        @keyframes acy-avatar-float { 0%, 100% { transform: translateY(0px); } 50% { transform: translateY(-8px); } }
        .animate-avatar-float { animation: acy-avatar-float 3.5s ease-in-out infinite; }
        
        @keyframes acy-robot-peek { 0%, 15% { transform: translate(0, 10px) scale(0.5) rotate(0deg); opacity: 0; } 20%, 35% { transform: translate(-45px, -35px) scale(1.15) rotate(-15deg); opacity: 1; } 40%, 55% { transform: translate(0, 10px) scale(0.5) rotate(0deg); opacity: 0; } 60%, 75% { transform: translate(45px, -35px) scale(1.15) rotate(15deg); opacity: 1; } 80%, 100% { transform: translate(0, 10px) scale(0.5) rotate(0deg); opacity: 0; } }
        .animate-robot-peek { animation: acy-robot-peek 14s cubic-bezier(0.34, 1.56, 0.64, 1) infinite; }
        
        @keyframes acy-avatar-flip { 0% { transform: translateY(0) scale(1.05) rotateY(0deg); } 30% { transform: translateY(-35px) scale(1.25) rotateY(180deg); filter: brightness(1.2); } 60% { transform: translateY(-10px) scale(1.15) rotateY(360deg); } 100% { transform: translateY(0) scale(1.05) rotateY(360deg); } }
        .animate-avatar-flip { animation: acy-avatar-flip 0.8s ease-out forwards; }
        
        @keyframes acy-avatar-thinking { 0%, 100% { transform: translate(0, 0) scale(1.05); } 20% { transform: translate(-2px, 1px) scale(1.05) rotate(-1deg); } 40% { transform: translate(2px, -1px) scale(1.05) rotate(1deg); } 60% { transform: translate(-1px, -2px) scale(1.05); } 80% { transform: translate(2px, 2px) scale(1.05); } }
        .animate-avatar-thinking { animation: acy-avatar-thinking 0.25s linear infinite; }
        
        @keyframes thought-pulse { 0%, 100% { transform: scale(1); opacity: 0.7; } 50% { transform: scale(1.3); opacity: 1; } }
        .thought-dot-1 { animation: thought-pulse 1.5s infinite ease-in-out; }
        .thought-dot-2 { animation: thought-pulse 1.5s infinite ease-in-out 0.3s; }
        .thought-dot-3 { animation: thought-pulse 1.5s infinite ease-in-out 0.6s; }

        @keyframes v-listen { 0% { box-shadow: 0 0 0 0px rgba(16, 185, 129, 0.4); } 70% { box-shadow: 0 0 0 20px rgba(16, 185, 129, 0); } 100% { box-shadow: 0 0 0 0px rgba(16, 185, 129, 0); } }
        .anim-v-listen { border: 2px solid #10b981; animation: v-listen 2s infinite; }

        @keyframes v-process { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .anim-v-process { border: 3px dashed var(--accent-blue); border-right-color: transparent; animation: v-process 1.5s linear infinite; }

        @keyframes v-speak { 0% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.2); opacity: 0.5; } 100% { transform: scale(1); opacity: 1; } }
        .anim-v-speak-1 { border: 2px solid var(--primary); animation: v-speak 1.2s ease-in-out infinite; }
        .anim-v-speak-2 { border: 2px solid var(--primary); animation: v-speak 1.2s ease-in-out infinite 0.3s; }
      `}</style>

      {showPeek && !isOpen && (
        <div className="absolute bottom-[90px] right-2 z-50 animate-acy-spring origin-bottom-right">
          <div className="relative z-10 bg-[var(--card-bg)] border border-[var(--border-color)] rounded-[32px] p-5 w-[280px] shadow-[0_20px_40px_rgba(0,0,0,0.3)] animate-avatar-float">
            <p className="text-[14px] text-[var(--foreground)] font-bold mb-4 leading-snug text-center">
              Want to see how many website leads you might be missing?
            </p>
            <div className="flex justify-center gap-3">
              <button className="text-xs font-bold px-5 py-2.5 rounded-xl bg-[var(--primary)] text-white transition-transform hover:-translate-y-0.5 shadow-[0_0_15px_var(--lead-glow)] outline-none" onClick={openChat}>Show me</button>
              <button className="text-xs font-bold px-5 py-2.5 rounded-xl text-[var(--foreground-muted)] border border-transparent hover:border-[var(--border-color)] outline-none" onClick={() => setShowPeek(false)}>Not now</button>
            </div>
          </div>
          <div className="absolute -bottom-3 right-12 w-5 h-5 bg-[var(--card-bg)] border border-[var(--border-color)] rounded-full shadow-md z-10 thought-dot-1"></div>
          <div className="absolute -bottom-7 right-8 w-3 h-3 bg-[var(--card-bg)] border border-[var(--border-color)] rounded-full shadow-sm z-10 thought-dot-2"></div>
          <div className="absolute -bottom-10 right-6 w-2 h-2 bg-[var(--card-bg)] border border-[var(--border-color)] rounded-full shadow-sm z-10 thought-dot-3"></div>
        </div>
      )}

      {!isOpen && (
        <div className="relative group z-50">
          <div onClick={openChat} onMouseEnter={handleAvatarHover} onMouseLeave={handleAvatarLeave} className={`absolute cursor-pointer pointer-events-auto transition-all duration-500 ease-in-out ${showPeek ? "-top-[64px] right-0 w-20 h-20 animate-avatar-float drop-shadow-[0_10px_20px_rgba(0,0,0,0.3)] z-20 scale-100" : "inset-0 m-auto w-16 h-16 animate-robot-peek group-hover:opacity-0 -z-10 drop-shadow-[0_0_15px_rgba(16,185,129,0.5)] scale-90"} ${avatarEffect}`}>
            <img src={currentAvatarSrc} alt="AI Avatar" className="w-full h-full object-contain filter hover:brightness-110 transition-all" />
          </div>
          <button className={`relative z-10 flex items-center justify-center text-white shadow-[0_4px_20px_var(--lead-glow)] transition-all duration-300 ease-out hover:-translate-y-1 hover:shadow-[0_8px_30px_var(--lead-glow)] h-14 px-6 rounded-full rotate-0 bg-[var(--primary)] outline-none whitespace-nowrap shrink-0`} onClick={openChat} aria-label="Open Chat">
            <div className="flex items-center gap-2.5">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
              <span className="text-[15px] font-bold tracking-tight pr-1 whitespace-nowrap">{botConfig.launcherText}</span>
            </div>
            <span className="absolute top-0 right-0 flex h-3.5 w-3.5 -mt-0.5 -mr-0.5 z-50">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--accent-blue)] opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-[var(--accent-blue)] border-2 border-[var(--background)]"></span>
            </span>
          </button>
        </div>
      )}

      {isOpen && (
        <div className={`fixed inset-0 ${isInIframe ? "sm:inset-auto sm:absolute sm:bottom-0 sm:right-0" : "sm:inset-auto sm:absolute sm:bottom-4 sm:right-0"} w-full sm:w-[380px] z-50 sm:animate-acy-spring sm:origin-bottom-right flex flex-col`}>
          <div onMouseEnter={handleAvatarHover} onMouseLeave={handleAvatarLeave} onClick={handleAvatarClick} className={`hidden sm:block absolute -top-20 right-6 w-24 h-24 z-50 cursor-pointer pointer-events-auto transition-transform hover:scale-110 active:scale-95 drop-shadow-[0_0_20px_var(--lead-glow)] ${avatarEffect ? avatarEffect : isTyping || isProcessing ? "animate-avatar-thinking" : "animate-avatar-float"}`}>
            <img src={currentAvatarSrc} alt="AI Avatar" className="w-full h-full object-contain filter hover:brightness-110 transition-all" />
            {isHovered && speechText && (
              <div className="absolute bottom-full right-1/2 translate-x-1/2 mb-2 bg-[var(--primary)] text-white font-bold text-[11px] px-3 py-1.5 rounded-xl whitespace-nowrap shadow-xl border border-white/10 animate-acy-spring origin-bottom">
                {speechText}
                <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-[var(--primary)]" />
              </div>
            )}
          </div>

          <div className="relative z-10 w-full h-[100dvh] sm:h-[620px] sm:max-h-[85vh] bg-[var(--background)] sm:border border-[var(--border-color)] sm:rounded-[24px] shadow-none sm:shadow-[0_20px_60px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden">
            <div className="px-4 py-3 sm:py-4 flex items-center justify-between shrink-0 bg-[var(--card-bg)] border-b border-[var(--border-color)] pt-[max(env(safe-area-inset-top),16px)] sm:pt-4 z-20">
              <div className="flex items-center gap-3 overflow-hidden">
                <button onClick={handleCloseChat} className="group w-9 h-9 sm:w-10 sm:h-10 flex items-center justify-center text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-all duration-200 hover:scale-110 outline-none rounded-full shrink-0">
                  <svg className="w-4 h-4 sm:w-5 sm:h-5 transition-all duration-200 group-hover:stroke-[3.5px]" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
                </button>
                <div className="relative w-11 h-11 sm:w-14 sm:h-14 rounded-xl bg-[var(--background)] border border-[var(--border-color)] flex items-center justify-center shadow-sm overflow-hidden shrink-0">
                  <img src={currentAvatarSrc} alt="AI Assistant" className="w-full h-full object-contain p-2" />
                  <div className="absolute -bottom-1 -right-1 w-3 h-3 sm:w-3.5 sm:h-3.5 bg-[#10b981] border-[2px] sm:border-[2.5px] border-[var(--card-bg)] rounded-full z-10"></div>
                </div>
                <div className="flex flex-col overflow-hidden">
                  <h3 className="text-[14px] sm:text-[15px] font-bold text-[var(--foreground)] leading-tight tracking-tight truncate">{botConfig.botName}</h3>
                  <span className="text-[11px] sm:text-[12px] font-medium text-[var(--foreground-muted)] mt-0.5 truncate">Security & Lead Intel</span>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button type="button" onClick={() => { if (!isMuted) stopSpeech(); setIsMuted(!isMuted); }} className="w-9 h-9 sm:w-10 sm:h-10 flex items-center justify-center text-[var(--foreground-muted)] hover:text-[var(--foreground)] bg-[var(--background)] rounded-full ring-1 ring-[var(--border-color)] transition-colors outline-none" title={isMuted ? "Unmute Bot Voice" : "Mute Bot Voice"}>
                  {isMuted ? "🔇" : "🔊"}
                </button>
                {(botConfig.voiceChatAgent && botConfig.voiceEnabled) && (
                  <button onClick={handleToggleMode} className="w-9 h-9 sm:w-10 sm:h-10 flex items-center justify-center text-white bg-[var(--primary)] rounded-full shadow-md transition-all hover:scale-105 outline-none" title={agentMode === "text" ? "Switch to Call" : "Switch to Text"}>
                    {agentMode === "text" ? (
                      <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>
                    ) : (
                      <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>
                    )}
                  </button>
                )}
              </div>
            </div>

            {voiceState === "PERMISSION_DENIED" && (botConfig.voiceChatAgent && botConfig.voiceEnabled) && (
              <div role="alert" className="w-full bg-[var(--primary)] text-[var(--card-bg)] px-4 py-3 text-[13px] flex justify-between items-center shadow-sm shrink-0 z-20">
                <span className="font-bold">Microphone access denied.</span>
                <button onClick={handleStartVoiceCall} className="bg-[var(--card-bg)] text-[var(--primary)] px-3 py-1.5 rounded-lg font-bold text-xs hover:scale-105 outline-none">Request Again</button>
              </div>
            )}

            {/* 🔥 WebRTC Camera UI Overlay */}
            {botConfig.photoUploads && showWebcam && (
              <div className="absolute inset-0 z-50 bg-black flex flex-col items-center justify-center animate-acy-fade">
                <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover" />
                
                <div className="absolute bottom-8 left-0 right-0 flex justify-center items-center gap-8 px-6 pb-[env(safe-area-inset-bottom)]">
                  <button onClick={closeWebcam} className="px-5 py-3.5 bg-white/20 text-white rounded-full backdrop-blur-md font-bold text-sm hover:bg-white/30 transition-colors">
                    Cancel
                  </button>
                  <button onClick={capturePhotoFromWebcam} className="w-16 h-16 bg-white border-[6px] border-[var(--primary)] rounded-full shadow-[0_0_20px_var(--primary)] hover:scale-105 active:scale-95 transition-all">
                  </button>
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto overscroll-contain acy-scroll relative">
              {agentMode === "text" || (!botConfig.voiceChatAgent || !botConfig.voiceEnabled) ? (
                <div className="px-4 py-5 flex flex-col gap-5 bg-[var(--background)] min-h-full">
                  {messages.map((msg) => {
                    if (msg.type === "demo_card") {
                      return (
                        <div key={msg.id} className="relative w-[85%] self-start bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-4 shadow-sm animate-acy-fade">
                          <div className="flex items-center gap-2 mb-3 pb-3 border-b border-[var(--border-color)]">
                            <div className="w-6 h-6 rounded-full bg-green-500/20 flex items-center justify-center">
                              <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                            </div>
                            <span className="text-xs font-bold text-[var(--foreground)] uppercase tracking-wider">Intel Captured</span>
                          </div>
                          <div className="space-y-2.5">
                            {[["Intent", msg.demo.service], ["Name", "Alex M."], ["Phone", "(555) 019-2834"]].map(([k, v]) => (
                              <div key={k} className="flex justify-between items-center text-[13px]">
                                <span className="text-[var(--foreground-muted)]">{k}</span><span className="font-semibold text-[var(--foreground)]">{v}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    }
                    if (msg.role === "bot") {
                      return <TypewriterBubble key={msg.id} msg={msg} onButtonClick={handleButtonClick} scrollRef={messagesEndRef} isProcessing={isProcessing} onSpeak={speakText} isMuted={isMuted} agentMode={agentMode} setAnimatingIds={setAnimatingIds} />;
                    }
                    return (
                      <div key={msg.id} className="flex flex-col gap-1.5 max-w-[85%] self-end animate-acy-fade">
                        <div className="px-4 py-3 text-[14px] leading-relaxed whitespace-pre-wrap bg-[var(--primary)] text-white rounded-2xl rounded-br-sm shadow-sm">
                          {msg.imageUrl && (
                            <img
                              src={msg.imageUrl}
                              alt="Uploaded problem"
                              className="w-full max-h-48 object-cover rounded-xl mb-2 border border-white/20"
                            />
                          )}
                          {msg.text}
                        </div>
                      </div>
                    );
                  })}
                  {isTyping && (
                    <div className="self-start bg-[var(--card-bg)] rounded-2xl rounded-bl-sm px-4 py-3.5 flex items-center gap-1.5 border border-[var(--border-color)] animate-acy-fade">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--primary)] animate-bounce"></span>
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--primary)] animate-bounce" style={{ animationDelay: "0.15s" }}></span>
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--primary)] animate-bounce" style={{ animationDelay: "0.3s" }}></span>
                    </div>
                  )}
                  <div ref={messagesEndRef} className="h-2 shrink-0" />
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center bg-[var(--background)] p-6 min-h-full pb-[calc(env(safe-area-inset-bottom,0px)+24px)]">
                  <div className={`relative w-36 h-36 rounded-full flex items-center justify-center mb-8 bg-[var(--card-bg)] border border-[var(--border-color)]`} aria-hidden="true">
                    <img src={currentAvatarSrc} alt="Voice Agent" className="w-24 h-24 object-contain z-10 drop-shadow-md" />
                    {voiceState === "LISTENING" && <div className="absolute inset-0 rounded-full anim-v-listen"></div>}
                    {voiceState === "PROCESSING" && <div className="absolute inset-[-10px] rounded-full anim-v-process opacity-70"></div>}
                    {voiceState === "SPEAKING" && (<><div className="absolute inset-[-15px] rounded-full anim-v-speak-1"></div><div className="absolute inset-[-30px] rounded-full anim-v-speak-2"></div></>)}
                    {voiceState === "INTERRUPTED" && <div className="absolute inset-0 rounded-full border-4 border-yellow-500 opacity-60"></div>}
                    {voiceState === "ERROR" && <div className="absolute inset-0 rounded-full border-4 border-red-500 opacity-60"></div>}
                  </div>
                  <h3 className="text-xl font-bold text-[var(--foreground)] mb-2 text-center" aria-live="polite">
                    {voiceState === "IDLE" && "Ready to speak?"}
                    {voiceState === "REQUESTING_PERMISSION" && "Allow Microphone..."}
                    {voiceState === "PERMISSION_DENIED" && "Microphone Denied"}
                    {voiceState === "LISTENING" && "Listening..."}
                    {voiceState === "PROCESSING" && "Thinking..."}
                    {voiceState === "SPEAKING" && "Agent Speaking..."}
                    {voiceState === "INTERRUPTED" && "Listening..."}
                    {voiceState === "ERROR" && "Connection Lost"}
                  </h3>
                  <p className="text-[13px] text-[var(--foreground-muted)] text-center mb-10 max-w-[250px]">
                    {voiceState === "IDLE" ? "Tap below to start a live voice conversation with our Close Desk." : voiceState === "PERMISSION_DENIED" ? "Microphone access is required to use voice. Please check your browser settings or continue using text below." : voiceState === "ERROR" ? "The secure backend connection was dropped. Please try again or continue using text below." : "Speak naturally. You can also use the text box below anytime."}
                  </p>
                  {voiceState === "ERROR" && (
                    <button onClick={handleStartVoiceCall} className="bg-red-500 text-white px-8 py-3.5 rounded-full font-bold shadow-[0_0_20px_rgba(239,68,68,0.3)] hover:scale-105 outline-none">
                      <svg className="w-5 h-5 inline-block mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                      Reconnect
                    </button>
                  )}
                  {(voiceState === "IDLE" || voiceState === "PERMISSION_DENIED") && (
                    <button onClick={handleStartVoiceCall} className="bg-[var(--primary)] text-white px-8 py-3.5 rounded-full font-bold shadow-[0_0_20px_var(--lead-glow)] hover:scale-105 outline-none">
                      <svg className="w-5 h-5 inline-block mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" /></svg>
                      Start Voice Call
                    </button>
                  )}
                  {["LISTENING", "PROCESSING", "SPEAKING", "INTERRUPTED", "REQUESTING_PERMISSION"].includes(voiceState) && (
                    <button onClick={handleEndVoiceCall} className="bg-red-500 text-white px-8 py-3.5 rounded-full font-bold shadow-[0_0_20px_rgba(239,68,68,0.3)] hover:scale-105 outline-none">
                      <svg className="w-5 h-5 inline-block mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M16 8l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M5 3a2 2 0 00-2 2v1c0 8.284 6.716 15 15 15h1a2 2 0 002-2v-3.28a1 1 0 00-.684-.948l-4.493-1.498a1 1 0 00-1.21.502l-1.13 2.257a11.042 11.042 0 01-5.516-5.516l2.257-1.13a1 1 0 00.502-1.21L9.284 3.684A1 1 0 008.336 3H5z" /></svg>
                      End Call
                    </button>
                  )}
                  <div className="w-full text-center mt-auto flex items-center justify-center gap-1.5 opacity-60">
                    <span className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">Powered by Aicyro</span>
                  </div>
                </div>
              )}
            </div>

            <div className="p-3 pb-[calc(env(safe-area-inset-bottom,0px)+12px)] sm:pb-3 bg-[var(--background)] border-t border-[var(--border-color)] shrink-0 z-20">
              {[STEPS.AI_CHAT_MODE].includes(step) ? (
                <>
                  {botConfig.photoUploads && (
                    <input type="file" ref={fileGalleryInputRef} accept="image/*" className="hidden" onChange={handleGallerySelected} />
                  )}

                  <form className="relative flex items-center gap-2 bg-[var(--card-bg)] border border-[var(--border-color)] rounded-full pl-3 pr-1.5 py-1.5 focus-within:border-[var(--primary)] transition-all" onSubmit={handleTextInput}>
                    
                    {/* Wrapped the camera button in the imagePickerRef */}
                    {botConfig.photoUploads && (
                      <div ref={imagePickerRef} className="relative">
                        <button
                          type="button"
                          onClick={() => setShowImagePicker(!showImagePicker)}
                          disabled={isUploadingImage || isProcessing}
                          className="p-1.5 rounded-full text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background)] transition-all outline-none"
                          title="Send Photo of the Issue"
                        >
                          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                          </svg>
                        </button>

                        {/* Moved the popup slightly inside the ref container so it clicks-outside cleanly */}
                        {showImagePicker && (
                          <div className="absolute bottom-12 left-0 bg-[var(--card-bg)] border border-[var(--border-color)] shadow-2xl rounded-2xl p-2 flex flex-col gap-1 z-50 min-w-[200px] animate-acy-spring origin-bottom-left">
                            <div
                              onClick={(e) => { e.stopPropagation(); openWebcam(); }}
                              className="flex items-center gap-2.5 px-3 py-2 text-xs font-semibold text-[var(--foreground)] hover:bg-[var(--background)] rounded-xl transition-colors text-left w-full cursor-pointer"
                            >
                              <span>📸</span> Take a Photo
                            </div>
                            <div
                              onClick={(e) => { e.stopPropagation(); setShowImagePicker(false); fileGalleryInputRef.current?.click(); }}
                              className="flex items-center gap-2.5 px-3 py-2 text-xs font-semibold text-[var(--foreground)] hover:bg-[var(--background)] rounded-xl transition-colors text-left w-full cursor-pointer"
                            >
                              <span>🖼</span> Upload from Gallery
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    <button type="button" onClick={toggleListening} className={`p-1.5 rounded-full transition-all outline-none ${isListening ? "bg-red-500 text-white animate-pulse" : "text-[var(--foreground-muted)] hover:text-[var(--foreground)]"}`} title={isListening ? "Stop listening" : "Speak to type"}>
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 016 0v6a3 3 0 01-3 3z" /></svg>
                    </button>

                    <input
                      ref={inputRef}
                      disabled={agentMode === "text" && isUploadingImage}
                      onClick={handleInputInteraction}
                      onFocus={handleInputInteraction}
                      className="flex-1 bg-transparent text-[var(--foreground)] text-[14px] outline-none placeholder:text-[var(--foreground-muted)] disabled:opacity-50 py-1.5"
                      value={inputValue}
                      onChange={(e) => setInputValue(e.target.value)}
                      placeholder={isUploadingImage ? "Uploading & diagnosing..." : isListening ? "Listening..." : "Type, snap photo, or speak..."}
                    />

                    <button 
                      type="submit" 
                      disabled={!inputValue.trim() || (agentMode === "text" && (isProcessing || isTyping || animatingIds.length > 0))} 
                      className="w-9 h-9 rounded-full flex items-center justify-center bg-[var(--primary)] text-white transition-all disabled:opacity-50 disabled:scale-100 hover:scale-105 outline-none"
                    >
                      <svg className="w-4 h-4 ml-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" /></svg>
                    </button>
                  </form>
                </>
              ) : (
                <div className="w-full text-center py-2 flex items-center justify-center gap-1.5">
                  <svg className="w-3.5 h-3.5 text-[var(--foreground-muted)]" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2L2 22h20L12 2zm0 4.5l6.5 13.5h-13L12 6.5z" /></svg>
                  <span className="text-[11px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest">Powered by Aicyro</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
} 