// The `message` tool — agent-facing cross-session messaging over the same
// file-based mailbox the /dm command and the `otherSessionMessages` setting use
// (see lib/mailbox). It lets the model coordinate with the user's OTHER live
// MeowCode sessions on this machine: list who's running, send a note or a
// hand-off to one (or broadcast), check for replies, and subscribe to a peer's
// idle notices (the real-time socket layer, lib/sessionSocket). Same-machine,
// same-user convenience only — best-effort, not a durable queue, and no identity
// means no peers (e.g. print mode), which the tool reports rather than failing.
import type { ToolDef, ToolResult } from './types'
import { livePeers, sendMail, pollMail, getIdentity } from '../lib/mailbox'
import { subscribeTo, unsubscribeFrom, mySubscriptions, isSubscribed, isReachable } from '../lib/sessionSocket'

// Cursor for the `check` action: only inbound mail newer than this is reported,
// advanced to "now" after each check so a message is surfaced to the agent once.
let lastCheck = 0

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}
function rand(): string {
  return Math.random().toString(36).slice(2, 10)
}

export const messageTool: ToolDef = {
  name: 'message',
  description:
    'Coordinate with the user\'s OTHER running MeowCode sessions on this machine (same file-based mailbox as /dm). ' +
    'Actions: "list" — the live peer sessions (id, title, working dir); ' +
    '"send" {to, text} — send text to a peer session id, or to "*" to broadcast to all; ' +
    '"check" — inbound messages addressed to this session since you last checked; ' +
    '"subscribe"/"unsubscribe" {to} — start/stop receiving a peer\'s idle notices so you can react when it finishes a turn. ' +
    'Same-machine, same-user only; best-effort (a message may expire if the peer never reads it). Use it to hand off context or ask a peer session to do something in its own directory.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'send', 'check', 'subscribe', 'unsubscribe'], description: 'The operation to perform.' },
      to: { type: 'string', description: 'Recipient session id, or "*" to broadcast (required for send; recipient id for subscribe/unsubscribe).' },
      text: { type: 'string', description: 'Message body (required for send).' },
    },
    required: ['action'],
  },
  async run(input): Promise<ToolResult> {
    const action = str(input.action)
    const now = Date.now()
    switch (action) {
      case 'list': {
        const peers = livePeers(now)
        if (peers.length === 0) return { content: 'No other MeowCode sessions are currently running.', display: 'message · list (0 peers)' }
        const body = peers.map((p) => {
          const marks = [isReachable(p.id) ? '●' : '', isSubscribed(p.id) ? '✓' : ''].filter(Boolean).join(' ')
          return `• ${p.id} — ${p.title}\n  cwd: ${p.cwd}${marks ? `  ${marks}` : ''}`
        }).join('\n')
        return { content: `Live peer sessions (${peers.length}):\n${body}`, display: `message · list (${peers.length} peers)` }
      }
      case 'send': {
        const to = str(input.to)
        const text = str(input.text)
        if (!to || !text) return { content: 'message send: `to` and `text` are both required', isError: true }
        if (!getIdentity()) return { content: 'message send: this session has no mailbox identity (e.g. print mode); cannot send.', isError: true }
        const ok = sendMail(to, text, now, rand())
        return ok
          ? { content: `Sent to ${to === '*' ? 'all peers' : to}.`, display: `message · send → ${to}` }
          : { content: 'message send: failed (no session identity or write error).', isError: true }
      }
      case 'subscribe':
      case 'unsubscribe': {
        const to = str(input.to)
        if (!to || to === '*' || to === 'all') return { content: `message ${action}: a specific peer session id is required (use "list" to see them)`, isError: true }
        if (!getIdentity()) return { content: `message ${action}: this session has no mailbox identity (e.g. print mode); cannot subscribe.`, isError: true }
        if (action === 'subscribe') subscribeTo(to, now)
        else unsubscribeFrom(to, now)
        return { content: `${action === 'subscribe' ? 'Subscribed to' : 'Unsubscribed from'} ${to} idle notices.`, display: `message · ${action} → ${to}` }
      }
      case 'check': {
        if (!getIdentity()) return { content: 'message check: this session has no mailbox identity; nothing to check.', display: 'message · check (n/a)' }
        const mail = pollMail(lastCheck, now)
        lastCheck = now
        const subs = mySubscriptions()
        const idleNote = subs.length
          ? `\n\nSubscribed idle notices: ${subs.join(', ')}`
          : '\n\nNot subscribed to any peer idle notices — use "subscribe" to be woken when a peer finishes a turn.'
        if (mail.length === 0) return { content: `No new messages.${idleNote}`, display: `message · check (0 new)` }
        const body = mail.map((m) => `from ${m.fromTitle} (${m.from}) @ ${new Date(m.ts).toLocaleTimeString()}:\n${m.text}`).join('\n\n')
        return { content: `New messages (${mail.length}):\n\n${body}${idleNote}`, display: `message · check (${mail.length} new)` }
      }
      default:
        return { content: `message: unknown action "${action}" (use list | send | check | subscribe | unsubscribe)`, isError: true }
    }
  },
}
