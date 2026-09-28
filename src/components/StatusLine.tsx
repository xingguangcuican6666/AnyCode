import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { symbols, useTheme } from '../theme'
import { starFrames } from '../lib/spinner'
import { formatTokens } from '../lib/tokens'
import { useT } from '../lib/i18n'

interface Props {
  word: string
  elapsed: number
  tokens: number
  // Direction of the live token count: 'up' (input, on submit) or 'down'
  // (output, while the model streams its reply). Defaults to 'up'.
  dir?: 'up' | 'down'
  // Optional trailing note, e.g. "deep in thought with xhigh effort".
  suffix?: string
  // When true, hold the spinner on a single frame instead of cycling (respects
  // the `reduceMotion` setting).
  reduceMotion?: boolean
}

export function StatusLine({ word, elapsed, tokens, dir = 'up', suffix, reduceMotion = false }: Props): React.ReactElement {
  const colors = useTheme()
  const tr = useT()
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (reduceMotion) return
    const id = setInterval(() => setFrame((f) => f + 1), 120)
    return () => clearInterval(id)
  }, [reduceMotion])
  // A steady star (index 4 = '✻') when motion is reduced; the pulsing cycle otherwise.
  const star = reduceMotion ? starFrames[4] : starFrames[frame % starFrames.length]
  const arrow = dir === 'down' ? symbols.arrowDown : symbols.arrowUp
  return (
    <Box paddingLeft={1}>
      <Text color={colors.accent}>{star} </Text>
      <Text color={colors.accent}>{word}… </Text>
      <Text color={colors.dim}>
        {tr('statusline.meter', { elapsed, arrow, tokens: formatTokens(tokens), suffix: suffix ? ` · ${suffix}` : '' })}
      </Text>
    </Box>
  )
}
