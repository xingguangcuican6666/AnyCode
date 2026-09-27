/**
 * A pulsing star, in the spirit of Claude Code's ✻ spinner.
 * INVARIANT: every frame must be exactly one terminal column wide, or the
 * status line jitters left/right as the frame cycles. U+2733 (✳) and U+2734 (✴)
 * look right but carry emoji presentation → string-width 2; ✸ (U+2738) is the
 * width-1 stand-in for that "medium star" beat.
 */
import { getLang } from './i18n'

export const starFrames = ['·', '✢', '✸', '∗', '✻', '✽', '✻', '∗', '✸', '✢']

/** Playful gerunds shown next to the spinner while the model works. */
export const statusWords = [
  'Accomplishing', 'Actioning', 'Baking', 'Brewing', 'Calculating', 'Cerebrating',
  'Churning', 'Coalescing', 'Cogitating', 'Computing', 'Concocting', 'Conjuring',
  'Considering', 'Cooking', 'Crafting', 'Creating', 'Crunching', 'Deliberating',
  'Determining', 'Divining', 'Effecting', 'Elucidating', 'Envisioning', 'Finagling',
  'Forging', 'Forming', 'Generating', 'Hatching', 'Herding', 'Hustling', 'Ideating',
  'Imagining', 'Incubating', 'Inferring', 'Manifesting', 'Marinating', 'Meandering',
  'Mulling', 'Mustering', 'Musing', 'Noodling', 'Percolating', 'Pondering',
  'Processing', 'Puttering', 'Puzzling', 'Reticulating', 'Ruminating', 'Schlepping',
  'Shucking', 'Simmering', 'Smooshing', 'Spelunking', 'Stewing', 'Synthesizing',
  'Thinking', 'Tinkering', 'Transmuting', 'Vibing', 'Wibbling', 'Working',
]

/** The same playful register, in Chinese — shown when the UI language is zh. */
export const statusWordsZh = [
  '思考中', '酝酿中', '烹饪中', '冲泡中', '盘算中', '琢磨中',
  '搅拌中', '凝聚中', '沉思中', '计算中', '调制中', '施法中',
  '斟酌中', '炖煮中', '打磨中', '创作中', '咀嚼中', '推敲中',
  '揣摩中', '占卜中', '生成中', '阐释中', '构想中', '捣鼓中',
  '锻造中', '成形中', '孵化中', '张罗中', '发力中', '冒泡中',
  '腌制中', '神游中', '拿捏中', '哼唱中', '摆弄中', '合成中',
  '钻研中', '演算中', '编织中', '捉摸中', '熬煮中', '运转中',
]

export function randomStatusWord(): string {
  const list = getLang() === 'zh' ? statusWordsZh : statusWords
  return list[Math.floor(Math.random() * list.length)]
}

/** Playful past-tense verbs for the per-turn completion footer ("✻ Sautéed for
 *  10m 10s · done 2:09"), the spirit of Claude Code's done line. */
export const completedWords = [
  'Accomplished', 'Baked', 'Brewed', 'Calculated', 'Churned', 'Cogitated',
  'Computed', 'Concocted', 'Conjured', 'Cooked', 'Crafted', 'Created',
  'Crunched', 'Deliberated', 'Divined', 'Forged', 'Generated', 'Hatched',
  'Herded', 'Hustled', 'Ideated', 'Imagined', 'Incubated', 'Inferred',
  'Manifested', 'Marinated', 'Mulled', 'Mustered', 'Percolated', 'Pondered',
  'Processed', 'Puzzled', 'Ruminated', 'Sautéed', 'Simmered', 'Stewed',
  'Synthesized', 'Tinkered', 'Transmuted', 'Vibed', 'Worked', 'Wrangled',
]

/** The same, in Chinese — a short "…完成/完毕" register shown when lang is zh. */
export const completedWordsZh = [
  '烹制完成', '酝酿完毕', '思考完成', '盘算完毕', '琢磨完成', '推敲完毕',
  '调制完成', '炖煮完毕', '打磨完成', '创作完毕', '演算完成', '合成完毕',
  '构想完成', '锻造完毕', '孵化完成', '编织完毕', '拿捏完成', '钻研完毕',
]

export function randomCompletedWord(): string {
  const list = getLang() === 'zh' ? completedWordsZh : completedWords
  return list[Math.floor(Math.random() * list.length)]
}
