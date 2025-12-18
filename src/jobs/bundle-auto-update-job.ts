import { Job } from '../core/scheduler.js';
import { getConfig } from '../config.js';
import { listBundles, updateBundle } from '../bundle/service.js';
import { readManifest } from '../bundle/manifest.js';

export class BundleAutoUpdateJob extends Job {
	getName(): string {
		return 'BundleAutoUpdateJob';
	}

	getMaxRetries(): number {
		return 2; // 更新任务重试次数较少
	}

	getRetryDelay(): number {
		return 5000; // 5秒重试延迟
	}

	async run(): Promise<{ updated: number; failed: number; total: number; details: Array<{ bundleId: string; success: boolean; error?: string }> }> {
		const cfg = getConfig();
		const effectiveDir = cfg.storageDirs[0]!; // 使用主存储路径
		const maxAgeHours = 24; // 24小时未更新的 bundle 需要检查
		
		try {
			const bundleIds = await listBundles(effectiveDir);
			const results: Array<{ bundleId: string; success: boolean; error?: string }> = [];
			
			let updated = 0;
			let failed = 0;

			console.log(`[BundleAutoUpdateJob] Checking ${bundleIds.length} bundles for updates`);

			for (const bundleId of bundleIds) {
				try {
					// 检查 bundle 最后更新时间
					const manifestPath = `${effectiveDir}/${bundleId}/manifest.json`;
					const manifest = await readManifest(manifestPath);
					const updatedAt = new Date(manifest.updatedAt).getTime();
					const ageMs = Date.now() - updatedAt;
					const ageHours = ageMs / (1000 * 60 * 60);

					if (ageHours > maxAgeHours) {
						console.log(`[BundleAutoUpdateJob] Bundle ${bundleId} is ${ageHours.toFixed(1)}h old, checking for updates...`);
						
						const { changed, summary } = await updateBundle(cfg, bundleId, { force: false });
						
						if (changed) {
							updated++;
							console.log(`[BundleAutoUpdateJob] Bundle ${bundleId} updated successfully`);
						} else {
							console.log(`[BundleAutoUpdateJob] Bundle ${bundleId} is up to date`);
						}
						
						results.push({ bundleId, success: true });
					} else {
						console.log(`[BundleAutoUpdateJob] Bundle ${bundleId} is recent (${ageHours.toFixed(1)}h old), skipping`);
						results.push({ bundleId, success: true });
					}
				} catch (error) {
					failed++;
					const errorMsg = error instanceof Error ? error.message : String(error);
					console.error(`[BundleAutoUpdateJob] Failed to update bundle ${bundleId}:`, errorMsg);
					results.push({ bundleId, success: false, error: errorMsg });
				}
			}

			const result = {
				updated,
				failed,
				total: bundleIds.length,
				details: results
			};

			console.log(`[BundleAutoUpdateJob] Completed: ${updated} updated, ${failed} failed, ${bundleIds.length} total`);
			return result;
		} catch (error) {
			console.error('[BundleAutoUpdateJob] Failed to list bundles:', error);
			throw error;
		}
	}
}
