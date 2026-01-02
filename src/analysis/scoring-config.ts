/**
 * Scoring Configuration Constants
 *
 * This file contains all scoring-related constants used in static analysis.
 * Centralizing these values makes them easier to tune and document.
 *
 * @module analysis/scoring-config
 */

// ============================================================================
// Interface Scoring (Go Analyzer)
// ============================================================================

/**
 * Base score for exported interfaces.
 * Starting point before applying bonuses.
 */
export const INTERFACE_BASE_SCORE = 60;

/**
 * Score bonus for interfaces with 3+ methods.
 * More methods typically indicate more extensible APIs.
 */
export const INTERFACE_METHODS_HIGH_BONUS = 15;

/**
 * Score bonus for interfaces with 1-2 methods.
 * Moderate extensibility indication.
 */
export const INTERFACE_METHODS_LOW_BONUS = 10;

/**
 * Score for empty interfaces (any type).
 * Lower than base because they're too generic.
 */
export const INTERFACE_EMPTY_SCORE = 50;

/**
 * Score bonus for interfaces embedding other interfaces.
 * Suggests composition pattern usage.
 */
export const INTERFACE_EMBEDDING_BONUS = 10;

/**
 * Score bonus for handler/processor named interfaces.
 * Common extensibility patterns.
 */
export const INTERFACE_HANDLER_BONUS = 15;

/**
 * Score bonus for plugin/provider named interfaces.
 * Strong extensibility indication.
 */
export const INTERFACE_PLUGIN_BONUS = 20;

// ============================================================================
// Type Constraint Scoring (Go Analyzer)
// ============================================================================

/**
 * Base score for type constraints.
 */
export const CONSTRAINT_BASE_SCORE = 50;

/**
 * Score bonus for constraints with 5+ members.
 * More members indicate more comprehensive type bounds.
 */
export const CONSTRAINT_MEMBERS_HIGH_BONUS = 20;

/**
 * Score bonus for constraints with 3-4 members.
 */
export const CONSTRAINT_MEMBERS_LOW_BONUS = 10;

/**
 * Member count threshold for high bonus.
 */
export const CONSTRAINT_HIGH_MEMBER_THRESHOLD = 5;

/**
 * Member count threshold for low bonus.
 */
export const CONSTRAINT_LOW_MEMBER_THRESHOLD = 3;

// ============================================================================
// General Scoring Limits
// ============================================================================

/**
 * Maximum possible score for any item.
 */
export const MAX_SCORE = 100;

/**
 * Minimum score threshold for including items in results.
 */
export const MIN_SCORE_THRESHOLD = 0;

// ============================================================================
// TypeScript/JavaScript Scoring (for future use)
// ============================================================================

/**
 * Base score for exported TypeScript interfaces.
 */
export const TS_INTERFACE_BASE_SCORE = 60;

/**
 * Base score for exported TypeScript types.
 */
export const TS_TYPE_BASE_SCORE = 50;

/**
 * Score bonus for discriminated unions.
 */
export const TS_DISCRIMINATED_UNION_BONUS = 25;

// ============================================================================
// Python Scoring (for future use)
// ============================================================================

/**
 * Base score for Python ABC classes.
 */
export const PY_ABC_BASE_SCORE = 60;

/**
 * Base score for Python Protocol classes.
 */
export const PY_PROTOCOL_BASE_SCORE = 65;

// ============================================================================
// Rust Scoring (for future use)
// ============================================================================

/**
 * Base score for Rust traits.
 */
export const RUST_TRAIT_BASE_SCORE = 60;

/**
 * Score bonus for traits with default implementations.
 */
export const RUST_TRAIT_DEFAULT_IMPL_BONUS = 10;
