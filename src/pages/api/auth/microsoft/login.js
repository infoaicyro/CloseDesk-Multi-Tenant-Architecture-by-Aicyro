// src/pages/api/auth/microsoft/login.js
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

  // 1. Extract initiating operator and tenant context from verified session
  const session = await extractSession(req);
  if (!session) {
    return res.status(401).json({
      error: "Authentication required to initiate Microsoft OAuth account linking.",
    });
  }

  // 2. Feature Enablement & Config Gate
  const config = getProviderConfig("microsoft", req);
  if (!config.enabled) {
    return res.status(503).json({
      error: "Microsoft OAuth provider is not configured or disabled.",
      provider: "microsoft",
      status: "disabled",
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
    provider: "microsoft",
    redirectUri,
    codeVerifier,
  });

  // 5. Construct Microsoft authorization URL with least necessary scopes and state binding
  const authUrl = new URL(config.authUrl);
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("response_mode", "query");
  authUrl.searchParams.set("scope", config.scopes);
  authUrl.searchParams.set("prompt", "consent");
  authUrl.searchParams.set("state", stateToken);
  authUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", codeChallengeMethod);

  return res.redirect(authUrl.toString());
}
