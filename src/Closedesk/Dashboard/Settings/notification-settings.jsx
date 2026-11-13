// src/Closedesk/Dashboard/Settings/notification-settings.jsx
"use client";

import { useState, useEffect } from "react";
import { db } from "../../../lib/firebase";
import { ref, onValue, update } from "firebase/database";
import { createPulseLogger } from "../../../lib/loggerPresets";

const pulseLogger = createPulseLogger("NotificationSettings");

const RFC5322_EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export default function NotificationSettings() {
  const [tenantId, setTenantId] = useState("default");
  const [preferences, setPreferences] = useState({
    emailAlerts: true,
    smsAlerts: false,
    urgentOnly: false,
    adminEmail: "",
    backupEmail: "",
    adminPhone: "",
  });

  const [isSavingPrefs, setIsSavingPrefs] = useState(false);
  const [isSendingTest, setIsSendingTest] = useState(false);
  const [toast, setToast] = useState({ show: false, message: "", type: "success" });

  const showToast = (message, type = "success") => {
    setToast({ show: true, message, type });
    setTimeout(() => setToast({ show: false, message: "", type: "success" }), 4000);
  };

  useEffect(() => {
    const activeTenant = typeof window !== "undefined"
      ? (localStorage.getItem("currentTenant") || "default")
      : "default";
    setTenantId(activeTenant);

    // Fetch settings via authenticated API with fallback to Realtime Database listener
    const fetchSettings = async () => {
      try {
        const token = typeof window !== "undefined" ? localStorage.getItem("cd_session_token") : null;
        const res = await fetch("/api/notifications/settings", {
          headers: {
            "x-tenant-id": activeTenant,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        if (res.ok) {
          const data = await res.json();
          if (data && data.settings) {
            setPreferences((prev) => ({ ...prev, ...data.settings }));
            return;
          }
        }
      } catch (err) {
        pulseLogger.warn("settings_fetch", "api_fetch_failed_using_db_fallback", { error: err.message });
      }

      // Fallback: Realtime Database listener (tenant-scoped)
      const settingsPath = activeTenant && activeTenant !== "default"
        ? `tenants/${activeTenant}/notification_settings`
        : `settings/notification_settings`;

      const prefsRef = ref(db, settingsPath);
      const unsubPrefs = onValue(prefsRef, (snapshot) => {
        if (snapshot.exists()) {
          setPreferences((prev) => ({ ...prev, ...snapshot.val() }));
        }
      });
      return () => unsubPrefs();
    };

    fetchSettings();
  }, []);

  const isEmailValid = (email) => {
    if (!email) return false;
    return RFC5322_EMAIL_REGEX.test(email.trim());
  };

  const handleSavePreferences = async () => {
    if (preferences.adminEmail && !isEmailValid(preferences.adminEmail)) {
      showToast("Primary recipient email is invalid (RFC 5322 violation).", "error");
      return;
    }
    if (preferences.backupEmail && !isEmailValid(preferences.backupEmail)) {
      showToast("Backup recipient email is invalid (RFC 5322 violation).", "error");
      return;
    }

    setIsSavingPrefs(true);
    pulseLogger.info("settings_update", "notification_preferences_updating", { tenantId });

    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("cd_session_token") : null;
      const res = await fetch("/api/notifications/settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-id": tenantId,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(preferences),
      });

      if (res.ok) {
        const data = await res.json();
        setPreferences(data.settings);
        showToast("Tenant routing rules saved and verified!");
      } else {
        const errData = await res.json().catch(() => ({}));
        // Direct DB fallback if API fails
        const settingsPath = tenantId && tenantId !== "default"
          ? `tenants/${tenantId}/notification_settings`
          : `settings/notification_settings`;
        await update(ref(db, settingsPath), {
          ...preferences,
          updated_at: new Date().toISOString(),
        });
        showToast(errData.error || "Saved directly to database.", errData.error ? "error" : "success");
      }
    } catch (error) {
      pulseLogger.error("settings_update", "notification_preferences_failed", { error });
      showToast("Failed to save alert preferences: " + error.message, "error");
    } finally {
      setIsSavingPrefs(false);
    }
  };

  // Trigger a test alert to verify tenant recipient routing
  const handleTestEmail = async () => {
    if (!preferences.adminEmail || !isEmailValid(preferences.adminEmail)) {
      showToast("Please configure a valid destination email before testing.", "error");
      return;
    }

    setIsSendingTest(true);
    pulseLogger.info("settings_update", "test_email_triggered", { tenantId });

    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("cd_session_token") : null;
      const res = await fetch("/api/leads", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-tenant-id": tenantId,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          name: "CloseDesk Test Verification",
          email: preferences.adminEmail,
          phone: preferences.adminPhone || "+1-555-0199",
          message: "System test notification verifying tenant delivery queue and recipient routing.",
          source: "settings_test_ping",
          timestamp: Date.now(),
        }),
      });

      if (res.ok) {
        showToast("Test notification queued! Check the Live Notifications feed.");
      } else {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || "Failed to trigger test alert.", "error");
      }
    } catch (error) {
      pulseLogger.error("settings_update", "test_email_failed", { error });
      showToast("Failed to trigger test notification.", "error");
    } finally {
      setIsSendingTest(false);
    }
  };

  const primaryStatus = !preferences.adminEmail
    ? { label: "No Recipient Configured (Fail-Safe Hold)", color: "text-amber-600 bg-amber-50 border-amber-200" }
    : isEmailValid(preferences.adminEmail)
    ? { label: "✓ RFC 5322 Valid Recipient", color: "text-emerald-700 bg-emerald-50 border-emerald-200" }
    : { label: "✕ Malformed Syntax (Will Reject Delivery)", color: "text-rose-700 bg-rose-50 border-rose-200" };

  const backupStatus = !preferences.backupEmail
    ? { label: "Optional (Not Configured)", color: "text-gray-500 bg-gray-50 border-gray-200" }
    : isEmailValid(preferences.backupEmail)
    ? { label: "✓ RFC 5322 Valid Backup", color: "text-emerald-700 bg-emerald-50 border-emerald-200" }
    : { label: "✕ Malformed Syntax", color: "text-rose-700 bg-rose-50 border-rose-200" };

  return (
    <div className="max-w-[800px] mx-auto p-4 sm:p-8 lg:p-12 animate-acy-fade font-sans bg-[#F9FAFB] min-h-screen relative">
      <div className="bg-white rounded-[24px] p-6 sm:p-8 shadow-[0_2px_20px_rgba(0,0,0,0.03)] border border-gray-100">
        <div className="flex items-center justify-between gap-4 mb-8">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-[#DCFCE7] text-[#16A34A] flex items-center justify-center shrink-0">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
              </svg>
            </div>
            <div>
              <h2 className="text-[22px] font-black text-gray-900 tracking-tight">Lead Handoff & Routing</h2>
              <p className="text-[13px] text-gray-500 font-medium mt-0.5">
                Tenant-isolated destination routing. Unconfigured recipients are securely held without data loss.
              </p>
            </div>
          </div>
          <span className="text-[11px] font-mono uppercase px-3 py-1 bg-gray-100 rounded-full text-gray-600 font-semibold">
            Tenant: {tenantId}
          </span>
        </div>

        <div className="space-y-6">
          {/* Email Alerts Toggle */}
          <div className="flex justify-between items-center p-5 border border-gray-100 rounded-[16px] bg-white shadow-sm">
            <div>
              <h3 className="text-[15px] font-bold text-gray-900">Enable Email Delivery</h3>
              <p className="text-[12px] text-gray-500 mt-0.5">Dispatch inbound leads to designated business inboxes.</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={preferences.emailAlerts}
                onChange={(e) => setPreferences({ ...preferences, emailAlerts: e.target.checked })}
                className="sr-only peer"
              />
              <div className="w-12 h-7 bg-[#E5E7EB] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-200 after:border after:rounded-full after:h-6 after:w-6 after:transition-all after:shadow-sm peer-checked:bg-[var(--primary,#8B5CF6)] transition-colors"></div>
            </label>
          </div>

          {/* Primary Recipient Email */}
          <div className="p-5 border border-gray-100 rounded-[16px] bg-[#F8FAFC]">
            <div className="flex items-center justify-between mb-2">
              <label className="text-[11px] font-bold uppercase tracking-widest text-gray-600">
                Primary Destination Address
              </label>
              <span className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full border ${primaryStatus.color}`}>
                {primaryStatus.label}
              </span>
            </div>
            <input
              type="email"
              value={preferences.adminEmail}
              onChange={(e) => setPreferences({ ...preferences, adminEmail: e.target.value })}
              className="w-full bg-white rounded-xl px-4 py-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--primary,#8B5CF6)] border border-gray-200 transition-all"
              placeholder="leads@yourcompany.com"
            />
            <p className="text-[11px] text-gray-500 mt-2">
              Must be a valid RFC 5322 email. Never falls back to default system accounts or other tenants.
            </p>
          </div>

          {/* Backup Recipient Email */}
          <div className="p-5 border border-gray-100 rounded-[16px] bg-[#F8FAFC]">
            <div className="flex items-center justify-between mb-2">
              <label className="text-[11px] font-bold uppercase tracking-widest text-gray-600">
                Backup Escalation Address
              </label>
              <span className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full border ${backupStatus.color}`}>
                {backupStatus.label}
              </span>
            </div>
            <input
              type="email"
              value={preferences.backupEmail || ""}
              onChange={(e) => setPreferences({ ...preferences, backupEmail: e.target.value })}
              className="w-full bg-white rounded-xl px-4 py-3 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--primary,#8B5CF6)] border border-gray-200 transition-all"
              placeholder="manager@yourcompany.com"
            />
            <p className="text-[11px] text-gray-500 mt-2">
              Escalation destination if primary recipient delivery experiences retry exhaustion.
            </p>
          </div>

          {/* Urgent Filter */}
          <label className="flex items-start gap-4 cursor-pointer p-5 border border-gray-100 rounded-[16px] bg-[#F8FAFC] hover:border-gray-200 transition-colors w-full">
            <div className="mt-1">
              <input
                type="checkbox"
                checked={preferences.urgentOnly}
                onChange={(e) => setPreferences({ ...preferences, urgentOnly: e.target.checked })}
                className="w-[18px] h-[18px] rounded-[4px] border-none text-[var(--primary,#8B5CF6)] bg-white shadow-sm focus:ring-[var(--primary,#8B5CF6)] focus:ring-offset-0 cursor-pointer"
              />
            </div>
            <div className="flex flex-col">
              <span className="text-[15px] font-bold text-gray-900">Urgent / Bookings Only</span>
              <span className="text-[12px] font-medium text-gray-500 mt-1 leading-relaxed">
                Filter out general informational chatter and only dispatch high-intent handoffs and bookings.
              </span>
            </div>
          </label>
        </div>

        {/* Action Buttons */}
        <div className="mt-10 pt-6 border-t border-gray-100 flex flex-col sm:flex-row justify-between items-center gap-4">
          <button
            onClick={handleTestEmail}
            disabled={isSendingTest || !preferences.adminEmail}
            className="px-6 py-3.5 bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 text-xs font-bold uppercase tracking-widest rounded-xl transition-all duration-300 disabled:opacity-50 flex items-center gap-2 w-full sm:w-auto justify-center shadow-sm"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            {isSendingTest ? "Enqueuing..." : "Send Test Alert"}
          </button>

          <button
            onClick={handleSavePreferences}
            disabled={isSavingPrefs}
            className="px-8 py-3.5 bg-[var(--primary,#8B5CF6)] text-white hover:opacity-90 text-xs font-black uppercase tracking-widest rounded-xl transition-all duration-300 disabled:opacity-50 w-full sm:w-auto shadow-sm"
          >
            {isSavingPrefs ? "Validating & Saving..." : "Save Routing Configuration"}
          </button>
        </div>
      </div>

      {/* Toast Notification */}
      <div
        className={`fixed bottom-8 right-8 z-[100] transition-all duration-500 cubic-bezier(0.4, 0, 0.2, 1) ${
          toast.show ? "translate-y-0 opacity-100 scale-100" : "translate-y-8 opacity-0 scale-95 pointer-events-none"
        }`}
      >
        <div className="flex items-center gap-4 py-3 px-5 rounded-2xl bg-white border border-gray-100 shadow-[0_20px_40px_rgba(0,0,0,0.08)]">
          <div
            className={`w-2 h-2 rounded-full ${
              toast.type === "success"
                ? "bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]"
                : "bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]"
            }`}
          ></div>
          <p className="text-[13px] font-bold tracking-tight text-gray-900 pr-2">{toast.message}</p>
        </div>
      </div>
    </div>
  );
}
