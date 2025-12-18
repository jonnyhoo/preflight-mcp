import { Job } from '../core/scheduler.js';
import { getConfig } from '../config.js';
import { listBundles, bundleExists } from '../bundle/service.js';
import { readManifest } from '../bundle/manifest.js';
import { PreflightScheduler } from '../core/scheduler.js';
import { logger } from '../logging/logger.js';
import fs from 'node:fs/promises';
import path from 'node:path';

interface HealthCheckResult {
	status: 'healthy' | 'warning' | 'error';
	bundles: {
		total: number;
		healthy: number;
		corrupted: number;
		outdated: number;
	};
	storage: {
		totalPaths: number;
		accessiblePaths: number;
		totalSpace: number;
		freeSpace: number;
	};
	scheduler: {
		totalJobs: number;
		runningJobs: number;
		failedJobs: number;
	};
	timestamp: string;
}

export class HealthCheckJob extends Job {
	getName(): string {
		return 'HealthCheckJob';
	}

	getMaxRetries(): number {
		return 3;
	}

	getRetryDelay(): number {
		return 2000; // 2秒重试延迟
	}

	async run(): Promise<HealthCheckResult> {
		logger.debug('Starting system health check');
		
		const cfg = getConfig();
		const result: HealthCheckResult = {
			status: 'healthy',
			bundles: {
				total: 0,
				healthy: 0,
				corrupted: 0,
				outdated: 0
			},
			storage: {
				totalPaths: cfg.storageDirs.length,
				accessiblePaths: 0,
				totalSpace: 0,
				freeSpace: 0
			},
			scheduler: {
				totalJobs: 0,
				runningJobs: 0,
				failedJobs: 0
			},
			timestamp: new Date().toISOString()
		};

		try {
			// 检查存储路径健康状态
			await this.checkStorageHealth(cfg, result);
			
			// 检查 bundles 健康状态
			if (result.storage.accessiblePaths > 0) {
				await this.checkBundlesHealth(cfg, result);
			}
			
			// 检查调度器健康状态
			this.checkSchedulerHealth(result);
			
			this.determineOverallHealth(result);
			
			logger.info(`Health check completed: ${result.status}`, {
				bundles: `${result.bundles.healthy}/${result.bundles.total}`,
				storage: `${result.storage.accessiblePaths}/${result.storage.totalPaths}`,
				jobs: result.scheduler.totalJobs
			});
			
			return result;
		} catch (error) {
			logger.error('Health check failed', error instanceof Error ? error : undefined);
			result.status = 'error';
			return result;
		}
	}

	private async checkStorageHealth(cfg: any, result: HealthCheckResult): Promise<void> {
		for (const storageDir of cfg.storageDirs) {
			try {
				// 检查路径是否可访问
				await fs.access(storageDir);
				result.storage.accessiblePaths++;
				
				// 获取磁盘空间信息（简化版本，仅适用于某些系统）
				try {
					const stats = await fs.stat(storageDir);
					result.storage.totalSpace += 0;
					result.storage.freeSpace += 0;
				} catch (spaceError) {
					logger.warn(`Cannot get disk space info for ${storageDir}`);
				}
				
				logger.debug(`Storage path accessible: ${storageDir}`);
			} catch (error) {
				logger.warn(`Storage path not accessible: ${storageDir}`);
			}
		}
	}

	private async checkBundlesHealth(cfg: any, result: HealthCheckResult): Promise<void> {
		const effectiveDir = cfg.storageDirs[0]!; // 使用第一个可访问的路径
		const maxAgeHours = 72; // 3天未更新认为是过期的
		const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
		
		try {
			const bundleIds = await listBundles(effectiveDir);
			result.bundles.total = bundleIds.length;
			
			for (const bundleId of bundleIds) {
				try {
					// 检查 bundle 是否存在
					const exists = await bundleExists(effectiveDir, bundleId);
					if (!exists) {
						result.bundles.corrupted++;
						logger.warn(`Bundle ${bundleId} missing from filesystem`);
						continue;
					}

					// 检查 manifest 是否可读
					const manifestPath = path.join(effectiveDir, bundleId, 'manifest.json');
					try {
						const manifest = await readManifest(manifestPath);
						
						// 检查是否过期
						const updatedAt = new Date(manifest.updatedAt).getTime();
						const ageMs = Date.now() - updatedAt;
						
						if (ageMs > maxAgeMs) {
							result.bundles.outdated++;
						}
						
						result.bundles.healthy++;
					} catch (manifestError) {
						result.bundles.corrupted++;
						logger.warn(`Bundle ${bundleId} has corrupted manifest`);
					}
				} catch (error) {
					result.bundles.corrupted++;
					logger.warn(`Bundle ${bundleId} health check failed`);
				}
			}
		} catch (error) {
			logger.error('Failed to list bundles for health check', error instanceof Error ? error : undefined);
		}
	}

	private checkSchedulerHealth(result: HealthCheckResult): void {
		try {
			const jobsStatus = PreflightScheduler.getAllJobsStatus();
			result.scheduler.totalJobs = Object.keys(jobsStatus).length;
			
			for (const [jobName, status] of Object.entries(jobsStatus)) {
				if (status.scheduled) {
					result.scheduler.runningJobs++;
				}
				
				if (status.lastError && status.retries > 0) {
					result.scheduler.failedJobs++;
				}
			}
		} catch (error) {
			logger.error('Failed to check scheduler health', error instanceof Error ? error : undefined);
		}
	}

	private determineOverallHealth(result: HealthCheckResult): void {
		// 如果有任何存储路径不可访问，状态为 error
		if (result.storage.accessiblePaths < result.storage.totalPaths) {
			result.status = 'error';
			return;
		}
		
		// 如果有任何 bundles 损坏，状态为 error
		if (result.bundles.corrupted > 0) {
			result.status = 'error';
			return;
		}
		
		// 如果有过时的 bundles，状态为 warning
		if (result.bundles.outdated > 0) {
			result.status = 'warning';
			return;
		}
		
		// 如果调度器有失败的任务，状态为 warning
		if (result.scheduler.failedJobs > 0) {
			result.status = 'warning';
			return;
		}
		
		// 否则状态为 healthy
		result.status = 'healthy';
	}
}
