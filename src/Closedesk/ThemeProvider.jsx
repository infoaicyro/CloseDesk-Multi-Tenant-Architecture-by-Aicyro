// src/Closedesk/ThemeProvider.jsx
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { ref, onValue } from "firebase/database";
import { db } from "../lib/firebase";

const PUBLIC_THEME_KEY = "closeDesk-theme";
const PUBLIC_THEME_EVENT = "closeDesk-theme-change";

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

export default function ThemeProvider({ children }) {
  const router = useRouter();

  // Check if we are currently anywhere inside the Admin Portal (/lg)
  const isDashboardRoute = router.pathname.startsWith("/lg");

  const [themeData, setThemeData] = useState(null);

  // 1. Fetch Firebase data once & listen for live changes
  useEffect(() => {
    const username = localStorage.getItem("currentUser");
    if (!username) return;

    const appearanceRef = ref(db, `users/${username}/appearance`);

    const unsubscribe = onValue(appearanceRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.val();
        setThemeData(data);
        localStorage.setItem("aicyro_appearance", JSON.stringify(data));
      } else {
        const savedSettings = JSON.parse(
          localStorage.getItem("aicyro_appearance"),
        );
        if (savedSettings) setThemeData(savedSettings);
      }
    });

    return () => unsubscribe();
  }, []);

  // 2. Core Theme Applier function
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
          : null
        : `${hue}-${resolvedMode}`;

    if (themeString) {
      document.documentElement.setAttribute("data-theme", themeString);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }

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
    document.documentElement.style.setProperty(
      "--secondary",
      adjustedSecondary,
    );
  };

  // 3. Reactively apply themes based on route navigation AND database updates
  useEffect(() => {
    const applyPublicSiteTheme = () => {
      const mode = localStorage.getItem(PUBLIC_THEME_KEY) || "light";
      applyThemeToDOM(mode, "default", 500);
    };

    // Marketing site: use the navbar toggle preference (default light)
    if (!isDashboardRoute) {
      applyPublicSiteTheme();
      window.addEventListener(PUBLIC_THEME_EVENT, applyPublicSiteTheme);
      return () =>
        window.removeEventListener(PUBLIC_THEME_EVENT, applyPublicSiteTheme);
    }

    // Admin dashboard: use saved appearance settings (default light)
    if (!themeData) {
      applyThemeToDOM("light", "default", 500);
      return;
    }

    const mode = themeData.mode || "light";
    const hue = themeData.hue || "default";
    const shade = themeData.shade || 500;

    applyThemeToDOM(mode, hue, shade);
  }, [themeData, isDashboardRoute]);

  return <>{children}</>;
}
