/**
 * Pattern lists for dangerous shell-tool allow-rule prefixes.
 *
 * An allow rule like `Bash(python:*)` or `PowerShell(node:*)` lets the model
 * run arbitrary code via that interpreter, bypassing the auto-mode classifier.
 * These lists feed the isDangerous{Bash,PowerShell}Permission predicates in
 * permissionSetup.ts, which strip such rules at auto-mode entry.
 *
 * The matcher in each predicate handles the rule-shape variants (exact, `:*`,
 * trailing `*`, ` *`, ` -\u2026*`). PS-specific cmdlet strings live in
 * isDangerousPowerShellPermission (permissionSetup.ts).
 */

/**
 * Cross-platform code-execution entry points present on both Unix and Windows.
 * Shared to prevent the two lists drifting apart on interpreter additions.
 */
export const CROSS_PLATFORM_CODE_EXEC = [
  // Interpreters
  'python',
  'python3',
  'python2',
  'node',
  'deno',
  'tsx',
  'ruby',
  'perl',
  'php',
  'lua',
  // Package runners
  'npx',
  'bunx',
  'npm run',
  'yarn run',
  'pnpm run',
  'bun run',
  // Shells reachable from both (Git Bash / WSL on Windows, native on Unix)
  'bash',
  'sh',
  // Remote arbitrary-command wrapper (native OpenSSH on Win10+)
  'ssh',
] as const

export const DANGEROUS_BASH_PATTERNS: readonly string[] = [
  ...CROSS_PLATFORM_CODE_EXEC,
  'zsh',
  'fish',
  'eval',
  'exec',
  'env',
  'xargs',
  'sudo',
  // Anthropic internal: ant-only tools plus general tools that ant sandbox
  // dotfile data shows are commonly over-allowlisted as broad prefixes.
  // These stay ant-only \u2014 external users don't have coo, and the rest are
  // an empirical-risk call grounded in ant sandbox data, not a universal
  // "this tool is unsafe" judgment. PS may want these once it has usage data.
  // ant-only patterns omitted (process.env not available in VS Code renderer)
]
