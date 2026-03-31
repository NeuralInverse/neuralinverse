# Neural Inverse — AI Coding Rules

## CRITICAL: No Non-ASCII Characters in TypeScript/JavaScript Source

**This rule exists because non-ASCII characters have broken the release build three times.**

The esbuild minification step (`minify-vscode`) scans the output for non-ASCII characters and **fails the build** with:
```
Error: Found non-ascii character – in the minified output of workbench.desktop.main.js.
```

### Rule

**Never write non-ASCII characters in TypeScript/JavaScript string literals, template literals, or regex patterns.**

This applies to ALL `.ts` and `.js` files in `src/`, regardless of module.

### Banned characters and their replacements

| Character | Unicode | Name | Use instead |
|---|---|---|---|
| `—` | U+2014 | em dash | `-` |
| `–` | U+2013 | en dash | `-` |
| `→` | U+2192 | right arrow | `->` |
| `←` | U+2190 | left arrow | `<-` |
| `·` | U+00B7 | middle dot | ` / ` or ` \| ` |
| `…` | U+2026 | ellipsis | `...` |
| `μ` | U+03BC | micro/mu | `\u03bc` (in regex) or `us` |
| `µ` | U+00B5 | micro sign | `\u00b5` (in regex) or `us` |
| `⚠` | U+26A0 | warning | `[!]` |
| `✅` | U+2705 | check mark | `[OK]` |
| `⚡` | U+26A1 | lightning | `[~]` |
| `⟳` `↺` `🔄` | — | rotate/refresh | `<<` |
| `✕` `✗` | U+2715/U+2717 | cross | `X` |
| Any emoji | >U+FFFF | emoji | plain ASCII label |

### Exception: comments only

Non-ASCII is **allowed in `//` line comments and `/* */` block comments** — esbuild strips those. It is also allowed in string literals that will NEVER be bundled (e.g. standalone Node scripts outside `src/`).

### Exception: unicode escape sequences

If the character is semantically required (e.g. matching an en dash in user-provided PDF text), use a unicode escape so esbuild can handle it:
```typescript
// WRONG
const reCompact = /[-–]/g;

// CORRECT
const reCompact = /[-\u2013]/g;
```

### How to check before committing

Run this from the repo root to find violations in any file you modified:

```bash
python3 -c "
import sys
files = sys.argv[1:]
for path in files:
    lines = open(path, encoding='utf-8').read().split('\n')
    for i, line in enumerate(lines, 1):
        stripped = line.lstrip()
        if stripped.startswith('//') or stripped.startswith('*') or stripped.startswith('/*'):
            continue
        for j, ch in enumerate(line):
            if ord(ch) > 127:
                if '//' in line[:j]: break
                print(f'{path}:{i}: U+{ord(ch):04X} {repr(ch)}  {line.strip()[:80]}')
                break
" src/vs/workbench/contrib/neuralInverseFirmware/**/*.ts
```
