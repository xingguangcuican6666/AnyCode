import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { parseFrontmatter } from './frontmatter'

// Skills are reusable prompt playbooks, like Claude Code's skills. Each lives in
// its own directory as SKILL.md with optional front-matter (name, description).
// Invoking a skill sends its body to the model as a user turn (with $ARGUMENTS
// substituted), so a skill is essentially a saved, parameterizable instruction.
export interface Skill {
  name: string
  description: string
  body: string
  source: string // absolute path to the SKILL.md
}

// User-global skills, then project-local ones (project wins on name clash).
export function skillDirs(cwd = process.cwd()): string[] {
  return [path.join(os.homedir(), '.anycode', 'skills'), path.join(cwd, '.anycode', 'skills')]
}

function readSkillDir(dir: string): Skill[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return [] // dir doesn't exist — fine
  }
  const out: Skill[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const file = path.join(dir, e.name, 'SKILL.md')
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch {
      continue // no SKILL.md in this subdir
    }
    const { meta, body } = parseFrontmatter(raw)
    out.push({
      name: (meta.name || e.name).toLowerCase(),
      description: meta.description || 'User skill',
      body,
      source: file,
    })
  }
  return out
}

// Merge skills across all dirs; later dirs (project-local) override earlier ones
// (user-global) on matching name.
export function loadSkills(cwd = process.cwd()): Skill[] {
  const byName = new Map<string, Skill>()
  for (const dir of skillDirs(cwd)) for (const s of readSkillDir(dir)) byName.set(s.name, s)
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// Substitute $ARGUMENTS (whole arg string) and $1..$9 (whitespace-split tokens)
// in a skill/command body, exactly like Claude Code's slash-command templates.
export function expandArgs(body: string, args: string): string {
  const tokens = args.trim().length ? args.trim().split(/\s+/) : []
  let out = body.replace(/\$ARGUMENTS\b/g, args.trim())
  out = out.replace(/\$([1-9])\b/g, (_, d: string) => tokens[Number(d) - 1] ?? '')
  // If the template referenced no placeholder but args were given, append them.
  if (!/\$ARGUMENTS\b|\$[1-9]\b/.test(body) && args.trim()) out = `${out}\n\n${args.trim()}`
  return out
}
