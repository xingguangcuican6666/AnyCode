// Follow-up prompt suggestions for the `promptSuggestions` setting. Rather than
// spend an extra model round-trip after every turn, we derive a few short,
// contextual follow-ups from the last assistant message with light keyword
// heuristics — enough to be useful hints, never authoritative. Returns [] when
// nothing fits, so the caller can fall back to the idle footer / tips line.
import { getLang } from './i18n'

interface Rule {
  test: RegExp
  zh: string
  en: string
}

// Ordered by usefulness; the first few matches win. Patterns run against a
// lowercased, ANSI-stripped copy of the last assistant message.
const RULES: Rule[] = [
  { test: /```|diff|\bpatch\b|edited|修改|改动/, zh: '解释这段改动', en: 'explain this change' },
  { test: /\btest|测试|spec\b/, zh: '运行测试', en: 'run the tests' },
  { test: /error|错误|failed|失败|exception|traceback/, zh: '帮我修复这个错误', en: 'help me fix this error' },
  { test: /\bTODO\b|待办|next step|下一步|remaining/, zh: '继续下一步', en: 'continue with the next step' },
  { test: /function|class|方法|函数|接口|api/, zh: '补充注释与文档', en: 'add comments and docs' },
  { test: /commit|提交|git\b/, zh: '提交这些改动', en: 'commit these changes' },
]

// Generic fallbacks appended (deduped) so there's usually something to show.
const GENERIC: Array<{ zh: string; en: string }> = [
  { zh: '总结一下', en: 'summarize this' },
  { zh: '还有什么要注意的', en: 'anything else to watch for?' },
]

/** Up to `max` short follow-up prompts derived from the last assistant text. */
export function suggestFollowups(lastAssistant: string, max = 3): string[] {
  const zh = getLang() === 'zh'
  const hay = lastAssistant.toLowerCase()
  const out: string[] = []
  for (const r of RULES) {
    if (r.test.test(hay)) out.push(zh ? r.zh : r.en)
    if (out.length >= max) break
  }
  for (const gsug of GENERIC) {
    if (out.length >= max) break
    const s = zh ? gsug.zh : gsug.en
    if (!out.includes(s)) out.push(s)
  }
  return out.slice(0, max)
}
