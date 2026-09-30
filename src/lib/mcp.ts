// MCP (Model Context Protocol) client — connects MeowCode to local MCP servers
// so their tools become callable by the model, the largest parity gap with Claude
// Code. Scope: the stdio transport (the common local case) — a server is a child
// process we speak newline-delimited JSON-RPC 2.0 to. We run the initialize
// handshake, discover the server's tools with `tools/list`, and expose each as a
// ToolDef named `mcp__<server>__<tool>` whose `run` proxies to `tools/call`.
//
// Servers are configured under the `mcpServers` key of settings.json (user-global
// via AppConfig) merged with a project-local .anycode/settings.json, mirroring
// Claude Code's shape:
//   "mcpServers": { "fs": { "command": "npx", "args": ["-y","@modelcontextprotocol/server-filesystem","/tmp"] } }
//
// Everything here is in-memory and process-scoped: servers start on app mount and
// are killed on exit. Discovery is async, so a server's tools appear once it has
// initialized (by the next turn at the latest).
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { loadConfig } from '../config'
import type { ToolDef, ToolResult } from '../tools/types'

export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  disabled?: boolean
  // Working directory for the server process (defaults to the session cwd).
  cwd?: string
}
export type McpServers = Record<string, McpServerConfig>

export interface McpTool {
  name: string                 // the server-local tool name
  description?: string
  inputSchema?: Record<string, unknown>
}

export type McpStatus = 'starting' | 'ready' | 'failed' | 'stopped'

interface Pending {
  resolve: (v: any) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// One connected (or connecting) server: its process, the JSON-RPC plumbing, and
// what we've discovered.
export interface McpServer {
  name: string
  config: McpServerConfig
  child: ChildProcess
  status: McpStatus
  error?: string
  tools: McpTool[]
  buf: string                  // partial line carried between stdout chunks
  nextId: number
  pending: Map<number, Pending>
}

const servers = new Map<string, McpServer>()
const PROTOCOL_VERSION = '2024-11-05'
const REQUEST_TIMEOUT_MS = 30_000

// ---- JSON-RPC transport (newline-delimited over the child's stdio) -----------

// Send a request and await its response; `notify` sends a fire-and-forget
// notification (no id, no reply) instead.
function rpc(srv: McpServer, method: string, params?: unknown): Promise<any> {
  const id = srv.nextId++
  const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
  return new Promise((resolve, reject) => {
    if (!srv.child.stdin || srv.child.stdin.destroyed) {
      reject(new Error('server stdin closed'))
      return
    }
    const timer = setTimeout(() => {
      srv.pending.delete(id)
      reject(new Error(`MCP request timed out: ${method}`))
    }, REQUEST_TIMEOUT_MS)
    srv.pending.set(id, { resolve, reject, timer })
    srv.child.stdin.write(line, (err) => {
      if (err) {
        clearTimeout(timer)
        srv.pending.delete(id)
        reject(err)
      }
    })
  })
}

function notify(srv: McpServer, method: string, params?: unknown): void {
  if (!srv.child.stdin || srv.child.stdin.destroyed) return
  srv.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
}

// Parse one complete stdout line. Responses carry an `id` we match to a pending
// request; notifications (no id) are ignored — we don't subscribe to any.
function handleLine(srv: McpServer, line: string): void {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg: any
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return // non-JSON chatter on stdout — ignore
  }
  if (msg && typeof msg.id === 'number' && srv.pending.has(msg.id)) {
    const p = srv.pending.get(msg.id)!
    srv.pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new Error(msg.error.message || 'MCP error'))
    else p.resolve(msg.result)
  }
}

function onStdout(srv: McpServer, chunk: Buffer): void {
  srv.buf += chunk.toString('utf8')
  let nl: number
  while ((nl = srv.buf.indexOf('\n')) >= 0) {
    const line = srv.buf.slice(0, nl)
    srv.buf = srv.buf.slice(nl + 1)
    handleLine(srv, line)
  }
}

// ---- config loading ----------------------------------------------------------

// Merge the user-global `mcpServers` (settings.json via AppConfig) with a
// project-local .anycode/settings.json; the project entry wins on name clash.
export function loadMcpServers(cwd = process.cwd()): McpServers {
  const out: McpServers = {}
  try {
    const user = loadConfig().mcpServers as McpServers | undefined
    if (user && typeof user === 'object') Object.assign(out, user)
  } catch {}
  try {
    const p = path.join(cwd, '.anycode', 'settings.json')
    if (fs.existsSync(p)) {
      const proj = JSON.parse(fs.readFileSync(p, 'utf8'))?.mcpServers as McpServers | undefined
      if (proj && typeof proj === 'object') Object.assign(out, proj)
    }
  } catch {}
  return out
}

// ---- lifecycle ---------------------------------------------------------------

function fail(srv: McpServer, err: unknown): void {
  srv.status = 'failed'
  srv.error = err instanceof Error ? err.message : String(err)
  for (const p of srv.pending.values()) {
    clearTimeout(p.timer)
    p.reject(new Error(srv.error))
  }
  srv.pending.clear()
}

async function initServer(srv: McpServer): Promise<void> {
  await rpc(srv, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'MeowCode', version: '1.0.0' },
  })
  notify(srv, 'notifications/initialized')
  const res = await rpc(srv, 'tools/list', {})
  const tools = Array.isArray(res?.tools) ? res.tools : []
  srv.tools = tools.map((t: any) => ({
    name: String(t.name),
    description: typeof t.description === 'string' ? t.description : undefined,
    inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : undefined,
  }))
  srv.status = 'ready'
}

function spawnServer(name: string, config: McpServerConfig, cwd: string): McpServer {
  const child = spawn(config.command, config.args ?? [], {
    cwd: config.cwd || cwd,
    env: { ...process.env, ...(config.env ?? {}) } as NodeJS.ProcessEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const srv: McpServer = {
    name, config, child, status: 'starting', tools: [],
    buf: '', nextId: 1, pending: new Map(),
  }
  child.stdout?.on('data', (c: Buffer) => onStdout(srv, c))
  child.on('error', (e) => fail(srv, e))
  child.on('exit', (code) => {
    if (srv.status === 'stopped') return
    if (srv.status !== 'ready' || code) fail(srv, new Error(`server exited (code ${code})`))
    else srv.status = 'stopped'
  })
  return srv
}

// Start every configured, non-disabled server that isn't already running.
// Discovery is async and best-effort: a spawn/handshake failure marks that one
// server 'failed' without throwing, so one bad entry can't block the others.
export function startMcpServers(cwd = process.cwd()): void {
  const configs = loadMcpServers(cwd)
  for (const [name, config] of Object.entries(configs)) {
    if (config.disabled) continue
    if (servers.has(name)) continue
    if (!config.command) continue
    let srv: McpServer
    try {
      srv = spawnServer(name, config, cwd)
    } catch (e) {
      const stub: McpServer = {
        name, config, child: null as any, status: 'failed',
        error: e instanceof Error ? e.message : String(e),
        tools: [], buf: '', nextId: 1, pending: new Map(),
      }
      servers.set(name, stub)
      continue
    }
    servers.set(name, srv)
    initServer(srv).catch((e) => fail(srv, e))
  }
}

export function stopMcpServers(): void {
  for (const srv of servers.values()) {
    srv.status = 'stopped'
    try { srv.child?.kill('SIGTERM') } catch {}
  }
  servers.clear()
}

export interface McpServerInfo {
  name: string
  status: McpStatus
  error?: string
  tools: string[]
  command: string
}

export function listMcpServers(): McpServerInfo[] {
  return [...servers.values()].map((s) => ({
    name: s.name,
    status: s.status,
    error: s.error,
    tools: s.tools.map((t) => t.name),
    command: [s.config.command, ...(s.config.args ?? [])].join(' '),
  }))
}

// ---- tool bridging -----------------------------------------------------------

// Fully-qualified tool name, matching Claude Code: mcp__<server>__<tool>. The
// server and tool names can themselves contain underscores, so we can't split on
// '__' naively — we peel the fixed `mcp__` prefix, then the server name is the
// key of the server that owns a tool whose qualified name equals `full`.
export const MCP_PREFIX = 'mcp__'

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_PREFIX)
}

function qualified(server: string, tool: string): string {
  return `${MCP_PREFIX}${server}__${tool}`
}

// Resolve a fully-qualified name back to its (server, tool) by matching against
// live registrations — robust to underscores in either component.
function resolve(full: string): { srv: McpServer; tool: McpTool } | undefined {
  for (const srv of servers.values()) {
    for (const tool of srv.tools) {
      if (qualified(srv.name, tool.name) === full) return { srv, tool }
    }
  }
  return undefined
}

// Flatten an MCP tools/call result into our text-first ToolResult. MCP returns a
// `content` array of typed parts; we join the text parts and note any others.
function formatCallResult(res: any): ToolResult {
  const parts = Array.isArray(res?.content) ? res.content : []
  const texts: string[] = []
  for (const p of parts) {
    if (p?.type === 'text' && typeof p.text === 'string') texts.push(p.text)
    else if (p?.type === 'image') texts.push('[image omitted]')
    else if (p?.type === 'resource') texts.push(`[resource: ${p.resource?.uri ?? '?'}]`)
    else if (p) texts.push(`[${p.type ?? 'unknown'} content]`)
  }
  const content = texts.join('\n') || '(no content)'
  return { content, isError: res?.isError === true }
}

// Build a ToolDef for every tool of every ready server. Called each time schemas
// are assembled, so tools that finish discovering after startup appear on the
// next turn without any explicit refresh.
export function mcpToolDefs(): ToolDef[] {
  const defs: ToolDef[] = []
  for (const srv of servers.values()) {
    if (srv.status !== 'ready') continue
    for (const tool of srv.tools) {
      const name = qualified(srv.name, tool.name)
      defs.push({
        name,
        description: tool.description || `MCP tool ${tool.name} (server: ${srv.name})`,
        input_schema:
          tool.inputSchema && (tool.inputSchema as any).type
            ? (tool.inputSchema as Record<string, unknown>)
            : { type: 'object', properties: {} },
        async run(input) {
          const hit = resolve(name)
          if (!hit) return { content: `MCP tool no longer available: ${name}`, isError: true }
          if (hit.srv.status !== 'ready')
            return { content: `MCP server '${hit.srv.name}' is ${hit.srv.status}`, isError: true }
          try {
            const res = await rpc(hit.srv, 'tools/call', { name: hit.tool.name, arguments: input })
            return formatCallResult(res)
          } catch (e) {
            return { content: `MCP call failed: ${e instanceof Error ? e.message : String(e)}`, isError: true }
          }
        },
      })
    }
  }
  return defs
}

// Find a single MCP ToolDef by fully-qualified name (used by runTool dispatch).
export function findMcpTool(name: string): ToolDef | undefined {
  if (!isMcpToolName(name)) return undefined
  return mcpToolDefs().find((d) => d.name === name)
}
