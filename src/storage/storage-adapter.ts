import { PreflightConfig } from '../config.js';
import fs from 'node:fs/promises';
import nodePath from 'node:path';

export interface StorageStats {
	totalSize: number;
	freeSpace: number;
	usedSpace: number;
	accessible: boolean;
}

export interface StorageAdapter {
	name: string;
	type: 'local' | 's3' | 'gcs' | 'azure' | 'custom';
	
	// 基础操作
	exists(path: string): Promise<boolean>;
	readFile(path: string): Promise<Buffer>;
	writeFile(path: string, data: Buffer | string): Promise<void>;
	deleteFile(path: string): Promise<void>;
	
	// 目录操作
	createDirectory(path: string): Promise<void>;
	deleteDirectory(path: string, recursive?: boolean): Promise<void>;
	listDirectory(path: string): Promise<string[]>;
	
	// 统计信息
	getStats(path?: string): Promise<StorageStats>;
	getFileSize(path: string): Promise<number>;
	
	// 批量操作
	copyFile(source: string, destination: string): Promise<void>;
	moveFile(source: string, destination: string): Promise<void>;
	
	// 健康检查
	healthCheck(): Promise<boolean>;
}

export class LocalStorageAdapter implements StorageAdapter {
	name: string;
	type: 'local' | 's3' | 'gcs' | 'azure' | 'custom' = 'local';
	private basePath: string;

	constructor(basePath: string) {
		this.name = `LocalStorage(${basePath})`;
		this.basePath = basePath;
	}

	private getFullPath(filePath: string): string {
		// 确保路径是相对于基础路径的
		if (filePath.startsWith(this.basePath)) {
			return filePath;
		}
		return nodePath.join(this.basePath, filePath);
	}

	async exists(filePath: string): Promise<boolean> {
		try {
			await fs.access(this.getFullPath(filePath));
			return true;
		} catch {
			return false;
		}
	}

	async readFile(filePath: string): Promise<Buffer> {
		return await fs.readFile(this.getFullPath(filePath));
	}

	async writeFile(filePath: string, data: Buffer | string): Promise<void> {
		const fullPath = this.getFullPath(filePath);
		
		// 确保目录存在
		const dir = nodePath.dirname(fullPath);
		await this.createDirectory(dir);
		
		await fs.writeFile(fullPath, data);
	}

	async deleteFile(filePath: string): Promise<void> {
		await fs.unlink(this.getFullPath(filePath));
	}

	async createDirectory(dirPath: string): Promise<void> {
		await fs.mkdir(this.getFullPath(dirPath), { recursive: true });
	}

	async deleteDirectory(dirPath: string, recursive = false): Promise<void> {
		const fullPath = this.getFullPath(dirPath);
		
		if (recursive) {
			await fs.rm(fullPath, { recursive: true, force: true });
		} else {
			await fs.rmdir(fullPath);
		}
	}

	async listDirectory(dirPath: string): Promise<string[]> {
		try {
			const entries = await fs.readdir(this.getFullPath(dirPath), { withFileTypes: true });
			return entries
				.map((entry: { name: string }) => nodePath.join(dirPath, entry.name))
				.filter((name: string) => !name.endsWith('/.'));
		} catch {
			return [];
		}
	}

	async getStats(filePath?: string): Promise<StorageStats> {
		const checkPath = filePath ? this.getFullPath(filePath) : this.basePath;
		
		try {
			const stats = await fs.stat(checkPath);
			
			return {
				totalSize: 0, // 需要系统特定的实现
				freeSpace: 0, // 需要系统特定的实现
				usedSpace: stats.size,
				accessible: true
			};
		} catch {
			return {
				totalSize: 0,
				freeSpace: 0,
				usedSpace: 0,
				accessible: false
			};
		}
	}

	async getFileSize(filePath: string): Promise<number> {
		const stats = await fs.stat(this.getFullPath(filePath));
		return stats.size;
	}

	async copyFile(source: string, destination: string): Promise<void> {
		await fs.copyFile(this.getFullPath(source), this.getFullPath(destination));
	}

	async moveFile(source: string, destination: string): Promise<void> {
		await fs.rename(this.getFullPath(source), this.getFullPath(destination));
	}

	async healthCheck(): Promise<boolean> {
		try {
			await this.exists('');
			return true;
		} catch {
			return false;
		}
	}
}

export class S3StorageAdapter implements StorageAdapter {
	name: string;
	type: 'local' | 's3' | 'gcs' | 'azure' | 'custom' = 's3';
	private bucket: string;
	private region: string;
	private accessKeyId?: string;
	private secretAccessKey?: string;
	private endpoint?: string;

	constructor(config: {
		bucket: string;
		region: string;
		accessKeyId?: string;
		secretAccessKey?: string;
		endpoint?: string;
	}) {
		this.name = `S3Storage(${config.bucket})`;
		this.bucket = config.bucket;
		this.region = config.region;
		this.accessKeyId = config.accessKeyId;
		this.secretAccessKey = config.secretAccessKey;
		this.endpoint = config.endpoint;
	}

	private async getS3Client(): Promise<any> {
		// 这里需要导入 AWS SDK
		// 为了简化，我们返回一个模拟实现
		throw new Error('S3StorageAdapter requires AWS SDK to be installed');
	}

	async exists(path: string): Promise<boolean> {
		try {
			const s3 = await this.getS3Client();
			await s3.headObject({ Bucket: this.bucket, Key: path });
			return true;
		} catch {
			return false;
		}
	}

	async readFile(path: string): Promise<Buffer> {
		const s3 = await this.getS3Client();
		const result = await s3.getObject({ Bucket: this.bucket, Key: path });
		return result.Body;
	}

	async writeFile(path: string, data: Buffer | string): Promise<void> {
		const s3 = await this.getS3Client();
		await s3.putObject({
			Bucket: this.bucket,
			Key: path,
			Body: data
		});
	}

	async deleteFile(path: string): Promise<void> {
		const s3 = await this.getS3Client();
		await s3.deleteObject({ Bucket: this.bucket, Key: path });
	}

	async createDirectory(path: string): Promise<void> {
		// S3 不需要显式创建目录，但我们可以创建一个占位符对象
		const dirPath = path.endsWith('/') ? path : `${path}/`;
		await this.writeFile(dirPath, '');
	}

	async deleteDirectory(path: string, recursive = false): Promise<void> {
		if (recursive) {
			const s3 = await this.getS3Client();
			const objects = await s3.listObjectsV2({
				Bucket: this.bucket,
				Prefix: path.endsWith('/') ? path : `${path}/`
			});
			
			if (objects.Contents && objects.Contents.length > 0) {
				await s3.deleteObjects({
					Bucket: this.bucket,
					Delete: {
						Objects: objects.Contents.map((obj: { Key?: string }) => ({ Key: obj.Key! }))
					}
				});
			}
		} else {
			await this.deleteFile(path.endsWith('/') ? path : `${path}/`);
		}
	}

	async listDirectory(path: string): Promise<string[]> {
		const s3 = await this.getS3Client();
		const prefix = path.endsWith('/') ? path : `${path}/`;
		const result = await s3.listObjectsV2({
			Bucket: this.bucket,
			Prefix: prefix,
			Delimiter: '/'
		});
		
		const files: string[] = [];
		
		// 添加文件
		if (result.Contents) {
			files.push(...result.Contents.map((obj: { Key?: string }) => obj.Key!).filter((key: string) => key !== prefix));
		}
		
		// 添加子目录
		if (result.CommonPrefixes) {
			files.push(...result.CommonPrefixes.map((p: { Prefix?: string }) => p.Prefix!.slice(0, -1)));
		}
		
		return files;
	}

	async getStats(path?: string): Promise<StorageStats> {
		// S3 的存储统计需要通过 CloudWatch 或其他方式获取
		return {
			totalSize: 0,
			freeSpace: 0,
			usedSpace: 0,
			accessible: await this.healthCheck()
		};
	}

	async getFileSize(path: string): Promise<number> {
		const s3 = await this.getS3Client();
		const result = await s3.headObject({ Bucket: this.bucket, Key: path });
		return result.ContentLength || 0;
	}

	async copyFile(source: string, destination: string): Promise<void> {
		const s3 = await this.getS3Client();
		await s3.copyObject({
			Bucket: this.bucket,
			Key: destination,
			CopySource: `${this.bucket}/${source}`
		});
	}

	async moveFile(source: string, destination: string): Promise<void> {
		await this.copyFile(source, destination);
		await this.deleteFile(source);
	}

	async healthCheck(): Promise<boolean> {
		try {
			const s3 = await this.getS3Client();
			await s3.headBucket({ Bucket: this.bucket });
			return true;
		} catch {
			return false;
		}
	}
}

export class StorageManager {
	private adapters: Map<string, StorageAdapter> = new Map();
	private primaryAdapter: string = 'default';

	constructor(config: PreflightConfig) {
		this.initializeAdapters(config);
	}

	private initializeAdapters(config: PreflightConfig): void {
		// 初始化默认本地存储适配器
		if (config.storageDirs && config.storageDirs.length > 0) {
			const localAdapter = new LocalStorageAdapter(config.storageDirs[0]!);
			this.adapters.set('default', localAdapter);
			this.primaryAdapter = 'default';
		}

		// 可以在这里初始化其他存储适配器
		// 例如：S3、GCS、Azure Blob Storage 等
	}

	getAdapter(name = 'default'): StorageAdapter {
		const adapter = this.adapters.get(name);
		if (!adapter) {
			throw new Error(`Storage adapter '${name}' not found`);
		}
		return adapter;
	}

	addAdapter(name: string, adapter: StorageAdapter): void {
		this.adapters.set(name, adapter);
	}

	removeAdapter(name: string): boolean {
		if (name === this.primaryAdapter) {
			throw new Error('Cannot remove primary storage adapter');
		}
		return this.adapters.delete(name);
	}

	setPrimaryAdapter(name: string): void {
		if (!this.adapters.has(name)) {
			throw new Error(`Storage adapter '${name}' not found`);
		}
		this.primaryAdapter = name;
	}

	getPrimaryAdapter(): StorageAdapter {
		return this.getAdapter(this.primaryAdapter);
	}

	async getAdapterHealth(): Promise<Record<string, boolean>> {
		const health: Record<string, boolean> = {};
		
		for (const [name, adapter] of this.adapters) {
			try {
				health[name] = await adapter.healthCheck();
			} catch {
				health[name] = false;
			}
		}
		
		return health;
	}

	listAdapters(): Array<{ name: string; type: string; isPrimary: boolean }> {
		return Array.from(this.adapters.entries()).map(([name, adapter]) => ({
			name,
			type: adapter.type,
			isPrimary: name === this.primaryAdapter
		}));
	}
}

// 单例实例
let storageManager: StorageManager | null = null;

export function getStorageManager(config?: PreflightConfig): StorageManager {
	if (!storageManager) {
		if (!config) {
			throw new Error('StorageManager requires config for initialization');
		}
		storageManager = new StorageManager(config);
	}
	return storageManager;
}

export function resetStorageManager(): void {
	storageManager = null;
}
