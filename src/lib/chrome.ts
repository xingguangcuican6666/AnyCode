import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Best-effort Chrome detection for the `chromeEnabled` setting ("Claude in
// Chrome"). The full browser integration needs a companion extension (not built
// yet), so this only locates a Chrome/Chromium binary so the UI can honestly
// report whether the integration COULD run — it never launches or drives Chrome.

export interface ChromeStatus {
  available: boolean
  path?: string
}

// Common install locations per platform, plus the CHROME_PATH env override that
// many tools honor. First hit wins.
function candidates(env: NodeJS.ProcessEnv): string[] {
  const list: string[] = []
  if (env.CHROME_PATH) list.push(env.CHROME_PATH)
  if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    )
  } else if (process.platform === 'win32') {
    const pf = env['PROGRAMFILES'] ?? 'C:\\Program Files'
    const pfx86 = env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'
    list.push(
      path.join(pf, 'Google/Chrome/Application/chrome.exe'),
      path.join(pfx86, 'Google/Chrome/Application/chrome.exe'),
    )
  } else {
    list.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    )
  }
  return list
}

export function detectChrome(env: NodeJS.ProcessEnv = process.env): ChromeStatus {
  for (const c of candidates(env)) {
    try { if (c && fs.existsSync(c)) return { available: true, path: c } } catch { /* ignore */ }
  }
  return { available: false }
}
