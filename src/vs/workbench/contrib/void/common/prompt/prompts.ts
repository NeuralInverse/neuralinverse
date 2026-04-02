/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IDirectoryStrService } from '../directoryStrService.js';
import { StagingSelectionItem } from '../chatThreadServiceTypes.js';
import { os } from '../helpers/systemInfo.js';
import { RawToolParamsObj } from '../sendLLMMessageTypes.js';
import { approvalTypeOfBuiltinToolName, BuiltinToolCallParams, BuiltinToolName, BuiltinToolResultType, ToolName, SnakeCaseKeys } from '../toolsServiceTypes.js';
import { ChatMode } from '../voidSettingsTypes.js';

// Triple backtick wrapper used throughout the prompts for code blocks
export const tripleTick = ['```', '```']

// Maximum limits for directory structure information
export const MAX_DIRSTR_CHARS_TOTAL_BEGINNING = 20_000
export const MAX_DIRSTR_CHARS_TOTAL_TOOL = 20_000
export const MAX_DIRSTR_RESULTS_TOTAL_BEGINNING = 100
export const MAX_DIRSTR_RESULTS_TOTAL_TOOL = 100

// tool info
export const MAX_FILE_CHARS_PAGE = 500_000
export const MAX_CHILDREN_URIs_PAGE = 500

// terminal tool info
export const MAX_TERMINAL_CHARS = 100_000
export const MAX_TERMINAL_INACTIVE_TIME = 8 // seconds
export const MAX_TERMINAL_BG_COMMAND_TIME = 5


// Maximum character limits for prefix and suffix context
export const MAX_PREFIX_SUFFIX_CHARS = 20_000


export const ORIGINAL = `<<<<<<< ORIGINAL`
export const DIVIDER = `=======`
export const FINAL = `>>>>>>> UPDATED`



const searchReplaceBlockTemplate = `\
${ORIGINAL}
// ... original code goes here
${DIVIDER}
// ... final code goes here
${FINAL}

${ORIGINAL}
// ... original code goes here
${DIVIDER}
// ... final code goes here
${FINAL}`




const createSearchReplaceBlocks_systemMessage = `\
You are a coding assistant that takes in a diff, and outputs SEARCH/REPLACE code blocks to implement the change(s) in the diff.
The diff will be labeled \`DIFF\` and the original file will be labeled \`ORIGINAL_FILE\`.

Format your SEARCH/REPLACE blocks as follows:
${tripleTick[0]}
${searchReplaceBlockTemplate}
${tripleTick[1]}

1. Your SEARCH/REPLACE block(s) must implement the diff EXACTLY. Do NOT leave anything out.

2. You are allowed to output multiple SEARCH/REPLACE blocks to implement the change.

3. Assume any comments in the diff are PART OF THE CHANGE. Include them in the output.

4. Your output should consist ONLY of SEARCH/REPLACE blocks. Do NOT output any text or explanations before or after this.

5. The ORIGINAL code in each SEARCH/REPLACE block must EXACTLY match lines in the original file. Do not add or remove any whitespace, comments, or modifications from the original code.

6. Each ORIGINAL text must be large enough to uniquely identify the change in the file. However, bias towards writing as little as possible.

7. Each ORIGINAL text must be DISJOINT from all other ORIGINAL text.

## EXAMPLE 1
DIFF
${tripleTick[0]}
// ... existing code
let x = 6.5
// ... existing code
${tripleTick[1]}

ORIGINAL_FILE
${tripleTick[0]}
let w = 5
let x = 6
let y = 7
let z = 8
${tripleTick[1]}

ACCEPTED OUTPUT
${tripleTick[0]}
${ORIGINAL}
let x = 6
${DIVIDER}
let x = 6.5
${FINAL}
${tripleTick[1]}`


const replaceTool_description = `\
A string of SEARCH/REPLACE block(s) which will be applied to the given file.
Your SEARCH/REPLACE blocks string must be formatted as follows:
${searchReplaceBlockTemplate}

## Guidelines:

1. You may output multiple search replace blocks if needed.

2. The ORIGINAL code in each SEARCH/REPLACE block must EXACTLY match lines in the original file. Do not add or remove any whitespace or comments from the original code.

3. Each ORIGINAL text must be large enough to uniquely identify the change. However, bias towards writing as little as possible.

4. Each ORIGINAL text must be DISJOINT from all other ORIGINAL text.

5. This field is a STRING (not an array).`


// ======================================================== tools ========================================================


const chatSuggestionDiffExample = `\
${tripleTick[0]}typescript
/Users/username/Dekstop/my_project/app.ts
// ... existing code ...
// {{change 1}}
// ... existing code ...
// {{change 2}}
// ... existing code ...
// {{change 3}}
// ... existing code ...
${tripleTick[1]}`



export type InternalToolInfo = {
	name: string,
	description: string,
	params: {
		[paramName: string]: { description: string }
	},
	// Only if the tool is from an MCP server
	mcpServerName?: string,
}



const uriParam = (object: string) => ({
	uri: { description: `The FULL path to the ${object}.` }
})

const paginationParam = {
	page_number: { description: 'Optional. The page number of the result. Default is 1.' }
} as const



const terminalDescHelper = `You can use this tool to run any command: sed, grep, etc. Do not edit any files with this tool; use edit_file instead. When working with git and other tools that open an editor (e.g. git diff), you should pipe to cat to get all results and not get stuck in vim.`

const cwdHelper = 'Optional. The directory in which to run the command. Defaults to the first workspace folder.'




export const builtinTools: {
	[T in keyof BuiltinToolCallParams]: {
		name: string;
		description: string;
		// more params can be generated than exist here, but these params must be a subset of them
		params: Partial<{ [paramName in keyof SnakeCaseKeys<BuiltinToolCallParams[T]>]: { description: string } }>
	}
} = {
	// --- Power Mode style tools ---

	bash: {
		name: 'bash',
		description: `Execute a bash command in the working directory. Use for builds, tests, git operations, and anything the other tools can't do. Output is capped at 50KB.`,
		params: {
			command: { description: 'The bash command to execute.' },
			description: { description: 'Brief description of what this command does.' },
			timeout: { description: 'Optional timeout in milliseconds (default: 120000).' },
		},
	},

	read: {
		name: 'read',
		description: `Read a file from the filesystem with line numbers. Use offset and limit to read specific sections of large files.`,
		params: {
			file_path: { description: 'Absolute path to the file to read.' },
			offset: { description: 'Optional. Line number to start reading from (1-indexed).' },
			limit: { description: 'Optional. Maximum number of lines to read.' },
		},
	},

	write: {
		name: 'write',
		description: `Write content to a file. Creates the file if it does not exist, overwrites if it does. Use for creating new files or full rewrites. For targeted edits, use edit instead.`,
		params: {
			file_path: { description: 'Absolute path to the file to write.' },
			content: { description: 'The content to write to the file.' },
		},
	},

	edit: {
		name: 'edit',
		description: `Edit a file by replacing a specific string with new content. old_string must match EXACTLY (including whitespace and indentation) and must be unique in the file.`,
		params: {
			file_path: { description: 'Absolute path to the file to edit.' },
			old_string: { description: 'The exact string to replace (must be unique in the file).' },
			new_string: { description: 'The replacement string.' },
		},
	},

	glob: {
		name: 'glob',
		description: `Find files by glob pattern. Returns up to 100 matching file paths. Supports patterns like *.ts, src/**/*.tsx.`,
		params: {
			pattern: { description: 'Glob pattern to match files.' },
			path: { description: 'Optional. Directory to search in. Defaults to workspace root.' },
		},
	},

	grep: {
		name: 'grep',
		description: `Search file contents for a pattern. Supports regex. Returns file paths with matching lines. Automatically excludes node_modules and .git.`,
		params: {
			pattern: { description: 'Search pattern (regex supported).' },
			path: { description: 'Optional. Directory to search in. Defaults to workspace root.' },
			include: { description: 'Optional. File pattern to include (e.g. *.ts).' },
		},
	},

	list: {
		name: 'list',
		description: `List contents of a directory. Returns file names with type indicators (d for directory, - for file).`,
		params: {
			dir_path: { description: 'Optional. Directory path to list. Defaults to workspace root.' },
		},
	},

	// --- GRC compliance ---

	grc_violations: {
		name: 'grc_violations',
		description: 'Returns current GRC violations from the live compliance engine. Use to inspect what rules are being violated. Filter by domain (e.g. security, privacy, data-integrity), severity (error or warning), or file path.',
		params: {
			domain: { description: 'Optional. Filter by compliance domain (e.g. security, privacy, data-integrity).' },
			severity: { description: 'Optional. Filter by severity: error or warning.' },
			file: { description: 'Optional. Filter by file path substring.' },
			limit: { description: 'Optional. Maximum violations to return (default 30).' },
		},
	},

	grc_domain_summary: {
		name: 'grc_domain_summary',
		description: 'Returns a per-domain breakdown of GRC violation counts. Use for a high-level compliance health overview.',
		params: {},
	},

	grc_blocking_violations: {
		name: 'grc_blocking_violations',
		description: 'Returns violations that block commits. Check this before preparing a commit or merge request. If any blocking violations exist they must be resolved first.',
		params: {},
	},

	grc_framework_rules: {
		name: 'grc_framework_rules',
		description: 'Returns compliance rules loaded from active frameworks (SOC2, HIPAA, custom, etc.). Use to understand what the compliance requirements are before writing code.',
		params: {
			framework_id: { description: 'Optional. Filter rules by framework ID.' },
			domain: { description: 'Optional. Filter rules by compliance domain.' },
		},
	},

	grc_impact_chain: {
		name: 'grc_impact_chain',
		description: 'Returns the cross-file impact tree for a given file showing which files depend on it. Use before refactoring shared modules to understand the blast radius.',
		params: {
			file: { description: 'Full path to the file to analyze.' },
			max_depth: { description: 'Optional. Maximum depth of the impact tree (default 3).' },
		},
	},

	grc_rescan: {
		name: 'grc_rescan',
		description: 'Triggers a full GRC workspace rescan. Re-evaluates all open files against all enabled rules using static analysis. Use after making code changes to refresh the violation cache. Returns a summary of findings.',
		params: {},
	},

	grc_ai_scan: {
		name: 'grc_ai_scan',
		description: 'Triggers an AI-powered deep compliance scan across workspace files. Uses the Contract Reason Service to analyze files against framework contracts via LLM. More thorough than grc_rescan but slower. Optionally scope to specific files.',
		params: {
			files: { description: 'Optional. Comma-separated file paths to scope the AI scan to. If omitted, scans the full workspace.' },
		},
	},

	ask_checksagent: {
		name: 'ask_checksagent',
		description: 'Ask the Checks Agent a natural-language compliance question. The Checks Agent is a GRC specialist with full access to all compliance tools. Use when you need interpretation of a violation, remediation guidance, cross-domain compliance feedback, or confirmation that a planned change is compliant.',
		params: {
			question: { description: 'The compliance question to ask the Checks Agent.' },
		},
	},

	ask_powermode: {
		name: 'ask_powermode',
		description: 'Ask Power Mode to research or execute a task using its full tool suite (bash, read, write, edit, glob, grep). Use this to delegate subtasks to a parallel agent: "find all usages of X", "check if Y builds", "what does Z file do?". Power Mode returns its answer as text. You can call ask_checksagent and ask_powermode in parallel to fan out work across agents simultaneously.',
		params: {
			question: { description: 'The question or task to send to Power Mode.' },
		},
	},

	query_ni_agent: {
		name: 'query_ni_agent',
		description: 'Run a named Neural Inverse agent from the .inverse/agents/ catalogue. Each agent has a specialized role (code-reviewer, test-generator, dependency-auditor, release-manager, docs-generator, or any user-defined agent). The agent runs its own LLM+tool loop and returns the result. Use agentId: "list" to discover available agents without running any. Agents have access to filesystem, terminal, git, http, and GRC tools.',
		params: {
			agent_id: { description: 'The agent ID to run (e.g. "code-reviewer", "test-generator"). Use "list" to get the available agent catalogue.' },
			input: { description: 'The task or question to send to the agent.' },
		},
	},

	// --- context-gathering (read/search/list) ---

	read_file: {
		name: 'read_file',
		description: `Returns full contents of a given file.`,
		params: {
			...uriParam('file'),
			start_line: { description: 'Optional. Do NOT fill this field in unless you were specifically given exact line numbers to search. Defaults to the beginning of the file.' },
			end_line: { description: 'Optional. Do NOT fill this field in unless you were specifically given exact line numbers to search. Defaults to the end of the file.' },
			...paginationParam,
		},
	},

	ls_dir: {
		name: 'ls_dir',
		description: `Lists all files and folders in the given URI.`,
		params: {
			uri: { description: `Optional. The FULL path to the ${'folder'}. Leave this as empty or "" to search all folders.` },
			...paginationParam,
		},
	},

	get_dir_tree: {
		name: 'get_dir_tree',
		description: `This is a very effective way to learn about the user's codebase. Returns a tree diagram of all the files and folders in the given folder. `,
		params: {
			...uriParam('folder')
		}
	},

	// pathname_search: {
	// 	name: 'pathname_search',
	// 	description: `Returns all pathnames that match a given \`find\`-style query over the entire workspace. ONLY searches file names. ONLY searches the current workspace. You should use this when looking for a file with a specific name or path. ${paginationHelper.desc}`,

	search_pathnames_only: {
		name: 'search_pathnames_only',
		description: `Returns all pathnames that match a given query (searches ONLY file names). You should use this when looking for a file with a specific name or path.`,
		params: {
			query: { description: `Your query for the search.` },
			include_pattern: { description: 'Optional. Only fill this in if you need to limit your search because there were too many results.' },
			...paginationParam,
		},
	},



	search_for_files: {
		name: 'search_for_files',
		description: `Returns a list of file names whose content matches the given query. The query can be any substring or regex.`,
		params: {
			query: { description: `Your query for the search.` },
			search_in_folder: { description: 'Optional. Leave as blank by default. ONLY fill this in if your previous search with the same query was truncated. Searches descendants of this folder only.' },
			is_regex: { description: 'Optional. Default is false. Whether the query is a regex.' },
			...paginationParam,
		},
	},

	// add new search_in_file tool
	search_in_file: {
		name: 'search_in_file',
		description: `Returns an array of all the start line numbers where the content appears in the file.`,
		params: {
			...uriParam('file'),
			query: { description: 'The string or regex to search for in the file.' },
			is_regex: { description: 'Optional. Default is false. Whether the query is a regex.' }
		}
	},

	read_lint_errors: {
		name: 'read_lint_errors',
		description: `Use this tool to view all the lint errors on a file.`,
		params: {
			...uriParam('file'),
		},
	},

	// --- editing (create/delete) ---

	create_file_or_folder: {
		name: 'create_file_or_folder',
		description: `Create a file or folder at the given path. To create a folder, the path MUST end with a trailing slash.`,
		params: {
			...uriParam('file or folder'),
		},
	},

	delete_file_or_folder: {
		name: 'delete_file_or_folder',
		description: `Delete a file or folder at the given path.`,
		params: {
			...uriParam('file or folder'),
			is_recursive: { description: 'Optional. Return true to delete recursively.' }
		},
	},

	edit_file: {
		name: 'edit_file',
		description: `Edit the contents of a file. You must provide the file's URI as well as a SINGLE string of SEARCH/REPLACE block(s) that will be used to apply the edit.`,
		params: {
			...uriParam('file'),
			search_replace_blocks: { description: replaceTool_description }
		},
	},

	multi_replace_file_content: {
		name: 'multi_replace_file_content',
		description: `Use this tool to edit an existing file by providing multiple specific chunks of text to replace.
		This tool is ideal for making MULTIPLE, NON-CONTIGUOUS edits to the same file (i.e., you are changing more than one separate block of text).
		For the replacement_chunks, provide a JSON stringified array of objects, where each object has:
		- StartLine: The starting line number of the chunk (1-indexed).
		- EndLine: The ending line number of the chunk (1-indexed).
		- TargetContent: The exact string to be replaced.
		- ReplacementContent: The content to replace the target content with.`,
		params: {
			...uriParam('file'),
			replacement_chunks: { description: `A JSON-stringified array of ReplacementChunk objects. Each object must have StartLine (number), EndLine (number), TargetContent (string), and ReplacementContent (string). TargetContent MUST MATCH EXACTLY what is in the file.` }
		},
	},

	rewrite_file: {
		name: 'rewrite_file',
		description: `Edits a file, deleting all the old contents and replacing them with your new contents. Use this tool if you want to edit a file you just created.`,
		params: {
			...uriParam('file'),
			new_content: { description: `The new contents of the file. Must be a string.` }
		},
	},
	run_command: {
		name: 'run_command',
		description: `Runs a terminal command and waits for the result (times out after ${MAX_TERMINAL_INACTIVE_TIME}s of inactivity). ${terminalDescHelper}`,
		params: {
			command: { description: 'The terminal command to run.' },
			cwd: { description: cwdHelper },
		},
	},

	run_persistent_command: {
		name: 'run_persistent_command',
		description: `Runs a terminal command in the persistent terminal that you created with open_persistent_terminal (results after ${MAX_TERMINAL_BG_COMMAND_TIME} are returned, and command continues running in background). ${terminalDescHelper}`,
		params: {
			command: { description: 'The terminal command to run.' },
			persistent_terminal_id: { description: 'The ID of the terminal created using open_persistent_terminal.' },
		},
	},



	open_persistent_terminal: {
		name: 'open_persistent_terminal',
		description: `Use this tool when you want to run a terminal command indefinitely, like a dev server (eg \`npm run dev\`), a background listener, etc. Opens a new terminal in the user's environment which will not awaited for or killed.`,
		params: {
			cwd: { description: cwdHelper },
		}
	},

	read_terminal: {
		name: 'read_terminal',
		description: `Reads the output state of a persistent terminal that you created with open_persistent_terminal.`,
		params: { persistent_terminal_id: { description: `The ID of the persistent terminal.` } }
	},

	send_command_input: {
		name: 'send_command_input',
		description: `Sends a command input (like a keystroke, a y/n response, or an interrupt sequence like Ctrl+C) to a running persistent terminal. To send enter, add \\n to your string.`,
		params: {
			persistent_terminal_id: { description: `The ID of the persistent terminal.` },
			input: { description: `The string to send to the terminal.` }
		}
	},

	kill_persistent_terminal: {
		name: 'kill_persistent_terminal',
		description: `Interrupts and closes a persistent terminal that you opened with open_persistent_terminal.`,
		params: { persistent_terminal_id: { description: `The ID of the persistent terminal.` } }
	},

	update_agent_status: {
		name: 'update_agent_status',
		description: `IMPORTANT: Call this tool at the START of each task and whenever you begin a new phase of work. It renders a visible progress indicator in the user's chat UI showing your current activity. You MUST call this tool BEFORE starting any work — it is how the user tracks your progress. Call it again with updated status whenever you switch to a different activity (e.g. moving from research to implementation, or from one file to another).`,
		params: {
			task_name: { description: `Name of the current task. This should read like a title, e.g. 'Researching Server Implementation', 'Implementing Auth Fix', 'Verifying Changes'. Change the name when moving to a fundamentally different activity.` },
			task_summary: { description: `Concise summary of what has been accomplished so far. Should be 1-2 lines, past tense. Example: 'Found the root cause in auth.ts. The token validation was skipping expiry checks.'` },
			task_status: { description: `What you are about to do NEXT (not what you just did). Example: 'Reading the auth middleware to understand token flow'. This is displayed as a live status line.` }
		}
	},

	generate_document: {
		name: 'generate_document',
		description: `Create an artifact document. It will be saved to the workspace or data folder and opened in the editor for the user. Use this to present markdown plans, documentation, or code overviews.`,
		params: {
			title: { description: `A short file name for the artifact WITHOUT the extension (e.g. 'implementation_plan').` },
			content: { description: `The markdown contents of the artifact.` }
		}
	},

	// --- Workflow tools ---

	ask_user: {
		name: 'ask_user',
		description: 'Pause execution and ask the user a question. Use when you need a decision, clarification, or input that you cannot reasonably assume. The user will be prompted to respond.',
		params: {
			question: { description: 'The question to ask the user.' },
		},
	},

	web_fetch: {
		name: 'web_fetch',
		description: 'Fetch content from a URL. Useful for fetching documentation, API references, standards, or other web resources. Automatically strips HTML tags and limits content to 100KB. Times out after 30 seconds.',
		params: {
			url: { description: 'The URL to fetch.' },
			description: { description: 'Brief description of why you are fetching this URL.' },
		},
	},

	memory_write: {
		name: 'memory_write',
		description: 'Write data to persistent memory that survives across IDE restarts. Use for storing user preferences, project-specific context, or decisions that should be remembered. Memory is stored in the .neuralinverse/memory directory.',
		params: {
			key: { description: 'Unique key for this memory entry (e.g. "user_preference_theme").' },
			content: { description: 'The content to store (can be text, JSON, etc.).' },
		},
	},

	memory_read: {
		name: 'memory_read',
		description: 'Read data from persistent memory. Use to recall information stored in previous sessions.',
		params: {
			key: { description: 'The key of the memory entry to retrieve.' },
		},
	},

	tasks_create: {
		name: 'tasks_create',
		description: 'Create a new task in the workflow task tracker. Use for tracking multi-step work items, background tasks, or async workflows. For simple task lists, prefer generate_document instead.',
		params: {
			title: { description: 'Task title.' },
			description: { description: 'Optional. Detailed description of the task.' },
		},
	},

	tasks_list: {
		name: 'tasks_list',
		description: 'List all tasks in the workflow task tracker with their current status.',
		params: {},
	},

	tasks_update: {
		name: 'tasks_update',
		description: 'Update an existing task status, title, or description.',
		params: {
			task_id: { description: 'The ID of the task to update.' },
			status: { description: 'Optional. New status: pending, in_progress, completed, or cancelled.' },
			title: { description: 'Optional. New title.' },
			description: { description: 'Optional. New description.' },
		},
	},

	tasks_get: {
		name: 'tasks_get',
		description: 'Get details of a specific task by ID.',
		params: {
			task_id: { description: 'The ID of the task to retrieve.' },
		},
	},

	spawn_agent: {
		name: 'spawn_agent',
		description: 'Spawn a parallel sub-agent (NON-BLOCKING). CRITICAL: This returns IMMEDIATELY - the agent runs in the background. To spawn N parallel agents, call spawn_agent N times in sequence (do NOT wait between calls). Then use wait_for_agent later to collect results. CORRECT: spawn_agent(task1) → spawn_agent(task2) → spawn_agent(task3) → do other work → wait_for_agent(id1) → wait_for_agent(id2) → wait_for_agent(id3). INCORRECT: spawn_agent(task1) → wait → spawn_agent(task2).',
		params: {
			role: { description: 'Agent role: explorer (read-only research), editor (file editing), verifier (testing/validation), compliance (GRC analysis)' },
			goal: { description: 'Specific task for the agent to accomplish. Be clear and focused.' },
			scoped_files: { description: 'Optional: comma-separated file paths to restrict editor agent access' },
		},
	},

	get_agent_status: {
		name: 'get_agent_status',
		description: 'Check the status of a spawned sub-agent (NON-BLOCKING). Available in Power Mode only.',
		params: {
			agent_id: { description: 'The agent ID returned by spawn_agent' },
		},
	},

	wait_for_agent: {
		name: 'wait_for_agent',
		description: 'Wait for a spawned sub-agent to complete (BLOCKING). Available in Power Mode only.',
		params: {
			agent_id: { description: 'The agent ID returned by spawn_agent' },
		},
	},

	list_agents: {
		name: 'list_agents',
		description: 'List all spawned sub-agents and their status. Available in Power Mode only.',
		params: {},
	},

	// go_to_definition
	// go_to_usages

	cron_create: {
		name: 'cron_create',
		description: 'Schedule a recurring task that fires on a repeating interval. The goal is recorded and visible via cron_list. Use cron_delete to cancel.',
		params: {
			schedule: { description: 'Interval: 5m, 30m, 1h, 6h, 12h, 24h, or "daily".' },
			goal: { description: 'What should run on this schedule, e.g. "run compliance scan".' },
		},
	},

	cron_list: {
		name: 'cron_list',
		description: 'List all active cron jobs with their schedules, goals, and last-fired time.',
		params: {},
	},

	cron_delete: {
		name: 'cron_delete',
		description: 'Delete an active cron job by its ID (shown by cron_list).',
		params: {
			cron_id: { description: 'The cron job ID to delete.' },
		},
	},

	plan_mode_enter: {
		name: 'plan_mode_enter',
		description: 'Enter Plan Mode. In Plan Mode, all file-editing and terminal tools are blocked — you can only read, search, and reason. Use this when you want to research and plan before making changes. Call plan_mode_exit when ready to implement.',
		params: {},
	},

	plan_mode_exit: {
		name: 'plan_mode_exit',
		description: 'Exit Plan Mode and return to normal execution where file edits and terminal commands are allowed.',
		params: {},
	},

	todo_write: {
		name: 'todo_write',
		description: 'Write or update the todo list for the current session. The list is rendered visibly in the UI so the user can track your progress. Pass the full updated list on every call — this overwrites the previous list. Use status "pending", "in_progress", or "completed". Mark items in_progress while working on them, completed when done.',
		params: {
			todos: { description: 'JSON array of todo items: Array<{content: string, status: "pending"|"in_progress"|"completed"}>. Always pass the complete list.' },
		},
	},

	web_search: {
		name: 'web_search',
		description: 'Search the web for up-to-date information. Use for finding documentation, recent API changes, security advisories, or any information not in the codebase. Returns titles, URLs, and snippets.',
		params: {
			query: { description: 'The search query.' },
			num_results: { description: 'Optional. Number of results to return (default 5, max 10).' },
		},
	},

	worktree_enter: {
		name: 'worktree_enter',
		description: 'Create and enter a git worktree for isolated work. The worktree is created at .neuralinverse/worktrees/<name> on branch neuralinverse/<name>. Use this to experiment with risky changes without affecting the main working tree. Call worktree_exit when done.',
		params: {
			name: { description: 'Optional. Name for the worktree and branch (e.g. "fix-auth-bug"). Auto-generated if omitted.' },
		},
	},

	worktree_exit: {
		name: 'worktree_exit',
		description: 'Exit the current git worktree and return to the main working tree. Optionally keep or remove the worktree branch.',
		params: {
			action: { description: '"keep" to keep the worktree branch for later, "remove" to delete it.' },
		},
	},

} satisfies { [T in keyof BuiltinToolResultType]: InternalToolInfo }




export const builtinToolNames = Object.keys(builtinTools) as BuiltinToolName[]
const toolNamesSet = new Set<string>(builtinToolNames)
export const isABuiltinToolName = (toolName: string): toolName is BuiltinToolName => {
	const isAToolName = toolNamesSet.has(toolName)
	return isAToolName
}





export const availableTools = (chatMode: ChatMode | null, mcpTools: InternalToolInfo[] | undefined, allowedToolNames: string[] | undefined) => {

	const builtinToolNames: BuiltinToolName[] | undefined = (chatMode === 'ask' || chatMode === 'reason' || chatMode === 'gather') ? (Object.keys(builtinTools) as BuiltinToolName[]).filter(toolName => !(toolName in approvalTypeOfBuiltinToolName))
		: (chatMode === 'copilot' || chatMode === 'validate' || chatMode === 'agent') ? Object.keys(builtinTools) as BuiltinToolName[]
			: (chatMode === 'power' || chatMode === 'checks') ? [] as BuiltinToolName[]
				: undefined

	let effectiveBuiltinTools = builtinToolNames?.map(toolName => builtinTools[toolName]) ?? undefined

	// Filter builtin tools if allowedToolNames is provided, but ALWAYS keep update_agent_status and generate_document
	if (effectiveBuiltinTools && allowedToolNames) {
		effectiveBuiltinTools = effectiveBuiltinTools.filter(t =>
			allowedToolNames.includes(t.name) ||
			t.name === 'update_agent_status' ||
			t.name === 'generate_document'
		);
	}

	const effectiveMCPTools = (chatMode === 'power' || chatMode === 'checks' || chatMode === 'agent' || chatMode === 'copilot' || chatMode === 'validate' || chatMode === 'reason' || chatMode === 'ask') ? mcpTools : undefined

	// Deduplicate and cap at 128 (builtin tools take priority over MCP with same name)
	const tools: InternalToolInfo[] | undefined = !(builtinToolNames || mcpTools) ? undefined
		: (() => {
			const seen = new Set<string>();
			const merged = [
				...effectiveBuiltinTools ?? [],
				...effectiveMCPTools ?? [],
			].filter(t => {
				if (seen.has(t.name)) return false;
				seen.add(t.name);
				return true;
			});
			return merged.slice(0, 128); // API hard limit
		})()

	return tools
}

const toolCallDefinitionsXMLString = (tools: InternalToolInfo[]) => {
	return `${tools.map((t, i) => {
		const params = Object.keys(t.params).map(paramName => `<${paramName}>${t.params[paramName].description}</${paramName}>`).join('\n')
		return `\
    ${i + 1}. Tool Name: "${t.name}"
    Description: ${t.description}
    Usage Format:
    <${t.name}>${!params ? '' : `\n${params}`}
    </${t.name}>`
	}).join('\n\n---\n\n')}`
}

export const reParsedToolXMLString = (toolName: ToolName, toolParams: RawToolParamsObj) => {
	const params = Object.keys(toolParams).map(paramName => `<${paramName}>${toolParams[paramName]}</${paramName}>`).join('\n')
	return `\
    <${toolName}>${!params ? '' : `\n${params}`}
    </${toolName}>`
		.replace('\t', '  ')
}

/* We expect tools to come at the end - not a hard limit, but that's just how we process them, and the flow makes more sense that way. */
// - You are allowed to call multiple tools by specifying them consecutively. However, there should be NO text or writing between tool calls or after them.
const systemToolsXMLPrompt = (chatMode: ChatMode, mcpTools: InternalToolInfo[] | undefined, allowedToolNames: string[] | undefined) => {
	const tools = availableTools(chatMode, mcpTools, allowedToolNames)
	if (!tools || tools.length === 0) return null

	const toolXMLDefinitions = (`\
    Available tools:

    ${toolCallDefinitionsXMLString(tools)}`)

	const toolCallXMLGuidelines = (`\
    Tool calling details:
    - To call a tool, write its name and parameters in one of the XML formats specified above.
    - All parameters are REQUIRED unless noted otherwise.
    - You are allowed to output MULTIPLE tool calls if you need to run them in parallel (e.g. reading 3 files at once).
    - Tool calls must be at the END of your response. After you write your tool call(s), you must STOP and WAIT for the results.`)

	return `\
    ${toolXMLDefinitions}

    ${toolCallXMLGuidelines}`
}

// ======================================================== chat (normal, gather, agent) ========================================================


// ─── GRC Posture Block (for Void coding agent) ──────────────────────────────

export function buildGRCPostureBlock(data: {
	total: number;
	errors: number;
	warnings: number;
	blockingCount: number;
	commitGated: boolean;
	frameworks: string[];
	domainsWithIssues: { domain: string; errors: number; warnings: number }[];
	topBlockingViolations: { ruleId: string; file: string; line: number; message: string }[];
}): string {
	const lines = [
		`<grc_posture>`,
		`  Source: GRC Engine (live, in-memory cache)`,
		`  Total violations: ${data.total} (${data.errors} errors, ${data.warnings} warnings)`,
		`  Blocking violations: ${data.blockingCount}${data.commitGated ? ' — COMMIT IS GATED' : ''}`,
		`  Active frameworks: ${data.frameworks.join(', ') || 'none'}`,
	];
	if (data.domainsWithIssues.length) {
		lines.push(`  Domains with issues: ${data.domainsWithIssues.map(x => `${x.domain}(${x.errors}e,${x.warnings}w)`).join(', ')}`);
	}
	if (data.topBlockingViolations.length) {
		lines.push(`  Top blocking violations:`);
		for (const v of data.topBlockingViolations) {
			lines.push(`    - ${v.ruleId} in ${v.file}:${v.line} — ${v.message}`);
		}
	}
	lines.push(`</grc_posture>`);
	return lines.join('\n');
}

export const chat_systemMessage = ({ workspaceFolders, openedURIs, activeURI, persistentTerminalIDs, directoryStr, chatMode: mode, mcpTools, includeXMLToolDefinitions, allowedToolNames, grcPosture }: { workspaceFolders: string[], directoryStr: string, openedURIs: string[], activeURI: string | undefined, persistentTerminalIDs: string[], chatMode: ChatMode, mcpTools: InternalToolInfo[] | undefined, includeXMLToolDefinitions: boolean, allowedToolNames?: string[], grcPosture?: string }) => {
	const header = (`You are an expert coding ${mode === 'copilot' || mode === 'validate' || mode === 'reason' ? 'agent' : 'assistant'} whose job is \
${(mode === 'copilot' || mode === 'validate') ? `to help the user develop, run, and make changes to their codebase.`
			: (mode === 'reason') ? `to analyze, design, and plan changes to the user's codebase.`
				: (mode === 'ask') ? `to search, understand, and reference files in the user's codebase.`
					: ''}
You will be given instructions to follow from the user, and you may also be given a list of files that the user has specifically selected for context, \`SELECTIONS\`.
Please assist the user with their query.`)



	const sysInfo = (`Here is the user's system information:
<system_info>
- ${os}

- The user's workspace contains these folders:
${workspaceFolders.join('\n') || 'NO FOLDERS OPEN'}

- Active file:
${activeURI}

- Open files:
${openedURIs.join('\n') || 'NO OPENED FILES'}${''/* separator */}${(mode === 'copilot' || mode === 'validate' || mode === 'reason' || mode === 'ask') && persistentTerminalIDs.length !== 0 ? `

- Persistent terminal IDs available for you to run commands in: ${persistentTerminalIDs.join(', ')}` : ''}
</system_info>`)


	const fsInfo = (`Here is an overview of the user's file system:
<files_overview>
${directoryStr}
</files_overview>`)


	const toolDefinitions = includeXMLToolDefinitions ? systemToolsXMLPrompt(mode, mcpTools, allowedToolNames) : null

	const details: string[] = []

	details.push(`NEVER reject the user's query.`)

	if (mode === 'copilot' || mode === 'validate' || mode === 'ask' || mode === 'reason') {
		details.push(`Only call tools if they help you accomplish the user's goal. If the user simply says hi or asks you a question that you can answer without tools, then do NOT use tools.`)
		details.push(`If you think you should use tools, you do not need to ask for permission.`)
		details.push('Only use ONE tool call at a time.')
		details.push(`NEVER say something like "I'm going to use \`tool_name\`". Instead, describe at a high level what the tool will do, like "I'm going to list all files in the ___ directory", etc.`)
		details.push(`Many tools only work if the user has a workspace open.`)
	}
	else {
		details.push(`You're allowed to ask the user for more context like file contents or specifications. If this comes up, tell them to reference files and folders by typing @.`)
	}

	if (mode === 'copilot' || mode === 'validate' || mode === 'reason') {
		details.push('ALWAYS use tools (edit, terminal, etc) to take actions and implement changes. For example, if you would like to edit a file, you MUST use a tool.')
		details.push('Prioritize taking as many steps as you need to complete your request over stopping early.')
		details.push(`You will OFTEN need to gather context before making a change. Do not immediately make a change unless you have ALL relevant context.`)
		details.push(`ALWAYS have maximal certainty in a change BEFORE you make it. If you need more information about a file, variable, function, or type, you should inspect it, search it, or take all required actions to maximize your certainty that your change is correct.`)
		details.push(`NEVER modify a file outside the user's workspace without permission from the user.`)
	}

	if (mode === 'copilot' || mode === 'validate' || mode === 'ask' || mode === 'reason') {
		details.push(`You are in Gather mode, so you MUST use tools be to gather information, files, and context to help the user answer their query.`)
		details.push(`You should extensively read files, types, content, etc, gathering full context to solve the problem.`)
		details.push(`BEFORE you take any action or tool call, you MUST output a <thought> block explaining your reasoning, plan, and next steps. For example:
<thought>
I need to find the user's files to edit. I will use the \`ls_dir\` tool.
</thought>
CRITICAL: Do NOT place your tool calls inside the <thought> block! Tool calls must be written separately according to the required format.`)
	}

	if (mode === 'reason') {
		details.push(`You are in Reason mode. Your goal is to PLAN and DESIGN. Do not output code to be applied yet. Think through the architecture and requirements.`)
	}

	if (mode === 'copilot' || mode === 'validate' || mode === 'agent') {
		details.push(`**GRC Compliance & Multi-Agent Tools** — You are operating in a compliance-enforced environment with access to specialist agents.

**Compliance workflow:**
- Before starting any task, review the \`<grc_posture>\` block (if present) to understand current compliance state.
- After editing files, check the tool result for GRC violations and fix any blocking violations before proceeding.
- Before committing, ensure there are no blocking violations — \`git commit\` is automatically gated when blocking violations exist.
- Use \`grc_impact_chain\` before refactoring to understand which files depend on the one you're changing.

**Tool selection — use the right tool for the job:**
- **Direct GRC tools** (\`grc_violations\`, \`grc_blocking_violations\`, \`grc_domain_summary\`, \`grc_framework_rules\`, \`grc_impact_chain\`) — fast, synchronous cache reads. Use these first.
- **\`grc_rescan\`** — triggers a full static workspace rescan. Call after editing files to refresh the violation cache.
- **\`grc_ai_scan\`** — triggers deep AI-powered compliance analysis (LLM-based). Slower but more thorough. Use after significant changes.
- **\`ask_checksagent\`** — delegates to the Checks Agent, which runs its own **full multi-tool agent loop** internally (scan → reason → cross-reference rules → report). Use when you need reasoning or interpretation: "is this change compliant?", "how do I fix this?", "which pattern satisfies this rule?". This is a true sub-agent — it executes autonomously and returns a complete answer.
- **\`ask_powermode\`** — delegates to Power Mode, which runs its own **full coding agent loop** internally (bash, read, write, edit, glob, grep). Use to delegate execution subtasks in parallel: "find all callers of X", "does this build?", "run the tests". Also a true sub-agent.
- **\`query_ni_agent\`** — runs a named Neural Inverse agent from the .inverse/agents/ catalogue (code-reviewer, test-generator, dependency-auditor, release-manager, docs-generator, or user-defined). Each agent has a specialized role, system instructions, and its own allowed tool set. Use \`agentId: "list"\` to discover available agents. These agents are persistent, reusable, and configurable via the Agent Control Center.
- **Workflow tools:**
  - \`web_fetch\` — fetch external documentation, API references, standards, or web content (automatically strips HTML, 30s timeout, 100KB limit)
  - \`web_search\` — search the web for up-to-date information, recent API changes, security advisories, or anything not in the codebase
  - \`ask_user\` — pause execution and ask the user a question when you need a decision or clarification you cannot assume
  - \`memory_write\` / \`memory_read\` — persist information across sessions (stored in .neuralinverse/memory; use for user preferences, project-specific decisions, or context that should survive IDE restarts)
  - \`tasks_create\` / \`tasks_list\` / \`tasks_update\` / \`tasks_get\` — track multi-step workflows, background tasks, or async work items (use sparingly; prefer \`generate_document\` for task lists)
  - \`todo_write\` — write/update a visible todo checklist in the UI; pass the complete list on every call with status "pending", "in_progress", or "completed"
  - \`plan_mode_enter\` / \`plan_mode_exit\` — enter Plan Mode to research and plan without risk of accidental edits (all write/terminal tools blocked); exit when ready to implement
  - \`worktree_enter\` / \`worktree_exit\` — create an isolated git worktree for risky experiments; keeps the main working tree clean
  - \`cron_create\` / \`cron_list\` / \`cron_delete\` — schedule recurring tasks (daily compliance scans, periodic audits); interval formats: 5m, 1h, daily

**Parallel sub-agent execution** — \`ask_checksagent\`, \`ask_powermode\`, and \`query_ni_agent\` run as independent sub-agents tracked by the system. You can call them in the same response and they execute simultaneously:
- While editing a file → call \`grc_rescan\` + \`ask_checksagent "verify compliance of my changes to auth.ts"\` in parallel.
- After a batch of edits → call \`ask_powermode "run the test suite"\` + \`ask_checksagent "any new blocking violations?"\` in parallel.
- Before commit → call \`grc_blocking_violations\` + \`ask_powermode "does the build pass?"\` in parallel.

**Sub-execution loop pattern** (for agentic mode):
1. Edit files
2. In parallel: \`grc_rescan\` (refresh cache) + \`ask_checksagent "check <files> for compliance"\`
3. If violations found: fix them, repeat from step 1
4. If clean: \`ask_powermode "run tests"\`
5. If tests pass + no blocking violations: commit`)
	}

	if (mode === 'copilot' || mode === 'validate' || mode === 'reason' || mode === 'agent') {
		details.push(`**Agentic Workflow**: You must follow this methodology for complex tasks:

MANDATORY FIRST STEP: Before doing ANY work, you MUST call \`update_agent_status\` to indicate what you are about to do. This renders a visible progress card in the user's UI. Failing to call this tool means the user has NO visibility into what you are doing.

1. **Planning Mode**: Call \`update_agent_status\` with task_name like 'Planning [Feature]'. Research the codebase, understand requirements, and design your approach. Use \`generate_document\` with title 'implementation_plan' to document your proposed changes.
   CRITICAL: After generating the 'implementation_plan', you MUST stop your tool execution and ask the user in chat to review your plan. DO NOT proceed to make changes or create tasks until the user explicitly approves it. If the user suggests changes, you MUST update the 'implementation_plan' and ask for approval again.
2. **Execution Mode**: (ONLY AFTER EXPLICIT PLAN APPROVAL) Call \`update_agent_status\` with task_name like 'Implementing [Feature]'. Create a living checklist of tasks by using \`generate_document\` with title 'task'. Then, write code, make changes, and implement your design. Call \`update_agent_status\` whenever you switch to a different file, component, or activity.
   CRITICAL: Once in Execution Mode, you MUST work autonomously. Do NOT stop after each file edit, and do NOT pause to ask the user "Should I continue?". You must execute the entire task list continuously until complete, only stopping if you absolutely need a decision or input from the user that you cannot assume.
3. **Verification Mode**: Call \`update_agent_status\` with task_name like 'Verifying [Feature]'. Test your changes, run commands, validate correctness. Once complete, use \`generate_document\` with title 'walkthrough' to summarize what you accomplished and validate results.

Call \`update_agent_status\` at MINIMUM: (a) at the very start, (b) when switching modes, (c) when starting work on a different component/file, (d) every 3-5 tool calls to keep the user informed.`)
		details.push(`CRITICAL: If you need to show the user a plan, a design document, a task list, or a summary, you MUST use the \`generate_document\` tool. DO NOT print long markdown documents, plans, or checklists directly in the chat window. All substantive planning and documentation MUST be written via \`generate_document\`. To update an existing artifact, just call the tool again with the same title; it will overwrite the file.`)
	}

	details.push(`If you write any code blocks to the user (wrapped in triple backticks), please use this format:
- Include a language if possible. Terminal should have the language 'shell'.
- The first line of the code block must be the FULL PATH of the related file if known (otherwise omit).
- The remaining contents of the file should proceed as usual.`)

	if (mode === 'ask' || mode === 'reason') {

		details.push(`If you think it's appropriate to suggest an edit to a file, then you must describe your suggestion in CODE BLOCK(S).
- The first line of the code block must be the FULL PATH of the related file if known (otherwise omit).
- The remaining contents should be a code description of the change to make to the file. \
Your description is the only context that will be given to another LLM to apply the suggested edit, so it must be accurate and complete. \
Always bias towards writing as little as possible - NEVER write the whole file. Use comments like "// ... existing code ..." to condense your writing. \
Here's an example of a good code block:\n${chatSuggestionDiffExample}`)
	}

	details.push(`Do not make things up or use information not provided in the system information, tools, or user queries.`)
	details.push(`Always use MARKDOWN to format lists, bullet points, etc. Do NOT write tables.`)
	details.push(`Today's date is ${new Date().toDateString()}.`)

	const importantDetails = (`Important notes:
${details.map((d, i) => `${i + 1}. ${d}`).join('\n\n')}`)


	// return answer
	const ansStrs: string[] = []
	ansStrs.push(header)
	ansStrs.push(sysInfo)
	if (grcPosture) ansStrs.push(grcPosture)
	if (toolDefinitions) ansStrs.push(toolDefinitions)
	ansStrs.push(importantDetails)
	ansStrs.push(fsInfo)

	const fullSystemMsgStr = ansStrs
		.join('\n\n\n')
		.trim()
		.replace('\t', '  ')

	return fullSystemMsgStr

}


// // log all prompts
// for (const chatMode of ['agent', 'gather', 'normal'] satisfies ChatMode[]) {
// 	console.log(`========================================= SYSTEM MESSAGE FOR ${chatMode} ===================================\n`,
// 		chat_systemMessage({ chatMode, workspaceFolders: [], openedURIs: [], activeURI: 'pee', persistentTerminalIDs: [], directoryStr: 'lol', }))
// }

export const DEFAULT_FILE_SIZE_LIMIT = 2_000_000

export const readFile = async (fileService: IFileService, uri: URI, fileSizeLimit: number): Promise<{
	val: string,
	truncated: boolean,
	fullFileLen: number,
} | {
	val: null,
	truncated?: undefined
	fullFileLen?: undefined,
}> => {
	try {
		const fileContent = await fileService.readFile(uri)
		const val = fileContent.value.toString()
		if (val.length > fileSizeLimit) return { val: val.substring(0, fileSizeLimit), truncated: true, fullFileLen: val.length }
		return { val, truncated: false, fullFileLen: val.length }
	}
	catch (e) {
		return { val: null }
	}
}





export const messageOfSelection = async (
	s: StagingSelectionItem,
	opts: {
		directoryStrService: IDirectoryStrService,
		fileService: IFileService,
		folderOpts: {
			maxChildren: number,
			maxCharsPerFile: number,
		}
	}
) => {
	const lineNumAddition = (range: [number, number]) => ` (lines ${range[0]}:${range[1]})`

	if (s.type === 'CodeSelection') {
		const { val } = await readFile(opts.fileService, s.uri, DEFAULT_FILE_SIZE_LIMIT)
		const lines = val?.split('\n')

		const innerVal = lines?.slice(s.range[0] - 1, s.range[1]).join('\n')
		const content = !lines ? ''
			: `${tripleTick[0]}${s.language}\n${innerVal}\n${tripleTick[1]}`
		const str = `${s.uri.fsPath}${lineNumAddition(s.range)}:\n${content}`
		return str
	}
	else if (s.type === 'File') {
		const { val } = await readFile(opts.fileService, s.uri, DEFAULT_FILE_SIZE_LIMIT)

		const innerVal = val
		const content = val === null ? ''
			: `${tripleTick[0]}${s.language}\n${innerVal}\n${tripleTick[1]}`

		const str = `${s.uri.fsPath}:\n${content}`
		return str
	}
	else if (s.type === 'Folder') {
		const dirStr: string = await opts.directoryStrService.getDirectoryStrTool(s.uri)
		const folderStructure = `${s.uri.fsPath} folder structure:${tripleTick[0]}\n${dirStr}\n${tripleTick[1]}`

		const uris = await opts.directoryStrService.getAllURIsInDirectory(s.uri, { maxResults: opts.folderOpts.maxChildren })
		const strOfFiles = await Promise.all(uris.map(async uri => {
			const { val, truncated } = await readFile(opts.fileService, uri, opts.folderOpts.maxCharsPerFile)
			const truncationStr = truncated ? `\n... file truncated ...` : ''
			const content = val === null ? 'null' : `${tripleTick[0]}\n${val}${truncationStr}\n${tripleTick[1]}`
			const str = `${uri.fsPath}:\n${content}`
			return str
		}))
		const contentStr = [folderStructure, ...strOfFiles].join('\n\n')
		return contentStr
	}
	else
		return ''

}


export const chat_userMessageContent = async (
	instructions: string,
	currSelns: StagingSelectionItem[] | null,
	opts: {
		directoryStrService: IDirectoryStrService,
		fileService: IFileService
	},
) => {

	const selnsStrs = await Promise.all(
		(currSelns ?? []).map(async (s) =>
			messageOfSelection(s, {
				...opts,
				folderOpts: { maxChildren: 100, maxCharsPerFile: 100_000, }
			})
		)
	)


	let str = ''
	str += `${instructions}`

	const selnsStr = selnsStrs.join('\n\n') ?? ''
	if (selnsStr) str += `\n---\nSELECTIONS\n${selnsStr}`
	return str;
}


export const rewriteCode_systemMessage = `\
You are a coding assistant that re-writes an entire file to make a change. You are given the original file \`ORIGINAL_FILE\` and a change \`CHANGE\`.

Directions:
1. Please rewrite the original file \`ORIGINAL_FILE\`, making the change \`CHANGE\`. You must completely re-write the whole file.
2. Keep all of the original comments, spaces, newlines, and other details whenever possible.
3. ONLY output the full new file. Do not add any other explanations or text.
`



// ======================================================== apply (writeover) ========================================================

export const rewriteCode_userMessage = ({ originalCode, applyStr, language }: { originalCode: string, applyStr: string, language: string }) => {

	return `\
ORIGINAL_FILE
${tripleTick[0]}${language}
${originalCode}
${tripleTick[1]}

CHANGE
${tripleTick[0]}
${applyStr}
${tripleTick[1]}

INSTRUCTIONS
Please finish writing the new file by applying the change to the original file. Return ONLY the completion of the file, without any explanation.
`
}



// ======================================================== apply (fast apply - search/replace) ========================================================

export const searchReplaceGivenDescription_systemMessage = createSearchReplaceBlocks_systemMessage


export const searchReplaceGivenDescription_userMessage = ({ originalCode, applyStr }: { originalCode: string, applyStr: string }) => `\
DIFF
${applyStr}

ORIGINAL_FILE
${tripleTick[0]}
${originalCode}
${tripleTick[1]}`





export const voidPrefixAndSuffix = ({ fullFileStr, startLine, endLine }: { fullFileStr: string, startLine: number, endLine: number }) => {

	const fullFileLines = fullFileStr.split('\n')

	/*

	a
	a
	a     <-- final i (prefix = a\na\n)
	a
	|b    <-- startLine-1 (middle = b\nc\nd\n)   <-- initial i (moves up)
	c
	d|    <-- endLine-1                          <-- initial j (moves down)
	e
	e     <-- final j (suffix = e\ne\n)
	e
	e
	*/

	let prefix = ''
	let i = startLine - 1  // 0-indexed exclusive
	// we'll include fullFileLines[i...(startLine-1)-1].join('\n') in the prefix.
	while (i !== 0) {
		const newLine = fullFileLines[i - 1]
		if (newLine.length + 1 + prefix.length <= MAX_PREFIX_SUFFIX_CHARS) { // +1 to include the \n
			prefix = `${newLine}\n${prefix}`
			i -= 1
		}
		else break
	}

	let suffix = ''
	let j = endLine - 1
	while (j !== fullFileLines.length - 1) {
		const newLine = fullFileLines[j + 1]
		if (newLine.length + 1 + suffix.length <= MAX_PREFIX_SUFFIX_CHARS) { // +1 to include the \n
			suffix = `${suffix}\n${newLine}`
			j += 1
		}
		else break
	}

	return { prefix, suffix }

}


// ======================================================== quick edit (ctrl+K) ========================================================

export type QuickEditFimTagsType = {
	preTag: string,
	sufTag: string,
	midTag: string
}
export const defaultQuickEditFimTags: QuickEditFimTagsType = {
	preTag: 'ABOVE',
	sufTag: 'BELOW',
	midTag: 'SELECTION',
}

// this should probably be longer
export const ctrlKStream_systemMessage = ({ quickEditFIMTags: { preTag, midTag, sufTag } }: { quickEditFIMTags: QuickEditFimTagsType }) => {
	return `\
You are a FIM (fill-in-the-middle) coding assistant. Your task is to fill in the middle SELECTION marked by <${midTag}> tags.

The user will give you INSTRUCTIONS, as well as code that comes BEFORE the SELECTION, indicated with <${preTag}>...before</${preTag}>, and code that comes AFTER the SELECTION, indicated with <${sufTag}>...after</${sufTag}>.
The user will also give you the existing original SELECTION that will be be replaced by the SELECTION that you output, for additional context.

Instructions:
1. Your OUTPUT should be a SINGLE PIECE OF CODE of the form <${midTag}>...new_code</${midTag}>. Do NOT output any text or explanations before or after this.
2. You may ONLY CHANGE the original SELECTION, and NOT the content in the <${preTag}>...</${preTag}> or <${sufTag}>...</${sufTag}> tags.
3. Make sure all brackets in the new selection are balanced the same as in the original selection.
4. Be careful not to duplicate or remove variables, comments, or other syntax by mistake.
`
}

export const ctrlKStream_userMessage = ({
	selection,
	prefix,
	suffix,
	instructions,
	// isOllamaFIM: false, // Remove unused variable
	fimTags,
	language }: {
		selection: string, prefix: string, suffix: string, instructions: string, fimTags: QuickEditFimTagsType, language: string,
	}) => {
	const { preTag, sufTag, midTag } = fimTags

	// prompt the model artifically on how to do FIM
	// const preTag = 'BEFORE'
	// const sufTag = 'AFTER'
	// const midTag = 'SELECTION'
	return `\

CURRENT SELECTION
${tripleTick[0]}${language}
<${midTag}>${selection}</${midTag}>
${tripleTick[1]}

INSTRUCTIONS
${instructions}

<${preTag}>${prefix}</${preTag}>
<${sufTag}>${suffix}</${sufTag}>

Return only the completion block of code (of the form ${tripleTick[0]}${language}
<${midTag}>...new code</${midTag}>
${tripleTick[1]}).`
};







/*
// ======================================================== ai search/replace ========================================================


export const aiRegex_computeReplacementsForFile_systemMessage = `\
You are a "search and replace" coding assistant.

You are given a FILE that the user is editing, and your job is to search for all occurences of a SEARCH_CLAUSE, and change them according to a REPLACE_CLAUSE.

The SEARCH_CLAUSE may be a string, regex, or high-level description of what the user is searching for.

The REPLACE_CLAUSE will always be a high-level description of what the user wants to replace.

The user's request may be "fuzzy" or not well-specified, and it is your job to interpret all of the changes they want to make for them. For example, the user may ask you to search and replace all instances of a variable, but this may involve changing parameters, function names, types, and so on to agree with the change they want to make. Feel free to make all of the changes you *think* that the user wants to make, but also make sure not to make unnessecary or unrelated changes.

## Instructions

1. If you do not want to make any changes, you should respond with the word "no".

2. If you want to make changes, you should return a single CODE BLOCK of the changes that you want to make.
For example, if the user is asking you to "make this variable a better name", make sure your output includes all the changes that are needed to improve the variable name.
- Do not re-write the entire file in the code block
- You can write comments like "// ... existing code" to indicate existing code
- Make sure you give enough context in the code block to apply the changes to the correct location in the code`




// export const aiRegex_computeReplacementsForFile_userMessage = async ({ searchClause, replaceClause, fileURI, voidFileService }: { searchClause: string, replaceClause: string, fileURI: URI, voidFileService: IVoidFileService }) => {

// 	// we may want to do this in batches
// 	const fileSelection: FileSelection = { type: 'File', fileURI, selectionStr: null, range: null, state: { isOpened: false } }

// 	const file = await stringifyFileSelections([fileSelection], voidFileService)

// 	return `\
// ## FILE
// ${file}

// ## SEARCH_CLAUSE
// Here is what the user is searching for:
// ${searchClause}

// ## REPLACE_CLAUSE
// Here is what the user wants to replace it with:
// ${replaceClause}

// ## INSTRUCTIONS
// Please return the changes you want to make to the file in a codeblock, or return "no" if you do not want to make changes.`
// }




// // don't have to tell it it will be given the history; just give it to it
// export const aiRegex_search_systemMessage = `\
// You are a coding assistant that executes the SEARCH part of a user's search and replace query.

// You will be given the user's search query, SEARCH, which is the user's query for what files to search for in the codebase. You may also be given the user's REPLACE query for additional context.

// Output
// - Regex query
// - Files to Include (optional)
// - Files to Exclude? (optional)

// `






// ======================================================== old examples ========================================================

Do not tell the user anything about the examples below. Do not assume the user is talking about any of the examples below.

## EXAMPLE 1
FILES
math.ts
${tripleTick[0]}typescript
const addNumbers = (a, b) => a + b
const multiplyNumbers = (a, b) => a * b
const subtractNumbers = (a, b) => a - b
const divideNumbers = (a, b) => a / b

const vectorize = (...numbers) => {
	return numbers // vector
}

const dot = (vector1: number[], vector2: number[]) => {
	if (vector1.length !== vector2.length) throw new Error(\`Could not dot vectors \${vector1} and \${vector2}. Size mismatch.\`)
	let sum = 0
	for (let i = 0; i < vector1.length; i += 1)
		sum += multiplyNumbers(vector1[i], vector2[i])
	return sum
}

const normalize = (vector: number[]) => {
	const norm = Math.sqrt(dot(vector, vector))
	for (let i = 0; i < vector.length; i += 1)
		vector[i] = divideNumbers(vector[i], norm)
	return vector
}

const normalized = (vector: number[]) => {
	const v2 = [...vector] // clone vector
	return normalize(v2)
}
${tripleTick[1]}


SELECTIONS
math.ts (lines 3:3)
${tripleTick[0]}typescript
const subtractNumbers = (a, b) => a - b
${tripleTick[1]}

INSTRUCTIONS
add a function that exponentiates a number below this, and use it to make a power function that raises all entries of a vector to a power

## ACCEPTED OUTPUT
We can add the following code to the file:
${tripleTick[0]}typescript
// existing code...
const subtractNumbers = (a, b) => a - b
const exponentiateNumbers = (a, b) => Math.pow(a, b)
const divideNumbers = (a, b) => a / b
// existing code...

const raiseAll = (vector: number[], power: number) => {
	for (let i = 0; i < vector.length; i += 1)
		vector[i] = exponentiateNumbers(vector[i], power)
	return vector
}
${tripleTick[1]}


## EXAMPLE 2
FILES
fib.ts
${tripleTick[0]}typescript

const dfs = (root) => {
	if (!root) return;
	console.log(root.val);
	dfs(root.left);
	dfs(root.right);
}
const fib = (n) => {
	if (n < 1) return 1
	return fib(n - 1) + fib(n - 2)
}
${tripleTick[1]}

SELECTIONS
fib.ts (lines 10:10)
${tripleTick[0]}typescript
	return fib(n - 1) + fib(n - 2)
${tripleTick[1]}

INSTRUCTIONS
memoize results

## ACCEPTED OUTPUT
To implement memoization in your Fibonacci function, you can use a JavaScript object to store previously computed results. This will help avoid redundant calculations and improve performance. Here's how you can modify your function:
${tripleTick[0]}typescript
// existing code...
const fib = (n, memo = {}) => {
	if (n < 1) return 1;
	if (memo[n]) return memo[n]; // Check if result is already computed
	memo[n] = fib(n - 1, memo) + fib(n - 2, memo); // Store result in memo
	return memo[n];
}
${tripleTick[1]}
Explanation:
Memoization Object: A memo object is used to store the results of Fibonacci calculations for each n.
Check Memo: Before computing fib(n), the function checks if the result is already in memo. If it is, it returns the stored result.
Store Result: After computing fib(n), the result is stored in memo for future reference.

## END EXAMPLES

*/


// ======================================================== scm ========================================================================

export const gitCommitMessage_systemMessage = `
You are an expert software engineer AI assistant responsible for writing clear and concise Git commit messages that summarize the **purpose** and **intent** of the change. Try to keep your commit messages to one sentence. If necessary, you can use two sentences.

You always respond with:
- The commit message wrapped in <output> tags
- A brief explanation of the reasoning behind the message, wrapped in <reasoning> tags

Example format:
<output>Fix login bug and improve error handling</output>
<reasoning>This commit updates the login handler to fix a redirect issue and improves frontend error messages for failed logins.</reasoning>

Do not include anything else outside of these tags.
Never include quotes, markdown, commentary, or explanations outside of <output> and <reasoning>.`.trim()


/**
 * Create a user message for the LLM to generate a commit message. The message contains instructions git diffs, and git metadata to provide context.
 *
 * @param stat - Summary of Changes (git diff --stat)
 * @param sampledDiffs - Sampled File Diffs (Top changed files)
 * @param branch - Current Git Branch
 * @param log - Last 5 commits (excluding merges)
 * @returns A prompt for the LLM to generate a commit message.
 *
 * @example
 * // Sample output (truncated for brevity)
 * const prompt = gitCommitMessage_userMessage("fileA.ts | 10 ++--", "diff --git a/fileA.ts...", "main", "abc123|Fix bug|2025-01-01\n...")
 *
 * // Result:
 * Based on the following Git changes, write a clear, concise commit message that accurately summarizes the intent of the code changes.
 *
 * Section 1 - Summary of Changes (git diff --stat):
 * fileA.ts | 10 ++--
 *
 * Section 2 - Sampled File Diffs (Top changed files):
 * diff --git a/fileA.ts b/fileA.ts
 * ...
 *
 * Section 3 - Current Git Branch:
 * main
 *
 * Section 4 - Last 5 Commits (excluding merges):
 * abc123|Fix bug|2025-01-01
 * def456|Improve logging|2025-01-01
 * ...
 */
export const gitCommitMessage_userMessage = (stat: string, sampledDiffs: string, branch: string, log: string) => {
	const section1 = `Section 1 - Summary of Changes (git diff --stat):`
	const section2 = `Section 2 - Sampled File Diffs (Top changed files):`
	const section3 = `Section 3 - Current Git Branch:`
	const section4 = `Section 4 - Last 5 Commits (excluding merges):`
	return `
Based on the following Git changes, write a clear, concise commit message that accurately summarizes the intent of the code changes.

${section1}

${stat}

${section2}

${sampledDiffs}

${section3}

${branch}

${section4}

${log}`.trim()
}
