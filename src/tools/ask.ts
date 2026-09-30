// ask_user — a structured-question tool mirroring Claude Code's AskUserQuestion.
// The model uses it when a decision is genuinely the user's to make and it wants
// to offer a few concrete options; the host raises an inline dialog (see
// components/AskUserDialog) and the answer flows back as text the model can act
// on. Only the TOP-LEVEL agent has an interactive user: sub-agents and headless
// runs get no ctx.requestUserInput, so the tool reports that and the model
// proceeds on its own judgment rather than blocking.
import type { ToolDef } from './types'
import type { UserQuestion } from '../types'

function normalizeQuestions(raw: unknown): UserQuestion[] {
  if (!Array.isArray(raw)) return []
  const out: UserQuestion[] = []
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue
    const question = String((q as any).question ?? '').trim()
    if (!question) continue
    const header = String((q as any).header ?? '').trim() || question.slice(0, 12)
    const optsRaw = Array.isArray((q as any).options) ? (q as any).options : []
    const options = optsRaw
      .map((o: any) => (o && typeof o === 'object' ? { label: String(o.label ?? '').trim(), description: o.description ? String(o.description) : undefined } : { label: String(o ?? '').trim() }))
      .filter((o: { label: string }) => o.label)
    out.push({ question, header, multiSelect: (q as any).multiSelect === true, options })
  }
  return out
}

export const askUser: ToolDef = {
  name: 'ask_user',
  description:
    'Ask the user one or more structured multiple-choice questions when you hit a decision that is genuinely theirs to make — a fork you cannot resolve from the request, the code, or sensible defaults. Each question offers 2-4 concrete options; the user can always pick "Other" and type a custom answer, so you never add an Other option yourself. Use sparingly: for small choices with an obvious default, just proceed and say what you chose. Returns the user\'s selections as text. In a sub-agent or headless run there is no interactive user, so the tool reports that instead — proceed on your best judgment.',
  input_schema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: '1-4 questions to ask the user.',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The full question text, ending with a question mark.' },
            header: { type: 'string', description: 'A very short label/chip for the question (≤12 chars).' },
            multiSelect: { type: 'boolean', description: 'Allow the user to select multiple options (default false).' },
            options: {
              type: 'array',
              description: '2-4 distinct options to choose from.',
              minItems: 2,
              maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'The option text shown and returned.' },
                  description: { type: 'string', description: 'Optional one-line explanation of what this option means.' },
                },
                required: ['label'],
              },
            },
          },
          required: ['question', 'header', 'options'],
        },
      },
    },
    required: ['questions'],
  },
  async run(input, ctx) {
    const questions = normalizeQuestions(input.questions)
    if (questions.length === 0) return { content: 'ask_user needs at least one question with a non-empty `question` field.', isError: true }
    if (!ctx.requestUserInput) {
      return { content: 'No interactive user is available to answer (sub-agent or headless run). Proceed with your best judgment and state the assumption you made.', isError: true }
    }
    const res = await ctx.requestUserInput({ questions })
    if (res.cancelled) {
      return { content: 'The user dismissed the questions without answering. Proceed with your best judgment, or ask again later if the decision is still blocking.' }
    }
    const lines = questions.map((q, i) => {
      const picked = res.answers[i] ?? []
      return `- ${q.header || q.question}: ${picked.length ? picked.join(', ') : '(skipped)'}`
    })
    return {
      content: `The user answered:\n${lines.join('\n')}`,
      display: `ask_user · ${questions.length} question${questions.length === 1 ? '' : 's'}`,
    }
  },
}
