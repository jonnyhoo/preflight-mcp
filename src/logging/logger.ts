import fs from 'node:fs/promises';
import path from 'node:path';

export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
	FATAL = 4
}

export interface LogEntry {
	timestamp: string;
	level: LogLevel;
	levelName: string;
	message: string;
	module?: string;
	function?: string;
	line?: number;
	metadata?: Record<string, any>;
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

export class StructuredLogger {
	private config: LoggerConfig;
	private logBuffer: LogEntry[] = [];
	private bufferSize = 1000;
	private flushInterval = 5000; // 5秒
	private flushTimer?: NodeJS.Timeout;

	constructor(config: Partial<LoggerConfig> = {}) {
		this.config = {
			level: LogLevel.INFO,
			output: 'both',
			maxFileSize: 10, // 10MB
			maxFiles: 5,
			enableColors: true,
			enableTimestamp: true,
			enableMetadata: true,
			enableStackTrace: true,
			format: 'text',
			...config
		};

		this.startFlushTimer();
	}

	private startFlushTimer(): void {
		this.flushTimer = setInterval(() => {
			this.flush().catch(error => {
				console.error('Failed to flush logs:', error);
			});
		}, this.flushInterval);
	}

	private async flush(): Promise<void> {
		if (this.logBuffer.length === 0) {
			return;
		}

		const entries = [...this.logBuffer];
		this.logBuffer = [];

		if (this.config.output === 'file' || this.config.output === 'both') {
			await this.writeToFile(entries);
		}

		if (this.config.output === 'console' || this.config.output === 'both') {
			this.writeToConsole(entries);
		}
	}

	private async writeToFile(entries: LogEntry[]): Promise<void> {
		if (!this.config.filePath) {
			return;
		}

		try {
			// 确保日志目录存在
			const logDir = path.dirname(this.config.filePath);
			await fs.mkdir(logDir, { recursive: true });

			// 检查文件大小，如果超过限制则轮转
			await this.rotateLogFile();

			// 写入日志条目
			const logLines = entries.map(entry => this.formatLogEntry(entry, 'json'));
			await fs.appendFile(this.config.filePath, logLines.join('\n') + '\n');
		} catch (error) {
			console.error('Failed to write logs to file:', error);
		}
	}

	private async rotateLogFile(): Promise<void> {
		if (!this.config.filePath) {
			return;
		}

		try {
			const stats = await fs.stat(this.config.filePath);
			const maxSizeBytes = (this.config.maxFileSize || 10) * 1024 * 1024;

			if (stats.size > maxSizeBytes) {
				// 轮转日志文件
				const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
				const rotatedPath = `${this.config.filePath}.${timestamp}`;
				
				await fs.rename(this.config.filePath, rotatedPath);
				
				// 清理旧日志文件
				await this.cleanupOldLogFiles();
			}
		} catch (error) {
			// 文件不存在或其他错误，忽略
		}
	}

	private async cleanupOldLogFiles(): Promise<void> {
		if (!this.config.filePath) {
			return;
		}

		try {
			const logDir = path.dirname(this.config.filePath);
			const logName = path.basename(this.config.filePath);
			const files = await fs.readdir(logDir);
			
			// 获取文件信息并排序
			const logFilesWithMtime: Array<{ name: string; path: string; mtime: Date }> = [];
			for (const file of files) {
				if (file.startsWith(logName) && file !== logName) {
					const filePath = path.join(logDir, file);
					try {
						const stats = await fs.stat(filePath);
						logFilesWithMtime.push({
							name: file,
							path: filePath,
							mtime: stats.mtime
						});
					} catch {
						// Skip files that can't be stat'd
					}
				}
			}

			// 按修改时间排序
			logFilesWithMtime.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

			// 保留最新的几个文件，删除其余的
			const maxFiles = this.config.maxFiles || 5;
			if (logFilesWithMtime.length > maxFiles) {
				const filesToDelete = logFilesWithMtime.slice(maxFiles);
				for (const file of filesToDelete) {
					try {
						await fs.unlink(file.path);
					} catch (error) {
						console.error(`Failed to delete old log file ${file.path}:`, error);
					}
				}
			}
		} catch (error) {
			console.error('Failed to cleanup old log files:', error);
		}
	}

	private writeToConsole(entries: LogEntry[]): void {
		for (const entry of entries) {
			const formatted = this.formatLogEntry(entry, 'text');
			
			if (this.config.enableColors) {
				this.writeColoredConsole(entry, formatted);
			} else {
				console.log(formatted);
			}
		}
	}

	private writeColoredConsole(entry: LogEntry, formatted: string): void {
		const colors = {
			[LogLevel.DEBUG]: '\x1b[36m', // Cyan
			[LogLevel.INFO]: '\x1b[32m',  // Green
			[LogLevel.WARN]: '\x1b[33m',  // Yellow
			[LogLevel.ERROR]: '\x1b[31m', // Red
			[LogLevel.FATAL]: '\x1b[35m'  // Magenta
		};

		const reset = '\x1b[0m';
		const color = colors[entry.level] || '';
		
		console.log(`${color}${formatted}${reset}`);
	}

	private formatLogEntry(entry: LogEntry, format: 'json' | 'text'): string {
		if (format === 'json') {
			return JSON.stringify(entry);
		}

		const parts: string[] = [];
		
		// 时间戳
		if (this.config.enableTimestamp) {
			parts.push(`[${entry.timestamp}]`);
		}
		
		// 日志级别
		parts.push(`[${entry.levelName}]`);
		
		// 模块和函数信息
		if (entry.module || entry.function) {
			const location = [entry.module, entry.function].filter(Boolean).join('.');
			parts.push(`[${location}]`);
		}
		
		// 主要消息
		parts.push(entry.message);
		
		// 元数据
		if (entry.metadata && Object.keys(entry.metadata).length > 0) {
			parts.push(`| ${JSON.stringify(entry.metadata)}`);
		}
		
		// 错误信息
		if (entry.error && this.config.enableStackTrace && entry.error.stack) {
			parts.push(`\n${entry.error.stack}`);
		}
		
		return parts.join(' ');
	}

	private createLogEntry(
		level: LogLevel,
		message: string,
		metadata?: Record<string, any>,
		error?: Error
	): LogEntry {
		const stack = new Error().stack;
		const callerLine = stack?.split('\n')[3]; // 获取调用栈的第3行
		
		let module: string | undefined;
		let func: string | undefined;
		let line: number | undefined;
		
		if (callerLine) {
			const match = callerLine.match(/at\s+(.+?)\s+\((.+?):(\d+):\d+\)/);
			if (match && match[1] && match[2] && match[3]) {
				func = match[1];
				const filePath = match[2];
				line = parseInt(match[3], 10);
				module = path.basename(filePath, '.js');
			}
		}

		return {
			timestamp: new Date().toISOString(),
			level,
			levelName: LogLevel[level],
			message,
			module,
			function: func,
			line,
			metadata,
			error: error ? {
				name: error.name,
				message: error.message,
				stack: error.stack
			} : undefined
		};
	}

	log(level: LogLevel, message: string, metadata?: Record<string, any>, error?: Error): void {
		if (level < this.config.level) {
			return;
		}

		const entry = this.createLogEntry(level, message, metadata, error);
		
		if (this.config.output === 'console' || this.config.output === 'both') {
			// 对于控制台输出，立即写入
			this.writeToConsole([entry]);
		}
		
		if (this.config.output === 'file' || this.config.output === 'both') {
			// 对于文件输出，缓冲后批量写入
			this.logBuffer.push(entry);
			
			if (this.logBuffer.length >= this.bufferSize) {
				this.flush().catch(error => {
					console.error('Failed to flush logs:', error);
				});
			}
		}
	}

	debug(message: string, metadata?: Record<string, any>): void {
		this.log(LogLevel.DEBUG, message, metadata);
	}

	info(message: string, metadata?: Record<string, any>): void {
		this.log(LogLevel.INFO, message, metadata);
	}

	warn(message: string, metadata?: Record<string, any>): void {
		this.log(LogLevel.WARN, message, metadata);
	}

	error(message: string, error?: Error, metadata?: Record<string, any>): void {
		this.log(LogLevel.ERROR, message, metadata, error);
	}

	fatal(message: string, error?: Error, metadata?: Record<string, any>): void {
		this.log(LogLevel.FATAL, message, metadata, error);
	}

	// 立即刷新缓冲区
	async flushNow(): Promise<void> {
		await this.flush();
	}

	// 更新配置
	updateConfig(config: Partial<LoggerConfig>): void {
		this.config = { ...this.config, ...config };
	}

	// 获取当前配置
	getConfig(): LoggerConfig {
		return { ...this.config };
	}

	// 关闭日志器
	async close(): Promise<void> {
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
		}
		await this.flush();
	}
}

// 默认日志器实例
export const defaultLogger = new StructuredLogger({
	level: LogLevel.INFO,
	output: 'both',
	filePath: './logs/preflight-mcp.log',
	format: 'text'
});

// 便捷函数
export const logger = {
	debug: (message: string, metadata?: Record<string, any>) => defaultLogger.debug(message, metadata),
	info: (message: string, metadata?: Record<string, any>) => defaultLogger.info(message, metadata),
	warn: (message: string, metadata?: Record<string, any>) => defaultLogger.warn(message, metadata),
	error: (message: string, error?: Error, metadata?: Record<string, any>) => defaultLogger.error(message, error, metadata),
	fatal: (message: string, error?: Error, metadata?: Record<string, any>) => defaultLogger.fatal(message, error, metadata),
	flush: () => defaultLogger.flushNow(),
	updateConfig: (config: Partial<LoggerConfig>) => defaultLogger.updateConfig(config),
	getConfig: () => defaultLogger.getConfig(),
	close: () => defaultLogger.close()
};

// 模块特定的日志器创建函数
export function createModuleLogger(moduleName: string, config?: Partial<LoggerConfig>) {
	const moduleConfig = {
		...config,
		// 可以在这里添加模块特定的配置
	};
	
	const moduleLogger = new StructuredLogger(moduleConfig);
	
	return {
		debug: (message: string, metadata?: Record<string, any>) => 
			moduleLogger.debug(message, { module: moduleName, ...metadata }),
		info: (message: string, metadata?: Record<string, any>) => 
			moduleLogger.info(message, { module: moduleName, ...metadata }),
		warn: (message: string, metadata?: Record<string, any>) => 
			moduleLogger.warn(message, { module: moduleName, ...metadata }),
		error: (message: string, error?: Error, metadata?: Record<string, any>) => 
			moduleLogger.error(message, error, { module: moduleName, ...metadata }),
		fatal: (message: string, error?: Error, metadata?: Record<string, any>) => 
			moduleLogger.fatal(message, error, { module: moduleName, ...metadata }),
		flush: () => moduleLogger.flushNow(),
		close: () => moduleLogger.close()
	};
}
