// src/pages/lg.jsx
"use client";

import { useState, useEffect, useRef } from "react";
import { db } from "../lib/firebase";
import { ref, onValue, get } from "firebase/database";

import LoginScreen from "../Closedesk/Dashboard/LoginScreen";
import SuperAdminLoginScreen from "../Closedesk/Dashboard/superadmin/superadminlogin";
import SuperAdminDashboard from "../Closedesk/Dashboard/superadmin/SuperAdminDashboard";

import HomeScreen from "../Closedesk/Dashboard/HomeScreen";
import TerminalScreen from "../Closedesk/Dashboard/TerminalScreen";
import BookingsScreen from "../Closedesk/Dashboard/Booking";
import Insight from "@/Closedesk/Dashboard/Insight";
import Conversations from "../Closedesk/Dashboard/Conversations";
import Report from "../Closedesk/Dashboard/Report";

import PasswordChange from "../Closedesk/Dashboard/Settings/PasswordChange";
import BusinessProfile from "../Closedesk/Dashboard/Settings/BusinessProfile";
import ChatbotSettings from "../Closedesk/Dashboard/Settings/Chatbotsetting";
import NotificationSettings from "../Closedesk/Dashboard/Settings/notification-settings";
import Apearance from "../Closedesk/Dashboard/Settings/apearance";

import LiveNotifications from "../Closedesk/Dashboard/LiveNotifications";
import CookieDataDisplay from "../Closedesk/Dashboard/CookieDataDisplay";

// Implement the new Website Logger
import { createWebsiteLogger } from "../lib/loggerPresets";
const logger = createWebsiteLogger("DashboardLayout");

// --- THEME HUES FOR GLOBAL CSS CALCULATION ---
const THEME_HUES = [
  { id: "default", name: "Default", color: "#8a2be2" },
  { id: "red", name: "Red", color: "#ef4444" },
  { id: "orange", name: "Orange", color: "#f97316" },
  { id: "yellow", name: "Yellow", color: "#f59e0b" },
  { id: "green", name: "Green", color: "#10b981" },
  { id: "blue", name: "Blue", color: "#3b82f6" },
  { id: "indigo", name: "Indigo", color: "#6366f1" },
  { id: "violet", name: "Violet", color: "#8b5cf6" },
];

const mockNotifications = [
  {
    id: 1,
    title: "Urgent Lead Captured",
    message: "John Doe requested a demo.",
    time: "5m ago",
    unread: true,
  },
  {
    id: 2,
    title: "Chatbot Alert",
    message: "A visitor asked to speak with a human.",
    time: "1h ago",
    unread: true,
  },
  {
    id: 3,
    title: "Weekly Summary",
    message: "Your Pulse performance report is ready.",
    time: "1d ago",
    unread: false,
  },
];

export default function LeadsDashboard() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loginView, setLoginView] = useState("user"); // 'user' or 'superadmin'
  const [currentView, setCurrentView] = useState("home");
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [sidebarBrandName, setSidebarBrandName] = useState("Aicyro Pulse");
  const [isSettingsExpanded, setIsSettingsExpanded] = useState(false);
  const [isInsightExpanded, setIsInsightExpanded] = useState(false);

  // =========================================================================
  // --- TERMINATE SESSION ON PAGE RELOAD ---
  // =========================================================================
  useEffect(() => {
    const handleBeforeUnload = () => {
      localStorage.removeItem("currentUser");
      localStorage.removeItem("currentSuperAdmin");
      localStorage.removeItem("currentTenant");
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, []);

  // --- FETCH BUSINESS NAME FROM FIREBASE ---
  useEffect(() => {
    if (isAuthenticated) {
      const brandRef = ref(
        db,
        "settings/business_profile/basic_info/businessName",
      );
      const unsubscribe = onValue(brandRef, (snapshot) => {
        if (snapshot.exists() && snapshot.val().trim() !== "") {
          setSidebarBrandName(snapshot.val());
        } else {
          setSidebarBrandName("Aicyro Pulse");
        }
      });
      return () => unsubscribe();
    }
  }, [isAuthenticated]);

  // --- GLOBAL THEME INITIALIZATION ---
  useEffect(() => {
    const applyGlobalTheme = async () => {
      const superAdminName = localStorage.getItem("currentSuperAdmin");
      const standardUserName = localStorage.getItem("currentUser");
      const activeUser = superAdminName || standardUserName;

      if (!activeUser || !isAuthenticated) {
        const fallbackTheme = localStorage.getItem("theme") || "light";
        document.documentElement.setAttribute("data-theme", fallbackTheme);
        return;
      }

      try {
        const themePath = superAdminName
          ? `superAdminSettings/${activeUser}/appearance`
          : `users/${activeUser}/appearance`;

        const appearanceRef = ref(db, themePath);
        const snapshot = await get(appearanceRef);

        if (snapshot.exists()) {
          const {
            mode = "system",
            hue = "default",
            shade = 500,
          } = snapshot.val();
          let resolvedMode = mode;
          if (resolvedMode === "system") {
            resolvedMode = window.matchMedia("(prefers-color-scheme: dark)")
              .matches
              ? "dark"
              : "light";
          }
          const themeString =
            hue === "default"
              ? resolvedMode === "dark"
                ? "dark"
                : "light"
              : `${hue}-${resolvedMode}`;
          document.documentElement.setAttribute("data-theme", themeString);

          const baseColor =
            THEME_HUES.find((h) => h.id === hue)?.color || "#8a2be2";
          let adjustedPrimary = baseColor;
          let adjustedSecondary = baseColor;

          if (shade !== 500) {
            const isDark = shade > 500;
            const intensity = Math.abs(shade - 500) / 450;
            if (isDark) {
              const mixPercent = intensity * 70;
              adjustedPrimary = `color-mix(in srgb, black ${mixPercent}%, ${baseColor})`;
              adjustedSecondary = `color-mix(in srgb, black ${Math.min(100, mixPercent + 15)}%, ${baseColor})`;
            } else {
              const mixPercent = intensity * 85;
              adjustedPrimary = `color-mix(in srgb, white ${mixPercent}%, ${baseColor})`;
              adjustedSecondary = `color-mix(in srgb, white ${Math.max(0, mixPercent - 10)}%, ${baseColor})`;
            }
          }

          document.documentElement.style.setProperty(
            "--primary",
            adjustedPrimary,
          );
          document.documentElement.style.setProperty(
            "--secondary",
            adjustedSecondary,
          );
        } else {
          const localStorageKey = superAdminName
            ? "aicyro_appearance_superadmin"
            : "aicyro_appearance";
          const localSettings = JSON.parse(
            localStorage.getItem(localStorageKey),
          );
          if (localSettings) {
            let resMode =
              localSettings.mode === "system"
                ? window.matchMedia("(prefers-color-scheme: dark)").matches
                  ? "dark"
                  : "light"
                : localSettings.mode;
            const tStr =
              localSettings.hue === "default"
                ? resMode
                : `${localSettings.hue}-${resMode}`;
            document.documentElement.setAttribute("data-theme", tStr);
          } else {
            document.documentElement.setAttribute("data-theme", "light");
          }
        }
      } catch (error) {
        logger.error("theme", "load_failed", { error });
      }
    };

    applyGlobalTheme();
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleOsChange = () => applyGlobalTheme();
    mediaQuery.addEventListener("change", handleOsChange);
    return () => mediaQuery.removeEventListener("change", handleOsChange);
  }, [isAuthenticated]);

  const handleNavClick = (view) => {
    setCurrentView(view);
    setIsSidebarOpen(false);
    if (
      [
        "business_profile",
        "chatbot_settings",
        "notification_settings",
        "apearance",
      ].includes(view)
    ) {
      setIsSettingsExpanded(true);
    }
  };

  const handleLogout = async () => {
    try {
      const isSuperAdmin = Boolean(localStorage.getItem("currentSuperAdmin"));
      const logoutEndpoint = isSuperAdmin ? "/api/superadmin/logout" : "/api/logout";
      const token = localStorage.getItem("cd_session_token");
      await fetch(logoutEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-requested-with": "XMLHttpRequest",
          ...(token ? { "x-cd-session": token } : {}),
        },
        credentials: "include",
      });
    } catch (e) {
      console.warn("Logout notification failed:", e);
    }
    setIsAuthenticated(false);
    setIsSidebarOpen(false);
    setLoginView("user");
    localStorage.removeItem("currentUser");
    localStorage.removeItem("currentSuperAdmin");
    localStorage.removeItem("currentTenant");
    localStorage.removeItem("cd_session_token");
    document.documentElement.setAttribute("data-theme", "light");
    document.documentElement.style.removeProperty("--primary");
    document.documentElement.style.removeProperty("--secondary");
  };

  // 1. Check Super Admin Login State
  const isSuperAdminLoggedIn =
    typeof window !== "undefined" &&
    localStorage.getItem("currentSuperAdmin") !== null;

  // 2. Handle Unauthenticated Views
  if (!isAuthenticated) {
    if (loginView === "superadmin") {
      return (
        <SuperAdminLoginScreen
          onLoginSuccess={() => setIsAuthenticated(true)}
          onNavigateToUserLogin={() => {
            localStorage.removeItem("currentSuperAdmin");
            setLoginView("user");
          }}
        />
      );
    }
    return (
      <LoginScreen
        onLoginSuccess={() => setIsAuthenticated(true)}
        onNavigateToSuperAdmin={() => {
          localStorage.removeItem("currentUser");
          localStorage.removeItem("currentTenant");
          setLoginView("superadmin");
        }}
      />
    );
  }

  // 3. Handle Authenticated Super Admin View (Strictly gated by loginView and superadmin session)
  if (isSuperAdminLoggedIn && loginView === "superadmin") {
    return <SuperAdminDashboard onLogout={handleLogout} />;
  }

  // 4. Handle Authenticated Standard User View
  const getHeaderTitle = () => {
    const titles = {
      home: "Pulse Overview",
      terminal: "Leads Terminal",
      bookings: "Bookings",
      insight: "Insight Overview",
      cookie_data: "Visitor Cookie Data",
      conversations: "Conversations",
      reports: "Reports",
      business_profile: "Business Profile",
      chatbot_settings: "Chatbot Settings",
      apearance: "Appearance Settings",
      notification_settings: "Notification Settings",
      password_change: "Account Security",
    };
    return titles[currentView] || "Dashboard";
  };

  return (
    <div className="flex min-h-screen bg-[var(--background)] font-sans text-[var(--foreground)] relative overflow-hidden">
      <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[50vw] h-[50vw] bg-[var(--primary)] opacity-5 blur-[150px] rounded-full mix-blend-screen"></div>
      </div>

      <div
        className={`fixed inset-0 bg-black/40 backdrop-blur-sm z-40 transition-opacity duration-300 ${isSidebarOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}
        onClick={() => setIsSidebarOpen(false)}
      ></div>

      <aside
        className={`fixed inset-y-0 left-0 z-50 w-72 bg-[var(--sidebar-bg)] backdrop-blur-2xl border-r border-[var(--sidebar-border)] shadow-[20px_0_50px_rgba(0,0,0,0.1)] transform transition-transform duration-400 ease-[cubic-bezier(0.16,1,0.3,1)] flex flex-col ${isSidebarOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex items-center justify-between p-6 border-b border-[var(--border-color)]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center overflow-hidden bg-[var(--background)] border border-[var(--border-color)] shrink-0">
              <img
                src="/icon.png"
                alt="Icon"
                className="w-full h-full object-contain p-1"
              />
            </div>
            <span
              className="text-lg font-bold text-[var(--foreground)] tracking-wide truncate max-w-[150px]"
              title={sidebarBrandName}
            >
              {sidebarBrandName}
            </span>
            <span className="text-lg font-bold text-[var(--foreground)] tracking-wide truncate max-w-[150px]">
              Pulse
            </span>
          </div>
          <button
            onClick={() => setIsSidebarOpen(false)}
            className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background)] transition-colors shrink-0"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="flex-grow overflow-y-auto custom-scrollbar flex flex-col gap-2 p-4 mt-2">
          <p className="px-4 text-[10px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest mb-1">
            Main Menu
          </p>

          {["home", "terminal", "bookings", "insight", "reports"].map(
            (view) => {
              const labels = {
                home: "Pulse",
                terminal: "Leads",
                bookings: "Booking",
                insight: "Insight",
                reports: "Reports",
              };

              if (view === "insight") {
                return (
                  <div key={view} className="flex flex-col">
                    <button
                      onClick={() => setIsInsightExpanded(!isInsightExpanded)}
                      className={`flex items-center justify-between px-4 py-3.5 rounded-xl text-sm font-semibold transition-all duration-200 group ${currentView === "insight" || currentView === "cookie_data" ? "bg-[var(--primary)]/10 text-[var(--primary)] border border-[var(--primary)]/20 shadow-[0_0_15px_var(--lead-glow)]" : "text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background)] border border-transparent"}`}
                    >
                      <div className="flex items-center gap-4">
                        <div
                          className={`w-2 h-2 rounded-full ${currentView === "insight" || currentView === "cookie_data" ? "bg-[var(--primary)]" : "bg-[var(--foreground-muted)] opacity-50 group-hover:bg-[var(--foreground)] transition-colors"}`}
                        ></div>
                        {labels[view]}
                      </div>
                      <svg
                        className={`w-4 h-4 transition-transform duration-300 ${isInsightExpanded ? "rotate-180 text-[var(--primary)]" : "text-[var(--foreground-muted)]"}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth="2"
                          d="M19 9l-7 7-7-7"
                        />
                      </svg>
                    </button>

                    <div
                      className={`overflow-hidden transition-all duration-300 ease-in-out ${isInsightExpanded ? "max-h-32 opacity-100 mt-2" : "max-h-0 opacity-0"}`}
                    >
                      <div className="flex flex-col gap-1 pl-4 ml-6 border-l border-[var(--border-color)]">
                        <button
                          onClick={() => handleNavClick("insight")}
                          className={`text-left px-4 py-2.5 rounded-r-xl text-xs font-medium transition-all ${currentView === "insight" ? "bg-[var(--primary)]/10 text-[var(--primary)] border-l-2 border-[var(--primary)]" : "text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background)] border-l-2 border-transparent"}`}
                        >
                          Insight Overview
                        </button>
                        <button
                          onClick={() => handleNavClick("cookie_data")}
                          className={`text-left px-4 py-2.5 rounded-r-xl text-xs font-medium transition-all ${currentView === "cookie_data" ? "bg-[var(--primary)]/10 text-[var(--primary)] border-l-2 border-[var(--primary)]" : "text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background)] border-l-2 border-transparent"}`}
                        >
                          Cookie Data
                        </button>
                      </div>
                    </div>
                  </div>
                );
              }

              return (
                <button
                  key={view}
                  onClick={() => handleNavClick(view)}
                  className={`flex items-center gap-4 px-4 py-3.5 rounded-xl text-sm font-semibold transition-all duration-200 group ${currentView === view ? "bg-[var(--primary)]/10 text-[var(--primary)] border border-[var(--primary)]/20 shadow-[0_0_15px_var(--lead-glow)]" : "text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background)] border border-transparent"}`}
                >
                  <div
                    className={`w-2 h-2 rounded-full ${currentView === view ? "bg-[var(--primary)]" : "bg-[var(--foreground-muted)] opacity-50 group-hover:bg-[var(--foreground)] transition-colors"}`}
                  ></div>
                  {labels[view]}
                </button>
              );
            },
          )}

          <div className="mt-4 pt-4 border-t border-[var(--border-color)]">
            <button
              onClick={() => setIsSettingsExpanded(!isSettingsExpanded)}
              className={`w-full flex items-center justify-between px-4 py-3.5 rounded-xl text-sm font-semibold transition-all duration-200 ${isSettingsExpanded ? "text-[var(--foreground)] bg-[var(--background)]" : "text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background)]"}`}
            >
              <div className="flex items-center gap-4">
                <svg
                  className={`w-4 h-4 ${isSettingsExpanded ? "text-[var(--primary)]" : "text-[var(--foreground-muted)]"}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2.5"
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2.5"
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
                Settings
              </div>
              <svg
                className={`w-4 h-4 transition-transform duration-300 ${isSettingsExpanded ? "rotate-180 text-[var(--foreground)]" : "text-[var(--foreground-muted)]"}`}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>

            <div
              className={`overflow-hidden transition-all duration-300 ease-in-out ${isSettingsExpanded ? "max-h-64 opacity-100 mt-2" : "max-h-0 opacity-0"}`}
            >
              <div className="flex flex-col gap-1 pl-4 ml-6 border-l border-[var(--border-color)]">
                <button
                  onClick={() => handleNavClick("business_profile")}
                  className={`text-left px-4 py-2.5 rounded-r-xl text-xs font-medium transition-all ${currentView === "business_profile" ? "bg-[var(--primary)]/10 text-[var(--primary)] border-l-2 border-[var(--primary)]" : "text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background)] border-l-2 border-transparent"}`}
                >
                  Business Profile
                </button>
                <button
                  onClick={() => handleNavClick("chatbot_settings")}
                  className={`text-left px-4 py-2.5 rounded-r-xl text-xs font-medium transition-all ${currentView === "chatbot_settings" ? "bg-[var(--primary)]/10 text-[var(--primary)] border-l-2 border-[var(--primary)]" : "text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background)] border-l-2 border-transparent"}`}
                >
                  Chatbot Configuration
                </button>
                <button
                  onClick={() => handleNavClick("notification_settings")}
                  className={`text-left px-4 py-2.5 rounded-r-xl text-xs font-medium transition-all ${currentView === "notification_settings" ? "bg-[var(--primary)]/10 text-[var(--primary)] border-l-2 border-[var(--primary)]" : "text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background)] border-l-2 border-transparent"}`}
                >
                  Notification Settings
                </button>
                <button
                  onClick={() => handleNavClick("apearance")}
                  className={`text-left px-4 py-2.5 rounded-r-xl text-xs font-medium transition-all ${currentView === "apearance" ? "bg-[var(--primary)]/10 text-[var(--primary)] border-l-2 border-[var(--primary)]" : "text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background)] border-l-2 border-transparent"}`}
                >
                  Appearance Themes
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 border-t border-[var(--border-color)] shrink-0">
          <button
            onClick={handleLogout}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-bold text-red-400 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 transition-all"
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
                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
              />
            </svg>
            Sign Out
          </button>
        </div>
      </aside>

      <div className="flex-grow flex flex-col w-full h-screen overflow-y-auto relative z-10">
        <header className="sticky top-0 z-30 w-full px-6 sm:px-12 py-4 flex items-center justify-between bg-[var(--background)]/80 backdrop-blur-xl border-b border-[var(--border-color)] shadow-sm">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setIsSidebarOpen(true)}
              className="p-2.5 rounded-xl bg-[var(--card-bg)] border border-[var(--border-color)] text-[var(--foreground)] hover:text-[var(--primary)] hover:border-[var(--primary)] transition-all shadow-sm"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  d="M4 6h16M4 12h16M4 18h16"
                />
              </svg>
            </button>
            <div className="h-6 w-px bg-[var(--border-color)] mx-2"></div>
            <span className="text-[var(--foreground-muted)] text-sm font-semibold tracking-wider uppercase">
              {getHeaderTitle()}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <LiveNotifications onNavigate={handleNavClick} />
          </div>
        </header>

        <div className="flex-grow">
          {currentView === "home" && <HomeScreen onLogout={handleLogout} />}
          {currentView === "terminal" && (
            <TerminalScreen onLogout={handleLogout} />
          )}
          {currentView === "bookings" && (
            <BookingsScreen onLogout={handleLogout} />
          )}
          {currentView === "insight" && <Insight onLogout={handleLogout} />}
          {currentView === "cookie_data" && <CookieDataDisplay />}
          {currentView === "reports" && <Report onLogout={handleLogout} />}
          {currentView === "business_profile" && (
            <BusinessProfile onNavigate={handleNavClick} />
          )}
          {currentView === "apearance" && <Apearance />}
          {currentView === "chatbot_settings" && <ChatbotSettings />}
          {currentView === "notification_settings" && <NotificationSettings />}
          {currentView === "password_change" && (
            <PasswordChange onNavigate={handleNavClick} />
          )}
        </div>
      </div>

      <style
        dangerouslySetInnerHTML={{
          __html: `.custom-scrollbar::-webkit-scrollbar { width: 5px; } .custom-scrollbar::-webkit-scrollbar-track { background: transparent; } .custom-scrollbar::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 4px; } .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: var(--foreground-muted); }`,
        }}
      />
    </div>
  );
}
