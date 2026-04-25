// @ts-nocheck
/**
 * /reload-plugins \u2014 Layer-3 refresh. Applies pending plugin changes to the
 * running session. Implementation lazy-loaded.
 */
import type { Command } from '../../commands.js'

const reloadPlugins = {
  type: 'local',
  name: 'reload-plugins',
  description: 'Activate pending plugin changes in the current session',
  // SDK callers use query.reloadPlugins() (control request) instead of
  // sending this as a text prompt \u2014 that returns structured data
  // (commands, agents, plugins, mcpServers) for UI updates.
  supportsNonInteractive: false,
  load: () => import('./reload-plugins.js'),
} satisfies Command

export default reloadPlugins
