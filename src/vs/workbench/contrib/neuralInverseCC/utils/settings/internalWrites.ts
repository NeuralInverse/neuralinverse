// @ts-nocheck
/**
 * Tracks timestamps of in-process settings-file writes so the chokidar watcher
 * in changeDetector.ts can ignore its own echoes.
 *
 * Extracted from changeDetector.ts to break the settings.ts \u2192 changeDetector.ts \u2192
 * hooks.ts \u2192 \u2026 \u2192 settings.ts cycle. settings.ts needs to mark "I'm about to
 * write" before the write lands; changeDetector needs to read the mark when
 * chokidar fires. The map is the only shared state \u2014 everything else in
 * changeDetector (chokidar, hooks, mdm polling) is irrelevant to settings.ts.
 *
 * Callers pass resolved paths. The path\u2192source resolution (getSettingsFilePathForSource)
 * lives in settings.ts, so settings.ts does it before calling here. No imports.
 */

const timestamps = new Map<string, number>()

export function markInternalWrite(path: string): void {
  timestamps.set(path, Date.now())
}

/**
 * True if `path` was marked within `windowMs`. Consumes the mark on match \u2014
 * the watcher fires once per write, so a matched mark shouldn't suppress
 * the next (real, external) change to the same file.
 */
export function consumeInternalWrite(path: string, windowMs: number): boolean {
  const ts = timestamps.get(path)
  if (ts !== undefined && Date.now() - ts < windowMs) {
    timestamps.delete(path)
    return true
  }
  return false
}

export function clearInternalWrites(): void {
  timestamps.clear()
}
