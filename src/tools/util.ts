// Small shared helpers for the tool implementations. Kept in their own module so
// both the basic file/shell/search tools (fs-tools) and the orchestration tools
// (orchestration) can use them without importing each other.

export const MAX_OUT = 30000 // hard cap on any single tool's returned text

/** Truncate a tool's returned text to MAX_OUT, appending a note when clipped. */
export function clip(s: string, max = MAX_OUT): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n… [truncated ${s.length - max} chars]`
}
