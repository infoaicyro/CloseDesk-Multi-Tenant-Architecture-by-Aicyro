"use client";

import { useEffect, useState } from "react";
import { ref, get, set } from "firebase/database";
import { db } from "../../../lib/firebase";
import HomeScreen from "../HomeScreen";
import TerminalScreen from "../TerminalScreen";
import Booking from "../Booking";

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

const applyThemeToDOM = (mode, hue, shade) => {
  let resolvedMode = mode;
  if (resolvedMode === "system") {
    resolvedMode = window.matchMedia("(prefers-color-scheme: dark)").matches
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

  const baseColor = THEME_HUES.find((h) => h.id === hue)?.color || "#8a2be2";
  let adjustedPrimary = baseColor;
  let adjustedSecondary = baseColor;

  if (shade !== 500) {
    const isDark = shade > 500;
    const intensity = Math.abs(shade - 500) / 450;
    if (isDark) {
      adjustedPrimary = `color-mix(in srgb, black ${intensity * 70}%, ${baseColor})`;
      adjustedSecondary = `color-mix(in srgb, black ${Math.min(100, intensity * 70 + 15)}%, ${baseColor})`;
    } else {
      adjustedPrimary = `color-mix(in srgb, white ${intensity * 85}%, ${baseColor})`;
      adjustedSecondary = `color-mix(in srgb, white ${Math.max(0, intensity * 85 - 10)}%, ${baseColor})`;
    }
  }

  document.documentElement.style.setProperty("--primary", adjustedPrimary);
  document.documentElement.style.setProperty("--secondary", adjustedSecondary);
};

export default function AppearanceSettings() {
  const [activeMode, setActiveMode] = useState("system");
  const [activeHue, setActiveHue] = useState("default");
  const [accentShade, setAccentShade] = useState(500);
  const [applyScope, setApplyScope] = useState("global");

  const [isSaving, setIsSaving] = useState(false);
  const [toast, setToast] = useState({ show: false, message: "" });
  const [username, setUsername] = useState(null);

  // NEW: State to manage the active preview tab
  const [activePreview, setActivePreview] = useState("home");

  useEffect(() => {
    const storedUser = localStorage.getItem("currentUser");
    if (storedUser) {
      setUsername(storedUser);
    }
  }, []);

  useEffect(() => {
    const loadPreferencesFromDB = async () => {
      const activeUser = username || localStorage.getItem("currentUser");
      if (!activeUser) return;

      try {
        const appearanceRef = ref(db, `users/${activeUser}/appearance`);
        const snapshot = await get(appearanceRef);

        if (snapshot.exists()) {
          const data = snapshot.val();
          setActiveMode(data.mode || "system");
          setActiveHue(data.hue || "default");
          setAccentShade(data.shade || 500);
          setApplyScope(data.applyScope || "global");
        } else {
          const savedSettings = JSON.parse(
            localStorage.getItem("aicyro_appearance"),
          );
          if (savedSettings) {
            setActiveMode(savedSettings.mode || "system");
            setActiveHue(savedSettings.hue || "default");
            setAccentShade(savedSettings.shade || 500);
            setApplyScope(savedSettings.applyScope || "global");
          }
        }
      } catch (error) {
        console.error("Failed to load settings", error);
      }
    };

    loadPreferencesFromDB();
  }, [username]);

  const savePreferencesToDB = async () => {
    const activeUser = username || localStorage.getItem("currentUser");
    if (!activeUser) {
      showToast("Error: No user logged in.");
      return;
    }

    setIsSaving(true);
    try {
      const payload = {
        mode: activeMode,
        hue: activeHue,
        shade: accentShade,
        applyScope: applyScope,
      };

      const appearanceRef = ref(db, `users/${activeUser}/appearance`);
      await set(appearanceRef, payload);

      localStorage.setItem("aicyro_appearance", JSON.stringify(payload));

      showToast("Appearance settings saved securely.");
    } catch (error) {
      console.error("Failed to save settings", error);
      showToast("Error saving settings.");
    } finally {
      setIsSaving(false);
    }
  };

  const showToast = (message) => {
    setToast({ show: true, message });
    setTimeout(() => setToast({ show: false, message: "" }), 3000);
  };

  useEffect(() => {
    applyThemeToDOM(activeMode, activeHue, accentShade);
  }, [activeMode, activeHue, accentShade]);

  useEffect(() => {
    return () => {
      const savedSettings = JSON.parse(
        localStorage.getItem("aicyro_appearance"),
      );
      if (savedSettings) {
        applyThemeToDOM(
          savedSettings.mode || "system",
          savedSettings.hue || "default",
          savedSettings.shade || 500,
        );
      } else {
        applyThemeToDOM("system", "default", 500);
      }
    };
  }, []);

  const resetTheme = () => {
    setActiveMode("system");
    setActiveHue("default");
    setAccentShade(500);
    setApplyScope("global");
    showToast("Reset to defaults (Click Save to apply).");
  };

  const activeBaseColor =
    THEME_HUES.find((h) => h.id === activeHue)?.color || "#8a2be2";
  const sliderGradient = `linear-gradient(to right, color-mix(in srgb, white 85%, ${activeBaseColor}) 0%, ${activeBaseColor} 50%, color-mix(in srgb, black 70%, ${activeBaseColor}) 100%)`;

  return (
    <div className="flex min-h-screen bg-[var(--background)] text-[var(--foreground)] font-sans transition-colors duration-300">
      <main className="flex-1 px-6 py-10 lg:px-12 overflow-y-auto w-full max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 pb-8 border-b border-[var(--border-color)]">
          <div>
            <div className="text-xs text-[var(--foreground-muted)] mb-2 flex items-center gap-2">
              Settings <span>›</span>{" "}
              <b className="text-[var(--foreground)]">Appearance</b>
            </div>
            <h1 className="text-2xl lg:text-3xl font-bold tracking-tight">
              Appearance
            </h1>
            <p className="text-sm text-[var(--foreground-muted)] mt-2">
              Customize your dashboard mode, accent color, and visual
              preference.
            </p>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={resetTheme}
              className="px-4 py-2.5 rounded-xl text-sm font-semibold border border-[var(--border-color)] text-[var(--foreground-muted)] hover:bg-[var(--card-bg)] hover:text-[var(--foreground)] transition-colors flex items-center gap-2"
            >
              <svg
                className="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              Reset
            </button>
            <button
              onClick={savePreferencesToDB}
              disabled={isSaving}
              className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-[var(--primary)] text-white hover:opacity-90 transition-all shadow-[0_4px_14px_var(--lead-glow)] flex items-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {isSaving ? (
                <svg
                  className="w-4 h-4 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : (
                <svg
                  className="w-4 h-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                  <path d="M17 21v-8H7v8M7 3v5h8" />
                </svg>
              )}
              Save Changes
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 mt-8">
          {/* Controls - Left Column */}
          <div className="lg:col-span-5 flex flex-col gap-6">
            {/* Mode Selection */}
            <section className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-6 shadow-sm transition-colors duration-300">
              <div className="mb-5">
                <h2 className="text-[15px] font-semibold flex items-center gap-2.5">
                  <span className="w-2 h-2 rounded-full bg-[var(--primary)] shadow-[0_0_0_3px_var(--lead-glow)] transition-colors"></span>
                  Mode
                </h2>
              </div>
              <div className="grid grid-cols-3 gap-2 bg-[var(--background)] border border-[var(--border-color)] rounded-xl p-1.5">
                {[
                  {
                    id: "light",
                    label: "Light",
                    icon: (
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        className="w-5 h-5"
                      >
                        <circle cx="12" cy="12" r="4" />
                        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                      </svg>
                    ),
                  },
                  {
                    id: "dark",
                    label: "Dark",
                    icon: (
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        className="w-5 h-5"
                      >
                        <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
                      </svg>
                    ),
                  },
                  {
                    id: "system",
                    label: "System",
                    icon: (
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        className="w-5 h-5"
                      >
                        <rect x="2" y="3" width="20" height="14" rx="2" />
                        <path d="M8 21h8M12 17v4" />
                      </svg>
                    ),
                  },
                ].map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setActiveMode(m.id)}
                    className={`flex flex-col items-center gap-2 p-3.5 rounded-lg border text-[13px] font-semibold transition-all ${
                      activeMode === m.id
                        ? "bg-[var(--card-bg)] border-[var(--primary)] text-[var(--primary)] shadow-sm ring-2 ring-[var(--primary)]/10"
                        : "border-transparent text-[var(--foreground-muted)] hover:bg-[var(--card-bg)] hover:text-[var(--foreground)]"
                    }`}
                  >
                    {m.icon}
                    <span>{m.label}</span>
                  </button>
                ))}
              </div>
            </section>

            {/* Theme Scope Selection */}
            <section className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-6 shadow-sm transition-colors duration-300">
              <div className="mb-5">
                <h2 className="text-[15px] font-semibold flex items-center gap-2.5">
                  <span className="w-2 h-2 rounded-full bg-[var(--primary)] shadow-[0_0_0_3px_var(--lead-glow)] transition-colors"></span>
                  Theme Scope
                </h2>
                <p className="text-[13px] text-[var(--foreground-muted)] mt-1.5">
                  Choose where this theme should be applied.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {[
                  {
                    id: "dashboard",
                    label: "Pulse Only",
                    sub: "Only styles the dashboard ",
                    icon: (
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="w-5 h-5"
                      >
                        <rect
                          x="3"
                          y="3"
                          width="18"
                          height="18"
                          rx="2"
                          ry="2"
                        />
                        <path d="M3 9h18M9 21V9" />
                      </svg>
                    ),
                  },
                  {
                    id: "global",
                    label: "Entire Website",
                    sub: "Applies to public pages and admin",
                    icon: (
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="w-5 h-5"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                      </svg>
                    ),
                  },
                ].map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setApplyScope(s.id)}
                    className={`flex flex-col items-start gap-2 p-4 rounded-xl border transition-all duration-300 text-left ${
                      applyScope === s.id
                        ? "bg-[var(--card-bg)] border-[var(--primary)] text-[var(--primary)] shadow-sm ring-2 ring-[var(--primary)]/10"
                        : "border-[var(--border-color)] text-[var(--foreground-muted)] hover:bg-[var(--card-bg)] hover:text-[var(--foreground)]"
                    }`}
                  >
                    <div className="flex items-center gap-2 text-[14px] font-semibold">
                      {s.icon} {s.label}
                    </div>
                    <span className="text-[11px] font-medium opacity-80 leading-tight">
                      {s.sub}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            {/* Color Selection & Shade Bar */}
            <section className="bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl p-6 shadow-sm transition-colors duration-300">
              <div className="mb-5">
                <h2 className="text-[15px] font-semibold flex items-center gap-2.5">
                  <span className="w-2 h-2 rounded-full bg-[var(--primary)] shadow-[0_0_0_3px_var(--lead-glow)] transition-colors"></span>
                  Color Theme
                </h2>
              </div>

              <div className="grid grid-cols-4 gap-3">
                {THEME_HUES.map((hue) => (
                  <button
                    key={hue.id}
                    onClick={() => {
                      setActiveHue(hue.id);
                      setAccentShade(500);
                    }}
                    className={`relative flex flex-col items-center gap-3 p-3.5 rounded-xl border transition-all duration-300 ${
                      activeHue === hue.id
                        ? "border-[var(--primary)] bg-[var(--background)] shadow-[0_0_0_3px_var(--lead-glow)] scale-[1.02]"
                        : "border-[var(--border-color)] bg-[var(--card-bg)] hover:border-[var(--foreground-muted)] hover:-translate-y-0.5"
                    }`}
                  >
                    <div
                      className="w-10 h-10 rounded-full shadow-inner flex items-center justify-center transition-transform"
                      style={{ background: hue.color }}
                    >
                      {activeHue === hue.id && (
                        <svg
                          className="w-5 h-5 text-white"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      )}
                    </div>
                    <span
                      className={`text-[11px] font-semibold ${activeHue === hue.id ? "text-[var(--foreground)]" : "text-[var(--foreground-muted)]"}`}
                    >
                      {hue.name}
                    </span>
                  </button>
                ))}
              </div>

              <div className="mt-8 pt-6 border-t border-[var(--border-color)]">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold flex items-center gap-2 text-[var(--foreground-muted)]">
                    Accent Shade
                  </h3>
                  <div className="text-xs font-mono font-bold text-[var(--foreground)] bg-[var(--background)] border border-[var(--border-color)] px-2 py-1 rounded-md shadow-sm">
                    {accentShade}
                  </div>
                </div>
                <div
                  className="relative h-4 rounded-full shadow-inner flex items-center overflow-visible border border-[var(--border-color)]/50"
                  style={{ background: sliderGradient }}
                >
                  <input
                    type="range"
                    min="50"
                    max="950"
                    step="10"
                    value={accentShade}
                    onChange={(e) => setAccentShade(Number(e.target.value))}
                    className="w-full appearance-none bg-transparent cursor-pointer relative z-10 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-6 [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:bg-[var(--primary)] [&::-webkit-slider-thumb]:border-[3px] [&::-webkit-slider-thumb]:border-white [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:shadow-[0_2px_8px_rgba(0,0,0,0.5)] [&::-webkit-slider-thumb]:transition-transform hover:[&::-webkit-slider-thumb]:scale-110"
                  />
                </div>
              </div>
            </section>
          </div>

          {/* Live Component Preview */}
          <section className="lg:col-span-7 bg-[var(--card-bg)] border border-[var(--border-color)] rounded-2xl shadow-sm overflow-hidden flex flex-col transition-colors duration-300 h-fit sticky top-8">
            <div className="p-4 border-b border-[var(--border-color)] flex justify-between items-center bg-[var(--background)]/50 z-20">
              <h2 className="text-[14px] font-semibold flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[var(--primary)] shadow-[0_0_0_3px_var(--lead-glow)] transition-colors"></span>
                Live Preview
              </h2>
            </div>

            {/* LIVE PREVIEW NAVBAR */}
            <div className="bg-[var(--card-bg)] border-b border-[var(--border-color)] px-4 flex gap-6 text-xs font-bold z-20 relative">
              <button
                onClick={() => setActivePreview("home")}
                className={`py-3 border-b-2 transition-colors uppercase tracking-widest ${activePreview === "home" ? "border-[var(--primary)] text-[var(--primary)]" : "border-transparent text-[var(--foreground-muted)] hover:text-[var(--foreground)]"}`}
              >
                Dashboard
              </button>
              <button
                onClick={() => setActivePreview("terminal")}
                className={`py-3 border-b-2 transition-colors uppercase tracking-widest ${activePreview === "terminal" ? "border-[var(--primary)] text-[var(--primary)]" : "border-transparent text-[var(--foreground-muted)] hover:text-[var(--foreground)]"}`}
              >
                Terminal
              </button>
              <button
                onClick={() => setActivePreview("booking")}
                className={`py-3 border-b-2 transition-colors uppercase tracking-widest ${activePreview === "booking" ? "border-[var(--primary)] text-[var(--primary)]" : "border-transparent text-[var(--foreground-muted)] hover:text-[var(--foreground)]"}`}
              >
                Booking
              </button>
            </div>

            {/* FULLY FUNCTIONAL SCALED COMPONENTS */}
            <div className="relative w-full h-[550px] md:h-[650px] bg-[var(--background)] overflow-hidden">
              <div
                className="absolute top-0 left-0 w-[150%] h-[150%] origin-top-left overflow-y-auto overflow-x-hidden custom-scrollbar"
                style={{ transform: "scale(0.6666)" }}
              >
                <div className="pointer-events-auto w-full">
                  {activePreview === "home" && <HomeScreen />}
                  {activePreview === "terminal" && <TerminalScreen />}
                  {activePreview === "booking" && <Booking />}
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>

      <div
        className={`fixed bottom-8 right-8 z-50 transition-all duration-300 ${toast.show ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0 pointer-events-none"}`}
      >
        <div className="app-toast border-l-4 border-l-green-500 shadow-xl rounded-lg p-4 pr-10 flex items-center gap-3 bg-[var(--card-bg)] text-[var(--foreground)]">
          <svg
            className="w-5 h-5 app-toast-icon text-green-500"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <span className="text-sm font-semibold">{toast.message}</span>
        </div>
      </div>
    </div>
  );
}
