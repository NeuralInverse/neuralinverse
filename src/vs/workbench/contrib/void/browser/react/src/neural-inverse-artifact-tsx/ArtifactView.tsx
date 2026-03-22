/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
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
			await navigator.clipboard.writeText(content)
			setCopied(true)
			setTimeout(() => setCopied(false), 2000)
		} catch (err) {
			console.error('Failed to copy:', err)
		}
	}

	return (
		<div className="void-artifact-view w-full h-full overflow-y-auto bg-[var(--vscode-editor-background)] text-[var(--vscode-editor-foreground)] font-sans">
			{/* Professional Header */}
			<div className="sticky top-0 z-10 bg-[var(--vscode-editor-background)] border-b border-[var(--vscode-widget-border)] backdrop-blur-sm bg-opacity-95">
				<div className="mx-auto w-full max-w-[900px] px-8 py-4 flex items-center justify-between">
					{/* Left: Document Info */}
					<div className="flex items-center gap-3">
						<div className="p-2 rounded-lg bg-[var(--vscode-button-background)] bg-opacity-10">
							<FileText size={20} className="text-[var(--vscode-button-background)]" />
						</div>
						<div>
							<h1 className="text-base font-semibold text-[var(--vscode-editor-foreground)] m-0 leading-tight">
								{uri ? uri.path.split('/').pop()?.replace('.md', '') : 'NeuralInverse Artifact'}
							</h1>
							<p className="text-xs text-[var(--vscode-descriptionForeground)] m-0 mt-0.5">
								AI-Generated Artifact
							</p>
						</div>
					</div>

					{/* Right: Action Buttons */}
					<div className="flex items-center gap-2">
						<button
							onClick={handleCopy}
							className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium
								bg-[var(--vscode-button-secondaryBackground)] text-[var(--vscode-button-secondaryForeground)]
								hover:bg-[var(--vscode-button-secondaryHoverBackground)]
								transition-colors duration-150 border-none cursor-pointer"
							title="Copy to clipboard"
						>
							{copied ? (
								<>
									<Check size={14} />
									<span>Copied</span>
								</>
							) : (
								<>
									<Copy size={14} />
									<span>Copy</span>
								</>
							)}
						</button>
						<button
							onClick={handleDownload}
							className="flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium
								bg-[var(--vscode-button-background)] text-[var(--vscode-button-foreground)]
								hover:bg-[var(--vscode-button-hoverBackground)]
								transition-colors duration-150 border-none cursor-pointer"
							title="Download as Markdown"
						>
							<Download size={14} />
							<span>Download</span>
						</button>
					</div>
				</div>
			</div>

			{/* Content Area */}
			<div className="mx-auto w-full max-w-[900px] px-8 py-12">
				<div className="
					prose prose-base max-w-none
					prose-invert
					prose-headings:text-[var(--vscode-editor-foreground)] prose-headings:font-semibold prose-headings:tracking-tight
					prose-h1:text-3xl prose-h1:mb-8 prose-h1:mt-0
					prose-h2:text-2xl prose-h2:mt-10 prose-h2:mb-5 prose-h2:border-b prose-h2:border-[var(--vscode-widget-border)] prose-h2:border-opacity-20 prose-h2:pb-3
					prose-h3:text-xl prose-h3:mt-8 prose-h3:mb-4
					prose-p:text-[var(--vscode-editor-foreground)] prose-p:opacity-90 prose-p:leading-relaxed prose-p:text-[15px] prose-p:my-4
					prose-a:text-[var(--vscode-textLink-foreground)] prose-a:no-underline hover:prose-a:underline prose-a:transition-all
					prose-code:text-[var(--vscode-textPreformat-foreground)] prose-code:bg-[var(--vscode-textCodeBlock-background)] prose-code:px-2 prose-code:py-0.5 prose-code:rounded prose-code:text-[13px] prose-code:font-mono
					prose-pre:bg-[var(--vscode-textCodeBlock-background)] prose-pre:border prose-pre:border-[var(--vscode-widget-border)] prose-pre:border-opacity-40 prose-pre:rounded-lg prose-pre:p-5 prose-pre:my-6
					prose-li:text-[var(--vscode-editor-foreground)] prose-li:opacity-90 prose-li:text-[15px] prose-li:leading-relaxed prose-li:my-1.5
					prose-ul:list-disc prose-ul:pl-6 prose-ul:my-4
					prose-ol:list-decimal prose-ol:pl-6 prose-ol:my-4
					prose-strong:text-[var(--vscode-editor-foreground)] prose-strong:font-semibold
					prose-em:text-[var(--vscode-editor-foreground)] prose-em:italic
					prose-blockquote:border-l-4 prose-blockquote:border-[var(--vscode-textLink-foreground)] prose-blockquote:pl-4 prose-blockquote:py-1 prose-blockquote:opacity-80
					prose-hr:border-[var(--vscode-widget-border)] prose-hr:border-opacity-20 prose-hr:my-8
					prose-table:border-collapse prose-table:w-full
					prose-th:bg-[var(--vscode-editor-background)] prose-th:border prose-th:border-[var(--vscode-widget-border)] prose-th:p-3 prose-th:text-left
					prose-td:border prose-td:border-[var(--vscode-widget-border)] prose-td:p-3
				">
					<ChatMarkdownRender string={content} chatMessageLocation={undefined} />
				</div>
			</div>
		</div>
	)
}
