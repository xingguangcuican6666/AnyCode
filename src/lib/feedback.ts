// Local feedback capture for the `/feedback` command and the `draftedFeedback`
// setting. MeowCode has no feedback backend, so we persist each report as a small
// Markdown file under ~/.anycode/feedback/ (the honest local analogue of Claude
// Code's "report feedback"). `draftedFeedback` decides whether a bare `/feedback`
// asks the model to DRAFT a report for you first (see the command), versus just
// prompting you to type one.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const FEEDBACK_DIR = path.join(os.homedir(), '.anycode', 'feedback')

export interface SavedFeedback { file: string }

// Persist a feedback report to a timestamp-named Markdown file. `stamp` is passed
// in (callers hold the clock) so this stays a pure fs helper. Returns the path.
export function saveFeedback(body: string, stamp: string): SavedFeedback {
  fs.mkdirSync(FEEDBACK_DIR, { recursive: true })
  const safe = stamp.replace(/[^\w.-]+/g, '-')
  const file = path.join(FEEDBACK_DIR, `feedback-${safe}.md`)
  fs.writeFileSync(file, `# MeowCode feedback\n\n- when: ${stamp}\n\n${body.trim()}\n`, 'utf8')
  return { file }
}

// Count of stored feedback files (for the "you have N drafts" summary), 0 on any error.
export function feedbackCount(): number {
  try { return fs.readdirSync(FEEDBACK_DIR).filter((f) => f.endsWith('.md')).length } catch { return 0 }
}
