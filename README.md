# dsh-workspace-memory

English | [中文](README.zh.md)

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![](https://img.shields.io/npm/v/dsh-workspace-memory?style=flat-square)](https://www.npmjs.com/package/dsh-workspace-memory)
[![](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

**Per-workspace persistent memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)** — a plugin that gives every workspace its own durable memory files, injects them into every session running in that workspace, and lets both you and the agent manage them.

## Why this plugin exists

DSH agents are stateless across sessions: everything a session "learns" — your project's decisions, conventions, hard-won debugging facts — lives only in that conversation's context and is gone when it ends. The built-in mechanism for durable knowledge is `AGENTS.md`, but it is a static, project-owned instruction file: the agent cannot update it on its own, and there is no place for the growing, day-to-day memory of *working in* a workspace.

This plugin closes that gap with a small, explicit memory loop:

1. **Every workspace gets a memory directory** — `<workspace>/.dsh/memory/*.md`, plain Markdown you can read, diff, and commit.
2. **Memories are injected automatically** — each session created in a workspace carries that workspace's memory files in its system prompt, alongside `AGENTS.md`, so a fresh session starts already "remembering".
3. **The agent can write memories itself** — a global `save_workspace_memory` tool lets any session persist a decision, convention, or preference the moment you say "remember this".
4. **You stay in control** — a sidebar panel lists, creates, edits, and deletes memory files per workspace, so memory stays inspectable and correctable instead of hidden in a database.

## Features

| Capability | Where |
|---|---|
| Browse / create / edit / delete memory files | **Workspace Memory** sidebar panel (switch workspaces via the selector) |
| Ask the agent to remember something | Any session: "remember: …" → the agent calls `save_workspace_memory` |
| Automatic recall | Every session in the workspace gets `.dsh/memory/*.md` injected into its system prompt |

Works in every built-in agent preset (Standard, PTC, Minimal, Creator): the tool is registered in the root composition, and global tools are visible to all presets unless a custom preset opts out with a `tools.restrict` allow list — add `save_workspace_memory` to that list if so.

## Installation

The package is plain JavaScript with no build step, so every install channel works:

```sh
# from npm (once published)
dsh plugin --profile desktop add dsh-workspace-memory

# straight from GitHub (no build script needed — sources ship as-is)
dsh plugin --profile desktop add github:lengfengng1-ai-architect/dsh-workspace-memory

# from a local checkout
dsh plugin --profile desktop add ./dsh-workspace-memory
```

Or use the GUI: sidebar **Plugins → Add plugin**, paste a package name, GitHub address, or absolute local path, then **Enable now**.

Uninstall: the Plugins page, or `dsh plugin --profile desktop remove dsh-workspace-memory`.

## Usage

- Open the **Workspace Memory** entry in the sidebar. The selector defaults to the workspace of the current session. **New file** creates a `.md` memory (the extension is added when missing); select a file to edit, save, or delete it.
- Tell the agent "remember: this project uses pnpm, not npm" — it writes a memory file that every session of the workspace (and the panel) sees immediately.
- The memory directory is configurable through the plugin's `directory` config field (default `.dsh/memory`, must stay inside the workspace).

## Important: start a new session after installing or upgrading

Tool registration takes effect immediately on the host, but **a model's visible tool list is assembled when each conversation turn starts**:

- If a session's current turn began *before* the plugin was installed or reloaded, that turn's tool declaration is stale. This is most visible in **PTC mode**, where the model reads a pre-generated TypeScript binding (`ToolArgsMap`) that does not yet contain `save_workspace_memory` — the model may conclude "there is no memory tool", or fall back to probing the tool by name through the code channel (which actually works, since dispatch goes through the live host registry).
- **The fix is simple: start a new session, or just send a new message after the current turn ends.** The next turn regenerates the tool declaration and `save_workspace_memory` appears normally — no probing needed.

Memory injection into the system prompt is attached when an agent is created (session start, resume after a restart, clear, or compaction); once attached, a session picks up changed memory files on its next step automatically.

## Data layout and safety

```
<workspace>/.dsh/memory/     # memory files: plain Markdown, one file per topic
dsh-workspace-memory/        # this plugin
├── package.json             #   bundle manifest (dsh.bundle.patch + dsh.client)
├── cordis.patch.yml         #   plugin row declaration
├── index.js                 #   host: /api routes + prompt injection + the save tool
├── client.js                #   browser: sidebar entry + management panel
├── locale/                  #   panel copy (en, zh)
├── icon.svg
└── selftest.mjs             #   host-logic self-test: node selftest.mjs
```

Safety constraints: the browser panel can only address registered workspaces by `workspaceId` (no arbitrary host paths); file names are strictly validated (no path separators, `..`, whitespace, or control characters); one file is capped at 1 MiB; prompt injection truncates each file to 32K characters and caps at 20 files.

## Development

- Install with a `link:` dependency (local-path install does this): editing `client.js` hot-reloads in the page via the client HMR receiver; editing `index.js` (host code) requires a DSH restart to load the new module generation.
- Run the self-test: `node selftest.mjs` (mocks the plugin context; covers routes, prompt rendering, tool writes, and validation failures).
- Runtime checks: host entry `include:workspace-memory` should be `active`; the client slot `sidebar.panellist` should list a `workspace-memory` occupant; `save_workspace_memory` should appear in the tool list.

## License

[MIT](LICENSE) — © 2026 lengfengng1-ai-architect

---

This is a community plugin built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness); it is not an official DeepSeek product. Naming follows the [DSH brand guidelines](https://github.com/deepseek-ai/deepseek-harness/blob/main/BRAND_GUIDELINES.md).
