/**
 * Legacy treeSitter module shim.
 *
 * Some tests and external users import from src/ast/treeSitter.js.
 * Keep this file as a thin re-export to preserve that path.
 */

export * from './index.js';
