// @ts-nocheck
import { initializeAnalyticsSink } from '../services/analytics/sink.js'
import { initializeErrorLogSink } from './errorLogSink.js'

/**
 * Attach error log and analytics sinks, draining any events queued before
 * attachment. Both inits are idempotent. Called from setup() for the default
 * command; other entrypoints (subcommands, daemon, bridge) call this directly
 * since they bypass setup().
 *
 * Leaf module \u2014 kept out of setup.ts to avoid the setup \u2192 commands \u2192 bridge
 * \u2192 setup import cycle.
 */
export function initSinks(): void {
  initializeErrorLogSink()
  initializeAnalyticsSink()
}
