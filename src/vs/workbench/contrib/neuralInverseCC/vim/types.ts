// @ts-nocheck
/**
 * Vim Mode State Machine Types
 *
 * This file defines the complete state machine for vim input handling.
 * The types ARE the documentation - reading them tells you how the system works.
 *
 * State Diagram:
 * ```
 *                              VimState
 *   \u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510
 *   \u2502  INSERT                      \u2502  NORMAL                              \u2502
 *   \u2502  (tracks insertedText)       \u2502  (CommandState machine)              \u2502
 *   \u2502                              \u2502                                      \u2502
 *   \u2502                              \u2502  idle \u2500\u2500\u252C\u2500[d/c/y]\u2500\u2500\u25BA operator        \u2502
 *   \u2502                              \u2502         \u251C\u2500[1-9]\u2500\u2500\u2500\u2500\u25BA count           \u2502
 *   \u2502                              \u2502         \u251C\u2500[fFtT]\u2500\u2500\u2500\u25BA find            \u2502
 *   \u2502                              \u2502         \u251C\u2500[g]\u2500\u2500\u2500\u2500\u2500\u2500\u25BA g               \u2502
 *   \u2502                              \u2502         \u251C\u2500[r]\u2500\u2500\u2500\u2500\u2500\u2500\u25BA replace         \u2502
 *   \u2502                              \u2502         \u2514\u2500[><]\u2500\u2500\u2500\u2500\u2500\u25BA indent          \u2502
 *   \u2502                              \u2502                                      \u2502
 *   \u2502                              \u2502  operator \u2500\u252C\u2500[motion]\u2500\u2500\u25BA execute     \u2502
 *   \u2502                              \u2502            \u251C\u2500[0-9]\u2500\u2500\u2500\u2500\u25BA operatorCount\u2502
 *   \u2502                              \u2502            \u251C\u2500[ia]\u2500\u2500\u2500\u2500\u2500\u25BA operatorTextObj
 *   \u2502                              \u2502            \u2514\u2500[fFtT]\u2500\u2500\u2500\u25BA operatorFind \u2502
 *   \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518
 * ```
 */

// ============================================================================
// Core Types
// ============================================================================

export type Operator = 'delete' | 'change' | 'yank'

export type FindType = 'f' | 'F' | 't' | 'T'

export type TextObjScope = 'inner' | 'around'

// ============================================================================
// State Machine Types
// ============================================================================

/**
 * Complete vim state. Mode determines what data is tracked.
 *
 * INSERT mode: Track text being typed (for dot-repeat)
 * NORMAL mode: Track command being parsed (state machine)
 */
export type VimState =
  | { mode: 'INSERT'; insertedText: string }
  | { mode: 'NORMAL'; command: CommandState }

/**
 * Command state machine for NORMAL mode.
 *
 * Each state knows exactly what input it's waiting for.
 * TypeScript ensures exhaustive handling in switches.
 */
export type CommandState =
  | { type: 'idle' }
  | { type: 'count'; digits: string }
  | { type: 'operator'; op: Operator; count: number }
  | { type: 'operatorCount'; op: Operator; count: number; digits: string }
  | { type: 'operatorFind'; op: Operator; count: number; find: FindType }
  | {
      type: 'operatorTextObj'
      op: Operator
      count: number
      scope: TextObjScope
    }
  | { type: 'find'; find: FindType; count: number }
  | { type: 'g'; count: number }
  | { type: 'operatorG'; op: Operator; count: number }
  | { type: 'replace'; count: number }
  | { type: 'indent'; dir: '>' | '<'; count: number }

/**
 * Persistent state that survives across commands.
 * This is the "memory" of vim - what gets recalled for repeats and pastes.
 */
export type PersistentState = {
  lastChange: RecordedChange | null
  lastFind: { type: FindType; char: string } | null
  register: string
  registerIsLinewise: boolean
}

/**
 * Recorded change for dot-repeat.
 * Captures everything needed to replay a command.
 */
export type RecordedChange =
  | { type: 'insert'; text: string }
  | {
      type: 'operator'
      op: Operator
      motion: string
      count: number
    }
  | {
      type: 'operatorTextObj'
      op: Operator
      objType: string
      scope: TextObjScope
      count: number
    }
  | {
      type: 'operatorFind'
      op: Operator
      find: FindType
      char: string
      count: number
    }
  | { type: 'replace'; char: string; count: number }
  | { type: 'x'; count: number }
  | { type: 'toggleCase'; count: number }
  | { type: 'indent'; dir: '>' | '<'; count: number }
  | { type: 'openLine'; direction: 'above' | 'below' }
  | { type: 'join'; count: number }

// ============================================================================
// Key Groups - Named constants, no magic strings
// ============================================================================

export const OPERATORS = {
  d: 'delete',
  c: 'change',
  y: 'yank',
} as const satisfies Record<string, Operator>

export function isOperatorKey(key: string): key is keyof typeof OPERATORS {
  return key in OPERATORS
}

export const SIMPLE_MOTIONS = new Set([
  'h',
  'l',
  'j',
  'k', // Basic movement
  'w',
  'b',
  'e',
  'W',
  'B',
  'E', // Word motions
  '0',
  '^',
  '$', // Line positions
])

export const FIND_KEYS = new Set(['f', 'F', 't', 'T'])

export const TEXT_OBJ_SCOPES = {
  i: 'inner',
  a: 'around',
} as const satisfies Record<string, TextObjScope>

export function isTextObjScopeKey(
  key: string,
): key is keyof typeof TEXT_OBJ_SCOPES {
  return key in TEXT_OBJ_SCOPES
}

export const TEXT_OBJ_TYPES = new Set([
  'w',
  'W', // Word/WORD
  '"',
  "'",
  '`', // Quotes
  '(',
  ')',
  'b', // Parens
  '[',
  ']', // Brackets
  '{',
  '}',
  'B', // Braces
  '<',
  '>', // Angle brackets
])

export const MAX_VIM_COUNT = 10000

// ============================================================================
// State Factories
// ============================================================================

export function createInitialVimState(): VimState {
  return { mode: 'INSERT', insertedText: '' }
}

export function createInitialPersistentState(): PersistentState {
  return {
    lastChange: null,
    lastFind: null,
    register: '',
    registerIsLinewise: false,
  }
}
