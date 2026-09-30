// The `skill` tool — makes MeowCode's reusable prompt playbooks (see lib/skills)
// invocable BY THE MODEL, not just via the /skill slash command. Real Claude Code
// exposes skills as a tool with progressive disclosure: the agent sees the list of
// available skills (names + one-line descriptions) in the tool schema, and calls
// the tool to pull a chosen skill's full instructions into context on demand,
// rather than front-loading every skill body into the system prompt.
//
// Here the tool returns the selected skill's body (with $ARGUMENTS / $1..$9
// expanded, exactly like the slash command) as its result, so the agent then
// follows those instructions in the same turn. With no name it lists what's
// available — a cheap way for the model to discover skills mid-task.
import type { ToolDef, ToolResult } from './types'
import { loadSkills, expandArgs } from '../lib/skills'

// Build a short catalog line list for the description and the no-arg listing.
function catalog(cwd: string): string {
  const skills = loadSkills(cwd)
  if (!skills.length) return ''
  return skills.map((s) => `- ${s.name}: ${s.description}`).join('\n')
}

export const skillTool: ToolDef = {
  name: 'skill',
  description:
    'Invoke a reusable project/user skill — a saved playbook of instructions for a recurring task (deploy steps, a review checklist, a repo-specific workflow). ' +
    'Call with a `name` to load that skill\'s full instructions (its body, with any $ARGUMENTS/$1..$9 placeholders filled from `args`) into your context; then follow them as part of the current turn. ' +
    'Call with NO `name` to list the available skills first. Skills live in `~/.anycode/skills/<name>/SKILL.md` (user-global) and `./.anycode/skills/<name>/SKILL.md` (project, wins on name clash). ' +
    'Prefer a matching skill over improvising when the task is one a skill covers.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The skill to invoke (case-insensitive). Omit to list available skills.' },
      args: { type: 'string', description: 'Optional argument string, substituted for $ARGUMENTS and $1..$9 in the skill body.' },
    },
  },
  async run(input, ctx): Promise<ToolResult> {
    const cwd = ctx.cwd || process.cwd()
    const skills = loadSkills(cwd)
    const name = typeof input.name === 'string' ? input.name.trim().toLowerCase() : ''
    if (!name) {
      if (!skills.length) {
        return { content: 'No skills available. Add one at `~/.anycode/skills/<name>/SKILL.md` or `./.anycode/skills/<name>/SKILL.md`.' }
      }
      const list = catalog(cwd)
      return { content: `Available skills:\n${list}\n\nCall this tool again with a \`name\` to load one.`, display: `${skills.length} skill${skills.length === 1 ? '' : 's'}` }
    }
    const found = skills.find((s) => s.name === name)
    if (!found) {
      const list = catalog(cwd)
      const hint = list ? `\n\nAvailable skills:\n${list}` : ''
      return { content: `Unknown skill "${name}".${hint}`, isError: true }
    }
    const args = typeof input.args === 'string' ? input.args : ''
    const body = expandArgs(found.body, args)
    return {
      content: `Skill "${found.name}" loaded — follow these instructions:\n\n${body}`,
      display: `skill · ${found.name}`,
    }
  },
}
