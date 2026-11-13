// src/pages/api/superadmin/verify-pin.js
import { ref, get, update } from "firebase/database";
import { withApiLogger } from "../../../lib/apiMiddleware";
import { db } from "../../../lib/firebase";
import { recordAuditTrail } from "../../../lib/auditTracer";
import { verifyPassword, hashPassword } from "../../../lib/authCrypto";
import {
  extractSession,
  signSessionToken,
  serializeSessionCookie,
} from "../../../lib/authSession";
import {
  checkRateLimit,
  recordFailedAttempt,
  resetRateLimit,
  getClientIp,
} from "../../../lib/persistentRateLimiter";
import { verifyTotp, verifyRecoveryCode } from "../../../lib/totp";

const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_DURATION_MS = 15 * 60 * 1000;

async function handler(req, res, apiLogger) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { username, pin, code } = req.body || {};
  const candidateCode = String(code || pin || "").trim();

  if (!username || !candidateCode) {
    return res.status(400).json({ error: "Username and verification code are required" });
  }

  const cleanUsername = String(username).trim();
  const clientIp = getClientIp(req);
  const rateKey = `secondary_factor_${clientIp}_${cleanUsername.toLowerCase()}`;

  // 1. Check persistent rate limit across cold starts
  const rateCheck = await checkRateLimit(rateKey, {
    maxAttempts: MAX_PIN_ATTEMPTS,
    lockoutMs: PIN_LOCKOUT_DURATION_MS,
  });

  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: `Too many failed verification attempts. Locked for ${Math.ceil(
        rateCheck.retryAfter / 60
      )} minutes.`,
      retryAfter: rateCheck.retryAfter,
    });
  }

  // 2. Validate current Super Admin pre-step-up or active session
  const currentSession = await extractSession(req);
  if (!currentSession || currentSession.role !== "superadmin") {
    return res.status(401).json({
      error: "Active Super Admin session required to complete secondary factor verification",
    });
  }

  if (currentSession.sub.toLowerCase() !== cleanUsername.toLowerCase()) {
    return res.status(403).json({
      error: "Session identity does not match verification target",
    });
  }

  try {
    const adminRef = ref(db, "superAdmin");
    const snapshot = await get(adminRef);

    if (!snapshot.exists()) {
      return res.status(500).json({ error: "SuperAdmin configuration unavailable" });
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
        matchedAdmin = a;
        matchedIndexOrKey = isArray ? i : a._key;
        break;
      }
    }

    if (!matchedAdmin) {
      return res.status(404).json({ error: "Super Admin account not found" });
    }

    let factorVerified = false;
    let verifiedFactorType = "pin";

    // 3A. Check TOTP (RFC 6238 6-digit code) if configured
    const totpSecret =
      process.env.SUPERADMIN_TOTP_SECRET || matchedAdmin.totpSecret || null;
    if (totpSecret && /^\d{6}$/.test(candidateCode)) {
      if (verifyTotp(candidateCode, totpSecret)) {
        factorVerified = true;
        verifiedFactorType = "totp";
      }
    }

    // 3B. Check Emergency Recovery Code if configured
    if (!factorVerified && candidateCode.replace(/[\s-]/g, "").length >= 8) {
      const recoveryCodes =
        matchedAdmin.recoveryCodes ||
        (process.env.SUPERADMIN_RECOVERY_CODES
          ? process.env.SUPERADMIN_RECOVERY_CODES.split(",").map((c) => c.trim())
          : []);

      if (recoveryCodes && recoveryCodes.length > 0) {
        const matchedIdx = verifyRecoveryCode(candidateCode, recoveryCodes);
        if (matchedIdx !== -1) {
          factorVerified = true;
          verifiedFactorType = "recovery_code";
        }
      }
    }

    // 3C. Secondary PIN Verification (Fallback / Local dev)
    if (!factorVerified && matchedAdmin.pin) {
      const { match, needsUpgrade } = verifyPassword(
        candidateCode,
        String(matchedAdmin.pin)
      );

      if (match) {
        factorVerified = true;
        verifiedFactorType = "secondary_pin";

        if (needsUpgrade) {
          try {
            const newHashedPin = hashPassword(candidateCode);
            const targetPath = `superAdmin/${matchedIndexOrKey}`;
            await update(ref(db, targetPath), { pin: newHashedPin });
          } catch (upgradeErr) {
            apiLogger.warn("auth", "pin_upgrade_failed", {
              error: upgradeErr.message,
            });
          }
        }
      }
    }

    if (factorVerified) {
      // Reset rate limiter on success
      await resetRateLimit(rateKey);

      // Issue upgraded session token with stepUpVerified: true
      const upgradedToken = signSessionToken({
        sub: matchedAdmin.name,
        role: "superadmin",
        tenantId: "superadmin",
        stepUpVerified: true,
        sessionVersion: currentSession.sessionVersion || 1,
        expiresIn: 24 * 60 * 60, // 24 hours
      });

      // Deliver via HttpOnly SameSite=Strict cookie
      const sessionCookie = serializeSessionCookie(upgradedToken, 24 * 60 * 60);
      res.setHeader("Set-Cookie", sessionCookie);

      recordAuditTrail(apiLogger, "pin_verification_success", {
        who: cleanUsername,
        target: "sensitive_action",
        status: "success",
        factorType: verifiedFactorType,
      });

      return res.status(200).json({
        success: true,
        verified: true,
        factorType: verifiedFactorType,
        token: upgradedToken,
      });
    } else {
      const attemptResult = await recordFailedAttempt(rateKey, {
        maxAttempts: MAX_PIN_ATTEMPTS,
        lockoutMs: PIN_LOCKOUT_DURATION_MS,
      });

      recordAuditTrail(apiLogger, "pin_verification_failure", {
        who: cleanUsername,
        target: "sensitive_action",
        status: "failed",
        reason: "Invalid verification code or PIN",
        attemptsRemaining: attemptResult.locked ? 0 : MAX_PIN_ATTEMPTS - attemptResult.count,
      });

      if (attemptResult.locked) {
        return res.status(429).json({
          error: "Too many failed verification attempts. Locked for 15 minutes.",
          retryAfter: attemptResult.retryAfter,
        });
      }

      return res.status(401).json({
        error: "Invalid Secondary Verification PIN or Code. Access denied.",
        attemptsRemaining: MAX_PIN_ATTEMPTS - attemptResult.count,
      });
    }
  } catch (error) {
    apiLogger.error("PIN Verification Error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export default withApiLogger(handler, "SuperAdmin-VerifyPin-API");
