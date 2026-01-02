import { PreflightScheduler } from '../core/scheduler.js';
import { BundleAutoUpdateJob } from '../jobs/bundle-auto-update-job.js';
import { StorageCleanupJob } from '../jobs/storage-cleanup-job.js';
import { HealthCheckJob } from '../jobs/health-check-job.js';
import { TmpCleanupJob } from '../jobs/tmp-cleanup-job.js';
import { getStorageManager } from '../storage/storage-adapter.js';
import { compressData, decompressData, detectCompressionType } from '../storage/compression.js';
import { logger, createModuleLogger } from '../logging/logger.js';
import { getConfig } from '../config.js';

const moduleLogger = createModuleLogger('OptimizedServer');

export class OptimizedPreflightServer {
	private isInitialized = false;
	private isRunning = false;

	async initialize(): Promise<void> {
		if (this.isInitialized) {
			moduleLogger.warn('Server already initialized');
			return;
		}

		try {
			moduleLogger.info('Initializing optimized preflight server...');

			// 初始化存储管理器
			const config = getConfig();
			const storageManager = getStorageManager(config);
			moduleLogger.info('Storage manager initialized', {
				adapters: storageManager.listAdapters().length
			});

			// 设置定时任务
			await this.setupScheduledJobs();

			// 执行初始健康检查
			await this.performInitialHealthCheck();

			this.isInitialized = true;
			moduleLogger.info('Optimized preflight server initialized successfully');
		} catch (error) {
			moduleLogger.error('Failed to initialize optimized server', error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	async start(): Promise<void> {
		if (!this.isInitialized) {
			await this.initialize();
		}

		if (this.isRunning) {
			moduleLogger.warn('Server already running');
			return;
		}

		try {
			moduleLogger.info('Starting optimized preflight server...');

			// 启动调度器
			await PreflightScheduler.start();

			this.isRunning = true;
			moduleLogger.info('Optimized preflight server started successfully');
		} catch (error) {
			moduleLogger.error('Failed to start optimized server', error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (!this.isRunning) {
			moduleLogger.warn('Server not running');
			return;
		}

		try {
			moduleLogger.info('Stopping optimized preflight server...');

			// 停止调度器
			await PreflightScheduler.stop();

			// 刷新并关闭日志
			await logger.close();

			this.isRunning = false;
			moduleLogger.info('Optimized preflight server stopped successfully');
		} catch (error) {
			moduleLogger.error('Failed to stop optimized server', error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
	}

	private async setupScheduledJobs(): Promise<void> {
		moduleLogger.info('Setting up scheduled jobs...');

		// Bundle 自动更新任务 - 每小时检查一次
		PreflightScheduler.build(BundleAutoUpdateJob).schedule('0 * * * *');
		moduleLogger.info('Bundle auto-update job scheduled (hourly)');

		// 存储清理任务 - 每天凌晨2点执行
		PreflightScheduler.build(StorageCleanupJob).schedule('0 2 * * *');
		moduleLogger.info('Storage cleanup job scheduled (daily at 2 AM)');

		// 健康检查任务 - 每30分钟执行一次
		PreflightScheduler.build(HealthCheckJob).schedule('*/30 * * * *');
		moduleLogger.info('Health check job scheduled (every 30 minutes)');

		// 临时目录清理任务 - 每6小时执行一次
		PreflightScheduler.build(TmpCleanupJob).schedule('0 */6 * * *');
		moduleLogger.info('Temporary directory cleanup job scheduled (every 6 hours)');

		moduleLogger.info('All scheduled jobs configured', {
			totalJobs: PreflightScheduler.getAllJobsStatus()
		});
	}

	private async performInitialHealthCheck(): Promise<void> {
		moduleLogger.info('Performing initial health check...');

		try {
			const healthJob = new HealthCheckJob();
			const healthResult = await healthJob.run();

			if (healthResult.status === 'error') {
				moduleLogger.warn('Initial health check revealed issues', {
					status: healthResult.status,
					bundles: healthResult.bundles,
					storage: healthResult.storage,
					scheduler: healthResult.scheduler
				});
			} else {
				moduleLogger.info('Initial health check passed', {
					status: healthResult.status,
					bundles: healthResult.bundles,
					storage: healthResult.storage,
					scheduler: healthResult.scheduler
				});
			}
		} catch (error) {
			moduleLogger.error('Initial health check failed', error instanceof Error ? error : new Error(String(error)));
		}
	}

	// 获取服务器状态
	async getServerStatus(): Promise<{
		initialized: boolean;
		running: boolean;
		uptime: number;
		jobs: any;
		storage: any;
		compression: any;
	}> {
		const storageManager = getStorageManager();
		const jobsStatus = PreflightScheduler.getAllJobsStatus();
		const adapterHealth = await storageManager.getAdapterHealth();

		return {
			initialized: this.isInitialized,
			running: this.isRunning,
			uptime: this.isRunning ? Date.now() - (this as any).startTime : 0,
			jobs: {
				total: Object.keys(jobsStatus).length,
				status: jobsStatus
			},
			storage: {
				adapters: storageManager.listAdapters(),
				health: adapterHealth
			},
			compression: {
				enabled: true,
				supportedTypes: ['none', 'gzip', 'br', 'deflate']
			}
		};
	}

	// 手动触发任务
	async triggerBundleUpdate(): Promise<any> {
		moduleLogger.info('Manually triggering bundle update job');
		const job = new BundleAutoUpdateJob();
		return await job.run();
	}

	async triggerStorageCleanup(): Promise<any> {
		moduleLogger.info('Manually triggering storage cleanup job');
		const job = new StorageCleanupJob();
		return await job.run();
	}

	async triggerHealthCheck(): Promise<any> {
		moduleLogger.info('Manually triggering health check job');
		const job = new HealthCheckJob();
		return await job.run();
	}

	// 压缩相关功能
	async compressData(data: Buffer | string, options?: any): Promise<any> {
		return await compressData(data, options);
	}

	async decompressData(data: Buffer, type: string): Promise<Buffer> {
		return await decompressData(data, type as any);
	}

	detectCompressionType(data: Buffer): string {
		return detectCompressionType(data);
	}

	// 存储相关功能
	async getStorageStats(): Promise<any> {
		const storageManager = getStorageManager();
		const adapter = storageManager.getPrimaryAdapter();
		return await adapter.getStats();
	}

	async getStorageHealth(): Promise<Record<string, boolean>> {
		const storageManager = getStorageManager();
		return await storageManager.getAdapterHealth();
	}

	// 日志相关功能
	updateLoggerConfig(config: any): void {
		logger.updateConfig(config);
		moduleLogger.info('Logger configuration updated', config);
	}

	async getLogStats(): Promise<any> {
		const config = logger.getConfig();
		return {
			...config,
			bufferSize: 1000, // 示例值
			lastFlush: new Date().toISOString()
		};
	}

	async flushLogs(): Promise<void> {
		await logger.flush();
		moduleLogger.debug('Logs flushed manually');
	}
}

// 单例实例
let optimizedServer: OptimizedPreflightServer | null = null;

export function getOptimizedServer(): OptimizedPreflightServer {
	if (!optimizedServer) {
		optimizedServer = new OptimizedPreflightServer();
	}
	return optimizedServer;
}

export function resetOptimizedServer(): void {
	optimizedServer = null;
}

// 导出便捷函数
export async function initializeOptimizedServer(): Promise<void> {
	const server = getOptimizedServer();
	await server.initialize();
}

export async function startOptimizedServer(): Promise<void> {
	const server = getOptimizedServer();
	await server.start();
}

export async function stopOptimizedServer(): Promise<void> {
	const server = getOptimizedServer();
	await server.stop();
}

// 服务器启动时的初始化流程
export async function bootstrapOptimizedServer(): Promise<void> {
	try {
		logger.info('Bootstrapping optimized preflight server...');
		
		const server = getOptimizedServer();
		(server as any).startTime = Date.now(); // 记录启动时间
		
		await server.initialize();
		await server.start();
		
		logger.info('Optimized preflight server bootstrap completed');
		
		// 设置优雅关闭
		process.on('SIGINT', async () => {
			logger.info('Received SIGINT, shutting down gracefully...');
			await server.stop();
			try { await logger.close(); } catch { /* ignore */ }
			process.exit(0);
		});
		
		process.on('SIGTERM', async () => {
			logger.info('Received SIGTERM, shutting down gracefully...');
			await server.stop();
			try { await logger.close(); } catch { /* ignore */ }
			process.exit(0);
		});
		
		// 处理未捕获的异常
		process.on('uncaughtException', async (error) => {
			logger.fatal('Uncaught exception', error);
			await server.stop();
			try { await logger.close(); } catch { /* ignore */ }
			process.exit(1);
		});
		
		process.on('unhandledRejection', async (reason, promise) => {
			logger.fatal('Unhandled rejection', new Error(String(reason)), { promise });
			await server.stop();
			try { await logger.close(); } catch { /* ignore */ }
			process.exit(1);
		});
		
	} catch (error) {
		logger.fatal('Failed to bootstrap optimized server', error instanceof Error ? error : new Error(String(error)));
		process.exit(1);
	}
}
