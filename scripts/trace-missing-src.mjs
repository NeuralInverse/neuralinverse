/**
 * Traces missing imports against the src/ directory (TypeScript sources).
 * Run this BEFORE transpiling to catch all missing files in one pass.
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC  = path.join(ROOT, 'src');

const MAX_FILES = 50000;

// Entry: src equivalent of workbench.desktop.main
const entryAbs = path.join(SRC, 'vs/workbench/workbench.desktop.main.ts');
if (!existsSync(entryAbs)) { console.error('Entry not found'); process.exit(1); }

console.log(`Tracing src imports from: ${path.relative(ROOT, entryAbs)}\n`);

// Match both .ts and .js extension imports (TS uses .js in import statements)
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;

const visited = new Set();
const missing = [];
const queue   = [entryAbs];
let processed = 0;

function resolveImport(fromFile, importPath) {
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) return null;
    const dir = path.dirname(fromFile);
    // Strip extension and try .ts, .tsx
    const base = path.resolve(dir, importPath.replace(/\.(js|mjs)$/, ''));
    for (const ext of ['.ts', '.tsx', '']) {
        const candidate = base + ext;
        if (existsSync(candidate)) return candidate;
    }
    // Return .ts version (may be missing)
    return base + '.ts';
}

while (queue.length > 0 && processed < MAX_FILES) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    processed++;
    if (!existsSync(file)) continue;

    let src;
    try { src = readFileSync(file, 'utf8'); } catch { continue; }

    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(src)) !== null) {
        const ip = m[1];
        if (ip.endsWith('.css') || ip.endsWith('.json') || ip.endsWith('.wasm')) continue;
        const resolved = resolveImport(file, ip);
        if (!resolved || visited.has(resolved)) continue;

        if (!existsSync(resolved)) {
            // Only report files inside our src/ tree (not node_modules etc)
            const rel = path.relative(ROOT, resolved);
            if (rel.startsWith('src' + path.sep) || rel.startsWith('src/')) {
                missing.push({ file: path.relative(ROOT, file), importPath: ip, resolved: rel });
            }
            visited.add(resolved);
        } else {
            queue.push(resolved);
        }
    }
}

console.log(`Processed ${processed} files, found ${missing.length} missing src imports.\n`);
if (missing.length === 0) {
    console.log('✔ No missing source imports.');
} else {
    for (const { file, importPath, resolved } of missing) {
        console.log(`  MISS: [${file}]\n        imports: ${importPath}\n        → ${resolved}\n`);
    }
}
