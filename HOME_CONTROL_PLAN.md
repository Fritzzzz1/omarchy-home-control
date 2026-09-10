# Home Control — implementation brief

**Maintainer:** Codex only. This document is the authoritative product and implementation handoff. Other agents may read it and implement from it, but must not edit it; they report needed plan changes to Codex.

## The product

Home Control is a voice home assistant for one person's Omarchy machine. It serves two pages:

- a Safari-first phone client, used as microphone and speaker;
- a desktop dashboard that shows the conversation and the agent's work.

The server connects transcription, the user's chosen AI agent, and text-to-speech. It is personal, fast, reliable, thin, and adaptable to a user's own machine, providers, language, and private network.

This ships as a normal Git repository with an agent-led setup experience. It is **not** an Omarchy plugin. An optional Omarchy desktop integration may be offered only as an independent convenience after the service works; it must never be required for installation, launch, or distribution.

## The intended first-run experience

1. The user clones the repository.
2. They open that folder with their own AI coding agent and invoke `/setup-home-control`.
3. The agent explains the next decision briefly, asks it, performs the chosen work itself, and reports the result. It uses repository scripts or snippets when they make actions accurate and repeatable. The user does not manually assemble the system.
4. Setup validates the full route: phone client -> transcription -> runtime agent -> TTS -> phone playback. It fixes ordinary configuration problems before declaring success.
5. Setup offers to add the desktop dashboard as an Omarchy web app with a shortcut, and offers to add the phone client to the phone's home screen.

The setup conversation is deliberately adaptive. Integrations in the repository are working templates, not assumptions about one creator's network, account, paths, model, or devices.

## Agent-facing repository contract

- Keep one canonical `/setup-home-control` instruction in the repository root. It is the complete step-by-step setup contract.
- `AGENTS.md`, `CLAUDE.md`, and the equivalent entrypoints for supported coding agents must all point to that one command. They must not duplicate setup logic.
- When an agent opens this repository and Home Control is not installed, it should offer `/setup-home-control` before ordinary repository work. For Claude, `CLAUDE.md` must make this behavior explicit.
- The setup contract works with the user's own coding agent. It does not require Claude as the agent conducting setup.
- The setup agent is expected to install packages, create configuration, connect private services, start user services, configure tailnet access, and repair routine environment differences. It should not turn normal setup into a manual checklist.

## Setup order and decisions

### 1. Discover and confirm the runtime agent

- Read Omarchy's configured default coding agent using `omarchy default agent` / `~/.config/omarchy/defaults/agent`.
- Present it as the recommended default and ask the user to confirm it for the Home Control runtime. Do not silently select it.
- Offer another runtime only when the user asks for it or the detected default is unavailable.
- Treat the agent runtime as a provider adapter. An adapter owns detection, authentication, command/API invocation, conversation persistence, streaming output, tool/permission behavior, concise voice rewriting, configuration rendering, and validation.
- Claude Code is the proven initial adapter.
- Codex using a ChatGPT subscription, OpenAI via API, and local/open-source providers are supported adapter targets. Their credentials and invocation differ, so setup must detect and configure the selected one rather than pretending a Claude command works everywhere.
- API credentials belong in protected per-user storage and must not be placed in logs, spoken replies, transcripts, or passed unnecessarily to the runtime agent.

#### Provider selection and adapter contract

- Setup never scans a user's network or guesses credentials. It reads the detected Omarchy default, asks for confirmation, then probes only the selected provider.
- Claude detection is `claude` on `PATH` plus its non-interactive authentication-status command.
- Codex detection is `codex` on `PATH` plus `codex login status`. A ChatGPT login selects the Codex-subscription adapter. A direct OpenAI API adapter is selected only when the user explicitly chooses it and supplies an API credential through protected storage.
- A local/open-source provider is selected only when the user chooses it or it is the confirmed Omarchy default; setup then asks for its local endpoint or CLI and validates it.
- Every runtime adapter implements the same contract: `detect`, `describeAuth`, `configure`, `validate`, `startOrResumeConversation`, `sendTurn`, `cancelTurn`, `closeConversation`, and `rewriteForSpeech` when that provider supports the optional rewrite pass. It emits the provider-neutral activity events defined below.
- Conversation persistence belongs to the adapter. A CLI adapter may resume its native session; an API adapter persists its own conversation identifier/history; a local adapter follows its service's contract.

### 2. Ask language once

- Ask the user's default language once, before speech services are selected.
- Carry that choice into transcription model/language defaults and TTS voice defaults.
- Preserve the ability to add languages later without rebuilding the architecture.

### 3. Configure transcription

- Ask whether the user already has a transcription solution reachable on their private network.
- If yes, collect its connection details, authenticate if required, adapt to its actual protocol, and validate a real transcription request.
- If no, explain what transcription provides and recommend the shipped default: a local `whisper.cpp` `whisper-server`. Setup installs it, downloads a multilingual GGML model, and configures it as a user-owned service. It selects the model from the default language and detected hardware, preferring accuracy where the machine can sustain it and a smaller multilingual model where it cannot.
- Local and remote transcription must have explicit service ownership, separate ports, startup behavior, timeouts, health checks, and clear recovery messages.

### 4. Configure text-to-speech

- Ask whether the user already has a TTS solution reachable on their private network.
- If yes, connect it through a provider adapter and validate synthesis and playback.
- If no, explain the role of TTS and install the shipped default: Edge TTS, with a voice suited to the default language.
- Edge TTS is the first-release default. Private-network and online TTS providers use the same adapter shape when selected; they do not change the rest of the system.
- The optional long-reply speech rewrite is a separate provider call. Setup explains that it improves spoken long/formatted replies and costs an additional model call when triggered. It is on by default, user-disableable, persisted in configuration, validated, and documented.

### 5. Configure remote phone access

- Ask whether the user already has a private network/tailnet path for their phone and machine.
- If yes, connect it and validate the actual HTTPS phone URL.
- If no, explain Tailscale in plain language, recommend it, and explain that it is free for this personal use and makes Home Control available while the user is away from home. The setup agent installs, signs in/configures it, and creates the service mapping when the user chooses it.
- Phone voice use requires a real HTTPS route. Do not describe a localhost-only service as phone-accessible LAN fallback.
- Never enable public internet exposure by default.

### 6. Install and launch

- Install the server, mobile client, dashboard, runtime configuration, provider state, and systemd user services.
- Start both required runtime services. The dashboard must be a real installed feature with a documented launch path, not an unstarted source file.
- Assign distinct, configurable ports to the voice server, local transcription server, TTS worker, and dashboard.
- Use `$HOME` as the clean-machine-safe default runtime working directory. Setup shows it and lets the user choose a narrower directory, but never assumes a developer directory exists.
- Create a clear control command for status, logs, health, start/stop/restart, and the phone URL.
- A successful install must verify startup, provider authentication, transcription, TTS, HTTPS phone reachability, and one end-to-end turn before reporting success.

## Runtime behavior and boundaries

- Preserve one continuing voice conversation with the selected runtime agent. Supply the voice system prompt when a new runtime process/conversation begins; do not reapply it for every streamed turn.
- Keep provider-specific protocol handling behind adapters. The dashboard must consume provider-neutral activity rather than Claude session files or Claude-specific event names.
- Write activity to a versioned local event stream with this minimum shape: `{ version, at, turnId, source, type, state, text, detail }`. `source` is `setup`, `transcription`, `agent`, `tts`, or `system`; `type` is `status`, `input`, `output`, `tool`, `error`, or `health`; `state` describes the current stage. `detail` is optional structured data safe to display or inspect. The dashboard renders this contract and never reads a provider's private session storage.
- The runtime agent's working scope and tool permissions must be explicit during setup. Do not present a path-based deny list as a security boundary when shell tools can escape it.
- The phone page must be designed for Safari first. Chrome compatibility is not a release requirement.
- The phone page and dashboard must remain useful when a service is unavailable: show the actual failed component and offer the recovery action. Never hang indefinitely on a nonresponsive provider.

## Repository and release shape

- Delete the current plugin packaging from this repository: `manifest.json`, `Panel.qml`, and widget-specific installation/documentation. Do not rename or retain it as a required optional step. A future Omarchy integration can be a separate, valid non-reserved package once the service product is established.
- Keep the repository self-contained: every imported runtime file and setup template is tracked and copied by the install process. Avoid a vendoring workflow that injects imports without shipping their modules.
- Keep installation reversible. State deletion remains explicit and opt-in.
- Publish from a real Git remote with a versioned release. The repository must not depend on a local filesystem remote or private source checkout.
- Document the supported first release honestly: clean Omarchy, Safari phone client, confirmed runtime provider, chosen transcription/TTS route, and private HTTPS phone access.

## Current repository state

- This brief supersedes the current partial edits to `app/server.mjs`, `install.sh`, and `tools/parameterise.py`.
- Retain only work that conforms to this brief. For example, the speech-rewrite choice is retained only when it is validated, persisted in configuration, and honored by the runtime.
- Do not preserve existing Claude-only wiring, untracked/missing payload files, plugin artifacts, or source-specific assumptions merely because they are already present.

## Acceptance conditions

An implementation is finished when a new user on a clean Omarchy installation can clone the repository, open it with their own AI coding agent, run `/setup-home-control`, make the few product choices above, and receive a working Safari phone conversation plus desktop dashboard without manually wiring services.

The setup agent must handle the common case in which the user has no existing transcription, TTS, or private network, while also correctly connecting and validating the user's own private-network services when they do have them.
