// src/pages/api/auth/google/callback.js
import { db } from "@/lib/firebase";
import { ref } from "firebase/database";
import { safeDbUpdate } from "@/lib/safeDb";
import {
  getProviderConfig,
  verifyAndConsumeOAuthState,
  validateIdToken,
  buildPostMessageHtml,
  getAppBaseUrl,
} from "@/lib/oauthService";

export default async function handler(req, res) {
  const { code, state, error } = req.query || {};
  const allowedOrigin = getAppBaseUrl(req);

  // 1. Check for provider callback error
  if (error || !code) {
    return res.status(400).send(
      buildPostMessageHtml({
        status: "error",
        provider: "google",
        error: error || "Authorization code missing from Google callback",
        allowedOrigin,
      })
    );
  }

  // 2. Reject absent or missing state parameter
  if (!state) {
    return res.status(400).send(
      buildPostMessageHtml({
        status: "error",
        provider: "google",
        error: "OAuth state parameter missing. CSRF protection check failed.",
        allowedOrigin,
      })
    );
  }

  // 3. Cryptographically verify state token, tenant binding, and replay defense
  const stateCheck = verifyAndConsumeOAuthState(state, "google");
  if (!stateCheck.valid) {
    return res.status(403).send(
      buildPostMessageHtml({
        status: "error",
        provider: "google",
        error: stateCheck.error || "Invalid or expired OAuth state parameter.",
        allowedOrigin,
      })
    );
  }

  const { sub: operator, tenantId, nonce, cv: codeVerifier, redirectUri } = stateCheck.payload;
  const config = getProviderConfig("google", req);

  try {
    // 4. Exchange authorization code for tokens
    const bodyParams = {
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: redirectUri || config.redirectUri,
      grant_type: "authorization_code",
    };
    if (codeVerifier) {
      bodyParams.code_verifier = codeVerifier;
    }

    const tokenRes = await fetch(config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(bodyParams),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      throw new Error(tokenData.error_description || tokenData.error || "Token exchange failed with Google");
    }

    let userEmail = null;

    // 5. Cryptographic ID Token validation (not simple base64 decoding!)
    if (tokenData.id_token) {
      const idCheck = validateIdToken(tokenData.id_token, {
        expectedClientId: config.clientId,
        expectedNonce: nonce,
        provider: "google",
      });

      if (!idCheck.valid) {
        throw new Error(`ID token verification failed: ${idCheck.error}`);
      }
      userEmail = idCheck.email;
    }

    // Fallback: fetch user profile if email claim was not present in ID token
    if (!userEmail && tokenData.access_token) {
      const userRes = await fetch(config.userinfoUrl, {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const userData = await userRes.json();
      userEmail = userData.email;
    }

    if (!userEmail) {
      throw new Error("Could not extract verified email from Google account");
    }

    // 6. Strict Tenant Isolation Storage:
    // SuperAdmin connects to global settings/email_config.
    // Tenant operators connect to their specific tenant partition tenants/{tenantId}/email_config.
    const targetPath = tenantId && tenantId !== "default"
      ? `tenants/${tenantId}/email_config`
      : "settings/email_config";

    await safeDbUpdate(ref(db, targetPath), {
      provider: "google_oauth",
      smtpEmail: userEmail,
      refreshToken: tokenData.refresh_token || null,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      connectedAt: Date.now(),
      connectedBy: operator,
      status: "connected",
    }, 800);

    // 7. Dispatch connection status (NEVER raw tokens) to exact trusted origin
    return res.status(200).send(
      buildPostMessageHtml({
        status: "connected",
        provider: "google",
        tenantId,
        allowedOrigin,
      })
    );

  } catch (err) {
    return res.status(500).send(
      buildPostMessageHtml({
        status: "error",
        provider: "google",
        tenantId,
        error: err.message || "OAuth linking failed",
        allowedOrigin,
      })
    );
  }
}
