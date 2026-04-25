/*---------------------------------------------------------------------------------------------
 *  NeuralInverseCC — Tool Bridge (Tier 1b)
 *
 *  Patches void's `builtinTools` descriptions with battle-tested CC tool descriptions at
 *  startup.  These descriptions are derived from the CC tool prompt files:
 *    tools/BashTool/prompt.ts      \u2192 bash
 *    tools/FileReadTool/prompt.ts  \u2192 read
 *    tools/FileWriteTool/prompt.ts \u2192 write
 *    tools/FileEditTool/prompt.ts  \u2192 edit
 *    tools/GlobTool/prompt.ts      \u2192 glob
 *    tools/GrepTool/prompt.ts      \u2192 grep
 *    tools/WebFetchTool/prompt.ts  \u2192 web_fetch
 *
 *  CC's functions have runtime dependencies (bun:bundle, process.env flags, PDF detection,
 *  etc.) that are unavailable in the VS Code renderer.  We therefore inline the static
 *  text here — the content mirrors CC's output for a standard desktop environment and is
 *  kept in sync with the CC source tree.
 *
 *  Called once at startup from neuralInverseCC.contribution.ts (side-effect import is
 *  enough; the module-level call executes on first import).
 *--------------------------------------------------------------------------------------------*/

import { builtinTools } from '../../../void/common/prompt/prompts.js';

// ── Per-tool descriptions (CC-derived) ────────────────────────────────────────

/**
 * Derived from tools/BashTool/prompt.ts `getDescription()`.
 * Runtime-variable sections (sandbox path, timeout defaults, git instructions) have been
 * replaced with their standard desktop values.
 */
const BASH_DESCRIPTION = `Execute a given bash command and returns its output.

The working directory persists between commands, but shell state does not. The shell environment is initialized from the user's profile (bash or zsh).

IMPORTANT: Avoid using this tool to run \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user:

 - File search: Use Glob (NOT find or ls)
 - Content search: Use Grep (NOT grep or rg)
 - Read files: Use Read (NOT cat/head/tail)
 - Edit files: Use Edit (NOT sed/awk)
 - Write files: Use Write (NOT echo >/cat <<EOF)
 - Communication: Output text directly (NOT echo/printf)
While the Bash tool can do similar things, it's better to use the built-in tools as they provide a better user experience and make it easier to review tool calls and give permission.

# Instructions
 - If your command will create new directories or files, first use this tool to run \`ls\` to verify the parent directory exists and is the correct location.
 - Always quote file paths that contain spaces with double quotes in your command (e.g., cd "path with spaces/file.txt")
 - Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of \`cd\`. You may use \`cd\` if the User explicitly requests it.
 - You may specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). By default, your command will timeout after 120000ms (2 minutes).
 - You can use the \`run_in_background\` parameter to run the command in the background. Only use this if you don't need the result immediately and are OK being notified when the command completes later. You do not need to check the output right away - you'll be notified when it finishes. You do not need to use '&' at the end of the command when using this parameter.
 - When issuing multiple commands:
  - If the commands are independent and can run in parallel, make multiple Bash tool calls in a single message.
  - If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together.
  - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.
  - DO NOT use newlines to separate commands (newlines are ok in quoted strings).
 - For git commands:
  - Prefer to create a new commit rather than amending an existing commit.
  - Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative that achieves the same goal. Only use destructive operations when they are truly the best approach.
  - Never skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user has explicitly asked for it. If a hook fails, investigate and fix the underlying issue.
 - Avoid unnecessary \`sleep\` commands:
  - Do not sleep between commands that can run immediately — just run them.
  - If your command is long running and you would like to be notified when it finishes — use \`run_in_background\`. No sleep needed.
  - Do not retry failing commands in a sleep loop — diagnose the root cause.
  - If waiting for a background task you started with \`run_in_background\`, you will be notified when it completes — do not poll.
  - If you must poll an external process, use a check command rather than sleeping first.
  - If you must sleep, keep the duration short (1-5 seconds) to avoid blocking the user.`;

/**
 * Derived from tools/FileReadTool/prompt.ts `renderPromptTemplate()`.
 * PDF support section included as a standard capability.
 */
const READ_DESCRIPTION = `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to 2000 lines starting from the beginning of the file
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- Results are returned using cat -n format, with line numbers starting at 1
- This tool allows Claude Code to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as Claude Code is a multimodal LLM.
- This tool can read PDF files (.pdf). For large PDFs (more than 10 pages), you MUST provide the pages parameter to read specific page ranges (e.g., pages: "1-5"). Reading a large PDF without the pages parameter will fail. Maximum 20 pages per request.
- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.
- This tool can only read files, not directories. To read a directory, use an ls command via the Bash tool.
- You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.`;

/**
 * Derived from tools/FileWriteTool/prompt.ts `getWriteToolDescription()`.
 */
const WRITE_DESCRIPTION = `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- Prefer the Edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`;

/**
 * Derived from tools/FileEditTool/prompt.ts `getEditToolDescription()`.
 * Line number prefix format defaults to "line number + tab" (compact mode).
 */
const EDIT_DESCRIPTION = `Performs exact string replacements in files.

Usage:
- You must use your \`Read\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`;

/**
 * Derived from tools/GlobTool/prompt.ts `DESCRIPTION`.
 */
const GLOB_DESCRIPTION = `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead`;

/**
 * Derived from tools/GrepTool/prompt.ts `getDescription()`.
 */
const GREP_DESCRIPTION = `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use Grep for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command. The Grep tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
  - Use Agent tool for open-ended searches requiring multiple rounds
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\`
`;

/**
 * Derived from tools/WebFetchTool/prompt.ts `DESCRIPTION`.
 */
const WEB_FETCH_DESCRIPTION = `
- Fetches content from a specified URL and processes it using an AI model
- Takes a URL and a prompt as input
- Fetches the URL content, converts HTML to markdown
- Processes the content with the prompt using a small, fast model
- Returns the model's response about the content
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions.
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - The prompt should describe what information you want to extract from the page
  - This tool is read-only and does not modify any files
  - Results may be summarized if the content is very large
  - Includes a self-cleaning 15-minute cache for faster responses when repeatedly accessing the same URL
  - When a URL redirects to a different host, the tool will inform you and provide the redirect URL in a special format. You should then make a new WebFetch request with the redirect URL to fetch the content.
  - For GitHub URLs, prefer using the gh CLI via Bash instead (e.g., gh pr view, gh issue view, gh api).
`;

// ── Patch ──────────────────────────────────────────────────────────────────────

/**
 * Applies CC-derived descriptions to void's `builtinTools` mutable registry.
 * Called once at startup — idempotent.
 */
export function applyToolBridgeDescriptions(): void {
	builtinTools.bash.description = BASH_DESCRIPTION;
	builtinTools.read.description = READ_DESCRIPTION;
	builtinTools.write.description = WRITE_DESCRIPTION;
	builtinTools.edit.description = EDIT_DESCRIPTION;
	builtinTools.glob.description = GLOB_DESCRIPTION;
	builtinTools.grep.description = GREP_DESCRIPTION;
	builtinTools.web_fetch.description = WEB_FETCH_DESCRIPTION;
}

// Apply immediately on module import (side-effect import is sufficient)
applyToolBridgeDescriptions();
