// @ts-nocheck
/**
 * Leaf stripBOM \u2014 extracted from json.ts to break settings \u2192 json \u2192 log \u2192
 * types/logs \u2192 \u2026 \u2192 settings. json.ts imports this for its memoized+logging
 * safeParseJSON; leaf callers that can't import json.ts use stripBOM +
 * jsonParse inline (syncCacheState does this).
 *
 * UTF-8 BOM (U+FEFF): PowerShell 5.x writes UTF-8 with BOM by default
 * (Out-File, Set-Content). We can't control user environments, so strip on
 * read. Without this, JSON.parse fails with "Unexpected token".
 */

const UTF8_BOM = '\uFEFF'

export function stripBOM(content: string): string {
  return content.startsWith(UTF8_BOM) ? content.slice(1) : content
}
