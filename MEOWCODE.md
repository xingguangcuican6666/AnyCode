# MEOWCODE.md

This file is auto-loaded into every turn (see `src/lib/projectInstructions.ts` — it
is this repo's own agent-instruction mechanism). It is written for a coding agent
working in **MeowCode itself**, so most of the "what is this" detail that lives in
`README.md` is deliberately omitted here.

## What this project is

MeowCode is a Claude-Code-style agentic coding CLI. The name has drifted: `git` and
the npm package say `meowcode`, but much of the code and user-facing text still say
"AnyCode" (it began as a Claude Code clone). Both refer to the same product.

Notable: **the agent loop is self-hosted**. There is no SDK — the `anthropic`
provider speaks the Messages API over raw `fetch`/SSE, and the entire toolset
(bash, file edits, sub-agents, message/memory/monitor/schedule, etc.) is
implemented in-repo under `src/tools/`, mirroring Claude Code's tools one-for-one.
The default `default` provider is an **unwired stub** (`src/providers/index.ts`);
real work runs on `anthropic` (env `ANTHROPIC_API_KEY`), the logged-in `newapi`
relay, or a user-defined Anthropic-protocol endpoint.

## Commands

```bash
npm run dev         # interactive session; tsx src/cli.tsx (mock provider, no key)
npm run build       # tsup → dist/cli.js (ESM, shebang)
node dist/cli.js    # run the bundle (or: npm link → `meowcode`)
npm run typecheck   # tsc --noEmit  ← the closest thing to a linter; there is none
npm run clean       # rm -rf dist
npm run start       # node dist/cli.js
```

- **There are no tests and no lint tool.** `typecheck` + `build` is the whole
  verification story. Always run both before finishing.
- **CI** (`.github/workflows/build.yml`) installs with **Bun** and runs `bun run
  typecheck` + `bun run build`. The repo is `"type": "module"` (ESM, `ESNext`/
  `Bundler` resolution); imported local modules use extensionless paths.
- `.gitignore` excludes `dist/`, `node_modules/`, and `.anycode/` (the user's
  config/sessions/memory live in `~/.anycode`, **not** in the repo).

## Runtime notes

- Default model is `claude-opus-4-8` (`src/config.ts`); provider defaults to
  `mock` unless `ANTHROPIC_API_KEY` is set.
- Config, sessions, and cross-session memory persist to `~/.anycode/`:
  `settings.json`, `sessions/`, `memory/` (`MEMORY.md` index), `credentials.json`,
  `history.json`. API keys are **never** written to disk — always env-sourced.
- UI language is i18n'd (zh/en/auto) — see `src/lib/i18n.ts`; the codebase has
  substantial Chinese comments and some Chinese UI strings.

## Architecture

```
src/
  cli.tsx               entry: arg parsing, print/piped mode, interactive mount loop
  app.tsx               the Ink app (large — global keys, layout, ~1870 LOC)
  app.tsx + app-helpers.ts   session snapshot, goal/loop state, foldContext wiring
  types.ts              core contracts: Message, MessageMeta, StreamOpts, Provider,
                        AgentEvent, ToolResultBlock, SlashCommand, CommandContext, etc.
  config.ts             ~/.anycode/settings.json load/save
  theme.ts              color themes + useTheme()/ThemeProvider
  hooks/useChat.ts      conversation state machine + streaming (foldContext/compact)
  components/           Ink components; PromptInput (~715), SettingsPanel (~590), etc.
  commands/index.ts     slash-command registry (~1310 LOC)
  providers/            mock (offline) · anthropic (fetch/SSE tool loop) · wire/retry
  tools/                the agent toolset
    index.ts            registry + Anthropic-format schemas + dispatcher
    impl.ts             the ordered TOOLS list (assembled from fs-tools/…/orchestration)
    fs-tools.ts         bash, read_file, write_file, edit_file, grep, glob, list_dir
    orchestration.ts    task / plan / workflow / agent_status / agent_wait
    permission.ts       permission-mode + per-tool rules (allow/ask/deny)
    memory-tool.ts      the cross-session `memory` tool
  lib/                  ~60 leaf modules (agents, mcp, sessions, transcript, i18n,
                        compact, summarize, usage, tokens, mentions, hooks, …)
```

The **agent loop** lives in `src/providers/anthropic.ts` (`agent(...)`): it builds
the tool schemas, streams SSE, runs tools, handles retries / context-overflow
compaction / OAuth refresh / plan-mode approval. The mock provider (`mock.ts`)
implements a synthetic offline loop over the same tools, so the UI works without a
key. The **UI is entirely Ink + React** (v18, `~18.3.1` react, `~5.1.0` ink).

## Conventions

- `src/types.ts` stays **dependency-free** by design: config types like hooks /
  MCP / permissions are kept loose (`Record<string, …>`) and typed properly in the
  owning `lib/` module instead. Follow that split.
- New toggles/settings are **one line** in the `SETTINGS` table
  (`src/lib/settings.ts`) — this drives `/config`, validation, and defaults.
  Effort levels (`low…max`), thinking budgets, and output-style directives all
  live there too.
- The `settings` bag on `AppConfig` is a `Record<string, boolean|string|number>`,
  merged key-by-key against `settingsDefaults()` so files from older builds still
  pick up new keys.
- New slash command: push a `SlashCommand` onto `builtins`
  (`src/commands/index.ts`). New tool: define it in `src/tools/` and add it to the
  `TOOLS` array in `impl.ts`. New provider: register in `src/providers/index.ts`.
- Import local modules with extensionless paths; no `import type` elision issues
  (JSX `automatic`, `react-jsx`).
- Markdown rendering is `src/lib/markdown.ts` (`renderMarkdown`, wrapping `marked`
  + `marked-terminal`); spinner frames, token estimation, etc. are siblings in
  `src/lib/`.

## Gotchas

- **`tsup` version drift:** `package.json` declares `^8.3.5` but the lockfile
  resolves `8.5.1`. Don't assume APIs exact across that range.
- **`marked-terminal.d.ts`** is a local type shim (in `src/`) for the
  `marked-terminal` import; be careful editing it.
- The **default `default` provider is a stub** and should not be "fixed" by
  pointing it at a hardcoded vendor — wire it via the existing provider layer.
- `exit_plan_mode` only surfaces in plan mode (`toolSchemas(..., planMode)`); the
  `workflow` tool is dropped when `dynamicWorkflows` is off; `task`/`plan`/`workflow`
  are withheld from sub-agents to cap nesting at one level.
- Mid-turn auto-compaction and context-overflow retry are implemented in
  `providers/anthropic.ts` (`compactConvo`, `pickCut`, `MAX_STEPS = 1000`) — do not
  assume Claude's exact thresholds there.
- **Reasoning/agent orchestration sub-features** defined by this repo's own system
  prompt (todo lists, effort levels, workflows) are concrete tools here — when you
  add one, it appears in `TOOLS` and its schema goes to the model.