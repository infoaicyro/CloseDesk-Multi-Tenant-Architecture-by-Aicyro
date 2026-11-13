// src/lib/ruleBook.js
import { composeTenantPolicy } from "./policyEngine";
import { COMMON_POLICY_VERSION } from "./policyContract";

/**
 * ============================================================================
 * SINGLE SOURCE OF TRUTH ARCHITECTURE & BOUNDARIES (CD08)
 * ============================================================================
 * Policy Version: 2.15.0
 *
 * --- VOICE ROLLBACK PROCEDURE (KILL SWITCH) ---
 * If production issues occur with the Realtime Voice API (e.g., latency,
 * hallucination, or abuse), you can disable the Voice Agent without affecting
 * the Text Chatbot.
 *
 * HOW TO DISABLE:
 * 1. In Firebase Realtime Database, navigate to `settings/chatbot_config`
 *    or `tenants/${tenantId}/chatbot_config`.
 * 2. Add or set the boolean field `"voiceEnabled": false`.
 * 3. The frontend will immediately hide the Voice switch button, and the
 *    /api/openai-token endpoint will block further connection attempts.
 * ============================================================================
 */
export const POLICY_VERSION = COMMON_POLICY_VERSION;

export async function getMasterRuleBook(
  mode = "text",
  currentLeadData = null,
  retrievedKnowledge = "",
  tenantId = "default"
) {
  const result = await composeTenantPolicy({
    tenantId,
    mode,
    currentLeadData,
    retrievedKnowledge,
  });

  return {
    instructions: result.instructions,
    botConfig: result.botConfig,
    metadata: result.metadata,
  };
}
