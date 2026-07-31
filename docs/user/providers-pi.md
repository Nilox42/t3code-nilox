# Pi Agent

T3 Code supports Pi Agent 0.82 or newer through Pi's subprocess JSONL RPC mode. T3 Code does not install or depend on Pi's npm SDK.

## Install and authenticate

Install the current Pi CLI globally:

```bash
npm install --global @earendil-works/pi-coding-agent
pi --version
```

Start `pi`, run `/login`, and authenticate an upstream provider. API keys supplied through environment variables also work. Return to T3 Code Settings and refresh the Pi Agent provider; a non-empty authenticated model list makes the provider ready.

## Settings

- **Binary path** defaults to `pi`. Set an absolute path when the CLI is not on the server's `PATH`.
- **Agent directory** is optional and maps to `PI_CODING_AGENT_DIR`. Provider instances that use different agent directories keep independent Pi state.
- **Launch arguments** adds ordinary Pi CLI arguments. T3 Code rejects arguments that would take ownership of RPC mode, model selection, credentials, trust, or session persistence.
- **Trust project resources** is off by default. T3 Code launches Pi with `--no-approve`, which prevents project-local extensions, skills, prompt templates, and context files from loading. Enable this only for projects whose Pi resources you trust.

Global Pi resources load normally during interactive sessions. Each T3 Code thread owns one persistent Pi process and can resume from its Pi session file. A missing persisted session file is reported instead of silently starting without its prior context.

## Models and thinking

Models are discovered from authenticated Pi providers. Model slugs have this form:

```text
<pi-provider>/<pi-model-id>
```

Only the first slash separates the provider, so model IDs may contain additional slashes. Each model exposes the thinking levels Pi reports for that model, from `off` through `max` where supported. T3 Code marks Pi's current RPC model as the default, or uses the first available model when Pi has no current model.

## Supported features

Pi Agent supports persistent and resumable threads, streaming assistant text and reasoning, tool activity, usage updates, image prompts, approvals, extension dialogs, interruption and steering, native fork rollback, multiple independently configured instances, and text generation for titles and Git workflows.

Permission modes map to Pi as follows:

- **Full access** allows every tool.
- **Auto-accept edits** allows built-in reads, searches, edits, and writes, while asking for bash and extension tools.
- **Approval required** asks for every tool.
- **Auto** also asks for every tool because Pi does not expose an automatic permission classifier.

“Accept for session” is cached only inside the active Pi process. Declining or cancelling returns a blocked tool result to Pi.

## Current limitations

Pi Agent support is Early Access. MCP/browser-tool injection and Pi-specific plan mode are deferred. User-installed Pi extensions may run in active sessions and their ordinary select, confirm, input, and editor dialogs are supported, but arbitrary custom widgets and TUI-only presentation APIs are not.
