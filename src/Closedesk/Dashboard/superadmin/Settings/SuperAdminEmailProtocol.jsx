// src/Closedesk/Dashboard/superadmin/Settings/SuperAdminEmailProtocol.jsx
"use client";

import { useState, useEffect, useRef } from "react";
import { db } from "../../../../lib/firebase";
import { ref, onValue, update } from "firebase/database";
import { createPulseLogger } from "../../../../lib/loggerPresets";

const pulseLogger = createPulseLogger("SuperAdminEmailProtocol");

const InfoIcon = ({ text }) => (
  <div className="relative group inline-flex items-center ml-2 align-middle">
    <span className="text-[14px] font-bold italic font-serif text-[var(--primary,#8B5CF6)] opacity-70 group-hover:opacity-100 transition-opacity cursor-help">i</span>
    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-[220px] p-3.5 bg-white border border-gray-100 text-[12px] text-gray-800 font-medium rounded-xl shadow-[0_10px_40px_rgba(0,0,0,0.08)] z-[100] normal-case tracking-normal text-left leading-relaxed opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity duration-200">
      {text}
      <div className="absolute top-full left-1/2 -translate-x-1/2 border-[6px] border-transparent border-t-white"></div>
    </div>
  </div>
);

// 🔥 Comprehensive Provider List
const PROVIDER_OPTIONS = [
  { id: "google_oauth", label: "Google / G Suite Workspace" },
  { id: "microsoft", label: "Microsoft 365 / Outlook" },
  { id: "hostinger", label: "Hostinger Mail" },
  { id: "namecheap", label: "Namecheap (PrivateEmail)" },
  { id: "cpanel", label: "Standard cPanel (Bluehost, SiteGround, HostGator, A2)" },
  { id: "titan", label: "Titan Email" },
  { id: "dreamhost", label: "DreamHost" },
  { id: "inmotion", label: "InMotion Hosting" },
  { id: "rackspace", label: "Rackspace Email" },
  { id: "yandex", label: "Yandex 360 / Mail" },
  { id: "custom_smtp", label: "Custom SMTP Server" },
];

// 🔥 Pre-configured hidden host/port combinations
const STATIC_SMTP_CONFIGS = {
  hostinger: { host: "smtp.hostinger.com", port: "465" },
  namecheap: { host: "mail.privateemail.com", port: "465" },
  titan: { host: "smtp.titan.email", port: "465" },
  dreamhost: { host: "smtp.dreamhost.com", port: "465" },
  rackspace: { host: "secure.emailsrvr.com", port: "465" },
  yandex: { host: "smtp.yandex.com", port: "465" }
};

export default function SuperAdminEmailProtocol() {
  const [emailConfig, setEmailConfig] = useState({
    senderName: "Aicyro Pulse",
    smtpEmail: "",
    smtpPassword: "",
    provider: "google_oauth", 
    smtpService: "google_oauth", // Used exclusively for UI dropdown state
    smtpHost: "",
    smtpPort: "465",
    refreshToken: "",
  });

  const [savedProvider, setSavedProvider] = useState("");
  const [savedService, setSavedService] = useState("");
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);
  const popupRef = useRef(null);
  
  const [isSavingEmail, setIsSavingEmail] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [toast, setToast] = useState({ show: false, message: "", type: "success" });

  const showToast = (message, type = "success") => {
    setToast({ show: true, message, type });
    setTimeout(() => setToast({ show: false, message: "", type: "success" }), 3500);
  };

  useEffect(() => {
    const configRef = ref(db, "settings/email_config");
    const unsubConfig = onValue(configRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val();
        
        // Derive the UI service state if not explicitly saved
        let derivedService = data.smtpService;
        if (!derivedService) {
          if (data.provider === "custom") derivedService = "custom_smtp";
          else derivedService = data.provider;
        }

        setEmailConfig((prev) => ({ ...prev, ...data, smtpService: derivedService }));
        setSavedProvider(data.provider || "");
        setSavedService(derivedService || "");
      }
    });

        const handleMessage = (event) => {
      // 🚨 SECURITY: Strict origin and source window verification
      if (typeof window !== "undefined" && event.origin !== window.location.origin) {
        return;
      }
      if (popupRef.current && event.source && event.source !== popupRef.current) {
        return;
      }

      const data = event.data;
      if (data?.type === "CLOSEDESK_OAUTH_STATUS") {
        if (data.status === "connected") {
          showToast("Account connected successfully!");
        } else {
          showToast(data.error || "Account connection failed.", "error");
        }
      } else if (data?.type === "OAUTH_SUCCESS") {
        showToast("Account connected successfully!");
      } else if (data?.type === "OAUTH_ERROR") {
        showToast("Account connection failed or was cancelled.", "error");
      }
    };
    window.addEventListener("message", handleMessage);

    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);

    return () => {
      unsubConfig();
      window.removeEventListener("message", handleMessage);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const handleProviderSelect = (serviceId) => {
    let updates = { smtpService: serviceId };
    
    if (serviceId === "google_oauth" || serviceId === "microsoft") {
      updates.provider = serviceId;
    } else {
      // Must be saved as "custom" so the Cloud Function processes it correctly
      updates.provider = "custom";
      if (STATIC_SMTP_CONFIGS[serviceId]) {
        updates.smtpHost = STATIC_SMTP_CONFIGS[serviceId].host;
        updates.smtpPort = STATIC_SMTP_CONFIGS[serviceId].port;
      }
    }
    
    setEmailConfig(prev => ({ ...prev, ...updates }));
    setIsDropdownOpen(false);
  };

  const handleSaveEmailConfig = async () => {
    setIsSavingEmail(true);
    pulseLogger.info("settings_update", "sender_email_config_updated");
    
    let finalConfig = { ...emailConfig };
    
    // Hard-enforce the correct host details right before saving
    if (STATIC_SMTP_CONFIGS[finalConfig.smtpService]) {
      finalConfig.smtpHost = STATIC_SMTP_CONFIGS[finalConfig.smtpService].host;
      finalConfig.smtpPort = STATIC_SMTP_CONFIGS[finalConfig.smtpService].port;
    }

    try {
      const token = localStorage.getItem("cd_session_token");
      const res = await fetch("/api/superadmin/settings", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-requested-with": "XMLHttpRequest",
          ...(token ? { "x-cd-session": token } : {}),
        },
        credentials: "include",
        body: JSON.stringify({
          section: "email_config",
          payload: finalConfig,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to save email settings");
      }

      showToast("Sender configuration updated!");
    } catch (error) {
      pulseLogger.error("settings_update", "sender_email_config_failed", { error });
      showToast("Failed to save sender configuration: " + error.message, "error");
    }
    setIsSavingEmail(false);
  };

  const confirmDisconnectAccount = async () => {
    setShowDisconnectConfirm(false);
    setIsDisconnecting(true);
    try {
      const token = localStorage.getItem("cd_session_token");
      const disconnectPayload = {
        refreshToken: null,
        clientId: null,
        clientSecret: null,
        smtpEmail: "",
        connectedAt: null,
        provider: "custom",
        smtpService: "custom_smtp",
      };
      const res = await fetch("/api/superadmin/settings", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-requested-with": "XMLHttpRequest",
          ...(token ? { "x-cd-session": token } : {}),
        },
        credentials: "include",
        body: JSON.stringify({
          section: "email_config",
          payload: disconnectPayload,
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to disconnect account");
      }

      setEmailConfig((prev) => ({
        ...prev,
        refreshToken: "",
        clientId: "",
        clientSecret: "",
        smtpEmail: "",
        provider: "custom",
        smtpService: "custom_smtp",
      }));
      setSavedProvider("");
      setSavedService("");
      pulseLogger.info("settings_update", "account_disconnected");
      showToast("Account successfully disconnected.");
    } catch (error) {
      pulseLogger.error("settings_update", "account_disconnect_failed", { error });
      showToast("Failed to disconnect account.", "error");
    }
    setIsDisconnecting(false);
  };

  const openOAuthPopup = (provider) => {
    const width = 550;
    const height = 700;
    const left = window.screen.width / 2 - width / 2;
    const top = window.screen.height / 2 - height / 2;
    popupRef.current = window.open(
      `/api/auth/${provider}/login`,
      "OAuthLoginPopup",
      `width=${width},height=${height},top=${top},left=${left}`
    );
  };

  // UI rendering flags
  const isGoogleConnected = savedProvider === "google_oauth" && !!emailConfig.refreshToken;
  const isMicrosoftConnected = savedProvider === "microsoft" && !!emailConfig.refreshToken;
  const isGoogleView = emailConfig.smtpService === "google_oauth";
  const isMicrosoftView = emailConfig.smtpService === "microsoft";
  const isStaticSmtpView = Object.keys(STATIC_SMTP_CONFIGS).includes(emailConfig.smtpService);
  const isDynamicSmtpView = ["custom_smtp", "cpanel", "inmotion"].includes(emailConfig.smtpService);
  
  const currentProviderLabel = PROVIDER_OPTIONS.find(p => p.id === emailConfig.smtpService)?.label || "Select Provider";
  const activeProviderName = PROVIDER_OPTIONS.find(p => p.id === savedService)?.label || "";

  return (
    <div className="max-w-[800px] mx-auto p-4 sm:p-8 lg:p-12 animate-acy-fade font-sans bg-[#F9FAFB] min-h-screen relative">
      <div className="bg-white rounded-[24px] p-6 sm:p-8 shadow-[0_2px_20px_rgba(0,0,0,0.03)] border border-gray-100 relative">
        <div className="flex items-center gap-4 mb-8">
          <div className="w-12 h-12 rounded-xl bg-[var(--primary-light,#F3E8FF)] text-[var(--primary,#9333EA)] flex items-center justify-center shrink-0">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
          </div>
          <div>
            <h2 className="text-[22px] font-black text-gray-900 tracking-tight">Outgoing Email Protocol</h2>
            <p className="text-[13px] text-gray-500 font-medium mt-0.5">The engine used to dispatch automated confirmation emails.</p>
          </div>
        </div>
        
        {/* Sleek Custom Dropdown Menu */}
        <div className="mb-8 relative z-50" ref={dropdownRef}>
          <label className="text-[11px] font-bold uppercase tracking-widest text-gray-600 block mb-2">Email Service Provider</label>
          <button 
            onClick={() => setIsDropdownOpen(!isDropdownOpen)}
            className="w-full bg-[#F3F4F6] rounded-xl px-4 py-3.5 text-sm text-gray-900 font-bold focus:outline-none focus:ring-2 focus:ring-[var(--primary,#8B5CF6)] focus:ring-opacity-30 transition-all border-none flex justify-between items-center"
          >
            <span>{currentProviderLabel}</span>
            <svg className={`w-4 h-4 text-gray-500 transition-transform ${isDropdownOpen ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          
          {isDropdownOpen && (
            <div className="absolute top-full mt-2 w-full bg-white border border-gray-100 rounded-xl shadow-[0_10px_40px_rgba(0,0,0,0.08)] overflow-hidden z-[100] max-h-64 overflow-y-auto">
              {PROVIDER_OPTIONS.map((provider) => (
                <button
                  key={provider.id}
                  onClick={() => handleProviderSelect(provider.id)}
                  className={`w-full text-left px-4 py-3 text-sm font-medium transition-colors ${emailConfig.smtpService === provider.id ? "bg-[var(--primary-light,#F3E8FF)] text-[var(--primary,#9333EA)]" : "text-gray-700 hover:bg-gray-50 border-b border-gray-50 last:border-0"}`}
                >
                  {provider.label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-6 relative z-10">
          <div>
            <div className="flex items-center mb-2">
              <label className="text-[11px] font-bold uppercase tracking-widest text-gray-600">Sender Name</label>
              <InfoIcon text="The name leads see in their inbox (e.g., 'Aicyro Support')." />
            </div>
            <input type="text" value={emailConfig.senderName} onChange={(e) => setEmailConfig({...emailConfig, senderName: e.target.value})} className="w-full bg-[#F3F4F6] rounded-xl px-4 py-3.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--primary,#8B5CF6)] focus:ring-opacity-30 transition-all border-none" placeholder="e.g., Aicyro Support" />
          </div>

          {isGoogleView && (
            <div className="p-6 bg-[#F8FAFC] border border-gray-100 rounded-2xl space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-gray-900">Google Account Connection</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {isGoogleConnected ? `Connected as ${emailConfig.smtpEmail}` : "Connect your Google account securely with 1 click."}
                  </p>
                </div>
                {isGoogleConnected && (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold bg-green-50 text-green-600 border border-green-200">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>Connected
                  </span>
                )}
              </div>
              
              <div className="flex flex-col sm:flex-row gap-3">
                {!isGoogleConnected && (
                  <div className="flex-1">
                    {savedService && savedService !== "google_oauth" && (
                      <p className="text-[11px] font-medium text-amber-600 bg-amber-50 p-3 rounded-xl border border-amber-100 mb-3 leading-relaxed">
                        <strong>Safe Switch:</strong> You are currently using {activeProviderName}. If this Google login is cancelled, your {activeProviderName} connection remains intact.
                      </p>
                    )}
                    <button onClick={() => openOAuthPopup('google')} className="w-full inline-flex items-center justify-center gap-3 py-3.5 px-4 bg-white hover:bg-gray-50 text-gray-800 text-xs font-bold uppercase tracking-wider rounded-xl transition-all shadow-sm border border-gray-200">
                      <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
                      {savedService && savedService !== "google_oauth" ? "Switch to Google" : "Sign in with Google"}
                    </button>
                  </div>
                )}
                
                {isGoogleConnected && (
                  <button onClick={() => setShowDisconnectConfirm(true)} disabled={isDisconnecting} className="w-full inline-flex items-center justify-center py-3.5 px-6 bg-red-50 hover:bg-red-100 text-red-600 border border-red-100 text-xs font-bold uppercase tracking-wider rounded-xl transition-all shadow-sm disabled:opacity-50">
                    {isDisconnecting ? "Disconnecting..." : "Disconnect"}
                  </button>
                )}
              </div>
            </div>
          )}

          {isMicrosoftView && (
            <div className="p-6 bg-[#F8FAFC] border border-gray-100 rounded-2xl space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-gray-900">Microsoft Account Connection</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {isMicrosoftConnected ? `Connected as ${emailConfig.smtpEmail}` : "Connect your Hotmail or Outlook account securely with 1 click."}
                  </p>
                </div>
                {isMicrosoftConnected && (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold bg-green-50 text-green-600 border border-green-200">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>Connected
                  </span>
                )}
              </div>
              
              <div className="flex flex-col sm:flex-row gap-3">
                {!isMicrosoftConnected && (
                  <div className="flex-1">
                    {savedService && savedService !== "microsoft" && (
                      <p className="text-[11px] font-medium text-amber-600 bg-amber-50 p-3 rounded-xl border border-amber-100 mb-3 leading-relaxed">
                        <strong>Safe Switch:</strong> You are currently using {activeProviderName}. If this Microsoft login is cancelled, your {activeProviderName} connection remains intact.
                      </p>
                    )}
                    <button onClick={() => openOAuthPopup('microsoft')} className="w-full inline-flex items-center justify-center gap-3 py-3.5 px-4 bg-[#2F2F2F] hover:bg-black text-white text-xs font-bold uppercase tracking-wider rounded-xl transition-all shadow-sm">
                      <svg className="w-4 h-4 shrink-0" viewBox="0 0 21 21"><path fill="#f25022" d="M1 1h9v9H1z"/><path fill="#00a4ef" d="M1 11h9v9H1z"/><path fill="#7fba00" d="M11 1h9v9h-9z"/><path fill="#ffb900" d="M11 11h9v9h-9z"/></svg>
                      {savedService && savedService !== "microsoft" ? "Switch to Microsoft" : "Sign in with Microsoft"}
                    </button>
                  </div>
                )}

                {isMicrosoftConnected && (
                  <button onClick={() => setShowDisconnectConfirm(true)} disabled={isDisconnecting} className="w-full inline-flex items-center justify-center py-3.5 px-6 bg-red-50 hover:bg-red-100 text-red-600 border border-red-100 text-xs font-bold uppercase tracking-wider rounded-xl transition-all shadow-sm disabled:opacity-50">
                    {isDisconnecting ? "Disconnecting..." : "Disconnect"}
                  </button>
                )}
              </div>
            </div>
          )}

          {isStaticSmtpView && (
            <div className="space-y-6">
              <div>
                <label className="text-[11px] font-bold uppercase tracking-widest text-gray-600 block mb-2">{currentProviderLabel} Address</label>
                <input type="email" value={emailConfig.smtpEmail} onChange={(e) => setEmailConfig({...emailConfig, smtpEmail: e.target.value})} className="w-full bg-[#F3F4F6] rounded-xl px-4 py-3.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--primary,#8B5CF6)] focus:ring-opacity-30 transition-all border-none" placeholder="contact@yourdomain.com" />
              </div>
              <div>
                <label className="text-[11px] font-bold uppercase tracking-widest text-gray-600 block mb-2">Mailbox Password</label>
                <input type="password" value={emailConfig.smtpPassword} onChange={(e) => setEmailConfig({...emailConfig, smtpPassword: e.target.value})} className="w-full bg-[#F3F4F6] rounded-xl px-4 py-3.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--primary,#8B5CF6)] focus:ring-opacity-30 transition-all font-mono border-none" placeholder="••••••••••••••••" />
              </div>
            </div>
          )}

          {isDynamicSmtpView && (
            <div className="space-y-6">
              <div>
                <div className="flex items-center mb-2">
                  <label className="text-[11px] font-bold uppercase tracking-widest text-gray-600">Email Address</label>
                </div>
                <input type="email" value={emailConfig.smtpEmail} onChange={(e) => setEmailConfig({...emailConfig, smtpEmail: e.target.value})} className="w-full bg-[#F3F4F6] rounded-xl px-4 py-3.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--primary,#8B5CF6)] focus:ring-opacity-30 transition-all border-none" placeholder="hello@company.com" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-widest text-gray-600 block mb-2">SMTP Host</label>
                  <input type="text" value={emailConfig.smtpHost} onChange={(e) => setEmailConfig({...emailConfig, smtpHost: e.target.value})} className="w-full bg-[#F3F4F6] rounded-xl px-4 py-3.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--primary,#8B5CF6)] focus:ring-opacity-30 transition-all font-mono border-none" placeholder={emailConfig.smtpService === "cpanel" ? "mail.yourdomain.com" : "smtp.mailserver.com"} />
                </div>
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-widest text-gray-600 block mb-2">SMTP Port</label>
                  <input type="text" value={emailConfig.smtpPort} onChange={(e) => setEmailConfig({...emailConfig, smtpPort: e.target.value})} className="w-full bg-[#F3F4F6] rounded-xl px-4 py-3.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--primary,#8B5CF6)] focus:ring-opacity-30 transition-all font-mono border-none" placeholder="465 or 587" />
                </div>
              </div>
              <div>
                <label className="text-[11px] font-bold uppercase tracking-widest text-gray-600 block mb-2">SMTP Password</label>
                <input type="password" value={emailConfig.smtpPassword} onChange={(e) => setEmailConfig({...emailConfig, smtpPassword: e.target.value})} className="w-full bg-[#F3F4F6] rounded-xl px-4 py-3.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--primary,#8B5CF6)] focus:ring-opacity-30 transition-all font-mono border-none" placeholder="••••••••••••••••" />
              </div>
            </div>
          )}
        </div>
        
        {(isStaticSmtpView || isDynamicSmtpView) && (
          <div className="mt-10 pt-6 border-t border-gray-100 flex justify-end relative z-10">
            <button onClick={handleSaveEmailConfig} disabled={isSavingEmail} className="px-8 py-3.5 bg-[var(--primary,#8B5CF6)] text-white text-xs font-black uppercase tracking-widest rounded-xl hover:opacity-90 transition-all duration-300 disabled:opacity-50">
              {isSavingEmail ? "Deploying..." : "Deploy Config"}
            </button>
          </div>
        )}
      </div>

      <div className={`fixed bottom-8 right-8 z-[100] transition-all duration-500 cubic-bezier(0.4, 0, 0.2, 1) ${toast.show ? "translate-y-0 opacity-100 scale-100" : "translate-y-8 opacity-0 scale-95 pointer-events-none"}`}>
        <div className="flex items-center gap-4 py-3 px-5 rounded-2xl bg-white border border-gray-100 shadow-[0_20px_40px_rgba(0,0,0,0.08)]">
          <div className={`w-2 h-2 rounded-full ${toast.type === "success" ? "bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]" : "bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]"}`}></div>
          <p className="text-[13px] font-bold tracking-tight text-gray-900 pr-2">{toast.message}</p>
        </div>
      </div>

      {showDisconnectConfirm && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-gray-900/40 backdrop-blur-sm animate-acy-fade">
          <div className="bg-white rounded-[24px] shadow-[0_20px_60px_rgba(0,0,0,0.1)] p-6 sm:p-8 max-w-[420px] w-full animate-acy-fade border border-gray-100">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-12 h-12 rounded-full bg-red-50 text-red-500 flex items-center justify-center shrink-0">
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
              </div>
              <h3 className="text-[18px] font-black text-gray-900 tracking-tight">Disconnect Account?</h3>
            </div>
            <p className="text-[13px] font-medium text-gray-500 mb-8 pl-16 leading-relaxed">
              Lead alerts will stop sending automatically until you reconnect a valid email provider. Are you sure you want to proceed?
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowDisconnectConfirm(false)} className="px-5 py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-800 text-[11px] font-bold uppercase tracking-wider rounded-xl transition-all">Cancel</button>
              <button onClick={confirmDisconnectAccount} className="px-5 py-2.5 bg-red-500 hover:bg-red-600 text-white text-[11px] font-bold uppercase tracking-wider rounded-xl transition-all shadow-[0_4px_10px_rgba(239,68,68,0.2)]">Yes, Disconnect</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}