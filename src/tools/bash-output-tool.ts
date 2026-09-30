// The `bash_output` tool — read incremental output from, list, or kill the
// background shells started by `bash` with `run_in_background: true`. This is the
// PULL side of background execution (see lib/bgshell): a background command
// buffers its output silently, and this tool hands back only the bytes produced
// since your last read, plus the shell's status. Mirrors Claude Code's
// BashOutput + KillShell, folded into one action-based tool.
import type { ToolDef, ToolResult } from './types'
import { readBgShell, killBgShell, listBgShells, type BgShell } from '../lib/bgshell'
import { clip } from './util'

function statusLine(s: BgShell): string {
  const age = Math.round(((s.endedAt ?? Date.now()) - s.startedAt) / 1000)
  const code = s.status === 'completed' || s.status === 'failed' ? ` (exit ${s.exitCode ?? '?'})` : ''
  const err = s.error ? ` · ${s.error}` : ''
  return `${s.id} · ${s.status}${code} · ${age}s · ${s.command.split('\n')[0].slice(0, 60)}${err}`
}

export const bashOutput: ToolDef = {
  name: 'bash_output',
  description:
    'Read new output from a background shell started by `bash` (run_in_background), or list/kill background shells. ' +
    'action "read" (default): return the stdout/stderr produced by `bash_id` SINCE YOUR LAST READ, plus its running/exited status — call it repeatedly to follow progress. Optional `filter` is a regex that keeps only matching output lines. ' +
    'action "list": show all background shells and their status. ' +
    'action "kill": terminate the shell `bash_id`.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['read', 'list', 'kill'], description: 'read new output (default), list shells, or kill one.' },
      bash_id: { type: 'string', description: 'The background shell id (from bash run_in_background). Required for read/kill.' },
      filter: { type: 'string', description: 'For "read": regex; only output lines matching it are returned.' },
    },
  },
  async run(input): Promise<ToolResult> {
    const action = String(input.action ?? 'read')
    if (action === 'list') {
      const shells = listBgShells()
      if (shells.length === 0) return { content: 'No background shells.', display: 'bash_output · none' }
      const view = shells.map(statusLine).join('\n')
      return { content: `Background shells:\n${view}`, display: `bash_output · ${shells.length} shell(s)` }
    }
    const id = String(input.bash_id ?? '')
    if (action === 'kill') {
      if (!id) return { content: 'bash_output kill: `bash_id` is required', isError: true }
      const ok = killBgShell(id)
      return ok ? { content: `Killed ${id}.`, display: `bash_output · killed ${id}` } : { content: `No such background shell: ${id}`, isError: true }
    }
    if (action === 'read') {
      if (!id) return { content: 'bash_output read: `bash_id` is required', isError: true }
      const filter = typeof input.filter === 'string' && input.filter.trim() ? input.filter : undefined
      const r = readBgShell(id, filter)
      if (!r) return { content: `No such background shell: ${id}`, isError: true }
      const parts: string[] = [statusLine(r.shell)]
      if (r.stdout.trim()) parts.push(`[stdout]\n${r.stdout.trimEnd()}`)
      if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`)
      if (!r.stdout.trim() && !r.stderr.trim()) parts.push(r.shell.status === 'running' ? '(no new output)' : '(no further output)')
      return { content: clip(parts.join('\n\n')), display: `bash_output · ${id} (${r.shell.status})` }
    }
    return { content: `bash_output: unknown action "${action}" (use read | list | kill)`, isError: true }
  },
}
