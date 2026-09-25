/**
 * A pulsing star, in the spirit of Claude Code's ✻ spinner.
 * INVARIANT: every frame must be exactly one terminal column wide, or the
 * status line jitters left/right as the frame cycles. U+2733 (✳) and U+2734 (✴)
 * look right but carry emoji presentation → string-width 2; ✸ (U+2738) is the
 * width-1 stand-in for that "medium star" beat.
 */
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

export function randomStatusWord(): string {
  return statusWords[Math.floor(Math.random() * statusWords.length)]
}
