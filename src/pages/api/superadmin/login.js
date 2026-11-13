// src/pages/api/superadmin/login.js
import { ref, get, update } from "firebase/database";
import { withApiLogger } from "../../../lib/apiMiddleware";
import { db } from "../../../lib/firebase";
import { recordAuditTrail } from "../../../lib/auditTracer";
import { verifyPassword, hashPassword } from "../../../lib/authCrypto";
import {
  signSessionToken,
  serializeSessionCookie,
} from "../../../lib/authSession";
import {
  checkRateLimit,
  recordFailedAttempt,
  resetRateLimit,
  getClientIp,
} from "../../../lib/persistentRateLimiter";

async function handler(req, res, apiLogger) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  const cleanUsername = String(username).trim();
  const cleanPassword = String(password).trim();
  const clientIp = getClientIp(req);
  const rateLimitKey = `superadmin_login_${clientIp}_${cleanUsername.toLowerCase()}`;

  // 1. Persistent rate-limiting check
  const rateCheck = await checkRateLimit(rateLimitKey, {
    maxAttempts: 5,
    lockoutMs: 15 * 60 * 1000,
  });

  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: `Too many failed login attempts. Account locked for ${Math.ceil(
        rateCheck.retryAfter / 60
      )} minutes.`,
      retryAfter: rateCheck.retryAfter,
    });
  }

  try {
    const adminRef = ref(db, "superAdmin");
    const snapshot = await get(adminRef);

    if (!snapshot.exists()) {
      return res.status(500).json({ error: "SuperAdmin database configuration unavailable" });
    }

    const adminData = snapshot.val();
    let adminList = [];
    let isArray = Array.isArray(adminData);

    if (isArray) {
      adminList = adminData;
    } else if (typeof adminData === "object" && adminData !== null) {
      adminList = Object.entries(adminData).map(([k, v]) => ({ ...v, _key: k }));
    }

    let matchedAdmin = null;
    let matchedIndexOrKey = null;

    for (let i = 0; i < adminList.length; i++) {
      const a = adminList[i];
      if (a && a.name && a.name.toLowerCase() === cleanUsername.toLowerCase()) {
        const { match, needsUpgrade } = verifyPassword(cleanPassword, String(a.password || ""));
        if (match) {
          matchedAdmin = a;
          matchedIndexOrKey = isArray ? i : a._key;

          // Backwards compatibility: Auto-upgrade legacy plaintext password to salted scrypt
          if (needsUpgrade) {
            try {
              const newHash = hashPassword(cleanPassword);
              const targetPath = isArray
                ? `superAdmin/${matchedIndexOrKey}`
                : `superAdmin/${matchedIndexOrKey}`;
              await update(ref(db, targetPath), { password: newHash });
              apiLogger.info("auth", "password_upgraded_to_scrypt", {
                who: cleanUsername,
              });
            } catch (upgradeErr) {
              apiLogger.warn("auth", "password_upgrade_failed", {
                error: upgradeErr.message,
              });
            }
          }
          break;
        }
      }
    }

    if (matchedAdmin) {
      // Clear failed rate limit attempts
      await resetRateLimit(rateLimitKey);

      // Issue signed session token with stepUpVerified: false (must verify second factor)
      const token = signSessionToken({
        sub: matchedAdmin.name,
        role: "superadmin",
        tenantId: "superadmin",
        stepUpVerified: false,
        expiresIn: 15 * 60, // 15 minutes pre-step-up window
      });

      // Deliver via HttpOnly SameSite=Strict cookie
      const sessionCookie = serializeSessionCookie(token, 15 * 60);
      res.setHeader("Set-Cookie", sessionCookie);

      recordAuditTrail(apiLogger, "superadmin_login_success", {
        who: cleanUsername,
        target: "superadmin_console",
        status: "success",
        stepUpRequired: true,
      });

      return res.status(200).json({
        success: true,
        name: matchedAdmin.name,
        stepUpRequired: true,
        token,
      });
    } else {
      // Record failed attempt
      const attemptResult = await recordFailedAttempt(rateLimitKey, {
        maxAttempts: 5,
        lockoutMs: 15 * 60 * 1000,
      });

      recordAuditTrail(apiLogger, "superadmin_login_failure", {
        who: cleanUsername,
        target: "superadmin_console",
        status: "failed",
        reason: "Invalid credentials",
        attemptsRemaining: attemptResult.locked ? 0 : 5 - attemptResult.count,
      });

      if (attemptResult.locked) {
        return res.status(429).json({
          error: "Too many failed login attempts. Locked for 15 minutes.",
          retryAfter: attemptResult.retryAfter,
        });
      }

      return res.status(401).json({
        error: "Invalid super admin credentials",
        attemptsRemaining: 5 - attemptResult.count,
      });
    }
  } catch (error) {
    apiLogger.error("SuperAdmin Login Error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export default withApiLogger(handler, "SuperAdmin-Login-API");
