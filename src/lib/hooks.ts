// Hooks — user-configurable shell commands that fire on lifecycle events, the
// local-shell counterpart to Claude Code's hooks (PreToolUse / PostToolUse /
// UserPromptSubmit / SessionStart / Stop / Notification). Unlike the LLM-driven
// goal Stop judge (lib/goalJudge), these are plain shell commands the user wires
// up in settings.json; each receives a JSON event payload on stdin and can steer
// the run through its exit code and (optionally) a JSON object on stdout.
//
// Configuration lives under the `hooks` key of settings.json — user-global
// (~/.anycode/settings.json via AppConfig) merged with project-local
// (<cwd>/.anycode/settings.json). Shape mirrors Claude Code:
//   "hooks": { "PreToolUse": [ { "matcher": "bash", "hooks": [ { "type": "command", "command": "...", "timeout": 30 } ] } ] }
//
// Exit-code protocol (per hook process):
//   0            success; stdout may carry a JSON control object or plain context.
//   2            BLOCKING error; stderr is the reason (deny the tool / block the prompt / block stop).
//   other        non-blocking error; stderr is surfaced but the run continues.
// A JSON stdout object may set: continue(false=stop), stopReason/reason,
// decision('block'|'approve'), systemMessage, and
// hookSpecificOutput.{permissionDecision, permissionDecisionReason, additionalContext}.
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { loadConfig } from '../config'

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'SessionStart' | 'Stop' | 'Notification'

export const HOOK_EVENTS: readonly HookEvent[] = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart', 'Stop', 'Notification']

export interface HookCommand {
  type?: string
  command: string
  timeout?: number // seconds
}
export interface HookMatcher {
  matcher?: string          // regex tested against tool_name (Pre/PostToolUse); absent = match all
  hooks: HookCommand[]
}
export type HooksConfig = Partial<Record<HookEvent, HookMatcher[]>>

// Merge user-global (settings.json) with project-local (.anycode/settings.json),
// concatenating matcher lists per event so both fire (project after user).
export function loadHooks(cwd = process.cwd()): HooksConfig {
  const merged: HooksConfig = {}
  const add = (h: HooksConfig | undefined): void => {
    if (!h || typeof h !== 'object') return
    for (const ev of HOOK_EVENTS) {
      const list = h[ev]
      if (Array.isArray(list) && list.length) merged[ev] = [...(merged[ev] ?? []), ...list]
    }
  }
  add(loadConfig().hooks)
  // Project-local settings.json (only its `hooks` key is consulted here).
  try {
    const p = path.join(cwd, '.anycode', 'settings.json')
    if (p !== path.join(os.homedir(), '.anycode', 'settings.json')) {
      const j = JSON.parse(fs.readFileSync(p, 'utf8')) as { hooks?: HooksConfig }
      add(j.hooks)
    }
  } catch { /* no project settings — fine */ }
  return merged
}

export function hasHooks(cwd = process.cwd()): boolean {
  const h = loadHooks(cwd)
  return HOOK_EVENTS.some((ev) => (h[ev]?.length ?? 0) > 0)
}

// Which hook commands fire for this event (filtered by matcher on tool name).
function matchingCommands(cfg: HooksConfig, event: HookEvent, toolName?: string): HookCommand[] {
  const matchers = cfg[event] ?? []
  const out: HookCommand[] = []
  for (const m of matchers) {
    if (m.matcher && toolName != null) {
      let re: RegExp | null = null
      try { re = new RegExp(m.matcher) } catch { re = null }
      // A malformed matcher matches nothing (safer than matching everything).
      if (re && !re.test(toolName)) continue
      if (!re) continue
    }
    for (const h of m.hooks ?? []) if (h && typeof h.command === 'string' && h.command.trim()) out.push(h)
  }
  return out
}

export interface HookOutcome {
  // Strongest permission signal across all hooks that ran: any 'deny' wins;
  // else an explicit 'allow' bypasses the normal permission prompt.
  decision?: 'allow' | 'deny'
  reason?: string          // why (denial reason / blocking feedback)
  context: string          // additionalContext / plain stdout to inject
  systemMessage: string    // messages to surface to the user
  stop: boolean            // a hook requested continue:false
  ran: number              // how many hook commands executed
}

interface OneResult { code: number; stdout: string; stderr: string }

function runOne(cmd: HookCommand, payload: unknown, cwd: string, signal?: AbortSignal): Promise<OneResult> {
  return new Promise((resolve) => {
    const timeoutMs = Math.max(1000, (cmd.timeout && cmd.timeout > 0 ? cmd.timeout : 60) * 1000)
    let child
    try {
      child = spawn(cmd.command, { cwd, shell: '/bin/bash', signal })
    } catch (e) {
      return resolve({ code: 1, stdout: '', stderr: (e as Error).message })
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, timeoutMs)
    child.stdout?.on('data', (d) => { stdout += d.toString() })
    child.stderr?.on('data', (d) => { stderr += d.toString() })
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: stderr || (e as Error).message }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 0, stdout, stderr }) })
    try { child.stdin?.write(JSON.stringify(payload)); child.stdin?.end() } catch { /* stdin may be closed */ }
  })
}

// Parse a hook's stdout as a JSON control object; returns null if it isn't one.
function parseControl(stdout: string): Record<string, any> | null {
  const s = stdout.trim()
  if (!s.startsWith('{')) return null
  try { return JSON.parse(s) as Record<string, any> } catch { return null }
}

// Run every hook configured for `event`, aggregate their outcomes, and return a
// single verdict. Hooks run sequentially (order = user then project); a blocking
// hook still lets the rest run so all context is collected, but any deny wins.
export async function runHooks(
  event: HookEvent,
  payload: Record<string, unknown>,
  cwd = process.cwd(),
  cfg?: HooksConfig,
  signal?: AbortSignal,
): Promise<HookOutcome> {
  const hooks = cfg ?? loadHooks(cwd)
  const cmds = matchingCommands(hooks, event, payload.tool_name as string | undefined)
  const outcome: HookOutcome = { context: '', systemMessage: '', stop: false, ran: 0 }
  if (cmds.length === 0) return outcome
  const body = { hook_event_name: event, cwd, ...payload }
  const ctxParts: string[] = []
  const sysParts: string[] = []
  for (const cmd of cmds) {
    if (signal?.aborted) break
    const r = await runOne(cmd, body, cwd, signal)
    outcome.ran += 1
    const control = parseControl(r.stdout)
    // Exit code 2 => blocking; stderr is the reason.
    if (r.code === 2) {
      outcome.decision = 'deny'
      outcome.reason = (r.stderr.trim() || outcome.reason || `Blocked by ${event} hook`).trim()
      continue
    }
    if (r.code !== 0) {
      // Non-blocking failure: surface stderr but keep going.
      if (r.stderr.trim()) sysParts.push(`[${event} hook exited ${r.code}] ${r.stderr.trim()}`)
      continue
    }
    if (control) {
      const spec = (control.hookSpecificOutput ?? {}) as Record<string, any>
      const permDecision = spec.permissionDecision ?? control.decision
      if (permDecision === 'deny' || permDecision === 'block') {
        outcome.decision = 'deny'
        outcome.reason = String(spec.permissionDecisionReason ?? control.reason ?? outcome.reason ?? `Blocked by ${event} hook`)
      } else if ((permDecision === 'allow' || permDecision === 'approve') && outcome.decision !== 'deny') {
        outcome.decision = 'allow'
        if (control.reason) outcome.reason = String(control.reason)
      }
      if (control.continue === false) { outcome.stop = true; if (control.stopReason) outcome.reason = String(control.stopReason) }
      if (typeof spec.additionalContext === 'string' && spec.additionalContext.trim()) ctxParts.push(spec.additionalContext.trim())
      if (typeof control.systemMessage === 'string' && control.systemMessage.trim()) sysParts.push(control.systemMessage.trim())
    } else if (r.stdout.trim()) {
      // Plain stdout is treated as context to inject (for events that support it).
      ctxParts.push(r.stdout.trim())
    }
  }
  outcome.context = ctxParts.join('\n\n')
  outcome.systemMessage = sysParts.join('\n')
  return outcome
}
