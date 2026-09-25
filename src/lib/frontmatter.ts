// Minimal front-matter parser for skill/command Markdown files. Supports the
// common `---\nkey: value\n---\nbody` shape with flat string values — enough for
// `name`, `description`, and comma-separated `aliases`. Not a full YAML parser.
export interface Frontmatter {
  meta: Record<string, string>
  body: string
}

export function parseFrontmatter(raw: string): Frontmatter {
  const text = raw.replace(/^﻿/, '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return { meta: {}, body: text.trim() }
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (!kv) continue
    let value = kv[2].trim()
    // Strip a single layer of matching quotes.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    meta[kv[1].toLowerCase()] = value
  }
  return { meta, body: m[2].trim() }
}
