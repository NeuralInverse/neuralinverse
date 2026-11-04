import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');

const MAX_FILES = 50000; // large enough to cover the full workbench

const entryArg = process.argv[2];
const entryAbs = entryArg
    ? path.resolve(ROOT, entryArg)
    : path.join(OUT, 'vs/workbench/workbench.desktop.main.js');

if (!existsSync(entryAbs)) { console.error(`Entry not found: ${entryAbs}`); process.exit(1); }

console.log(`Tracing imports from: ${path.relative(ROOT, entryAbs)}\n`);

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;

const visited = new Set();
const missing = [];
const queue = [entryAbs];
let processed = 0;

function resolveImport(fromFile, importPath) {
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) return null;
    let resolved = path.resolve(path.dirname(fromFile), importPath);
    if (!resolved.endsWith('.js') && !resolved.endsWith('.mjs') && !resolved.endsWith('.css')) resolved += '.js';
    return resolved;
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
        if (ip.endsWith('.css')) continue;
        const resolved = resolveImport(file, ip);
        if (!resolved || visited.has(resolved)) continue;

        if (!existsSync(resolved)) {
            missing.push({ file: path.relative(ROOT, file), importPath: ip, resolved: path.relative(ROOT, resolved) });
            visited.add(resolved);
        } else {
            queue.push(resolved);
        }
    }
}

console.log(`Processed ${processed} files, found ${missing.length} missing imports.\n`);
if (missing.length === 0) {
    console.log('✔ No missing imports found.');
} else {
    for (const { file, importPath, resolved } of missing) {
        console.log(`  MISS: [${file}]\n        imports: ${importPath}\n        → ${resolved}\n`);
    }
}
