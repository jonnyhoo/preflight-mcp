/**
 * Logger interface definitions for dependency decoupling.
 * Consumers should depend on these interfaces, not concrete implementations.
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  FATAL = 4,
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  levelName: string;
  message: string;
  module?: string;
  function?: string;
  line?: number;
  metadata?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

export interface LoggerConfig {
  level: LogLevel;
  output: 'console' | 'file' | 'both';
  filePath?: string;
  maxFileSize?: number; // MB
  maxFiles?: number;
  enableColors?: boolean;
  enableTimestamp?: boolean;
  enableMetadata?: boolean;
  enableStackTrace?: boolean;
  format: 'json' | 'text';
}

/**
 * Core logger interface.
 * All logging implementations must satisfy this contract.
 */
export interface ILogger {
  debug(message: string, metadata?: Record<string, unknown> | Error): void;
  info(message: string, metadata?: Record<string, unknown> | Error): void;
  warn(message: string, metadata?: Record<string, unknown> | Error): void;
  error(message: string, error?: Error, metadata?: Record<string, unknown>): void;
  fatal(message: string, error?: Error, metadata?: Record<string, unknown>): void;
  flush(): Promise<void>;
  updateConfig(config: Partial<LoggerConfig>): void;
  getConfig(): LoggerConfig;
  close(): Promise<void>;
  isDebugEnabled?(): boolean;
}

/**
 * Factory function type for creating module-specific loggers.
 */
export type ModuleLoggerFactory = (moduleName: string, config?: Partial<LoggerConfig>) => ILogger;

/**
 * No-op logger for testing or disabled logging scenarios.
 */
export const noopLogger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  flush: async () => {},
  updateConfig: () => {},
  getConfig: () => ({
    level: LogLevel.INFO,
    output: 'console',
    format: 'text',
  }),
  close: async () => {},
};
