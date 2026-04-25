/*---------------------------------------------------------------------------------------------
 * Shim for `bun:bundle` — Bun build-time feature flags module.
 * In the VS Code renderer (esbuild-bundled), all feature flags are off.
 *--------------------------------------------------------------------------------------------*/
export function feature(_flag: string): boolean {
	return false;
}
