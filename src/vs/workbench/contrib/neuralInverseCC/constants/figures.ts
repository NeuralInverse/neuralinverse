// @ts-nocheck
import { env } from '../utils/env.js'

// The former is better vertically aligned, but isn't usually supported on Windows/Linux
export const BLACK_CIRCLE = env.platform === 'darwin' ? '\u23FA' : '\u25CF'
export const BULLET_OPERATOR = '\u2219'
export const TEARDROP_ASTERISK = '\u273B'
export const UP_ARROW = '\u2191' // \u2191 - used for opus 1m merge notice
export const DOWN_ARROW = '\u2193' // \u2193 - used for scroll hint
export const LIGHTNING_BOLT = '\u21AF' // \u21af - used for fast mode indicator
export const EFFORT_LOW = '\u25CB' // \u25cb - effort level: low
export const EFFORT_MEDIUM = '\u25D0' // \u25d0 - effort level: medium
export const EFFORT_HIGH = '\u25CF' // \u25cf - effort level: high
export const EFFORT_MAX = '\u25C9' // \u25c9 - effort level: max (Opus 4.6 only)

// Media/trigger status indicators
export const PLAY_ICON = '\u25b6' // \u25B6
export const PAUSE_ICON = '\u23f8' // \u23F8

// MCP subscription indicators
export const REFRESH_ARROW = '\u21bb' // \u21BB - used for resource update indicator
export const CHANNEL_ARROW = '\u2190' // \u2190 - inbound channel message indicator
export const INJECTED_ARROW = '\u2192' // \u2192 - cross-session injected message indicator
export const FORK_GLYPH = '\u2442' // \u2442 - fork directive indicator

// Review status indicators (ultrareview diamond states)
export const DIAMOND_OPEN = '\u25c7' // \u25C7 - running
export const DIAMOND_FILLED = '\u25c6' // \u25C6 - completed/failed
export const REFERENCE_MARK = '\u203b' // \u203B - komejirushi, away-summary recap marker

// Issue flag indicator
export const FLAG_ICON = '\u2691' // \u2691 - used for issue flag banner

// Blockquote indicator
export const BLOCKQUOTE_BAR = '\u258e' // \u258E - left one-quarter block, used as blockquote line prefix
export const HEAVY_HORIZONTAL = '\u2501' // \u2501 - heavy box-drawing horizontal

// Bridge status indicators
export const BRIDGE_SPINNER_FRAMES = [
  '\u00b7|\u00b7',
  '\u00b7/\u00b7',
  '\u00b7\u2014\u00b7',
  '\u00b7\\\u00b7',
]
export const BRIDGE_READY_INDICATOR = '\u00b7\u2714\ufe0e\u00b7'
export const BRIDGE_FAILED_INDICATOR = '\u00d7'
