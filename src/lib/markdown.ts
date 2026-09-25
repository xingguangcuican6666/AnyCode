import { Marked } from 'marked'
import { markedTerminal } from 'marked-terminal'

/**
 * Render a Markdown string to an ANSI-styled terminal string. A fresh Marked
 * instance is used per call so the wrap width can track the terminal size
 * without accumulating global extensions.
 */
export function renderMarkdown(md: string, width = 80): string {
  const wrap = Math.max(40, Math.min(width, 120))
  try {
    const m = new Marked(
      markedTerminal({ width: wrap, reflowText: true, tab: 2 }) as never,
    )
    const out = m.parse(md, { async: false }) as string
    return out.replace(/\s+$/, '')
  } catch {
    return md
  }
}
