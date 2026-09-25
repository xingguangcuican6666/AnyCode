import React from 'react'
import { Box, Text } from 'ink'
import type { Message as Msg } from '../types'
import { symbols, useTheme } from '../theme'
import { renderMarkdown } from '../lib/markdown'
import { Banner } from './Banner'

interface Props {
  message: Msg
  width: number
  live?: boolean
  // When live, cap the rendered block to roughly this many terminal rows,
  // showing only the TAIL of an in-progress message. The full text still lands
  // in <Static> when the block commits, so nothing is lost — this only keeps
  // the live (redrawn) region from ever growing to the viewport height, which
  // is what makes Ink clear the whole screen + scrollback and float the input
  // box up to the top (the "输出超过一个窗口" rendering bug).
  maxLines?: number
}

// Word-wrap plain text to `width` columns, mirroring Ink's wrap="wrap" closely
// enough to count how many terminal rows it will occupy. Used only for the live
// thinking block (plain text, no ANSI), never for already-wrapped markdown.
function toVisualLines(text: string, width: number): string[] {
  const w = Math.max(1, width)
  const out: string[] = []
  for (const line of text.split('\n')) {
    if (line.length <= w) { out.push(line); continue }
    let cur = ''
    for (const word of line.split(' ')) {
      if (cur === '') cur = word
      else if ((cur + ' ' + word).length <= w) cur += ' ' + word
      else { out.push(cur); cur = word }
      while (cur.length > w) { out.push(cur.slice(0, w)); cur = cur.slice(w) }
    }
    out.push(cur)
  }
  return out
}

export function Message({ message, width, live, maxLines }: Props): React.ReactElement | null {
  const colors = useTheme()
  const { role, content, meta } = message

  if (role === 'system' && content === '__banner__') {
    return <Banner />
  }

  // A reasoning ("thinking") block. Live: show the reasoning as it streams, dim
  // + italic under a "✻ Thinking…" header. Committed: collapse to a one-line
  // "✻ Thought for Ns" summary, the way Claude Code folds it away.
  if (meta?.thinking) {
    if (live) {
      // Tail the reasoning to `maxLines` rows: 1 for the header, 1 for the
      // "…above" hint when clipped, the rest for the most recent thinking.
      let shown = content
      let clipped = 0
      if (maxLines) {
        const lines = toVisualLines(content, Math.max(4, width - 4))
        let cap = Math.max(1, maxLines - 1)
        if (lines.length > cap) { cap = Math.max(1, maxLines - 2); clipped = lines.length - cap }
        shown = clipped > 0 ? lines.slice(lines.length - cap).join('\n') : content
      }
      return (
        <Box marginBottom={1} paddingLeft={2} flexDirection="column">
          <Text color={colors.accent}>{symbols.star} Thinking…</Text>
          {clipped > 0 ? <Text color={colors.dim}>{`⋮ +${clipped} line${clipped === 1 ? '' : 's'} above`}</Text> : null}
          <Text color={colors.dim} italic wrap="wrap">{shown}</Text>
        </Box>
      )
    }
    return (
      <Box marginBottom={1} paddingLeft={2}>
        <Text color={colors.dim}>{symbols.star} Thought{meta.thinkingSeconds ? ` for ${meta.thinkingSeconds}s` : ''}</Text>
      </Box>
    )
  }

  if (role === 'user') {
    return (
      <Box marginBottom={1}>
        <Text color={colors.accent}>{symbols.userPrompt} </Text>
        <Text color={colors.text}>{content}</Text>
      </Box>
    )
  }

  if (role === 'system') {
    const body = renderMarkdown(content, width - 4)
    const color = meta?.error ? colors.error : meta?.retry ? colors.warning : colors.dim
    return (
      <Box marginBottom={1} paddingLeft={2} flexDirection="column">
        <Text color={color} wrap="wrap">{body}</Text>
      </Box>
    )
  }

  // tool activity: `⏺ name · args` headers (accent) and `⎿ output` blocks
  // (dim, rendered verbatim so command output isn't mangled by markdown).
  if (role === 'tool') {
    const isHeader = content.startsWith('⏺')
    const color = meta?.error ? colors.error : isHeader ? colors.accent : colors.dim
    return (
      <Box paddingLeft={2} flexDirection="column">
        <Text color={color} wrap="wrap">{content}</Text>
      </Box>
    )
  }

  // assistant messages
  const body = renderMarkdown(content, width - 4)
  // While live, tail the (already width-wrapped) markdown to `maxLines` rows so
  // the streaming reply can't inflate the live region past the viewport. We
  // split on the newlines renderMarkdown already inserted rather than re-wrap,
  // so we never slice through an ANSI colour escape.
  let shownBody = body
  let clipped = 0
  if (live && maxLines) {
    const lines = body.split('\n')
    let cap = maxLines
    if (lines.length > cap) { cap = Math.max(1, maxLines - 1); clipped = lines.length - cap }
    shownBody = clipped > 0 ? lines.slice(lines.length - cap).join('\n') : body
  }
  return (
    <Box marginBottom={1} flexDirection="row">
      <Box marginRight={1}>
        <Text color={colors.accent}>{symbols.assistant}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {clipped > 0 ? <Text color={colors.dim}>{`⋮ +${clipped} line${clipped === 1 ? '' : 's'} above (in scrollback)`}</Text> : null}
        <Text wrap="wrap">{shownBody || (live ? '' : ' ')}</Text>
        {meta?.interrupted ? (
          <Text color={colors.warning}>⎿ interrupted</Text>
        ) : null}
      </Box>
    </Box>
  )
}
