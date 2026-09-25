# AnyCode

A Claude Code–style agentic coding CLI. This is the **framework skeleton** — the
terminal UI, streaming loop, slash-command system, and a pluggable provider
layer are all in place. Real agent capabilities (tools, file edits, planning)
are meant to be layered on next.

## Quick start

```bash
npm install
npm run dev        # interactive session (mock provider, no API key needed)
```

Build a standalone CLI:

```bash
npm run build      # bundles to dist/cli.js with a shebang
node dist/cli.js   # or: npm link  → then run `anycode`
```

## Using a real model

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run dev        # provider auto-switches to `anthropic`
```

The Anthropic provider streams via the Messages API using the built-in `fetch`
(no SDK dependency).

## Non-interactive / scripting

```bash
anycode -p "explain this repo"
echo "write a haiku about tps reports" | anycode
```

## Commands

`/help` · `/model <id>` · `/provider <mock|anthropic>` · `/config` · `/clear` · `/version` · `/exit`

## Layout

```
src/
  cli.tsx            entry point (arg parsing, print mode, render)
  app.tsx            Ink app: layout, global keys, elapsed timer
  theme.ts           colors + symbols
  types.ts           Message / Provider / Command contracts
  config.ts          ~/.anycode/settings.json load/save
  hooks/useChat.ts   conversation state machine + streaming
  components/        Banner · Message · StatusLine · PromptInput
  commands/          slash-command registry
  providers/         mock (offline) + anthropic (real, fetch/SSE)
  lib/               markdown rendering · spinner frames · token estimate
```

## Extending

- **Add a command:** push a `SlashCommand` onto `registry` in `src/commands/index.ts`.
- **Add a provider:** implement the `Provider` interface and register it in `src/providers/index.ts`.
- **Add tools / file edits:** give a provider access to a tool loop and render
  `tool` messages in `src/components/Message.tsx` (the role already exists).
