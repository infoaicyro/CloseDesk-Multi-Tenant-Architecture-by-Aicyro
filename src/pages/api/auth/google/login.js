// src/pages/api/auth/google/login.js
import { extractSession } from "@/lib/authSession";
import {
  getProviderConfig,
  generateOAuthState,
  generatePkce,
  getAppBaseUrl,
} from "@/lib/oauthService";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 1. Feature Enablement & Config Gate
  const config = getProviderConfig("google", req);
  if (!config.enabled) {
    return res.status(503).json({
      error: "Google OAuth provider is not configured or disabled.",
      provider: "google",
      status: "disabled",
    });
  }

  // 2. Extract initiating operator and tenant context from verified session
  const session = await extractSession(req);
  if (!session) {
    return res.status(401).json({
      error: "Authentication required to initiate Google OAuth account linking.",
    });
  }

  const operator = session.sub;
  const tenantId = session.role === "superadmin"
    ? (req.query?.tenant_id || session.tenantId || "default")
    : (session.tenantId || "default");

  // 3. Generate PKCE parameters (RFC 7636)
  const { codeVerifier, codeChallenge, codeChallengeMethod } = generatePkce();

  // 4. Generate cryptographically bound state token
  const redirectUri = config.redirectUri;
  const { stateToken, nonce } = generateOAuthState({
    operator,
    tenantId,
    provider: "google",
    redirectUri,
    codeVerifier,
  });

  // 5. Construct Google authorization URL with least necessary scopes and state binding
  const authUrl = new URL(config.authUrl);
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", config.scopes);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", stateToken);
  authUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", codeChallengeMethod);

  return res.redirect(authUrl.toString());
}
