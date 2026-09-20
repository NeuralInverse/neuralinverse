/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// The summarizer moved to common/ because it has no DOM dependency and its node test
// may not import from browser/ (code-layering). This re-export keeps the browser-side
// importers untouched: repointing them would pull two core files into the diff, and
// hygiene lints a changed file in full, which would drag an unrelated 27-warning
// cleanup of the chat tool dispatch into an unrelated commit (task Q11).
// Delete this file once those two importers are updated.
export * from '../common/episodeSummarizer.js';
