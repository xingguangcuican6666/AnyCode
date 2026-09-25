import React from 'react'
import { Box, Text } from 'ink'
import { symbols, useTheme } from '../theme'
import { NAME, VERSION } from '../version'

export function Banner(): React.ReactElement {
  const colors = useTheme()
  const cwd = process.cwd()
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor={colors.accent} paddingX={1} flexDirection="column">
        <Text>
          <Text color={colors.accent}>{symbols.star} </Text>
          <Text bold color={colors.text}>Welcome to {NAME}</Text>
          <Text color={colors.dim}>  v{VERSION}</Text>
        </Text>
        <Text color={colors.dim}>a Claude Code–style coding agent</Text>
      </Box>
      <Box marginTop={1} flexDirection="column" paddingLeft={1}>
        <Text color={colors.dim}>cwd  {cwd}</Text>
        <Text color={colors.dim}>
          <Text color={colors.accentBright}>/help</Text> commands · <Text color={colors.accentBright}>/model</Text> switch models · <Text color={colors.accentBright}>/exit</Text> quit
        </Text>
      </Box>
    </Box>
  )
}
