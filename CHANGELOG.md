# Changelog

## 0.1.1 — 2026-10-13

- Exposed OMP’s complete `skill` CLI action surface through direct argument-array invocation with validated flags, confirmation gates, and private token-result handling.
- Routed Desktop MCP configuration inventory, reads, updates, and removals through the scoped `omp mcp config` CLI contract while preserving redaction and OAuth UI behavior.
- Decoupled provider discovery, OAuth and account management from the selected chat using an ephemeral native settings runtime.
- Added an independent Models settings page and no-chat toolbar model selection; defaults affect only newly created conversations.
- Kept settings owners out of chat tabs/history, guarded pending account operations during restart/quit, and refreshed settings catalogs after credential imports without restarting conversations.
- Push settings snapshots directly to the renderer so credential-refresh notifications do not race restart IPC guards.
- Automatically open the native authorization URL in the system default browser when the user starts provider sign-in, keeping a manual reopen button.
- Cancel native OAuth by stopping only its ephemeral settings actor; clear pending prompts and release the callback port without disconnecting conversations.
- Added a real-core regression for zero-credential settings discovery, command boundaries, journal absence and preservation of conversation models.

## 2026-10-13

- Added an Electron/React workbench backed by the actual OMP `rpc-ui` process, with independent conversation ownership and native history.
- Added streaming chat, model/thinking controls, image input, questions, model-tool approvals, queue recovery, context/branch/export controls and child-agent views.
- Added native workspace/files/clipboard/notifications and explicit finite user command execution.
- Added provider credentials, native user settings, scoped MCP/OAuth, managed skill imports and native plugin management.
- Preserved OMP's lazy empty-session persistence and saved model selection; explicit fresh-session model selection supports account onboarding.
- Fixed missing first-time Codex OAuth entry: Settings → Providers now starts ChatGPT sign-in without an existing session, API key or manually configured model, while preserving default preferences and saved conversation models.
- Show the native browser authorization handoff before its optional authorization-code input.
- Corrected finite command history hydration so outputs survive tab changes, and corrected completion-driven history refresh with workspace ownership guards.
- Retained completed child-agent records and added verified, bounded archive transcript access after restart; excluded actual child journals without hiding root forks.
- Matched native default/named profile precedence and home-relative configuration directory resolution.
- Persisted bundled-versus-external runtime selection so moving the packaged application does not retain a stale default OMP executable path; verified a relocated real runtime executing `42`.
- Added transport/privacy/filesystem/configuration/lifecycle regression coverage and verified actual OMP and native-window scenarios.
