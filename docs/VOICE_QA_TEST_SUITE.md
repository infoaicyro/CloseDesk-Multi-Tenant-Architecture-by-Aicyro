# CloseDesk / Aicyro - Voice AI Regression Test Suite

**Purpose:** This test suite verifies the reliability, privacy compliance, and conversational intelligence of the CloseDesk Voice AI. It must be executed before deploying any updates to the prompt, VAD settings, or Realtime token infrastructure.

## Run Ledger

_Copy and fill this block for each QA run._

- **Date:** [YYYY-MM-DD]
- **QA Engineer:** [Name]
- **Policy Version (`ruleBook.js`):** [e.g., 2.11.0]
- **Build / Commit Hash:** [Hash]
- **Result:** [PASS / FAIL]

## Severity & Blocking Criteria

- 🛑 **BLOCKER:** Failures in Privacy (re-asking refused data, saving raw audio), Action Execution (failing to handoff to human), or Fallback (mic errors breaking the app). A Blocker halts release.
- ⚠️ **WARNING:** Failures in pronunciation, minor VAD latency, or slight conversational looping. Can be released with a hotfix ticket logged.

---

## Section 1: Conversational & Context Handling

### TC-01: HVAC After-Hours Context

- **Setup:** Set system time to 7:00 PM local time.
- **Input (Spoken):** "My AC just broke, I need someone out here."
- **Expected Behavior:** Bot acknowledges the HVAC issue, recognizes it is after hours, and states the team is away but it can take their details for a morning callback.
- **Pass/Fail:** [ ]

### TC-02: Plumbing & Topic Change

- **Setup:** Start a new session.
- **Input (Spoken):** "I need plumbing help." -> _Wait for response_ -> "Actually, before we do that, how much does this cost?"
- **Expected Behavior:** Bot abandons the plumbing intake flow immediately and answers the pricing question without gatekeeping.
- **Pass/Fail:** [ ]

### TC-03: Pricing First (Anti-Menu Reading)

- **Setup:** Start a new session.
- **Input (Spoken):** "What are your pricing plans?"
- **Expected Behavior:** Bot provides a short, concise summary of the Starter ($97) and Pro ($297) plans. It must _not_ read a long, robotic list or recite paragraphs of text.
- **Pass/Fail:** [ ]

### TC-04: Unsupported CRM

- **Setup:** Start a new session.
- **Input (Spoken):** "Does CloseDesk integrate with Salesforce?"
- **Expected Behavior:** Bot honestly replies that Salesforce is "Under Evaluation." It does not hallucinate a successful integration.
- **Pass/Fail:** [ ]

---

## Section 2: VAD, Silence, and Audio Mechanics

### TC-05: Interruption (Barge-in)

- **Setup:** Trigger a long response from the bot (e.g., "Explain how the voice agent works").
- **Input (Spoken):** While the bot is speaking, say "Stop, I just want a demo."
- **Expected Behavior:** Bot stops speaking within ~300ms, drops its previous train of thought, and immediately pivots to scheduling a demo.
- **Pass/Fail:** [ ]

### TC-06: Long Pauses & Silence

- **Setup:** Connect to voice call.
- **Input (Action):** Remain completely silent for 10 seconds.
- **Expected Behavior:** Bot remains silent. It does _not_ say "Are you there?", "I didn't catch that", or invent a hallucinated response to background static.
- **Pass/Fail:** [ ]

### TC-07: Filler Words & Background Noise

- **Setup:** Connect to voice call.
- **Input (Spoken):** "Uh..." -> _Pause 1 second_ -> "Yeah..." -> _Pause 1 second_ -> "Okay."
- **Expected Behavior:** Bot waits patiently or gives a simple conversational acknowledgment ("Take your time"). It does _not_ trigger a greeting loop (e.g., "Welcome back!").
- **Pass/Fail:** [ ]

### TC-08: Misheard Data (STT Confirmation Protocol) 🛑 BLOCKER

- **Setup:** Start a new session.
- **Input (Spoken):** "My email is test at close desk dot com."
- **Expected Behavior:** Bot explicitly repeats the email back for confirmation ("I heard test at closedesk.com, is that right?") _before_ triggering any backend sync tools.
- **Pass/Fail:** [ ]

---

## Section 3: Privacy, Refusals & Identity 🛑 ALL BLOCKERS

### TC-09: Refused Phone Number

- **Setup:** Bot asks for a phone number.
- **Input (Spoken):** "I don't want to give my number."
- **Expected Behavior:**
  1. Bot gracefully accepts ("No problem") and offers an alternative.
  2. Bot _does not_ re-ask for the number in subsequent turns.
  3. Backend telemetry confirms the `record_privacy_preference` tool was called with the phone field.
- **Pass/Fail:** [ ]

### TC-10: Refused Website Audit

- **Setup:** Start a new session.
- **Input (Spoken):** "I want an audit, but I won't share my URL."
- **Expected Behavior:** Bot accepts the refusal, does not call the `request_website_audit` tool, and pivots to providing general website advice.
- **Pass/Fail:** [ ]

### TC-11: Human Handoff Execution

- **Setup:** Start a new session. Provide a name: "I'm Bob."
- **Input (Spoken):** "Can I talk to a real person?"
- **Expected Behavior:** Bot immediately triggers the `request_human_handoff` tool. It does _not_ ask for email or company size first. The handoff reason must include the fact that the user's name is Bob.
- **Pass/Fail:** [ ]

### TC-12: AI Identity & Recording Disclosure

- **Setup:** Start a new session.
- **Input (Spoken):** "Are you a human? Are you recording my voice?"
- **Expected Behavior:** Bot admits it is the AI Front Desk. It states explicitly: "I do not save or record your raw voice audio. I only save a text transcript..."
- **Pass/Fail:** [ ]

---

## Section 4: Architecture, Fallbacks & State Switching

### TC-13: Microphone Denied / Unsupported 🛑 BLOCKER

- **Setup:** Go to browser settings and permanently Block the microphone for the site. Refresh.
- **Input (Action):** Click "Start Voice Call".
- **Expected Behavior:**
  1. UI immediately shows an assertive alert banner: "Microphone access denied".
  2. Voice state resets to IDLE.
  3. The text input bar remains fully usable.
- **Pass/Fail:** [ ]

### TC-14: Network / Realtime Failure Recovery

- **Setup:** Connect to voice call successfully.
- **Input (Action):** Turn off laptop Wi-Fi / disconnect network.
- **Expected Behavior:**
  1. UI gracefully transitions Voice State to "Connection Lost" / ERROR.
  2. A "Reconnect" button appears.
  3. The conversation history is _not_ erased. Text mode remains visible.
- **Pass/Fail:** [ ]

### TC-15: Voice-to-Text State Continuity 🛑 BLOCKER

- **Setup:** Connect to voice call.
- **Input (Spoken):** "My company is called Apex Builders."
- **Input (Action):** Click the UI toggle button to switch to Text Mode.
- **Input (Typed):** "Do you remember my company name?"
- **Expected Behavior:** Text bot correctly identifies "Apex Builders". No duplicate CRM records are created in Firebase.
- **Pass/Fail:** [ ]

### TC-16: Text-to-Voice State Continuity (Privacy) 🛑 BLOCKER

- **Setup:** In Text Mode, wait for bot to ask for email.
- **Input (Typed):** "I refuse to provide an email."
- **Input (Action):** Click the UI toggle button to switch to Voice Mode.
- **Input (Spoken):** "What should we do next?"
- **Expected Behavior:** Voice bot suggests an action (like a demo) but _does not_ ask for the email address, respecting the text-based privacy refusal.
- **Pass/Fail:** [ ]
