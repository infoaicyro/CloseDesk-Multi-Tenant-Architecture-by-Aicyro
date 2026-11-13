// src/Closedesk/Dashboard/Settings/notification-settings.jsx
"use client";

import { useState, useEffect } from "react";
import { db } from "../../../lib/firebase";
// 🔥 Added 'push' to the import list to create new alerts
import { ref, onValue, update, push } from "firebase/database";
import { createPulseLogger } from "../../../lib/loggerPresets";

const pulseLogger = createPulseLogger("NotificationSettings");

export default function NotificationSettings() {
  const [preferences, setPreferences] = useState({
    emailAlerts: true,
    smsAlerts: false,
    urgentOnly: false,
    adminEmail: "",
    adminPhone: "",
  });

  const [isSavingPrefs, setIsSavingPrefs] = useState(false);
  const [isSendingTest, setIsSendingTest] = useState(false); // 🔥 State for the test button
  const [toast, setToast] = useState({ show: false, message: "", type: "success" });

  const showToast = (message, type = "success") => {
    setToast({ show: true, message, type });
    setTimeout(() => setToast({ show: false, message: "", type: "success" }), 3500);
  };

  useEffect(() => {
    const prefsRef = ref(db, "users/root/notifications");
    const unsubPrefs = onValue(prefsRef, (snapshot) => {
      if (snapshot.exists()) setPreferences(snapshot.val());
    });
    return () => unsubPrefs();
  }, []);

  const handleSavePreferences = async () => {
    setIsSavingPrefs(true);
    pulseLogger.info("settings_update", "notification_preferences_updated");
    try {
      await update(ref(db, "users/root/notifications"), preferences);
      showToast("Alert preferences saved successfully!");
    } catch (error) {
      pulseLogger.error("settings_update", "notification_preferences_failed", { error });
      showToast("Failed to save alert preferences.", "error");
    }
    setIsSavingPrefs(false);
  };

  // 🔥 Trigger a dummy alert to verify email dispatch
  const handleTestEmail = async () => {
    setIsSendingTest(true);
    pulseLogger.info("settings_update", "test_email_triggered");
    try {
      const alertsRef = ref(db, "email_alerts");
      await push(alertsRef, {
        status: "pending",
        event_type: "end",
        title: "Aicyro Pulse - Test Routing Alert",
        message: "This is a test alert to verify your routing configuration is working correctly.",
        lead_data: {
          name: "Test System",
          email: "noreply@aicyro.com",
          phone: "N/A",
          urgency_level: "Low",
          conversation_summary: "System generated test email to verify routing preferences."
        },
        timestamp: Date.now()
      });
      showToast("Test email triggered! Check your inbox.");
    } catch (error) {
      pulseLogger.error("settings_update", "test_email_failed", { error });
      showToast("Failed to trigger test email.", "error");
    }
    setIsSendingTest(false);
  };

  return (
    <div className="max-w-[800px] mx-auto p-4 sm:p-8 lg:p-12 animate-acy-fade font-sans bg-[#F9FAFB] min-h-screen relative">
      <div className="bg-white rounded-[24px] p-6 sm:p-8 shadow-[0_2px_20px_rgba(0,0,0,0.03)] border border-gray-100">
        <div className="flex items-center gap-4 mb-8">
          <div className="w-12 h-12 rounded-xl bg-[#DCFCE7] text-[#16A34A] flex items-center justify-center shrink-0">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
          </div>
          <div>
            <h2 className="text-[22px] font-black text-gray-900 tracking-tight">Admin Routing</h2>
            <p className="text-[13px] text-gray-500 font-medium mt-0.5">Where internal lead alerts are delivered.</p>
          </div>
        </div>
        
        <div className="space-y-6">
          <div className="flex justify-between items-center p-5 border border-gray-100 rounded-[16px] bg-white shadow-sm">
            <div>
              <h3 className="text-[15px] font-bold text-gray-900">Enable Email Alerts</h3>
              <p className="text-[12px] text-gray-500 mt-0.5">Receive immediate ping on new leads.</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer shrink-0">
              <input type="checkbox" checked={preferences.emailAlerts} onChange={(e) => setPreferences({ ...preferences, emailAlerts: e.target.checked })} className="sr-only peer" />
              <div className="w-12 h-7 bg-[#E5E7EB] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-200 after:border after:rounded-full after:h-6 after:w-6 after:transition-all after:shadow-sm peer-checked:bg-[var(--primary,#8B5CF6)] transition-colors"></div>
            </label>
          </div>

          <div>
            <label className="text-[11px] font-bold uppercase tracking-widest text-gray-600 block mb-2">Destination Address</label>
            <input type="email" value={preferences.adminEmail} onChange={(e) => setPreferences({ ...preferences, adminEmail: e.target.value })} className="w-full bg-[#F3F4F6] rounded-xl px-4 py-3.5 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--primary,#8B5CF6)] focus:ring-opacity-30 transition-all border-none" placeholder="admin@yourcompany.com" />
          </div>
          
          <label className="flex items-start gap-4 cursor-pointer p-5 border border-gray-100 rounded-[16px] bg-[#F8FAFC] hover:border-gray-200 transition-colors w-full">
            <div className="mt-1">
              <input type="checkbox" checked={preferences.urgentOnly} onChange={(e) => setPreferences({ ...preferences, urgentOnly: e.target.checked })} className="w-[18px] h-[18px] rounded-[4px] border-none text-[var(--primary,#8B5CF6)] bg-white shadow-sm focus:ring-[var(--primary,#8B5CF6)] focus:ring-offset-0 cursor-pointer" />
            </div>
            <div className="flex flex-col">
              <span className="text-[15px] font-bold text-gray-900">Urgent / Bookings Only</span>
              <span className="text-[12px] font-medium text-gray-500 mt-1 leading-relaxed">Ignore low-intent tire kickers. Perfect for high-volume sites.</span>
            </div>
          </label>
        </div>

        <div className="mt-10 pt-6 border-t border-gray-100 flex flex-col sm:flex-row justify-between items-center gap-4">
          <button 
            onClick={handleTestEmail} 
            disabled={isSendingTest} 
            className="px-6 py-3.5 bg-white border border-gray-200 text-gray-700 hover:bg-gray-50 text-xs font-bold uppercase tracking-widest rounded-xl transition-all duration-300 disabled:opacity-50 flex items-center gap-2 w-full sm:w-auto justify-center shadow-sm"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            {isSendingTest ? "Triggering..." : "Send Test Alert"}
          </button>

          <button 
            onClick={handleSavePreferences} 
            disabled={isSavingPrefs} 
            className="px-8 py-3.5 bg-[#F3F4F6] text-gray-900 hover:bg-[#E5E7EB] text-xs font-black uppercase tracking-widest rounded-xl transition-all duration-300 disabled:opacity-50 w-full sm:w-auto"
          >
            {isSavingPrefs ? "Updating..." : "Save Rules"}
          </button>
        </div>
      </div>

      <div className={`fixed bottom-8 right-8 z-[100] transition-all duration-500 cubic-bezier(0.4, 0, 0.2, 1) ${toast.show ? "translate-y-0 opacity-100 scale-100" : "translate-y-8 opacity-0 scale-95 pointer-events-none"}`}>
        <div className="flex items-center gap-4 py-3 px-5 rounded-2xl bg-white border border-gray-100 shadow-[0_20px_40px_rgba(0,0,0,0.08)]">
          <div className={`w-2 h-2 rounded-full ${toast.type === "success" ? "bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]" : "bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]"}`}></div>
          <p className="text-[13px] font-bold tracking-tight text-gray-900 pr-2">{toast.message}</p>
        </div>
      </div>
    </div>
  );
}