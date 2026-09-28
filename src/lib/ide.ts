import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Best-effort IDE detection for the `autoConnectIde` setting. A full editor
// integration needs a MeowCode IDE extension (not built yet), so this does what
// it honestly can WITHOUT one: recognize when we're running inside an editor's
// integrated terminal (from the env it sets), and otherwise scan for lock files
// a future extension would drop under ~/.anycode/ide/. It never opens a socket
// or claims a live connection — callers report detection, not a handshake.

export interface IdeLock {
  port: string
  pid?: number
  ideName?: string
  workspace?: string
  transport?: string
}

export interface IdeStatus {
  // Running inside an IDE's own integrated terminal (auto-connect is implicit).
  integrated: boolean
  // Best guess at the IDE's name (from the env, or a discovered lock file).
  ideName?: string
  // IDEs discoverable via lock files — the "external terminal" case the setting
  // is named for. Empty when integrated or when nothing is running.
  external: IdeLock[]
}

const LOCK_DIR = path.join(os.homedir(), '.anycode', 'ide')

// Recognize an IDE's integrated terminal from the environment it injects.
function integratedIde(env: NodeJS.ProcessEnv): string | undefined {
  if (env.TERM_PROGRAM === 'vscode' || env.VSCODE_GIT_IPC_HANDLE || env.VSCODE_INJECTION || env.VSCODE_PID) return 'VS Code'
  if ((env.TERMINAL_EMULATOR ?? '').includes('JetBrains') || env.INTELLIJ_ENVIRONMENT_READER) return 'JetBrains IDE'
  return undefined
}

// Parse the *.lock files a MeowCode IDE extension would leave (named <port>.lock,
// holding JSON). Tolerates missing dir and corrupt entries.
function readLocks(): IdeLock[] {
  let names: string[]
  try { names = fs.readdirSync(LOCK_DIR).filter((f) => f.endsWith('.lock')) } catch { return [] }
  const out: IdeLock[] = []
  for (const f of names) {
    const port = f.replace(/\.lock$/, '')
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(LOCK_DIR, f), 'utf8')) as Partial<IdeLock> & { workspaceFolders?: string[]; ide?: string }
      out.push({
        port,
        pid: typeof raw.pid === 'number' ? raw.pid : undefined,
        ideName: raw.ideName ?? raw.ide,
        workspace: raw.workspace ?? raw.workspaceFolders?.[0],
        transport: raw.transport,
      })
    } catch {
      out.push({ port }) // a lock we can't parse still signals "something is there"
    }
  }
  return out
}

export function detectIde(env: NodeJS.ProcessEnv = process.env): IdeStatus {
  const ideName = integratedIde(env)
  if (ideName) return { integrated: true, ideName, external: [] }
  const external = readLocks()
  return { integrated: false, ideName: external[0]?.ideName, external }
}
