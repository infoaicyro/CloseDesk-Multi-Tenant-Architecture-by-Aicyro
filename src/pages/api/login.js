// src/pages/api/login.js
import { ref, get, update } from "firebase/database";
import { withApiLogger } from "../../lib/apiMiddleware";
import { db } from "../../lib/firebase"; 
import { recordAuditTrail } from "../../lib/auditTracer";
import { verifyPassword, hashPassword } from "../../lib/authCrypto";
import {
  signSessionToken,
  serializeSessionCookie,
} from "../../lib/authSession";
import {
  checkRateLimit,
  recordFailedAttempt,
  resetRateLimit,
  getClientIp,
} from "../../lib/persistentRateLimiter";

const checkUserMatch = (user, targetUser, targetPass) => {
  if (!user || typeof user !== "object") return { match: false, needsUpgrade: false };
  const uName = (user.name || user.username || "").trim().toLowerCase();
  const tName = (targetUser || "").trim().toLowerCase();
  if (!uName || uName !== tName) {
    return { match: false, needsUpgrade: false };
  }
  return verifyPassword(targetPass, String(user.password || ""));
};

async function handler(req, res, apiLogger) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { username, password, tenant_id } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }

  const cleanUsername = String(username).trim();
  const cleanPassword = String(password).trim();
  const cleanTenantId = tenant_id ? String(tenant_id).trim() : null;
  const clientIp = getClientIp(req);
  const rateLimitKey = `login_${clientIp}_${cleanUsername.toLowerCase()}`;

  // 1. Check persistent rate limiting
  const rateCheck = await checkRateLimit(rateLimitKey, {
    maxAttempts: 5,
    lockoutMs: 15 * 60 * 1000,
  });

  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: `Too many failed login attempts. Locked for ${Math.ceil(
        rateCheck.retryAfter / 60
      )} minutes.`,
      retryAfter: rateCheck.retryAfter,
    });
  }

  try {
    let isValidUser = false;
    let matchedTenantId = cleanTenantId || "default";
    let matchedUserNode = null; // for auto-upgrading password
    let matchedUserKey = null;

    // 1. Check tenant-specific partition if tenant_id is provided
    if (cleanTenantId && cleanTenantId !== "default") {
      const tenantUsersRef = ref(db, `tenants/${cleanTenantId}/users`);
      const tenantUsersSnap = await get(tenantUsersRef);
      if (tenantUsersSnap.exists()) {
        const users = tenantUsersSnap.val();
        const userEntries = Array.isArray(users)
          ? users.map((u, i) => [i, u])
          : Object.entries(users);
        for (const [k, user] of userEntries) {
          const { match, needsUpgrade } = checkUserMatch(user, cleanUsername, cleanPassword);
          if (match) {
            isValidUser = true;
            matchedTenantId = cleanTenantId;
            matchedUserNode = `tenants/${cleanTenantId}/users/${k}`;
            if (needsUpgrade) {
              try {
                await update(ref(db, matchedUserNode), { password: hashPassword(cleanPassword) });
              } catch (e) {
                // ignore upgrade write error
              }
            }
            break;
          }
        }
      }
    }

    // 2. If not matched yet, check root login partition
    if (!isValidUser) {
      const loginRef = ref(db, "login");
      const snapshot = await get(loginRef);

      if (snapshot.exists()) {
        const users = snapshot.val();
        const userEntries = Array.isArray(users)
          ? users.map((u, i) => [i, u])
          : Object.entries(users);
        for (const [k, user] of userEntries) {
          const { match, needsUpgrade } = checkUserMatch(user, cleanUsername, cleanPassword);
          if (match) {
            isValidUser = true;
            matchedTenantId = "default";
            matchedUserNode = `login/${k}`;
            if (needsUpgrade) {
              try {
                await update(ref(db, matchedUserNode), { password: hashPassword(cleanPassword) });
              } catch (e) {
                // ignore
              }
            }
            break;
          }
        }
      }
    }

    // 3. Fallback: Search across all tenants if no explicit tenant_id was given
    if (!isValidUser && !cleanTenantId) {
      const allTenantsRef = ref(db, "tenants");
      const allTenantsSnap = await get(allTenantsRef);
      if (allTenantsSnap.exists()) {
        const tenantsData = allTenantsSnap.val();
        for (const [tId, tVal] of Object.entries(tenantsData)) {
          if (tVal && tVal.users) {
            const userEntries = Array.isArray(tVal.users)
              ? tVal.users.map((u, i) => [i, u])
              : Object.entries(tVal.users);
            for (const [k, user] of userEntries) {
              const { match, needsUpgrade } = checkUserMatch(user, cleanUsername, cleanPassword);
              if (match) {
                isValidUser = true;
                matchedTenantId = tId;
                matchedUserNode = `tenants/${tId}/users/${k}`;
                if (needsUpgrade) {
                  try {
                    await update(ref(db, matchedUserNode), { password: hashPassword(cleanPassword) });
                  } catch (e) {
                    // ignore
                  }
                }
                break;
              }
            }
            if (isValidUser) break;
          }
        }
      }
    }

    if (isValidUser) {
      // Reset rate limiter on successful login
      await resetRateLimit(rateLimitKey);

      // Issue signed session token with role: "tenant_operator"
      const token = signSessionToken({
        sub: cleanUsername,
        role: "tenant_operator",
        tenantId: matchedTenantId,
        stepUpVerified: true,
        sessionVersion: 1,
        expiresIn: 24 * 60 * 60, // 24 hours
      });

      // Deliver via HttpOnly SameSite=Strict cookie
      const sessionCookie = serializeSessionCookie(token, 24 * 60 * 60);
      res.setHeader("Set-Cookie", sessionCookie);

      recordAuditTrail(apiLogger, "login_success", {
        who: cleanUsername,
        target: "pulse_dashboard",
        tenant_id: matchedTenantId,
        status: "success",
      });

      return res.status(200).json({
        success: true,
        tenant_id: matchedTenantId,
        token,
      });
    } else {
      const attemptResult = await recordFailedAttempt(rateLimitKey, {
        maxAttempts: 5,
        lockoutMs: 15 * 60 * 1000,
      });

      recordAuditTrail(apiLogger, "login_failure", {
        who: cleanUsername,
        target: "pulse_dashboard",
        status: "failed",
        reason: "Invalid credentials",
        attemptsRemaining: attemptResult.locked ? 0 : 5 - attemptResult.count,
      });

      if (attemptResult.locked) {
        return res.status(429).json({
          error: "Too many failed login attempts. Account locked for 15 minutes.",
          retryAfter: attemptResult.retryAfter,
        });
      }

      return res.status(401).json({
        error: "Invalid username or password",
        attemptsRemaining: 5 - attemptResult.count,
      });
    }
  } catch (error) {
    apiLogger.error("Login Error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export default withApiLogger(handler, "Login-API");
