// The `monitor` tool — a background watcher, backed by lib/monitor. It spawns a
// shell command and turns each stdout/stderr line the command emits into a wakeup
// event fed back as a fresh turn (via the sink the app registers), so you're
// notified as things happen instead of polling. Point it at `tail -f app.log`,
// an `inotifywait` loop, or any poll-loop that prints when state changes; the
// watch ends when the command exits, when you stop it, or on a timeout/event cap.
// Session-scoped and in-memory. This mirrors Claude Code's Monitor tool.
import type { ToolDef, ToolResult } from './types'
import { startMonitor, listMonitors, stopMonitor, type Monitor } from '../lib/monitor'

function describe(m: Monitor): string {
  const age = Math.round((Date.now() - m.startedAt) / 1000)
  return `${m.id} · ${m.done ? 'ended' : 'running'} · ${m.events} event(s) · ${age}s · ${m.description}`
}

export const monitorTool: ToolDef = {
  name: 'monitor',
  description:
    'Watch a long-running command and get woken up as it emits output — a push alternative to polling with bash. ' +
    'action "start": spawn `command` in a shell; each stdout/stderr LINE it prints is forwarded to you as a new turn (bursts are batched). ' +
    'Good for `tail -f`, file watchers, or a poll loop that prints only when something changes. ' +
    'The watch ends when the command exits, when you "stop" it, or after `timeout_seconds` (default 300, max 1800) or an internal event cap. ' +
    'action "list": show monitors. action "stop": end one by `id`. Keep the command output SELECTIVE (grep/filter) so you are woken for signal, not noise.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'list', 'stop'], description: 'start a watcher, list watchers, or stop one.' },
      command: { type: 'string', description: 'For "start": the shell command to run and watch (its output lines become wakeups).' },
      description: { type: 'string', description: 'For "start": optional short label for this watcher.' },
      timeout_seconds: { type: 'number', description: 'For "start": auto-stop after this many seconds (default 300, max 1800).' },
      id: { type: 'string', description: 'For "stop": the monitor id (from start/list).' },
    },
    required: ['action'],
  },
  async run(input): Promise<ToolResult> {
    const action = String(input.action ?? '')
    if (action === 'list') {
      const mons = listMonitors()
      if (mons.length === 0) return { content: 'No monitors.', display: 'monitor · none' }
      const view = mons.map(describe).join('\n')
      return { content: `Monitors:\n${view}`, display: view }
    }
    if (action === 'stop') {
      const id = String(input.id ?? '')
      if (!id) return { content: 'monitor stop: `id` is required', isError: true }
      const ok = stopMonitor(id)
      return ok ? { content: `Stopped ${id}.`, display: `monitor · stopped ${id}` } : { content: `No such monitor: ${id}`, isError: true }
    }
    if (action === 'start') {
      const command = typeof input.command === 'string' ? input.command.trim() : ''
      if (!command) return { content: 'monitor start: `command` is required', isError: true }
      const desc = typeof input.description === 'string' ? input.description.trim() : undefined
      const ttl = typeof input.timeout_seconds === 'number' && isFinite(input.timeout_seconds) ? Math.round(input.timeout_seconds * 1000) : undefined
      const outcome = startMonitor(command, desc, ttl)
      if (outcome.error || !outcome.monitor) return { content: `monitor start: ${outcome.error ?? 'failed'}`, isError: true }
      const d = describe(outcome.monitor)
      return { content: `Started ${d}. Its output lines will be delivered to you as new turns until it ends.`, display: `monitor · ${d}` }
    }
    return { content: `monitor: unknown action "${action}" (use start | list | stop)`, isError: true }
  },
}
