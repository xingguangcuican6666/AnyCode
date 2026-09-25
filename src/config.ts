import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { AppConfig } from './types'
import { DEFAULT_THEME } from './theme'
import { settingsDefaults } from './lib/settings'

export const CONFIG_DIR = path.join(os.homedir(), '.anycode')
export const CONFIG_FILE = path.join(CONFIG_DIR, 'settings.json')

function defaults(): AppConfig {
  return {
    provider: process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'mock',
    model: 'claude-opus-4-8',
    theme: DEFAULT_THEME,
    apiKey: process.env.ANTHROPIC_API_KEY,
    system: undefined,
    settings: settingsDefaults(),
  }
}

export function loadConfig(): AppConfig {
  let fileCfg: Partial<AppConfig> = {}
  try {
    fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Partial<AppConfig>
  } catch {
    // no settings file yet — that's fine
  }
  const cfg: AppConfig = { ...defaults(), ...fileCfg }
  // Merge the settings bag key-by-key so a file written by an older build (with
  // fewer keys) still picks up defaults for any settings added since.
  cfg.settings = { ...settingsDefaults(), ...(fileCfg.settings ?? {}) }
  // The environment key always wins and is never read from disk.
  if (process.env.ANTHROPIC_API_KEY) cfg.apiKey = process.env.ANTHROPIC_API_KEY
  return cfg
}

export function saveConfig(cfg: AppConfig): void {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    // Never persist the API key to disk; it comes from the environment.
    const { apiKey: _omit, ...persist } = cfg
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(persist, null, 2))
  } catch {
    // best-effort; config persistence is non-critical
  }
}
