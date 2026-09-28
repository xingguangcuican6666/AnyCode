// Occasional usage tips shown in the idle footer when the `showTips` setting is
// on (mirrors Claude Code's rotating footer hints). Kept out of the i18n catalog
// (which is keyed single strings) since this is a rotating pool; localized here.
import { getLang } from './i18n'

const tipsEn: string[] = [
  'Tip: type / to browse slash commands.',
  'Tip: press esc to interrupt a running turn.',
  'Tip: /effort tunes how hard the agent thinks and verifies.',
  'Tip: /model switches models mid-session.',
  'Tip: /compact folds old context into a summary to free up room.',
  'Tip: /resume reopens a previous session.',
  'Tip: /theme changes the color theme.',
  'Tip: scroll up to reveal jump-to-previous-message and jump-to-bottom hints.',
  'Tip: /config toggles settings like thinking mode and output style.',
  'Tip: paste an image path to include it in your message.',
  'Tip: /goal sets a target the agent keeps working toward.',
  'Tip: turn off tips anytime in /config → Show tips.',
]

const tipsZh: string[] = [
  '提示：输入 / 可浏览斜杠命令。',
  '提示：按 esc 可中断正在进行的回合。',
  '提示：/effort 调节 agent 思考与验证的力度。',
  '提示：/model 可在会话中途切换模型。',
  '提示：/compact 把旧上下文折叠成摘要以腾出空间。',
  '提示：/resume 可重新打开之前的会话。',
  '提示：/theme 可切换配色主题。',
  '提示：向上滚动会显示"跳到上一条"与"跳到底部"提示。',
  '提示：/config 可开关思考模式、输出风格等设置。',
  '提示：粘贴图片路径即可把图片加入消息。',
  '提示：/goal 设定一个 agent 会持续推进的目标。',
  '提示：可随时在 /config → 显示提示 中关闭这些提示。',
]

/** A stable tip for the given rotation index (e.g. the session turn count), so
 *  the footer tip changes turn-to-turn without flickering within a render. */
export function tipFor(index: number): string {
  const list = getLang() === 'zh' ? tipsZh : tipsEn
  const i = ((Math.floor(index) % list.length) + list.length) % list.length
  return list[i]
}
