# OMP Desktop

An independent Windows desktop workbench for Oh My Pi. Electron owns native operations and process lifetime; React owns the workbench; the actual OMP standalone executable runs each conversation over `rpc-ui`. This is not a terminal mirror or a hosted Collab wrapper.

## Run and build

```powershell
npm ci
npm run dev
```

`npm run dev` compiles the app and launches its native window. For an already-built checkout, use `npm start`. Recommended development runtime: Node 24 LTS; the current application was exercised with Node 25.2.1 and Electron 40.10.6.

Select the OMP executable in Settings → Runtime when it cannot be discovered. The packaged Windows app includes OMP 18.10.2. To package a different standalone binary:

```powershell
$env:OMP_RUNTIME_PATH = 'C:\path\to\omp.exe'
npm run build
npm run dist:win
```

The installer and unpacked application are placed under `release/`. Development defaults to the executable used on this workstation; `OMP_DESKTOP_EXECUTABLE` provides an explicit development override. `OMP_DESKTOP_DATA_DIR` isolates desktop preferences and managed conversations; it does not isolate OMP provider credentials. For credential/configuration isolation also set the native OMP configuration directory/profile variables.

Native `PI_CONFIG_DIR` is a directory name **under home**, not an absolute path. `PI_CODING_AGENT_DIR` is the full default-profile agent-directory override; named profiles ignore it. An explicit empty or `default` `OMP_PROFILE` selects the default profile instead of inheriting `PI_PROFILE`. The desktop follows these native rules.

The Windows package includes OMP. Its default runtime selection follows the application's current `resources/omp/omp.exe` after relocation or installation; a program explicitly chosen through the file picker remains an external fixed path. The unpacked `release/win-unpacked/OMP Desktop.exe` can run without a development Node.js installation.

## Workbench

- Workspaces, searchable native/managed history, independent running conversation tabs, rename, exact resume, branches/forks, and native HTML export.
- Real model and supported thinking-level selection; streaming text/thinking, code, image attachments, tool results, questions and approvals.
- Explicit guidance/follow-up queues and stop-with-draft recovery.
- Todo editing, child-agent progress and transcript access, context compaction, supported fast/slow tiers and goal controls.
- Native file browser, bounded text/image previews, file references, image picker/drop, clipboard copy and completion notifications.
- Provider OAuth via OMP, API-key import into OMP's own credential store, native settings, scoped MCP configuration/OAuth, managed skill imports and native plugin management. The Skills panel also exposes OMP’s `skill` registry/install actions through direct CLI arguments with confirmation for risky operations.

MCP management requires an OMP executable that implements `omp mcp config list|get|set|remove`; rebuild/replace the bundled CLI before shipping this integration.

Keyboard shortcuts: Ctrl+N creates a conversation, Ctrl+K opens discovered commands, Ctrl+, opens settings, Enter sends, Shift+Enter inserts a newline. Escape closes local overlays or stops the current run; interactive OMP dialogs retain their own cancellation behavior.

The native OMP configuration, credentials and existing history are shared unless a profile or configuration-directory override was explicitly selected. Changing tabs does not issue a native session-switch operation or stop another conversation. Empty conversations follow OMP's lazy persistence and may not produce a journal until meaningful native activity occurs.

## Account setup

Settings → Providers discovers native authorization providers and manages accounts using an independent settings runtime for the selected workspace. It works before any chat is opened, with a failed chat, and after all chat tabs are closed. For Codex, use **Sign in** on **ChatGPT Plus/Pro (Codex Subscription)**: the app automatically opens the native authorization link in the system's default browser. **打开授权网页** remains available to open it again or recover from a browser-launch failure. Complete sign-in in the browser; the optional code/redirect-URL input remains available. Authorization never creates or switches a conversation, and credentials stay in OMP's native store. API keys are sent only through local IPC and native stdin, not chat, command arguments or renderer-readable credential exports.

Settings → Models discovers the native available-model catalog independently of chat history and saves the desktop's **new-conversation default**. The toolbar also exposes this selection when no ready conversation is selected. No available models is reported explicitly with a link to Providers; unauthenticated providers are not presented as usable models. An explicit custom model selector remains available. Changing this default affects new conversations only; existing and resumed conversations retain their own model and thinking level.

The settings runtime uses OMP's provider-only `openai-codex/` selector for metadata bootstrap, with `--no-session --no-tools`. It creates no chat journal and cannot accept chat prompts, tool runs, model switching or history navigation. Pending native authorization survives closing/reopening settings. Cancelling its input prompt terminates only that ephemeral settings actor and clears the browser callback and pending prompts; conversations are not stopped. API-key imports refresh only the settings runtime, not active conversations.

Global settings writes use OMP's native configuration CLI. Project/environment overrides can still win; the UI reports observed persisted layers rather than inventing full provenance. Credential stores backed by an auth broker must be managed through the configured broker; a rejected import is not reported as success.

## Permissions and limitations

Model-initiated tool calls default to `always-ask`. The separate manual command runner is an intentional user command: clicking Run authorizes direct execution. It is finite RPC bash execution, **not an interactive PTY**. Review commands and plugin code before running or installing them.

Plugin changes, credentials and MCP changes may require restarting idle owners. Restart refuses active work/questions; do not use process restart as a tab-focus action. A changed MCP menu alone is not treated as a reconnect.

Image inputs must fit OMP's 1 MiB inbound-frame budget. This client accepts PNG/JPEG/WebP/GIF up to 600 KiB each; a combined prompt exceeding the actual frame limit is rejected rather than silently losing images. Text and other working-tree files can be referenced by path for the agent's real file tools. Previews cannot escape their authorized workspace through path traversal or symlinks.

Live voice uses OMP's native audio runtime, the machine's microphone/speakers and a supported provider/account. Device permissions, entitlement and provider errors remain real; microphone/speaker operation has not been verified on this workstation. Fast tiers and voice/model use may incur provider charges.

The renderer has no Node access or raw IPC access. HTML/file previews are not executed as privileged application pages. Development CDP is enabled only with `OMP_DESKTOP_DEBUG_PORT`; do not expose that port publicly. Native user data is separate from installed resources. Windows builds are unsigned unless you supply signing credentials; Windows may show a publisher/SmartScreen warning.

REA is optional, not preinstalled: add it as an MCP server only after meeting its own Node/tool prerequisites and reviewing installation changes. Hermes inspired the workbench boundaries and interaction model; no Hermes application assets or branding are bundled.

## Verification

```powershell
npm run typecheck
npm run build
npm test
$env:OMP_TEST_EXECUTABLE = 'C:\path\to\omp.exe'
npm test
```

The opt-in integrations exercise the actual core, temporary journals and native finite command execution, without making a model request or writing provider credentials. The history fixture key is only a catalog-availability prerequisite. The global-settings regression starts without credentials or a default model, checks provider discovery, canonical-workspace single-flight, rejection of chat/tool commands, absence of settings journals, and independent restart/closure. It also cancels actual native Codex authorization on a temporary loopback port, verifies the settings runtime recovers, and proves an existing conversation stays connected with its original model. No browser is opened by that test. Permanent tests cover transport framing/UTF-8, privacy, session discovery, filesystem confinement, management precedence and shutdown. POSIX permission denial is intentionally skipped on Windows.

Real native-window checks also exercise model responses, image perception, ask answers, model switching, model-tool approval allow/deny, manual commands surviving tab focus changes, history restore/fork and HTML export. MCP OAuth/PKCE and credential/config writes use isolated local fixtures; they do not imply authorization to an actual third-party account.

See `LICENSE` and `THIRD_PARTY_NOTICES` for redistribution notices.
