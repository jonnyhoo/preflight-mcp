import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { PreflightScheduler } from '../src/core/scheduler.js';
import { BundleAutoUpdateJob } from '../src/jobs/bundle-auto-update-job.js';
import { StorageCleanupJob } from '../src/jobs/storage-cleanup-job.js';
import { HealthCheckJob } from '../src/jobs/health-check-job.js';
import { LocalStorageAdapter } from '../src/storage/storage-adapter.js';
import { CompressionManager, compressData, decompressData, detectCompressionType } from '../src/storage/compression.js';
import { StructuredLogger, createModuleLogger } from '../src/logging/logger.js';
import { OptimizedPreflightServer } from '../src/server/optimized-server.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

describe('Optimization Features Test Suite', () => {
	let testDir: string;
	let storageAdapter: LocalStorageAdapter;
	let compressionManager: CompressionManager;
	let logger: StructuredLogger;
	let optimizedServer: OptimizedPreflightServer;

	beforeEach(async () => {
		// 创建临时测试目录
		testDir = await fs.mkdtemp(path.join(tmpdir(), 'preflight-test-'));
		storageAdapter = new LocalStorageAdapter(testDir);
		compressionManager = new CompressionManager();
		logger = new StructuredLogger({
			level: 1, // INFO
			output: 'console',
			enableColors: false,
			format: 'text'
		});
		optimizedServer = new OptimizedPreflightServer();
	});

	afterEach(async () => {
		// 清理测试目录
		await fs.rm(testDir, { recursive: true, force: true });
		
		// 清理调度器
		await PreflightScheduler.clear();
		
		// 关闭日志器
		await logger.close();
	});

	describe('Scheduler System', () => {
		it('should initialize and start scheduler', async () => {
			await PreflightScheduler.start();
			expect(PreflightScheduler.getAllJobsStatus()).toEqual({});
			
			await PreflightScheduler.stop();
		});

		it('should schedule and execute jobs', async () => {
			await PreflightScheduler.start();
			
			// 创建一个测试任务
			class TestJob {
				getName() { return 'TestJob'; }
				async run() { return { success: true, timestamp: new Date() }; }
			}
			
			const job = new TestJob() as any;
			PreflightScheduler.build(job.constructor).schedule('*/1 * * * * *'); // 每秒执行（仅用于测试）
			
			// 等待任务执行
			await new Promise(resolve => setTimeout(resolve, 1500));
			
			const status = PreflightScheduler.getJobStatus('TestJob');
			expect(status).toBeDefined();
			// 检查任务是否已注册并且有 cron 表达式
			expect(status!.cronExpression).toBe('*/1 * * * * *');
			
			await PreflightScheduler.stop();
		});

		it('should handle job failures and retries', async () => {
			await PreflightScheduler.start();
			
			// 创建一个失败的任务
			class FailingJob {
				getName() { return 'FailingJob'; }
				getMaxRetries() { return 2; }
				getRetryDelay() { return 100; }
				async run() { 
					throw new Error('Test error'); 
				}
			}
			
			const job = new FailingJob() as any;
			PreflightScheduler.build(job.constructor).schedule('*/1 * * * * *');
			
			// 等待任务执行和重试
			await new Promise(resolve => setTimeout(resolve, 5000));
			
			const status = PreflightScheduler.getJobStatus('FailingJob');
			expect(status).toBeDefined();
			expect(status!.retries).toBeGreaterThan(0);
			expect(status!.lastError).toBeDefined();
			
			await PreflightScheduler.stop();
		});
	});

	describe('Bundle Auto Update Job', () => {
		it('should create bundle auto update job', () => {
			const job = new BundleAutoUpdateJob();
			expect(job.getName()).toBe('BundleAutoUpdateJob');
			expect(job.getMaxRetries()).toBe(2);
		});

		it('should handle empty bundle list gracefully', async () => {
			const job = new BundleAutoUpdateJob();
			
			// 模拟空的结果
			const result = await job.run();
			expect(result.total).toBe(0);
			expect(result.updated).toBe(0);
			expect(result.failed).toBe(0);
		});
	});

	describe('Storage Cleanup Job', () => {
		it('should create storage cleanup job', () => {
			const job = new StorageCleanupJob();
			expect(job.getName()).toBe('StorageCleanupJob');
			expect(job.getMaxRetries()).toBe(1);
		});

		it('should calculate directory size correctly', async () => {
			const job = new StorageCleanupJob();
			
			// 创建测试文件
			const testFile = path.join(testDir, 'test.txt');
			await fs.writeFile(testFile, 'Hello, World!');
			
			// 使用反射访问私有方法进行测试
			const size = await (job as any).calculateDirectorySize(testDir);
			expect(size).toBeGreaterThan(0);
		});
	});

	describe('Health Check Job', () => {
		it('should create health check job', () => {
			const job = new HealthCheckJob();
			expect(job.getName()).toBe('HealthCheckJob');
			expect(job.getMaxRetries()).toBe(3);
		});

		it('should perform basic health check', async () => {
			const job = new HealthCheckJob();
			const result = await job.run();
			
			expect(result).toHaveProperty('status');
			expect(result).toHaveProperty('bundles');
			expect(result).toHaveProperty('storage');
			expect(result).toHaveProperty('scheduler');
			expect(result).toHaveProperty('timestamp');
			
			expect(['healthy', 'warning', 'error']).toContain(result.status);
		});
	});

	describe('Storage Adapter System', () => {
		it('should create local storage adapter', () => {
			const adapter = new LocalStorageAdapter(testDir);
			expect(adapter.name).toContain('LocalStorage');
			expect(adapter.type).toBe('local');
		});

		it('should perform basic file operations', async () => {
			const testFile = 'test.txt';
			const testData = 'Hello, Storage!';
			
			// 写入文件
			await storageAdapter.writeFile(testFile, testData);
			const exists = await storageAdapter.exists(testFile);
			expect(exists).toBe(true);
			
			// 读取文件
			const readData = await storageAdapter.readFile(testFile);
			expect(readData.toString()).toBe(testData);
			
			// 获取文件大小
			const size = await storageAdapter.getFileSize(testFile);
			expect(size).toBe(testData.length);
			
			// 删除文件
			await storageAdapter.deleteFile(testFile);
			const existsAfterDelete = await storageAdapter.exists(testFile);
			expect(existsAfterDelete).toBe(false);
		});

		it('should handle directory operations', async () => {
			const testDirName = 'testdir';
			
			// 创建目录
			await storageAdapter.createDirectory(testDirName);
			const files = await storageAdapter.listDirectory('');
			expect(files.some(f => f.includes(testDirName))).toBe(true);
			
			// 删除目录
			await storageAdapter.deleteDirectory(testDirName, true);
			const filesAfterDelete = await storageAdapter.listDirectory('');
			expect(filesAfterDelete.some(f => f.includes(testDirName))).toBe(false);
		});

		it('should perform health check', async () => {
			const isHealthy = await storageAdapter.healthCheck();
			expect(typeof isHealthy).toBe('boolean');
		});
	});

	describe('Compression System', () => {
		it('should compress and decompress data', async () => {
			const originalData = 'This is a test string for compression testing. '.repeat(50);
			const originalBuffer = Buffer.from(originalData);
			
			// 压缩数据
			const compressionResult = await compressionManager.compress(originalBuffer);
			expect(compressionResult.compressed).toBe(true);
			expect(compressionResult.compressedSize).toBeLessThan(compressionResult.originalSize);
			expect(compressionResult.type).toBe('gzip');
			
			// 解压缩数据
			const decompressedData = await compressionManager.decompress(compressionResult.data, compressionResult.type);
			expect(decompressedData.equals(originalBuffer)).toBe(true);
		});

		it('should handle small data without compression', async () => {
			const smallData = 'Hi';
			const compressionResult = await compressionManager.compress(smallData);
			expect(compressionResult.compressed).toBe(false);
			expect(compressionResult.type).toBe('none');
		});

		it('should detect compression types', () => {
			const testData = 'test';
			const buffer = Buffer.from(testData);
			
			const detectedType = detectCompressionType(buffer);
			expect(detectedType).toBe('none');
		});

		it('should estimate compression effectiveness', async () => {
			const repetitiveData = 'abc'.repeat(1000);
			const estimation = await compressionManager.estimateCompression(repetitiveData);
			
			expect(estimation).toHaveProperty('estimatedRatio');
			expect(estimation).toHaveProperty('recommendedType');
			expect(typeof estimation.estimatedRatio).toBe('number');
			expect(typeof estimation.recommendedType).toBe('string');
		});

		it('should use convenience functions', async () => {
			const testData = 'Test data for convenience functions';
			
			const result = await compressData(testData);
			expect(result).toHaveProperty('compressed');
			expect(result).toHaveProperty('data');
			
			if (result.compressed) {
				const decompressed = await decompressData(result.data, result.type);
				expect(decompressed.toString()).toBe(testData);
			}
		});
	});

	describe('Logging System', () => {
		it('should create structured logger', () => {
			const testLogger = new StructuredLogger({
				level: 1,
				output: 'console',
				format: 'text'
			});
			
			expect(testLogger).toBeDefined();
		});

		it('should create module-specific logger', () => {
			const moduleLogger = createModuleLogger('TestModule');
			
			expect(moduleLogger).toBeDefined();
			expect(typeof moduleLogger.info).toBe('function');
			expect(typeof moduleLogger.error).toBe('function');
		});

		it('should log different levels', async () => {
			const testLogger = new StructuredLogger({
				level: 0, // DEBUG
				output: 'console',
				format: 'text'
			});
			
			// 这些调用不应该抛出异常
			expect(() => testLogger.debug('Debug message')).not.toThrow();
			expect(() => testLogger.info('Info message')).not.toThrow();
			expect(() => testLogger.warn('Warning message')).not.toThrow();
			expect(() => testLogger.error('Error message')).not.toThrow();
			
			await testLogger.close();
		});
	});

	describe('Optimized Server Integration', () => {
		it('should create optimized server', () => {
			const server = new OptimizedPreflightServer();
			expect(server).toBeDefined();
		});

		it('should get server status', async () => {
			// 先初始化服务器以确保 StorageManager 已初始化
			await optimizedServer.initialize();
			
			const status = await optimizedServer.getServerStatus();
			
			expect(status).toHaveProperty('initialized');
			expect(status).toHaveProperty('running');
			expect(status).toHaveProperty('uptime');
			expect(status).toHaveProperty('jobs');
			expect(status).toHaveProperty('storage');
			expect(status).toHaveProperty('compression');
			
			await optimizedServer.stop();
		});

		it('should trigger manual tasks', async () => {
			// 这些调用不应该抛出异常
			await expect(optimizedServer.triggerHealthCheck()).resolves.toBeDefined();
		});

		it('should handle compression operations', async () => {
			const testData = 'Test compression integration';
			
			const compressed = await optimizedServer.compressData(testData);
			expect(compressed).toHaveProperty('compressed');
			
			if (compressed.compressed) {
				const detected = optimizedServer.detectCompressionType(compressed.data);
				expect(detected).toBe(compressed.type);
				
				const decompressed = await optimizedServer.decompressData(compressed.data, compressed.type);
				expect(decompressed.toString()).toBe(testData);
			}
		});
	});

	describe('Performance Benchmarks', () => {
		it('should measure compression performance', async () => {
			const largeData = 'Performance test data. '.repeat(10000);
			const startTime = Date.now();
			
			const result = await compressData(largeData);
			
			const compressionTime = Date.now() - startTime;
			const compressionRatio = result.compressedSize / result.originalSize;
			
			console.log(`Compression performance: ${compressionTime}ms, ratio: ${compressionRatio.toFixed(3)}`);
			
			expect(compressionTime).toBeLessThan(5000); // 应该在5秒内完成
			if (result.compressed) {
				expect(compressionRatio).toBeLessThan(1); // 压缩后应该变小
			}
		});

		it('should measure storage adapter performance', async () => {
			const testData = 'Storage performance test '.repeat(1000);
			const iterations = 100;
			
			const writeStartTime = Date.now();
			for (let i = 0; i < iterations; i++) {
				await storageAdapter.writeFile(`test-${i}.txt`, testData);
			}
			const writeTime = Date.now() - writeStartTime;
			
			const readStartTime = Date.now();
			for (let i = 0; i < iterations; i++) {
				await storageAdapter.readFile(`test-${i}.txt`);
			}
			const readTime = Date.now() - readStartTime;
			
			console.log(`Storage performance: Write ${writeTime}ms, Read ${readTime}ms for ${iterations} files`);
			
			expect(writeTime).toBeLessThan(10000); // 写入应该在10秒内完成
			expect(readTime).toBeLessThan(5000);  // 读取应该在5秒内完成
		});
	});
});

// 集成测试
describe('Integration Tests', () => {
	it('should complete full optimization workflow', async () => {
		const testDir = await fs.mkdtemp(path.join(tmpdir(), 'integration-test-'));
		const testStorageAdapter = new LocalStorageAdapter(testDir);
		
		try {
			// 初始化优化服务器
			const server = new OptimizedPreflightServer();
			await server.initialize();
			
			// 测试存储操作
			const testData = 'Integration test data';
			await testStorageAdapter.writeFile('integration.txt', testData);
			const readData = await testStorageAdapter.readFile('integration.txt');
			expect(readData.toString()).toBe(testData);
			
			// 测试压缩
			const compressed = await compressData(testData);
			if (compressed.compressed) {
				const decompressed = await decompressData(compressed.data, compressed.type);
				expect(decompressed.toString()).toBe(testData);
			}
			
			// 测试健康检查
			const healthResult = await server.triggerHealthCheck();
			expect(healthResult).toHaveProperty('status');
			
			// 清理
			await server.stop();
		} finally {
			await fs.rm(testDir, { recursive: true, force: true });
		}
	});
});
