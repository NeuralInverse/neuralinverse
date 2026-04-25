import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ISearchService, QueryType, ITextQuery } from '../../../../../services/search/common/search.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { IGRCEngineService } from '../../engine/services/grcEngineService.js';

export enum ToolPermission {
    READ_ONLY = 'read_only',
    WRITE = 'write',
    EXECUTE = 'execute' // For terminal commands
}

export interface IToolContext {
    // Context provided to the tool when executing (e.g., cancellation token)
}

export interface INanoTool {
    name: string;
    description: string;
    permission: ToolPermission;
    schema: any; // JSON Schema for arguments
    execute(args: any, context?: IToolContext): Promise<any>;
}

export class FileReadTool implements INanoTool {
    name = 'read_file';
    description = 'Read the contents of a file at the given path. Access is Read-Only.';
    permission = ToolPermission.READ_ONLY;
    schema = {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'The relative path of the file to read (e.g. "src/main.ts")'
            }
        },
        required: ['path']
    };

    constructor(
        private readonly rootUri: URI,
        @IFileService private readonly fileService: IFileService
    ) { }

    async execute(args: any): Promise<string> {
        if (!args.path) throw new Error('Path is required');

        // Security Check: prevent breaking out of root
        if (args.path.includes('..')) {
            throw new Error('Access denied: relative paths with ".." are not allowed for security.');
        }

        const targetUri = URI.joinPath(this.rootUri, args.path);

        try {
            const content = await this.fileService.readFile(targetUri);
            return content.value.toString();
        } catch (error: any) {
            return `Error reading file ${args.path}: ${error.message}`;
        }
    }
}

export class ListDirTool implements INanoTool {
    name = 'list_dir';
    description = 'List files and directories in a given path.';
    permission = ToolPermission.READ_ONLY;
    schema = {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'The relative path of the directory to list (e.g. "src/")'
            }
        },
        required: ['path']
    };

    constructor(
        private readonly rootUri: URI,
        @IFileService private readonly fileService: IFileService
    ) { }

    async execute(args: any): Promise<string> {
        const path = args.path || '.';
        if (path.includes('..')) {
            throw new Error('Access denied: relative paths with ".." are not allowed.');
        }

        const targetUri = URI.joinPath(this.rootUri, path);

        try {
            const stat = await this.fileService.resolve(targetUri);
            if (!stat.children) return 'Directory is empty.';

            return stat.children.map(c =>
                `${c.isDirectory ? '[DIR] ' : '[FILE]'} ${c.name}`
            ).join('\n');
        } catch (error: any) {
            return `Error listing directory ${path}: ${error.message}`;
        }
    }
}

export class SearchTool implements INanoTool {
    name = 'search';
    description = 'Search for a string or regex pattern in the codebase. Use this to find file paths or code snippets.';
    permission = ToolPermission.READ_ONLY;
    schema = {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'The string or regex pattern to search for.'
            },
            isRegex: {
                type: 'boolean',
                description: 'Whether the query is a regular expression. Default is false.'
            },
            includes: {
                type: 'string',
                description: 'Glob pattern for files to include (e.g. "**/*.ts").'
            }
        },
        required: ['query']
    };

    constructor(
        private readonly rootUri: URI,
        @ISearchService private readonly searchService: ISearchService
    ) { }

    async execute(args: any): Promise<string> {
        if (!args.query) throw new Error('Query is required');

        const query: ITextQuery = {
            type: QueryType.Text,
            contentPattern: {
                pattern: args.query,
                isRegExp: args.isRegex || false,
                isCaseSensitive: false,
                isWordMatch: false
            },
            folderQueries: [{
                folder: this.rootUri
            }],
            includePattern: args.includes ? { [args.includes]: true } : undefined,
            maxResults: 50 // Limit results for agent consumption
        };

        try {
            const result = await this.searchService.textSearch(query, CancellationToken.None);

            if (result.results.length === 0) {
                return 'No matches found.';
            }

            // Format results for the agent
            let output = `Found ${result.results.length} files matching "${args.query}":\n`;

            // Limit to top 10 files to avoid context overflow if many files match
            const topResults = result.results.slice(0, 10);

            for (const match of topResults) {
                // Get relative path
                const relPath = match.resource.path.replace(this.rootUri.path + '/', '');
                output += `\nFile: ${relPath}\n`;

                // Show first few matches in file
                if ('results' in match && match.results) {
                    const matches = match.results.filter((r: any) => !!r.previewText).slice(0, 3);
                    matches.forEach((m: any) => {
                        output += `  Line: ${m.previewText.trim()}\n`;
                    });
                    if (match.results.length > 3) {
                        output += `  ... and ${match.results.length - 3} more matches in this file.\n`;
                    }
                }
            }

            if (result.results.length > 10) {
                output += `\n... ${result.results.length - 10} more files found. Refine your search.`;
            }

            return output;

        } catch (error: any) {
            return `Error searching: ${error.message}`;
        }
    }
}

// \u2500\u2500\u2500 GRC Integration Tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class GetViolationsTool implements INanoTool {
    name = 'get_violations';
    description = 'Get current GRC compliance violations, optionally filtered by domain (e.g. "security", "compliance", "policy").';
    permission = ToolPermission.READ_ONLY;
    schema = {
        type: 'object',
        properties: {
            domain: { type: 'string', description: 'Optional domain filter' }
        }
    };

    constructor(private readonly grcEngine: IGRCEngineService) { }

    async execute(args: any): Promise<string> {
        const results = args.domain
            ? this.grcEngine.getResultsForDomain(args.domain)
            : this.grcEngine.getAllResults();

        if (results.length === 0) {
            return 'No violations found.';
        }

        const formatted = results.slice(0, 30).map(r => ({
            ruleId: r.ruleId,
            domain: r.domain,
            severity: r.severity,
            message: r.message,
            file: r.fileUri.path.split('/').pop(),
            line: r.line,
            isBreaking: r.isBreakingChange || false
        }));

        return JSON.stringify(formatted, null, 2);
    }
}

export class GetDomainSummaryTool implements INanoTool {
    name = 'get_domain_summary';
    description = 'Get a summary of GRC violations grouped by domain (security, compliance, etc.) with error/warning/info counts.';
    permission = ToolPermission.READ_ONLY;
    schema = { type: 'object', properties: {} };

    constructor(private readonly grcEngine: IGRCEngineService) { }

    async execute(): Promise<string> {
        const summary = this.grcEngine.getDomainSummary();
        return JSON.stringify(summary, null, 2);
    }
}

export class GetBlockingViolationsTool implements INanoTool {
    name = 'get_blocking_violations';
    description = 'Get violations that are blocking commits or deploys (critical/blocker severity or explicit blocking behavior).';
    permission = ToolPermission.READ_ONLY;
    schema = { type: 'object', properties: {} };

    constructor(private readonly grcEngine: IGRCEngineService) { }

    async execute(): Promise<string> {
        const violations = this.grcEngine.getBlockingViolations();
        if (violations.length === 0) {
            return 'No blocking violations.';
        }

        const formatted = violations.slice(0, 20).map(v => ({
            ruleId: v.ruleId,
            severity: v.severity,
            message: v.message,
            file: v.fileUri.path.split('/').pop(),
            line: v.line
        }));

        return JSON.stringify(formatted, null, 2);
    }
}

export class GetImpactChainTool implements INanoTool {
    name = 'get_impact_chain';
    description = 'Get the cross-file impact chain for a file, showing which dependent files are affected by violations in the given file.';
    permission = ToolPermission.READ_ONLY;
    schema = {
        type: 'object',
        properties: {
            file: { type: 'string', description: 'File name or path to check impact for' }
        },
        required: ['file']
    };

    constructor(private readonly grcEngine: IGRCEngineService) { }

    async execute(args: any): Promise<string> {
        if (!args.file) {
            return 'Error: file parameter is required';
        }

        // Find matching file URI from results
        const allResults = this.grcEngine.getAllResults();
        const matchingResult = allResults.find(r => r.fileUri.path.includes(args.file));

        if (!matchingResult) {
            return `No violations found for file matching "${args.file}"`;
        }

        const impact = this.grcEngine.getImpactChain(matchingResult.fileUri);
        if (!impact) {
            return 'No cross-file impact detected for this file.';
        }

        return JSON.stringify(impact, null, 2);
    }
}

export class ToolRegistry extends Disposable {
    private tools: Map<string, INanoTool> = new Map();

    constructor(
        @IFileService private readonly fileService: IFileService,
        @ISearchService private readonly searchService: ISearchService
    ) {
        super();
    }

    // Call this with the workspace root and optional GRC engine
    public registerDefaultTools(rootUri: URI, grcEngine?: IGRCEngineService) {
        this.registerTool(new FileReadTool(rootUri, this.fileService));
        this.registerTool(new ListDirTool(rootUri, this.fileService));
        this.registerTool(new SearchTool(rootUri, this.searchService));

        if (grcEngine) {
            this.registerTool(new GetViolationsTool(grcEngine));
            this.registerTool(new GetDomainSummaryTool(grcEngine));
            this.registerTool(new GetBlockingViolationsTool(grcEngine));
            this.registerTool(new GetImpactChainTool(grcEngine));
        }
    }

    public registerTool(tool: INanoTool): void {
        if (this.tools.has(tool.name)) {
            console.warn(`Tool ${tool.name} is already registered. Overwriting.`);
        }
        this.tools.set(tool.name, tool);
    }

    public getTool(name: string): INanoTool | undefined {
        return this.tools.get(name);
    }

    public getAllTools(): INanoTool[] {
        return Array.from(this.tools.values());
    }

    public getToolsSchema(): any[] {
        return this.getAllTools().map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.schema
        }));
    }
}
