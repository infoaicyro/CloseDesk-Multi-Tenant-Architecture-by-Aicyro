# CloseDesk Voice AI - Privacy & Retention Architecture

## 1. Raw Audio Storage

**Policy:** Aicyro / CloseDesk **does not** record, store, or retain raw audio files (.wav, .mp3, .pcm) of user conversations by default.
**Implementation:** Audio is captured by the browser via standard WebRTC and streamed over an encrypted data channel directly to the processing LLM. The audio exists only in volatile memory during the active session. Once the WebRTC PeerConnection closes, the raw audio is destroyed.

## 2. Sub-processors

**Policy:** Real-time audio processing is handled by OpenAI.
**Implementation:** The ephemeral WebRTC stream is sent to the OpenAI Realtime API (`gpt-realtime-preview`). Under OpenAI's enterprise API data privacy agreements, data sent via the API is not used to train OpenAI models, and ephemeral audio inputs are not retained by OpenAI after the session ends.

## 3. Transcript Retention

**Policy:** Text-only transcripts of the conversation are saved to maintain context for human agents and ensure continuity if the user switches to text chat.
**Implementation:** The system listens for `input_audio_transcription.completed` and `response.audio_transcript.done` events from the WebRTC channel. Only these generated text strings are pushed to Firebase (`transcripts/{session_id}`).

## 4. Right to be Forgotten (Deletion Workflow)

**Policy:** Users have the right to request the immediate deletion of their session data.
**Implementation:** Both the Text and Voice AI agents are equipped with a `request_data_deletion` tool/flag. When invoked:

1. The structured CRM payload (`context_patch`) is overwritten with `null` values.
2. The `factual_summary` is erased.
3. The entire `transcripts/{session_id}` tree is permanently dropped from the Firebase Realtime Database.
