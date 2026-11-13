// src/Closedesk/Dashboard/superadmin/SuperAdminDashboard.jsx
"use client";

import React, { useState } from "react";
import ClientManagement from "./ClientManagement";
import SuperAdminAppearance from "./Settings/SuperAdminAppearance";
import SuperAdminEmailProtocol from "./Settings/SuperAdminEmailProtocol";

export default function SuperAdminDashboard({ onLogout }) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [activeView, setActiveView] = useState("clients");
  const [isSettingsExpanded, setIsSettingsExpanded] = useState(false);

  const handleNavClick = (view) => {
    setActiveView(view);
    setIsSidebarOpen(false);

    if (view === "appearance" || view === "email_protocol") {
      setIsSettingsExpanded(true);
    }
  };

  return (
    <div className="flex min-h-screen bg-[var(--background)] text-[var(--foreground)] font-sans relative overflow-hidden">
      <div className="fixed inset-0 z-0 pointer-events-none flex items-center justify-center">
        <div className="w-[60vw] h-[60vw] bg-[var(--primary)] opacity-5 blur-[150px] rounded-full mix-blend-screen"></div>
      </div>

      <div
        className={`fixed inset-0 bg-black/40 backdrop-blur-sm z-40 transition-opacity duration-300 ${
          isSidebarOpen
            ? "opacity-100 pointer-events-auto"
            : "opacity-0 pointer-events-none"
        }`}
        onClick={() => setIsSidebarOpen(false)}
      ></div>

      <aside
        className={`fixed inset-y-0 left-0 z-50 w-72 bg-[var(--sidebar-bg)] backdrop-blur-2xl border-r border-[var(--sidebar-border)] shadow-[20px_0_50px_rgba(0,0,0,0.1)] transform transition-transform duration-400 ease-[cubic-bezier(0.16,1,0.3,1)] flex flex-col ${
          isSidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between p-6 border-b border-[var(--border-color)]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[var(--primary)] to-[var(--secondary)] flex items-center justify-center text-white shadow-sm shrink-0">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </div>
            <span className="text-lg font-black text-[var(--foreground)] tracking-wide">
              System Admin
            </span>
          </div>
          <button
            onClick={() => setIsSidebarOpen(false)}
            className="p-2 rounded-lg text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background)] transition-colors"
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

        <div className="flex-grow overflow-y-auto p-4 flex flex-col gap-2">
          <p className="px-4 text-[10px] font-bold text-[var(--foreground-muted)] uppercase tracking-widest mb-1 mt-2">
            Global Management
          </p>

          <button
            onClick={() => handleNavClick("clients")}
            className={`flex items-center gap-4 px-4 py-3.5 rounded-xl text-sm font-semibold transition-all duration-200 group ${
              activeView === "clients"
                ? "bg-[var(--primary)]/10 text-[var(--primary)] border border-[var(--primary)]/20 shadow-[0_0_15px_var(--lead-glow)]"
                : "text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background)] border border-transparent"
            }`}
          >
            <svg
              className="w-5 h-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
              />
            </svg>
            Clients
          </button>

          <div className="mt-4 pt-4 border-t border-[var(--border-color)]">
            <button
              onClick={() => setIsSettingsExpanded(!isSettingsExpanded)}
              className={`w-full flex items-center justify-between px-4 py-3.5 rounded-xl text-sm font-semibold transition-all duration-200 ${
                isSettingsExpanded
                  ? "text-[var(--foreground)] bg-[var(--background)]"
                  : "text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background)]"
              }`}
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
              className={`overflow-hidden transition-all duration-300 ease-in-out ${isSettingsExpanded ? "max-h-48 opacity-100 mt-2" : "max-h-0 opacity-0"}`}
            >
              <div className="flex flex-col gap-1 pl-4 ml-6 border-l border-[var(--border-color)]">
              <button
                  onClick={() => handleNavClick("email_protocol")}
                  className={`text-left px-4 py-2.5 rounded-r-xl text-xs font-medium transition-all ${
                    activeView === "email_protocol"
                      ? "bg-[var(--primary)]/10 text-[var(--primary)] border-l-2 border-[var(--primary)]"
                      : "text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background)] border-l-2 border-transparent"
                  }`}
                >
                  Notifications Settings
                </button>
                <button
                  onClick={() => handleNavClick("appearance")}
                  className={`text-left px-4 py-2.5 rounded-r-xl text-xs font-medium transition-all ${
                    activeView === "appearance"
                      ? "bg-[var(--primary)]/10 text-[var(--primary)] border-l-2 border-[var(--primary)]"
                      : "text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:bg-[var(--background)] border-l-2 border-transparent"
                  }`}
                >
                  Appearance
                </button>
                
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 border-t border-[var(--border-color)] shrink-0">
          <button
            onClick={onLogout}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-bold text-[var(--logo-politico-red)] bg-[var(--logo-politico-red)]/10 hover:bg-[var(--logo-politico-red)]/20 border border-[var(--logo-politico-red)]/20 transition-all"
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
            End Session
          </button>
        </div>
      </aside>

      <div className="flex-grow w-full h-screen overflow-y-auto relative z-10 p-4 sm:p-8">
        <div className="max-w-7xl mx-auto h-full flex flex-col">
          <header className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-10 gap-4 shrink-0">
            <div className="flex items-center gap-4">
              <button
                onClick={() => setIsSidebarOpen(true)}
                className="p-3 rounded-xl bg-[var(--card-bg)] border border-[var(--border-color)] text-[var(--foreground)] hover:text-[var(--primary)] hover:border-[var(--primary)] transition-all shadow-sm flex items-center justify-center"
              >
                <svg
                  className="w-6 h-6"
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

              <div className="hidden sm:block w-14 h-14 rounded-2xl bg-gradient-to-br from-[var(--primary)] to-[var(--secondary)] flex flex-col items-center justify-center text-white shadow-[0_0_20px_var(--lead-glow)]">
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="m-auto mt-3"
                >
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                </svg>
              </div>

              <div>
                <h1 className="text-3xl font-black tracking-tight text-[var(--foreground)]">
                  Super Admin Console
                </h1>
                <p className="text-[var(--foreground-muted)] text-sm mt-1 font-medium capitalize">
                  Viewing: {activeView.replace("_", " ")}
                </p>
              </div>
            </div>
          </header>

          <div className="flex-grow w-full">
            {activeView === "clients" ? (
              <ClientManagement />
            ) : activeView === "appearance" ? (
              <SuperAdminAppearance />
            ) : activeView === "email_protocol" ? (
              <SuperAdminEmailProtocol />
            ) : (
              <div className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-3xl p-12 flex flex-col items-center justify-center min-h-[400px] text-center shadow-sm">
                <h2 className="text-2xl font-black text-[var(--foreground)] mb-2 capitalize">
                  {activeView.replace("_", " ")} Under Construction
                </h2>
                <p className="text-[var(--foreground-muted)] font-medium">
                  Check back later.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}