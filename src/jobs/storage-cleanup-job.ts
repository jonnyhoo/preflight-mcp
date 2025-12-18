import { Job } from '../core/scheduler.js';
import { getConfig } from '../config.js';
import { listBundles, bundleExists, clearBundleMulti } from '../bundle/service.js';
import { readManifest } from '../bundle/manifest.js';
import { logger } from '../logging/logger.js';
import fs from 'node:fs/promises';
import path from 'node:path';

export class StorageCleanupJob extends Job {
	getName(): string {
		return 'StorageCleanupJob';
	}

	getMaxRetries(): number {
		return 1; // 清理任务通常不需要重试
	}

	getRetryDelay(): number {
		return 10000; // 10秒重试延迟
	}

	async run(): Promise<{ 
		cleanedBundles: number; 
		freedSpace: number; 
		errors: string[]; 
		maxAgeDays: number;
		totalBundles: number;
	}> {
		const cfg = getConfig();
		const maxAgeDays = 30; // 30天未访问的 bundle 被认为是过期的
		const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
		
		try {
			const effectiveDir = cfg.storageDirs[0]!;
			const bundleIds = await listBundles(effectiveDir);
			
			let cleanedBundles = 0;
			let freedSpace = 0;
			const errors: string[] = [];

			logger.info(`Scanning ${bundleIds.length} bundles for cleanup`, { maxAgeDays });

			for (const bundleId of bundleIds) {
				try {
					const bundlePath = path.join(effectiveDir, bundleId);
					
					const exists = await bundleExists(effectiveDir, bundleId);
					if (!exists) {
						logger.warn(`Bundle ${bundleId} not found, skipping`);
						continue;
					}

					// 检查最后访问时间
					const manifestPath = path.join(bundlePath, 'manifest.json');
					const manifest = await readManifest(manifestPath);
					const lastAccess = new Date(manifest.updatedAt).getTime();
					const ageMs = Date.now() - lastAccess;

					if (ageMs > maxAgeMs) {
						const size = await this.calculateDirectorySize(bundlePath);
						const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
						
						logger.info(`Removing old bundle ${bundleId}`, { sizeMB: (size / 1024 / 1024).toFixed(2), ageDays });
						
						const deleted = await clearBundleMulti(cfg.storageDirs, bundleId);
						if (deleted) {
							cleanedBundles++;
							freedSpace += size;
						} else {
							errors.push(`Failed to delete bundle ${bundleId}`);
						}
					} else {
						const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
						logger.debug(`Bundle ${bundleId} is recent, keeping`, { ageDays });
					}
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : String(error);
					errors.push(`Error processing bundle ${bundleId}: ${errorMsg}`);
					logger.error(`Error processing bundle ${bundleId}`, error instanceof Error ? error : undefined);
				}
			}

			try {
				const tmpFreed = await this.cleanupTempFiles();
				freedSpace += tmpFreed;
				logger.debug(`Cleaned up temporary files`, { freedMB: (tmpFreed / 1024 / 1024).toFixed(2) });
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				errors.push(`Temp file cleanup failed: ${errorMsg}`);
			}

			const result = {
				cleanedBundles,
				freedSpace,
				errors,
				maxAgeDays,
				totalBundles: bundleIds.length
			};

			logger.info('Storage cleanup completed', { cleanedBundles, freedMB: (freedSpace / 1024 / 1024).toFixed(2), errors: errors.length });
			return result;
		} catch (error) {
			logger.error('Failed to cleanup storage', error instanceof Error ? error : undefined);
			throw error;
		}
	}

	private async calculateDirectorySize(dirPath: string): Promise<number> {
		let totalSize = 0;
		
		try {
			const entries = await fs.readdir(dirPath, { withFileTypes: true });
			
			for (const entry of entries) {
				const fullPath = path.join(dirPath, entry.name);
				
				if (entry.isDirectory()) {
					totalSize += await this.calculateDirectorySize(fullPath);
				} else if (entry.isFile()) {
					const stats = await fs.stat(fullPath);
					totalSize += stats.size;
				}
			}
		} catch (error) {
			logger.debug(`Cannot calculate size for ${dirPath}`);
		}
		
		return totalSize;
	}

	private async cleanupTempFiles(): Promise<number> {
		const cfg = getConfig();
		const tmpDir = cfg.tmpDir;
		let freedSpace = 0;

		try {
			// 检查临时目录是否存在
			try {
				await fs.access(tmpDir);
			} catch {
				// 临时目录不存在，无需清理
				return 0;
			}

			const entries = await fs.readdir(tmpDir, { withFileTypes: true });
			const now = Date.now();
			const maxAgeMs = 24 * 60 * 60 * 1000; // 24小时

			for (const entry of entries) {
				const fullPath = path.join(tmpDir, entry.name);
				
				try {
					const stats = await fs.stat(fullPath);
					const ageMs = now - stats.mtime.getTime();

					if (ageMs > maxAgeMs) {
						const size = stats.size;
						await fs.rm(fullPath, { recursive: true, force: true });
						freedSpace += size;
						logger.debug(`Removed old temp file/dir: ${entry.name}`);
					}
				} catch (error) {
					logger.debug(`Failed to remove temp file ${entry.name}`);
				}
			}
		} catch (error) {
			logger.debug('Failed to cleanup temp files');
		}

		return freedSpace;
	}
}
