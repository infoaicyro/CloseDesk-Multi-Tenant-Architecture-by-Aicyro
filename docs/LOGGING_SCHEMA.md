# CloseDesk Common Structured Logging Schema (v1.0.0)

Every log emitted across Website, API, AI, Voice, and Pulse must conform to this JSON schema.

## 1. Core Fields (Mandatory on every event)

| Field Name    | Type                  | Description                                  | Example                                           |
| ------------- | --------------------- | -------------------------------------------- | ------------------------------------------------- |
| `timestamp`   | String (ISO 8601 UTC) | Precise time event was recorded              | `"2026-09-09T16:45:12.342Z"`                      |
| `log_id`      | String (UUIDv4)       | Unique identifier for the log entry          | `"e2b8f8b4-0c58-48b2-b1d5-b6d4e21a2c31"`          |
| `level`       | String (Enum)         | `DEBUG`, `INFO`, `WARN`, `ERROR`, `CRITICAL` | `"INFO"`                                          |
| `environment` | String                | Environment identifier                       | `"production"`, `"staging"`, `"development"`      |
| `service`     | String (Enum)         | `Website`, `API`, `AI`, `Voice`, `Pulse`     | `"Voice"`                                         |
| `component`   | String                | File, module, or handler name                | `"VoiceGatewaySession"`, `"LeadApi"`              |
| `event_type`  | String                | High-level categorization                    | `"AUDIO_STREAM"`, `"HTTP_REQUEST"`, `"TOOL_CALL"` |
| `event_name`  | String                | Granular action descriptor                   | `"stream_initialized"`, `"lead_created"`          |

## 2. Correlation Fields (Propagated across services)

| Field Name        | Type   | Description                                              |
| ----------------- | ------ | -------------------------------------------------------- |
| `request_id`      | String | Unique HTTP/WS request ID                                |
| `correlation_id`  | String | Cross-service trace spanning from Website to Voice/Pulse |
| `session_id`      | String | Client browser or interactive session token              |
| `conversation_id` | String | Active Voice/AI chat session ID                          |
| `lead_id`         | String | Lead record identifier in database                       |
| `booking_id`      | String | Booking or appointment identifier                        |

## 3. Context Fields (Conditional based on event domain)

| Field Name                | Type   | Applied When                                                     |
| ------------------------- | ------ | ---------------------------------------------------------------- |
| `tenant_id` / `client_id` | String | Multi-tenant customer identification                             |
| `user_id`                 | String | Authenticated user or visitor ID                                 |
| `source`                  | String | Entrypoint channel (`"web_banner"`, `"incoming_call"`, `"cron"`) |
| `endpoint`                | String | API path or WebSocket route (`"/api/leads"`)                     |
| `http_method`             | String | `"GET"`, `"POST"`, `"PUT"`, `"DELETE"`                           |
| `status_code`             | Number | HTTP response code (`200`, `400`, `500`)                         |
| `duration_ms`             | Number | Execution duration in milliseconds                               |
| `message`                 | String | Human-readable explanation                                       |
| `error_code`              | String | Application-specific error identifier (`"DB_TIMEOUT"`)           |
| `error_message`           | String | Root cause message from caught `Error`                           |
| `ai_model`                | String | Model used (`"gpt-4o-realtime"`, `"grok-2"`)                     |
| `prompt_version`          | String | Tracked system prompt version (`"v2.1.0"`)                       |
| `tool_name`               | String | Function or tool invoked by agent (`"lookup_calendar"`)          |
| `metadata`                | Object | Arbitrary key-value map for non-breaking schema extensions       |
