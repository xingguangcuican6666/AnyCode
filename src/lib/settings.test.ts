import { describe, it, expect } from 'vitest'
import {
  SETTINGS,
  SETTINGS_BY_KEY,
  settingGroups,
  settingsDefaults,
  getSetting,
  formatSettingValue,
  coerceSetting,
  isEffortLevel,
  effortDirective,
  thinkingBudgetFor,
  resolveThinkingBudget,
  outputStyleDirective,
  workflowSizeDirective,
  type SettingSpec,
} from './settings'

describe('SETTINGS table', () => {
  it('has no duplicate keys', () => {
    const keys = SETTINGS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('every enum setting declares its values', () => {
    for (const s of SETTINGS) {
      if (s.type === 'enum') {
        expect(s.values?.length, s.key).toBeGreaterThan(0)
        expect(s.values, s.key).toContain(s.default)
      }
    }
  })

  it('every number setting respects its bounds by default', () => {
    for (const s of SETTINGS) {
      if (s.type === 'number') {
        const d = s.default as number
        if (s.min !== undefined) expect(d, s.key).toBeGreaterThanOrEqual(s.min)
        if (s.max !== undefined) expect(d, s.key).toBeLessThanOrEqual(s.max)
      }
    }
  })
})

describe('SETTINGS_BY_KEY', () => {
  it('indexes every setting', () => {
    expect(Object.keys(SETTINGS_BY_KEY)).toHaveLength(SETTINGS.length)
    expect(SETTINGS_BY_KEY['effort']?.type).toBe('enum')
  })
})

describe('settingGroups', () => {
  it('returns groups in first-seen order without duplicates', () => {
    const groups = settingGroups()
    expect(new Set(groups).size).toBe(groups.length)
    expect(groups[0]).toBe('Context & model')
  })
})

describe('settingsDefaults / getSetting', () => {
  it('defaults cover every key', () => {
    const bag = settingsDefaults()
    for (const s of SETTINGS) expect(bag[s.key], s.key).toBeDefined()
  })

  it('falls back to the spec default when the bag lacks a key', () => {
    expect(getSetting({}, 'autoCompact')).toBe(true)
    expect(getSetting(undefined, 'effort')).toBe('medium')
  })

  it('returns the live value when set', () => {
    expect(getSetting({ effort: 'max' }, 'effort')).toBe('max')
  })

  it('returns "" for unknown keys', () => {
    expect(getSetting({}, 'no-such-key')).toBe('')
  })
})

describe('formatSettingValue', () => {
  const boolSpec: SettingSpec = { key: 'k', label: 'l', group: 'g', type: 'boolean', default: true, description: '' }
  const numSpec: SettingSpec = { key: 'k', label: 'l', group: 'g', type: 'number', default: 0, unit: 's', description: '' }

  it('renders booleans as on/off', () => {
    expect(formatSettingValue(boolSpec, true)).toBe('on')
    expect(formatSettingValue(boolSpec, false)).toBe('off')
  })

  it('renders numbers with their unit', () => {
    expect(formatSettingValue(numSpec, 30)).toBe('30s')
  })
})

describe('coerceSetting', () => {
  const boolSpec = SETTINGS_BY_KEY['autoCompact']
  const enumSpec = SETTINGS_BY_KEY['effort']
  const numSpec = SETTINGS_BY_KEY['questionTimeout']

  it('accepts truthy/falsy spellings for booleans', () => {
    expect(coerceSetting(boolSpec, 'on')).toEqual({ ok: true, value: true })
    expect(coerceSetting(boolSpec, 'OFF')).toEqual({ ok: true, value: false })
    expect(coerceSetting(boolSpec, 'maybe').ok).toBe(false)
  })

  it('matches enum values case-insensitively and returns the canonical case', () => {
    expect(coerceSetting(enumSpec, 'MAX')).toEqual({ ok: true, value: 'max' })
    expect(coerceSetting(enumSpec, 'huge').ok).toBe(false)
  })

  it('validates numbers against bounds', () => {
    expect(coerceSetting(numSpec, '30')).toEqual({ ok: true, value: 30 })
    expect(coerceSetting(numSpec, '-1').ok).toBe(false)
    expect(coerceSetting(numSpec, '99999').ok).toBe(false)
    expect(coerceSetting(numSpec, 'abc').ok).toBe(false)
  })
})

describe('effort levels', () => {
  it('recognizes the five levels', () => {
    for (const l of ['low', 'medium', 'high', 'xhigh', 'max']) expect(isEffortLevel(l)).toBe(true)
    expect(isEffortLevel('ultra')).toBe(false)
  })

  it('produces a directive only for known levels', () => {
    expect(effortDirective('high')).toContain('Reasoning effort: high')
    expect(effortDirective('nope')).toBeUndefined()
    expect(effortDirective(undefined)).toBeUndefined()
  })

  it('maps thinking budgets: low/medium off, higher tiers on', () => {
    expect(thinkingBudgetFor('low')).toBe(0)
    expect(thinkingBudgetFor('medium')).toBe(0)
    expect(thinkingBudgetFor('high')).toBe(4096)
    expect(thinkingBudgetFor('max')).toBe(12288)
    expect(thinkingBudgetFor('bogus')).toBe(0)
  })
})

describe('resolveThinkingBudget', () => {
  it('mode off always wins', () => {
    expect(resolveThinkingBudget('max', 'off')).toBe(0)
  })

  it('mode on applies the floor when the tier budget is 0', () => {
    expect(resolveThinkingBudget('low', 'on')).toBe(4096)
    expect(resolveThinkingBudget('max', 'on')).toBe(12288)
  })

  it('auto keeps the effort-driven budget', () => {
    expect(resolveThinkingBudget('high', 'auto')).toBe(4096)
    expect(resolveThinkingBudget('low', 'auto')).toBe(0)
  })
})

describe('outputStyleDirective', () => {
  it('returns undefined for default/unset', () => {
    expect(outputStyleDirective(undefined)).toBeUndefined()
    expect(outputStyleDirective('default')).toBeUndefined()
  })

  it('describes concise and explanatory', () => {
    expect(outputStyleDirective('concise')).toContain('concise')
    expect(outputStyleDirective('explanatory')).toContain('explanatory')
  })
})

describe('workflowSizeDirective', () => {
  it('returns undefined for unset/unknown', () => {
    expect(workflowSizeDirective(undefined)).toBeUndefined()
    expect(workflowSizeDirective('huge')).toBeUndefined()
  })

  it('describes each size', () => {
    expect(workflowSizeDirective('small')).toContain('small')
    expect(workflowSizeDirective('large')).toContain('large')
  })
})
