/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { useIsDark } from '../util/services.js';
// import { SidebarThreadSelector } from './SidebarThreadSelector.js';
// import { SidebarChat } from './SidebarChat.js';

import '../styles.css'
import { SidebarChat } from './SidebarChat.js';
import ErrorBoundary from './ErrorBoundary.js';

export const Sidebar = ({ className }: { className: string }) => {

	const isDark = useIsDark()
	return <div
		className={`@@void-scope ${isDark ? 'dark' : ''}`}
		style={{ width: '100%', height: '100%' }}
	>
		<div
			// default background + text styles for sidebar
			className={`
				w-full h-full
				bg-void-bg-2
				text-void-fg-1
				flex flex-col
			`}
		>

			<div className={`w-full flex-1 min-h-0`}>
				<ErrorBoundary>
					<SidebarChat />
				</ErrorBoundary>
			</div>

			{/* Enterprise hint — minimal, non-intrusive */}
			<a
				href='https://neuralinverse.com/enterprise'
				target='_blank'
				rel='noreferrer'
				className='flex items-center justify-center gap-1 py-1.5 border-t border-void-border-1 text-void-fg-3 hover:text-void-fg-2 transition-colors'
				style={{ fontSize: 11, textDecoration: 'none', cursor: 'pointer', userSelect: 'none' }}
			>
				<span style={{ color: '#5eaed6' }}>✦</span>
				<span>Neural Inverse Enterprise</span>
				<span style={{ fontSize: 9, opacity: 0.6 }}>→</span>
			</a>
		</div>
	</div>


}

