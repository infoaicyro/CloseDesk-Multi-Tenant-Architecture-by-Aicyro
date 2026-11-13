// src/Closedesk/Dashboard/superadmin/superadminlogin.jsx
"use client";

import { useState, useEffect } from "react";
import { ref, get } from "firebase/database";
import { db } from "../../../lib/firebase";

import { createWebsiteLogger } from "../../../lib/loggerPresets";
import { generateCorrelationId } from "../../../lib/tracer";

const baseLogger = createWebsiteLogger("SuperAdminLogin");

// Helper function to generate a random 6-character CAPTCHA
const generateCaptcha = () => {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
};


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
  let adjustedPrimary = baseColor,
    adjustedSecondary = baseColor;

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

export default function SuperAdminLoginScreen({
  onLoginSuccess,
  onNavigateToUserLogin,
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  // --- CAPTCHA & BRUTE FORCE STATE ---
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [captchaValue, setCaptchaValue] = useState("");
  const [userCaptchaInput, setUserCaptchaInput] = useState("");



  useEffect(() => {
    document.documentElement.setAttribute("data-theme", "light");
    document.documentElement.style.removeProperty("--primary");
    document.documentElement.style.removeProperty("--secondary");

    const fetchTheme = async () => {
      try {
        const lastAdmin = localStorage.getItem("currentSuperAdmin") || "admin";
        const appearanceRef = ref(
          db,
          `superAdminSettings/${lastAdmin}/appearance`,
        );
        const snapshot = await get(appearanceRef);

        if (snapshot.exists()) {
          const data = snapshot.val();
          applyThemeToDOM(
            data.mode || "light",
            data.hue || "default",
            data.shade || 500,
          );
        } else {
          const saved = JSON.parse(
            localStorage.getItem("aicyro_appearance_superadmin"),
          );
          if (saved) {
            applyThemeToDOM(
              saved.mode || "light",
              saved.hue || "default",
              saved.shade || 500,
            );
          }
        }
      } catch (error) {
        baseLogger.error("theme", "load_failed", { error });
      }
    };

    fetchTheme();
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();

    const txId = generateCorrelationId();
    const txLogger = baseLogger.child({
      correlation: { correlation_id: txId },
    });

    setIsLoading(true);
    setError("");

    txLogger.info("auth", "superadmin_login_attempt", {
      context: { user_id: username },
    });

    try {
      const response = await fetch("/api/superadmin/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-requested-with": "XMLHttpRequest",
        },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });

      const data = await response.json();

      if (response.ok && data.success) {
        if (data.token) {
          localStorage.setItem("cd_session_token", data.token);
        }
        localStorage.setItem("currentSuperAdmin", data.name);
        setFailedAttempts(0);
        setShowCaptcha(false);

        txLogger.info("auth", "superadmin_login_success", {
          context: { user_id: username },
        });
        onLoginSuccess();
      } else {
        const newAttempts = failedAttempts + 1;
        setFailedAttempts(newAttempts);

        txLogger.warn("auth", "superadmin_login_invalid", {
          context: { user_id: username, attempts: newAttempts },
        });

        if (newAttempts >= 3) {
          setCaptchaValue(generateCaptcha());
          setShowCaptcha(true);
          setError("Too many failed attempts. Please solve the CAPTCHA to continue.");
        } else {
          setError(`Invalid super admin credentials. (${3 - newAttempts} attempts left)`);
        }
      }
    } catch (err) {
      txLogger.error("auth", "superadmin_login_error", {
        error: err,
        context: { user_id: username },
      });
      setError("A network error occurred. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };



  const handleCaptchaSubmit = (e) => {
    e.preventDefault();
    if (userCaptchaInput.toUpperCase() === captchaValue) {
      setShowCaptcha(false);
      setFailedAttempts(0);
      setUserCaptchaInput("");
      setError("");
      setPassword("");
    } else {
      setError("Incorrect CAPTCHA. Please try again.");
      setCaptchaValue(generateCaptcha());
      setUserCaptchaInput("");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--background)] p-4 font-sans text-[var(--foreground)] relative overflow-hidden transition-colors duration-300">
      <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
        <div className="w-[50vw] h-[50vw] bg-[var(--primary)] opacity-10 blur-[120px] rounded-full mix-blend-screen transition-colors duration-300"></div>
      </div>

      <div className="w-full max-w-md bg-[var(--card-bg)] border border-[var(--border-color)] rounded-3xl p-8 sm:p-10 shadow-2xl relative z-10 transition-colors duration-300">
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[var(--primary)] to-[var(--secondary)] flex items-center justify-center text-white shadow-[0_0_20px_var(--lead-glow)] mb-4 transition-all duration-300">
            <svg
              width="32"
              height="32"
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
          <h1 className="text-2xl font-black tracking-tight text-[var(--foreground)]">
            Super Admin Portal
          </h1>
          <p className="text-[var(--foreground-muted)] text-sm mt-1 font-medium">
            {showCaptcha ? "Security Verification Required" : "Restricted access. Sign in to continue."}
          </p>
        </div>

        {error && (
          <div className="mb-5 bg-[var(--logo-politico-red, #ef4444)]/10 border border-[var(--logo-politico-red, #ef4444)]/20 text-[var(--logo-politico-red, #ef4444)] text-xs font-bold px-4 py-3 rounded-xl text-center">
            {error}
          </div>
        )}

        {showCaptcha ? (
          // --- CAPTCHA FORM ---
          <form onSubmit={handleCaptchaSubmit} className="space-y-5 animate-fade-in">
            <div className="flex flex-col items-center bg-[var(--background)] border border-[var(--border-color)] p-6 rounded-xl">
              <span className="text-xs text-[var(--foreground-muted)] uppercase tracking-widest font-bold mb-2">Type this code</span>
              <div className="text-3xl font-black tracking-[0.3em] text-[var(--primary)] select-none bg-[var(--card-bg)] px-6 py-3 rounded-lg border border-[var(--primary)]/20 line-through decoration-[var(--foreground-muted)] decoration-2">
                {captchaValue}
              </div>
            </div>
            
            <div>
              <input
                type="text"
                value={userCaptchaInput}
                onChange={(e) => setUserCaptchaInput(e.target.value.toUpperCase())}
                className="w-full text-center tracking-[0.2em] font-bold bg-[var(--background)] border border-[var(--border-color)] text-[var(--foreground)] px-4 py-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/50 focus:border-[var(--primary)] transition-all font-mono"
                placeholder="ENTER CAPTCHA"
                required
              />
            </div>

            <button
              type="submit"
              className="w-full bg-[var(--primary)] text-white font-bold py-3.5 rounded-xl shadow-[0_4px_15px_var(--lead-glow)] hover:opacity-90 active:scale-[0.98] transition-all"
            >
              Verify & Return to Login
            </button>
          </form>
        ) : (
          // --- STANDARD LOGIN FORM ---
          <form onSubmit={handleLogin} className="space-y-5 animate-fade-in">
            <div>
              <label
                htmlFor="username"
                className="block text-xs font-bold text-[var(--foreground-muted)] uppercase tracking-wider mb-2"
              >
                Username
              </label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-[var(--background)] border border-[var(--border-color)] text-[var(--foreground)] px-4 py-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/50 focus:border-[var(--primary)] transition-all font-medium"
                placeholder="Enter admin username"
                required
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="block text-xs font-bold text-[var(--foreground-muted)] uppercase tracking-wider mb-2"
              >
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-[var(--background)] border border-[var(--border-color)] text-[var(--foreground)] px-4 py-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-[var(--primary)]/50 focus:border-[var(--primary)] transition-all font-medium"
                placeholder="••••••••"
                required
              />
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full bg-[var(--primary)] text-white font-bold py-3.5 rounded-xl shadow-[0_4px_15px_var(--lead-glow)] hover:opacity-90 active:scale-[0.98] transition-all flex items-center justify-center gap-2 mt-2 disabled:opacity-70 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <>
                  <svg
                    className="w-5 h-5 animate-spin"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  Authenticating...
                </>
              ) : (
                "Secure Admin Login"
              )}
            </button>
          </form>
        )}

        <div className="mt-8 pt-6 border-t border-[var(--border-color)] text-center">
          <p className="text-xs text-[var(--foreground-muted)] font-medium">
            Not a super admin?{" "}
            <button
              type="button"
              onClick={onNavigateToUserLogin}
              className="text-[var(--primary)] font-bold hover:underline transition-all bg-transparent border-none p-0 cursor-pointer"
            >
              Standard Login
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}