/**
 * Unified logging module exports.
 * 
 * Usage:
 * - Import { logger } for quick logging
 * - Import { getLogger, setGlobalLogger } for dependency injection
 * - Import { ILogger, LogLevel } for type-safe interfaces
 */

// Types and interfaces
export {
  LogLevel,
  type LogEntry,
  type LoggerConfig,
  type ILogger,
  type ModuleLoggerFactory,
  noopLogger,
} from './types.js';

// Context management
export {
  loggerContext,
  getLogger,
  getModuleLogger,
  setGlobalLogger,
  withLogger,
  withLoggerSync,
} from './context.js';

// Default implementation
export {
  StructuredLogger,
  defaultLogger,
  logger,
  createModuleLogger,
} from './logger.js';
