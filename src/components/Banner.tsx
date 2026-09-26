import React from 'react'
import { Box, Text } from 'ink'
import { symbols, useTheme } from '../theme'
import { NAME, VERSION } from '../version'
import { useT } from '../lib/i18n'

export function Banner(): React.ReactElement {
  const colors = useTheme()
  const t = useT()
  const cwd = process.cwd()
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor={colors.accent} paddingX={1} flexDirection="column">
        <Text>
          <Text color={colors.accent}>{symbols.star} </Text>
          <Text bold color={colors.text}>{t('banner.welcome', { name: NAME })}</Text>
          <Text color={colors.dim}>  v{VERSION}</Text>
        </Text>
        <Text color={colors.dim}>{t('banner.tagline')}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column" paddingLeft={1}>
        <Text color={colors.dim}>{t('banner.cwd', { cwd })}</Text>
        <Text color={colors.dim}>
          <Text color={colors.accentBright}>/help</Text>{t('banner.help')}<Text color={colors.accentBright}>/model</Text>{t('banner.model')}<Text color={colors.accentBright}>/exit</Text>{t('banner.exit')}
        </Text>
      </Box>
    </Box>
  )
}
