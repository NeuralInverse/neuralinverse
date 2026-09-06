/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import React, { useEffect, useState } from 'react'
import { useAccessor, useIsDark } from '../util/services.js'
import { URI } from '../../../../../../../base/common/uri.js'
import { ChatMarkdownRender } from '../markdown/ChatMarkdownRender.js'
import { Download, FileText, Copy, Check } from 'lucide-react'

export const ArtifactView = ({ uri }: { uri: URI | undefined }) => {
	const accessor = useAccessor()
	const fileService = accessor.get('IFileService')
	const isDark = useIsDark()

	const [content, setContent] = useState<string>('Loading artifact...')
	const [copied, setCopied] = useState(false)

	useEffect(() => {
		if (!uri) {
			setContent('No artifact URI provided.')
			return
		}

		let isMounted = true

		const loadFile = async () => {
			try {
				const res = await fileService.readFile(uri)
				if (isMounted) setContent(res.value.toString())
			} catch (e) {
				if (isMounted) setContent(`**Error loading artifact**: \n\n\`${e}\``)
			}
		}

		loadFile()

		// Reload content if the file changes on disk
		const disposable = fileService.onDidFilesChange(e => {
			if (e.contains(uri)) {
				loadFile()
			}
		})

		return () => {
			isMounted = false
			disposable.dispose()
		}
	}, [uri, fileService])

	const handleDownload = () => {
		if (!uri) return
		const filename = uri.path.split('/').pop() || 'artifact.md'
		const blob = new Blob([content], { type: 'text/markdown' })
		const url = URL.createObjectURL(blob)
		const a = document.createElement('a')
		a.href = url
		a.download = filename
		document.body.appendChild(a)
		a.click()
		document.body.removeChild(a)
		URL.revokeObjectURL(url)
	}

	const handleCopy = async () => {
		try {
			// navigator.clipboard is DENIED for the main window by Electron
			// (no clipboard-sanitized-write in allowedPermissionsInCore), so this
			// silently failed forever. IClipboardService routes through the native
			// host instead — same pattern as the working chat CopyButton.
			const clipboardService = accessor.get('IClipboardService') as { writeText(text: string): Promise<void> }
			await clipboardService.writeText(content)
			setCopied(true)
			setTimeout(() => setCopied(false), 2000)
		} catch (err) {
			console.error('Failed to copy:', err)
		}
	}

	return (
		<div className="void-artifact-view w-full h-full overflow-y-auto bg-[var(--vscode-editor-background)] text-[var(--vscode-editor-foreground)] font-sans">
			{/* Minimal Professional Header */}
			<div className="sticky top-0 z-10 bg-[var(--vscode-editor-background)] border-b border-[var(--vscode-panel-border)]">
				<div className="mx-auto w-full max-w-[1000px] px-12 py-3 flex items-center justify-between">
					{/* Left: Document Title */}
					<div className="flex items-center gap-2 min-w-0">
						<div className="flex items-center gap-2 min-w-0">
							<span className="text-[10px] font-mono uppercase tracking-wider text-[var(--vscode-descriptionForeground)] opacity-60 flex-shrink-0">
								Artifact
							</span>
							<span className="text-[var(--vscode-descriptionForeground)] opacity-30">·</span>
							<h1 className="text-sm font-medium text-[var(--vscode-editor-foreground)] m-0 leading-none truncate">
								{uri ? uri.path.split('/').pop()?.replace('.md', '') : 'Document'}
							</h1>
						</div>
					</div>

					{/* Right: Minimal Action Buttons */}
					<div className="flex items-center gap-1">
						<button
							onClick={handleCopy}
							className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium
								text-[var(--vscode-foreground)] opacity-60 hover:opacity-100
								hover:bg-[var(--vscode-toolbar-hoverBackground)]
								transition-all duration-100 border-none cursor-pointer rounded"
							title="Copy to clipboard"
						>
							{copied ? (
								<>
									<Check size={13} strokeWidth={2} />
									<span>Copied</span>
								</>
							) : (
								<>
									<Copy size={13} strokeWidth={1.5} />
									<span>Copy</span>
								</>
							)}
						</button>
						<button
							onClick={handleDownload}
							className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium
								text-[var(--vscode-foreground)] opacity-60 hover:opacity-100
								hover:bg-[var(--vscode-toolbar-hoverBackground)]
								transition-all duration-100 border-none cursor-pointer rounded"
							title="Download as Markdown"
						>
							<Download size={13} strokeWidth={1.5} />
							<span>Download</span>
						</button>
					</div>
				</div>
			</div>

			{/* Clean Content Area */}
			<div className="mx-auto w-full max-w-[1000px] px-12 py-8">
				<div className="
					prose prose-base max-w-none
					prose-invert
					prose-headings:text-[var(--vscode-editor-foreground)] prose-headings:font-medium prose-headings:tracking-tight
					prose-h1:text-2xl prose-h1:mb-6 prose-h1:mt-0 prose-h1:font-semibold
					prose-h2:text-lg prose-h2:mt-8 prose-h2:mb-3 prose-h2:pb-2 prose-h2:border-b prose-h2:border-[var(--vscode-panel-border)]
					prose-h3:text-base prose-h3:mt-6 prose-h3:mb-2.5 prose-h3:font-medium
					prose-h4:text-sm prose-h4:mt-5 prose-h4:mb-2 prose-h4:font-medium prose-h4:uppercase prose-h4:tracking-wide prose-h4:text-[var(--vscode-descriptionForeground)]
					prose-p:text-[var(--vscode-editor-foreground)] prose-p:leading-[1.65] prose-p:text-[14px] prose-p:my-3
					prose-a:text-[var(--vscode-textLink-foreground)] prose-a:no-underline hover:prose-a:underline prose-a:transition-all
					prose-code:text-[var(--vscode-textPreformat-foreground)] prose-code:bg-[var(--vscode-textCodeBlock-background)] prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-[13px] prose-code:font-mono prose-code:font-normal
					prose-pre:bg-[var(--vscode-textCodeBlock-background)] prose-pre:border prose-pre:border-[var(--vscode-panel-border)] prose-pre:rounded prose-pre:p-4 prose-pre:my-4
					prose-li:text-[var(--vscode-editor-foreground)] prose-li:text-[14px] prose-li:leading-[1.65] prose-li:my-1
					prose-ul:list-disc prose-ul:pl-5 prose-ul:my-3
					prose-ol:list-decimal prose-ol:pl-5 prose-ol:my-3
					prose-strong:text-[var(--vscode-editor-foreground)] prose-strong:font-semibold
					prose-em:text-[var(--vscode-editor-foreground)] prose-em:italic
					prose-blockquote:border-l-2 prose-blockquote:border-[var(--vscode-panel-border)] prose-blockquote:pl-4 prose-blockquote:italic prose-blockquote:opacity-70
					prose-hr:border-[var(--vscode-panel-border)] prose-hr:my-6
					prose-table:border-collapse prose-table:w-full prose-table:text-sm
					prose-th:bg-[var(--vscode-editor-background)] prose-th:border prose-th:border-[var(--vscode-panel-border)] prose-th:px-3 prose-th:py-2 prose-th:text-left prose-th:font-medium prose-th:text-xs prose-th:uppercase prose-th:tracking-wide
					prose-td:border prose-td:border-[var(--vscode-panel-border)] prose-td:px-3 prose-td:py-2 prose-td:text-[14px]
				">
					<ChatMarkdownRender string={content} chatMessageLocation={undefined} />
				</div>
			</div>
		</div>
	)
}
