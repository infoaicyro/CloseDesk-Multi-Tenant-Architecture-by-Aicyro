# CloseDesk Voice AI - Production Readiness & Sign-Off

**Document Version:** 1.0
**Target Release Date:** [YYYY-MM-DD]
**Policy Version Deployed:** 2.11.0

## Purpose

This document serves as the formal gate for enabling the Realtime Voice AI feature in the CloseDesk production environment. Explicit sign-off from both the Product Owner (PO) and Quality Assurance (QA) is strictly required before the `voiceEnabled` feature flag is set to `true`.

---

## Part 1: Architecture & Feature Validation Checklist

_QA and Engineering must verify all systems are functioning as defined in the architectural policies._

### 1. Core Conversational Mechanics

- [ ] **Shared-Policy Parity:** Voice and Text modes utilize the same underlying `MASTER_RULEBOOK`, ensuring answers to pricing, objections, and integrations are identical.
- [ ] **Turn Detection & Interruption:** VAD (Voice Activity Detection) is tuned (`threshold: 0.8`, `silence_duration: 800ms`) to prevent the bot from looping on background noise or cutting the user off too early.
- [ ] **Transcript Accuracy (STT Confirmation):** The bot explicitly repeats high-risk fields (Email, Phone, CRM Names, URLs) for verbal confirmation before executing backend tools.

### 2. Privacy & Compliance

- [ ] **Anonymous Flow:** Users can navigate the pricing, integration, and demo-explanation flows entirely anonymously without being gatekept by PII requests.
- [ ] **Privacy Refusal:** Spoken refusals (e.g., "I won't give my phone number") successfully invoke the `record_privacy_preference` tool. The bot does not re-ask for this data in Voice or Text mode.
- [ ] **Retention & Deletion:** "Right to be forgotten" requests successfully trigger `request_data_deletion`, which completely wipes the CRM context patch AND forcefully deletes the `transcripts/{session_id}` database node.
- [ ] **Audio Ephemerality:** No raw audio (`.wav`, `.mp3`) is stored on Aicyro servers. The privacy disclosure accurately reflects this behavior.

### 3. Execution & Fallbacks

- [ ] **Action Tools & Human Handoff:** Requests for human assistance immediately halt the qualification loop and invoke `request_human_handoff` with the current conversation summary attached.
- [ ] **False Action Prevention:** The AI never verbally confirms a webhook, audit, or callback until the backend tool returns `"success": true`.
- [ ] **Text Fallback & Accessibility:** Microphone denial, WebRTC failure, or Audio Playback blocks gracefully degrade to the Text UI. Screen readers are supported via `aria-live` and `aria-label` tags on all voice controls.

### 4. Security & Telemetry

- [ ] **Cross-Session Security:** Token generation and tool syncing enforce strict `session_id` Regex validation, preventing Path Traversal payload injection.
- [ ] **Rate Limiting:** IP-based rate limiting (Max 5 WebRTC connections per minute) is active on the `/api/openai-token` endpoint.
- [ ] **Zero-PII Telemetry:** Millisecond-level latency metrics (VAD, TTFB, STT) are logged to `voice_telemetry` without exposing raw transcripts or user identities.

---

## Part 2: Launch State & Accepted Limitations

### Rollback Procedure Verification

- [ ] **Tested:** The `voiceEnabled: false` kill-switch was toggled in the Firebase `settings/chatbot_config` node.
- [ ] **Verified:** The frontend "Switch to Voice" button disappeared instantly without requiring a code deployment.
- [ ] **Verified:** The `/api/openai-token` endpoint correctly returned a `403 Forbidden` rather than generating billed OpenAI tokens.

### Accepted Limitations for v1 Launch

_The following are known constraints of the OpenAI Realtime beta and our current architecture, accepted for the MVP launch:_

1. **Accent Sensitivity:** The Whisper-1 STT model may occasionally struggle with heavy regional accents or highly specific, non-standard trade terms. (Mitigated by the STT Confirmation Protocol).
2. **Autoplay Policies:** Strict mobile browsers (e.g., iOS Safari Low Power Mode) may block the WebRTC audio playback. (Mitigated by our text-transcript fallback UI streaming alongside the audio).
3. **Language:** The voice agent is currently optimized and prompted strictly for English.

---

## Part 3: Formal Acceptance Criteria & Sign-Off

To proceed with the production launch, all criteria below must be met and signed off.

- [ ] **Zero Critical Defects:** There are exactly ZERO open P0 or P1 defects related to privacy evasion, cross-session data leakage, false action confirmations, or conversation state loss.
- [ ] **Test Suite Passed:** The `VOICE_QA_TEST_SUITE.md` regression suite has been executed and passed 100%.
- [ ] **Audio Review:** The Product Owner has reviewed the generated QA recordings (`voice_qa_harness.js`) and approved the pronunciation, pacing, and tone of the default preset (`voice: "ash"`).

### Signatures

**Quality Assurance (QA) Lead**
_I verify that the regression suite has passed and no blocking defects exist._

- **Name:**
- **Date:**
- **Signature:**

**Product Owner (PO)**
_I accept the listed limitations and approve the Voice AI behavior for production prospects._

- **Name:**
- **Date:**
- **Signature:**

---

_Once signed, Dev/Ops is authorized to set_ `"voiceEnabled": true` _in the production Firebase configuration._
