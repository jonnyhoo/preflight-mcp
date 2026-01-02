/**
 * Global logger context management.
 * Enables dependency injection and test-time logger replacement.
 */

import { type ILogger, type LoggerConfig, noopLogger } from './types.js';

/**
 * Logger context holder.
 * Allows runtime replacement of the global logger instance.
 */
class LoggerContext {
  private currentLogger: ILogger = noopLogger;
  private moduleLoggers: Map<string, ILogger> = new Map();

  /**
   * Set the global logger instance.
   * Should be called once at application startup.
   */
  setLogger(logger: ILogger): void {
    this.currentLogger = logger;
  }

  /**
   * Get the current global logger instance.
   */
  getLogger(): ILogger {
    return this.currentLogger;
  }

  /**
   * Register a module-specific logger.
   */
  setModuleLogger(moduleName: string, logger: ILogger): void {
    this.moduleLoggers.set(moduleName, logger);
  }

  /**
   * Get a module-specific logger, falling back to global logger.
   */
  getModuleLogger(moduleName: string): ILogger {
    return this.moduleLoggers.get(moduleName) ?? this.currentLogger;
  }

  /**
   * Clear all module loggers (useful for testing).
   */
  clearModuleLoggers(): void {
    this.moduleLoggers.clear();
  }

  /**
   * Reset to no-op logger (useful for testing).
   */
  reset(): void {
    this.currentLogger = noopLogger;
    this.moduleLoggers.clear();
  }
}

/**
 * Global singleton logger context.
 */
export const loggerContext = new LoggerContext();

/**
 * Get the current logger instance.
 * Convenience function for accessing the global logger.
 */
export function getLogger(): ILogger {
  return loggerContext.getLogger();
}

/**
 * Get a module-specific logger.
 * Falls back to global logger if no module logger is registered.
 */
export function getModuleLogger(moduleName: string): ILogger {
  return loggerContext.getModuleLogger(moduleName);
}

/**
 * Set the global logger instance.
 * Should be called once at application startup.
 */
export function setGlobalLogger(logger: ILogger): void {
  loggerContext.setLogger(logger);
}

/**
 * Scoped logger context for testing.
 * Automatically restores the original logger after the callback completes.
 */
export async function withLogger<T>(logger: ILogger, fn: () => Promise<T>): Promise<T> {
  const original = loggerContext.getLogger();
  loggerContext.setLogger(logger);
  try {
    return await fn();
  } finally {
    loggerContext.setLogger(original);
  }
}

/**
 * Synchronous version of withLogger for non-async callbacks.
 */
export function withLoggerSync<T>(logger: ILogger, fn: () => T): T {
  const original = loggerContext.getLogger();
  loggerContext.setLogger(logger);
  try {
    return fn();
  } finally {
    loggerContext.setLogger(original);
  }
}
