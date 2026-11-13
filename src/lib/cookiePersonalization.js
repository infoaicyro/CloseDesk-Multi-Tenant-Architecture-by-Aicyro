// src/lib/cookiePersonalization.js
export const CONSENT_COOKIE_NAME = "aicyro_cookie_consent";
export const ANON_ID_COOKIE = "aicyro_anon_id";

export function setStrictCookie(name, value, days = 30) {
  if (typeof window === "undefined") return;
  const expires = new Date();
  expires.setTime(expires.getTime() + days * 24 * 60 * 60 * 1000);
  document.cookie = `${name}=${encodeURIComponent(
    JSON.stringify(value),
  )};expires=${expires.toUTCString()};path=/;SameSite=Strict;Secure`;
}

export function getStrictCookie(name) {
  if (typeof window === "undefined") return null;
  const match = document.cookie.match(new RegExp("(^| )" + name + "=([^;]+)"));
  if (match) {
    try {
      return JSON.parse(decodeURIComponent(match[2]));
    } catch (e) {
      return null;
    }
  }
  return null;
}

export function getOrCreateAnonId() {
  if (typeof window === "undefined") return null;
  let anonId = getStrictCookie(ANON_ID_COOKIE);
  if (!anonId) {
    anonId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `anon_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    setStrictCookie(ANON_ID_COOKIE, anonId, 30);
  }
  return anonId;
}