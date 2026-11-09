# 20. Host speech

> Source of truth: `packages/shared/src/types/speech.ts`,
> `packages/agent-runtime/src/speech/`,
> `apps/desktop/electron/main/services/speech-service.ts`.
> ADR: [0281-host-speech-capability](../../adr/0281-host-speech-capability.md).

## 1. Capability

Independent of chat streams and the model picker:

```
transcribe({ sessionId, path, mimeType?, language? }) → { text }
synthesize({ sessionId, text, voice?, format? }) → { path, mimeType, dataUrl? }
```

Input is a session-scratch file path. Output audio is written to that session's
scratch. The renderer never receives a provider secret. TTS `dataUrl` is omitted
when the file is larger than 8 MiB. Input is capped at 25 MiB
(`SPEECH_INPUT_TOO_LARGE`).

## 2. Bindings

`AppSettings.speech` is optional and does not bump the storage schema:

```
{
  transcribe?: { providerId, modelId, protocol, voice?, format?, path?, extra? }
  synthesize?: { providerId, modelId, protocol, voice?, format?, path?, extra? }
}
```

Protocol ids match `^[a-z][a-z0-9._-]{0,63}$`. Absent/empty speech is a valid
unconfigured state. No app surface reads it: callers are plugins and IPC
consumers (ADR 0291).

## 3. Built-in protocols

| id | transcribe | synthesize |
|---|---|---|
| `openai_audio` | `POST {baseUrl}/audio/transcriptions` multipart | `POST {baseUrl}/audio/speech` JSON |
| `openai_chat_audio` | unsupported | `POST {baseUrl}/chat/completions` with `audio:{format,voice}`; read `choices.0.message.audio.data` |

Local OpenAI-Audio-compatible servers use an `openai_compatible` provider and
`openai_audio`. Suggested models: OpenAI `whisper-1` / `tts-1`, Groq
`whisper-large-v3`, Xiaomi `mimo-v2.5-tts`.

## 4. IPC

```
pi-desktop/speech/getStatus → SpeechStatus (no secrets)
pi-desktop/speech/transcribe
pi-desktop/speech/synthesize
```

Errors: `SPEECH_NOT_CONFIGURED`, `SPEECH_PROTOCOL_UNSUPPORTED`,
`SPEECH_INPUT_TOO_LARGE`. Network/auth reuse `NETWORK_ERROR` /
`PROVIDER_UNAUTHORIZED`. A missing or disabled provider returns `NOT_FOUND`.

## 5. Plugin adapters

`pi.speech.registerAdapter({ protocol, label, roles, handle })` requires
`speech.adapter.register` (high risk). The handle stays in the plugin process.
The host stores metadata only and calls `speech.handle`. A handle may return
`{ kind: "text" }`, `{ kind: "audio", mimeType, data }`, or
`{ kind: "http", call }` for the host to execute with the bound key. HTTP URLs
must stay on the provider origin. Built-in protocol ids are reserved. Unload
unregisters.

## 6. Product

Settings exposes **no** speech surface (ADR 0291). A binding is written by a
caller through the host settings API; plugins and the `speech/*` IPC are its
only consumers, and the renderer has no transcription or speech control.
Whisper / TTS models must not appear in the chat model picker.

v1 does not implement microphone capture, Realtime, or agent tools.

## 7. Original ownership during idle handoff

Desktop Speech requires the shared admission gate. Status, transcription and
synthesis capture the original Host object, generation and availability before
settings lookup. Every later RPC, adapter dispatch, HTTP request and scratch
operation rechecks that authority. Closed admission returns `HOST_BUSY`; a
replaced or unavailable Host returns `HOST_UNAVAILABLE`. Ordinary settings errors
still permit the status catalog's unconfigured fallback, but cannot hide a retired
owner. New operations may capture the current Host; old operations never adopt it.

The selected plugin adapter registration and installation are captured before
provider/secret lookup. Re-registration or unload invalidates that invocation;
delayed replies cannot start HTTP or write output. The original owner guard also
travels with the pending child request into its host callbacks and workspace
continuations. Existing permissions, reply validation and the 60-second adapter
deadline remain in force. Original teardown and authorized retirement semantics
are preserved; no new plugin wire capability is introduced.

`SpeechService.getHandoffActivity()` reports original operations, resources and
saturating uncontained-resource evidence. Original settings/secret RPCs, adapter
work, file reads/writes, HTTP headers/bodies and unused response-body cancellation
remain counted until their promises settle. A started file write is neither
rolled back nor replayed after retirement. Permanent `dispose()` closes future
entry and aborts original HTTP signals without dropping pending work. Confirmed
application shutdown disposes Speech before awaited teardown; cancelled quit
confirmation or personal-todo preparation leaves it available.

Shared HTTP ownership hooks are optional for other callers. A transport attempt,
unknown Host completion or failed body cleanup remains refusal evidence after
ordinary completion; cleanup failures are observable without raw response data.
Response close, abort and ordinary child exit do not certify native-family
closure. This slice does not qualify microphones, Voice/LiveVoice, remote owners,
the complete nineteen-family inventory or end-to-end Desktop handoff.
