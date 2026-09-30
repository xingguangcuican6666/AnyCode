// Custom sub-agent types — the `.anycode/agents/*.md` loader that lets a project
// (or the user) define named sub-agents beyond the built-in general/explore/code/
// plan roles, mirroring Claude Code's `.claude/agents/*.md`. Each file is a
// Markdown doc with front-matter (name, description, optional tools, optional
// model) whose BODY is the sub-agent's system prompt. The orchestration tools
// (task/plan/workflow) resolve a `subagent_type` against these on spawn, and the
// names are surfaced to the model so it knows what's available.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { parseFrontmatter } from './frontmatter'

export interface CustomAgent {
  name: string
  description: string
  /** The system prompt for this sub-agent (the Markdown body). */
  prompt: string
  /** Optional allow-list of tool names the sub-agent may use (advisory). */
  tools?: string[]
  /** Optional model override for this sub-agent (advisory). */
  model?: string
  /** Absolute path to the source .md file. */
  source: string
}

// User-global agents, then project-local ones (project wins on name clash).
export function agentDirs(cwd = process.cwd()): string[] {
  return [path.join(os.homedir(), '.anycode', 'agents'), path.join(cwd, '.anycode', 'agents')]
}

function parseList(v: string | undefined): string[] | undefined {
  if (!v) return undefined
  const items = v.split(',').map((s) => s.trim()).filter(Boolean)
  return items.length ? items : undefined
}

function readAgentDir(dir: string): CustomAgent[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return [] // dir doesn't exist — fine
  }
  const out: CustomAgent[] = []
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.md')) continue
    const file = path.join(dir, e.name)
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const { meta, body } = parseFrontmatter(raw)
    const name = (meta.name || e.name.replace(/\.md$/i, '')).toLowerCase()
    if (!name || !body.trim()) continue
    out.push({
      name,
      description: meta.description || 'Custom sub-agent',
      prompt: body.trim(),
      tools: parseList(meta.tools),
      model: meta.model || undefined,
      source: file,
    })
  }
  return out
}

// Merge agents across all dirs; later dirs (project-local) override earlier ones
// (user-global) on matching name. Sorted by name for stable listings.
export function loadAgents(cwd = process.cwd()): CustomAgent[] {
  const byName = new Map<string, CustomAgent>()
  for (const dir of agentDirs(cwd)) for (const a of readAgentDir(dir)) byName.set(a.name, a)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// Look up one custom agent by (case-insensitive) name.
export function findAgent(name: string, cwd = process.cwd()): CustomAgent | undefined {
  const key = name.trim().toLowerCase()
  return loadAgents(cwd).find((a) => a.name === key)
}
