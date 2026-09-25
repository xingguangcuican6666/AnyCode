import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { symbols, useTheme } from '../theme'
import { starFrames } from '../lib/spinner'
import { formatTokens } from '../lib/tokens'

interface Props {
  word: string
  elapsed: number
  tokens: number
  // Direction of the live token count: 'up' (input, on submit) or 'down'
  // (output, while the model streams its reply). Defaults to 'up'.
  dir?: 'up' | 'down'
  // Optional trailing note, e.g. "deep in thought with xhigh effort".
  suffix?: string
}

export function StatusLine({ word, elapsed, tokens, dir = 'up', suffix }: Props): React.ReactElement {
  const colors = useTheme()
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => f + 1), 120)
    return () => clearInterval(t)
  }, [])
  const star = starFrames[frame % starFrames.length]
  const arrow = dir === 'down' ? symbols.arrowDown : symbols.arrowUp
  return (
    <Box paddingLeft={1}>
      <Text color={colors.accent}>{star} </Text>
      <Text color={colors.accent}>{word}… </Text>
      <Text color={colors.dim}>
        ({elapsed}s · {arrow} {formatTokens(tokens)} tokens{suffix ? ` · ${suffix}` : ''} · esc to interrupt)
      </Text>
    </Box>
  )
}
