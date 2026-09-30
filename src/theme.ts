/**
 * Visual themes for AnyCode. A *theme* is a named color palette; `symbols` are
 * shared across all themes. Colors are hex strings (Ink renders truecolor via
 * chalk) EXCEPT the `*-ansi` themes, which use the 16 named ANSI colors so they
 * render correctly on terminals without truecolor support.
 *
 * The active theme is chosen with the `/theme` command, stored on AppConfig
 * (persisted, and carried across `/clear`'s remount), and handed to the
 * component tree via <ThemeProvider>/useTheme() — see app.tsx. Components read
 * their palette from useTheme() rather than importing `colors` directly, so a
 * theme switch re-renders the whole UI in the new palette.
 */
import { createContext, useContext } from 'react'

export interface ThemeColors {
  accent: string
  accentDim: string
  accentBright: string
  user: string
  assistant: string
  system: string
  tool: string
  success: string
  error: string
  warning: string
  dim: string
  text: string
  // Reasoning ("thinking") text — a shade between `dim` and `text`, so the folded
  // reasoning reads clearly against the (dark) background instead of nearly
  // vanishing into it, while still sitting a notch below full text brightness.
  // Optional: falls back to `dim` for palettes that don't set it (the ANSI themes).
  thinking?: string
  // Full-row background tints for added / removed diff lines (GitHub/Claude Code
  // style). Empty string = no background (the ANSI-only themes, where a subtle
  // tint isn't possible, keep the plain coloured foreground instead).
  diffAddBg: string
  diffDelBg: string
  // Uniform background for an EXPANDED collapsed block (thinking + merged tool
  // output), so it reads as one Claude-Code-style box. ONE shade for the whole
  // block — think vs tool are distinguished by font depth, not by tint. Empty
  // string = no background (the ANSI-only themes).
  blockBg: string
}

export interface Theme {
  name: string
  /** Short label for the interactive picker, e.g. "Dark mode". */
  title: string
  label: string
  colors: ThemeColors
}

// The *-daltonized palettes draw from the Okabe–Ito colorblind-safe set
// (orange #E69F00, sky #56B4E9, bluish-green #009E73, yellow #F0E442,
// blue #0072B2, vermillion #D55E00, reddish-purple #CC79A7), which stays
// distinguishable under the common red/green color-vision deficiencies.
export const themes: Record<string, Theme> = {
  dark: {
    name: 'dark',
    title: 'Dark mode',
    label: 'Warm clay on a dark background (default)',
    colors: {
      accent: '#D97757',
      accentDim: '#B35C42',
      accentBright: '#E8A87C',
      user: '#7FB3D5',
      assistant: '#D97757',
      system: '#8E8E8E',
      tool: '#B39DDB',
      success: '#7FBF7F',
      error: '#E06C75',
      warning: '#E5C07B',
      dim: '#6B6B6B',
      text: '#E6E6E6',
      thinking: '#909090',
      diffAddBg: '#16351f',
      diffDelBg: '#3b1719',
      blockBg: '#1e1e22',
    },
  },
  light: {
    name: 'light',
    title: 'Light mode',
    label: 'Warm clay on a light background',
    colors: {
      accent: '#C2410C',
      accentDim: '#9A3412',
      accentBright: '#EA580C',
      user: '#1D4ED8',
      assistant: '#C2410C',
      system: '#57534E',
      tool: '#7C3AED',
      success: '#15803D',
      error: '#B91C1C',
      warning: '#A16207',
      dim: '#78716C',
      text: '#1C1917',
      thinking: '#5C5753',
      diffAddBg: '#CBEBD1',
      diffDelBg: '#F7CFD1',
      blockBg: '#F0EEEC',
    },
  },
  'dark-daltonized': {
    name: 'dark-daltonized',
    title: 'Dark mode (colorblind-friendly)',
    label: 'Colorblind-friendly, dark background',
    colors: {
      accent: '#E69F00',
      accentDim: '#D55E00',
      accentBright: '#F0E442',
      user: '#56B4E9',
      assistant: '#E69F00',
      system: '#9A9A9A',
      tool: '#CC79A7',
      success: '#56B4E9',
      error: '#D55E00',
      warning: '#F0E442',
      dim: '#6B6B6B',
      text: '#E6E6E6',
      thinking: '#909090',
      diffAddBg: '#123246',
      diffDelBg: '#3a2410',
      blockBg: '#1e1e22',
    },
  },
  'light-daltonized': {
    name: 'light-daltonized',
    title: 'Light mode (colorblind-friendly)',
    label: 'Colorblind-friendly, light background',
    colors: {
      accent: '#B36B00',
      accentDim: '#9C4400',
      accentBright: '#8A6D00',
      user: '#0072B2',
      assistant: '#B36B00',
      system: '#57534E',
      tool: '#A64D79',
      success: '#0072B2',
      error: '#9C4400',
      warning: '#8A6D00',
      dim: '#78716C',
      text: '#1C1917',
      thinking: '#5C5753',
      diffAddBg: '#CCE1F2',
      diffDelBg: '#F3DEC9',
      blockBg: '#ECEEF0',
    },
  },
  'dark-ansi': {
    name: 'dark-ansi',
    title: 'Dark mode (ANSI colors only)',
    label: '16-color ANSI, dark background',
    colors: {
      accent: 'yellow',
      accentDim: 'yellow',
      accentBright: 'yellowBright',
      user: 'cyan',
      assistant: 'yellow',
      system: 'gray',
      tool: 'magenta',
      success: 'green',
      error: 'red',
      warning: 'yellow',
      dim: 'gray',
      text: 'white',
      diffAddBg: '',
      diffDelBg: '',
      blockBg: '',
    },
  },
  'light-ansi': {
    name: 'light-ansi',
    title: 'Light mode (ANSI colors only)',
    label: '16-color ANSI, light background',
    colors: {
      accent: 'blue',
      accentDim: 'blue',
      accentBright: 'blueBright',
      user: 'blue',
      assistant: 'blue',
      system: 'gray',
      tool: 'magenta',
      success: 'green',
      error: 'red',
      warning: 'yellow',
      dim: 'gray',
      text: 'black',
      diffAddBg: '',
      diffDelBg: '',
      blockBg: '',
    },
  },
}

export const DEFAULT_THEME = 'dark'

// The special theme name 'auto' isn't a palette of its own — it resolves to a
// concrete light/dark theme at render time. Detection is a best-effort read of
// the COLORFGBG hint some terminals set ("fg;bg"; a light bg index means a light
// terminal); when absent we fall back to dark. (A proper OSC-11 background query
// is a future refinement.)
export const AUTO_THEME = 'auto'

export function resolveAuto(): string {
  const cfb = process.env.COLORFGBG
  if (cfb) {
    const parts = cfb.split(';')
    const bg = Number(parts[parts.length - 1])
    if (!Number.isNaN(bg)) return bg >= 11 ? 'light' : 'dark'
  }
  return 'dark'
}

/** Resolve a theme by name ('auto' → light/dark), falling back to the default. */
export function getTheme(name: string | undefined): Theme {
  const key = name === AUTO_THEME ? resolveAuto() : name
  return (key ? themes[key] : undefined) ?? themes[DEFAULT_THEME]
}

export function themeList(): Theme[] {
  return Object.values(themes)
}

// Back-compat / fallback palette for any code path outside the React tree.
export const colors: ThemeColors = themes[DEFAULT_THEME].colors

export const symbols = {
  userPrompt: '>',
  assistant: '●',
  toolResult: '⎿',
  star: '✻',
  bullet: '•',
  arrowUp: '↑',
  arrowDown: '↓',
} as const

export type ColorName = keyof ThemeColors

const ThemeContext = createContext<ThemeColors>(themes[DEFAULT_THEME].colors)
export const ThemeProvider = ThemeContext.Provider

/** The active theme's palette, from the nearest <ThemeProvider> above. */
export function useTheme(): ThemeColors {
  return useContext(ThemeContext)
}
