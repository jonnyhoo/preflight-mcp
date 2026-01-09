import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { logger } from '../logging/logger.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);
const deflate = promisify(zlib.deflate);
const inflate = promisify(zlib.inflate);

export type CompressionType = 'none' | 'gzip' | 'br' | 'deflate';

export interface CompressionOptions {
	type: CompressionType;
	level?: number; // 1-9 for gzip/deflate, 1-11 for brotli
	threshold?: number; // Minimum size in bytes to compress
}

export interface CompressionResult {
	compressed: boolean;
	originalSize: number;
	compressedSize: number;
	compressionRatio: number;
	type: CompressionType;
	data: Buffer;
}

export class CompressionManager {
	private defaultOptions: CompressionOptions = {
		type: 'gzip',
		level: 6,
		threshold: 1024 // Only compress files larger than 1KB
	};

	constructor(options?: Partial<CompressionOptions>) {
		if (options) {
			this.defaultOptions = { ...this.defaultOptions, ...options };
		}
	}

	/**
	 * 压缩数据
	 */
	async compress(data: Buffer | string, options?: Partial<CompressionOptions>): Promise<CompressionResult> {
		const opts = { ...this.defaultOptions, ...options };
		const inputBuffer = typeof data === 'string' ? Buffer.from(data) : data;
		const originalSize = inputBuffer.length;

		// 如果数据太小，不压缩
		if (originalSize < (opts.threshold || 0)) {
			return {
				compressed: false,
				originalSize,
				compressedSize: originalSize,
				compressionRatio: 1,
				type: 'none',
				data: inputBuffer
			};
		}

		// 如果不需要压缩
		if (opts.type === 'none') {
			return {
				compressed: false,
				originalSize,
				compressedSize: originalSize,
				compressionRatio: 1,
				type: 'none',
				data: inputBuffer
			};
		}

		try {
			let compressedData: Buffer;
			const startTime = Date.now();

			switch (opts.type) {
				case 'gzip':
					compressedData = await gzip(inputBuffer, { level: opts.level });
					break;
				case 'br':
					compressedData = await brotliCompress(inputBuffer, {
						params: {
							[zlib.constants.BROTLI_PARAM_QUALITY]: opts.level || 6
						}
					});
					break;
				case 'deflate':
					compressedData = await deflate(inputBuffer, { level: opts.level });
					break;
				default:
					throw new Error(`Unsupported compression type: ${opts.type}`);
			}

			const compressionTime = Date.now() - startTime;
			const compressionRatio = compressedData.length / originalSize;

			if (compressionRatio >= 0.95) {
				logger.debug(`Compression ineffective`, { type: opts.type, ratio: compressionRatio.toFixed(3), timeMs: compressionTime });
				return {
					compressed: false,
					originalSize,
					compressedSize: originalSize,
					compressionRatio: 1,
					type: 'none',
					data: inputBuffer
				};
			}

			logger.debug(`Compressed data`, { type: opts.type, originalSize, compressedSize: compressedData.length, ratio: compressionRatio.toFixed(3), timeMs: compressionTime });

			return {
				compressed: true,
				originalSize,
				compressedSize: compressedData.length,
				compressionRatio,
				type: opts.type,
				data: compressedData
			};
		} catch (error) {
			logger.debug(`Failed to compress data`, { error: error instanceof Error ? error.message : String(error) });
			return {
				compressed: false,
				originalSize,
				compressedSize: originalSize,
				compressionRatio: 1,
				type: 'none',
				data: inputBuffer
			};
		}
	}

	/**
	 * 解压缩数据
	 */
	async decompress(data: Buffer, type: CompressionType): Promise<Buffer> {
		if (type === 'none') {
			return data;
		}

		try {
			const startTime = Date.now();
			let decompressedData: Buffer;

			switch (type) {
				case 'gzip':
					decompressedData = await gunzip(data);
					break;
				case 'br':
					decompressedData = await brotliDecompress(data);
					break;
				case 'deflate':
					decompressedData = await inflate(data);
					break;
				default:
					throw new Error(`Unsupported decompression type: ${type}`);
			}

			const decompressionTime = Date.now() - startTime;
			logger.debug(`Decompressed data`, { type, originalSize: data.length, decompressedSize: decompressedData.length, timeMs: decompressionTime });

			return decompressedData;
		} catch (error) {
			logger.error(`Failed to decompress data`, error instanceof Error ? error : undefined);
			throw error;
		}
	}

	/**
	 * 检测数据的压缩类型
	 */
	detectCompressionType(data: Buffer): CompressionType {
		if (data.length < 2) {
			return 'none';
		}

		// Gzip magic number: 0x1f 0x8b
		if (data[0] === 0x1f && data[1] === 0x8b) {
			return 'gzip';
		}

		// Brotli magic number varies, but common patterns
		if (data.length >= 4 && this.isBrotli(data)) {
			return 'br';
		}

		// Deflate (zlib) magic number: 0x78
		if ((data[0] === 0x78 && (data[1] === 0x01 || data[1] === 0x9c || data[1] === 0xda))) {
			return 'deflate';
		}

		return 'none';
	}

	private isBrotli(data: Buffer): boolean {
		// Brotli magic number detection
		// This is a simplified check - real detection would be more complex
		const header = data.readUInt32LE(0);
		return (header & 0xFFFFFF) === 0x226849; // Common Brotli header
	}

	/**
	 * 估算压缩效果（不实际压缩）
	 */
	estimateCompression(data: Buffer | string): Promise<{ estimatedRatio: number; recommendedType: CompressionType }> {
		const inputBuffer = typeof data === 'string' ? Buffer.from(data) : data;
		
		// 简单的启发式估算
		const entropy = this.calculateEntropy(inputBuffer);
		
		let estimatedRatio = 1;
		let recommendedType: CompressionType = 'none';

		if (inputBuffer.length < 1024) {
			// 小文件不压缩
			estimatedRatio = 1;
			recommendedType = 'none';
		} else if (entropy < 3.0) {
			// 低熵数据（如重复文本）压缩效果好
			estimatedRatio = 0.3;
			recommendedType = 'br'; // Brotli 通常对文本效果最好
		} else if (entropy < 6.0) {
			// 中等熵数据
			estimatedRatio = 0.6;
			recommendedType = 'gzip'; // Gzip 是很好的通用选择
		} else {
			// 高熵数据（如已压缩或随机数据）压缩效果差
			estimatedRatio = 0.95;
			recommendedType = 'none';
		}

		return Promise.resolve({ estimatedRatio, recommendedType });
	}

	private calculateEntropy(data: Buffer): number {
		const frequency = new Array(256).fill(0);
		
		// 计算字节频率
		for (const byte of data) {
			frequency[byte]++;
		}

		// 计算熵
		let entropy = 0;
		const length = data.length;
		
		for (const count of frequency) {
			if (count > 0) {
				const probability = count / length;
				entropy -= probability * Math.log2(probability);
			}
		}

		return entropy;
	}

	/**
	 * 获取压缩统计信息
	 */
	getCompressionStats(): {
		supportedTypes: CompressionType[];
		defaultType: CompressionType;
		defaultLevel: number;
		defaultThreshold: number;
	} {
		return {
			supportedTypes: ['none', 'gzip', 'br', 'deflate'],
			defaultType: this.defaultOptions.type,
			defaultLevel: this.defaultOptions.level || 6,
			defaultThreshold: this.defaultOptions.threshold || 1024
		};
	}
}

// 默认压缩管理器实例
export const defaultCompressionManager = new CompressionManager();

/**
 * 便捷函数：压缩数据
 */
export async function compressData(data: Buffer | string, options?: Partial<CompressionOptions>): Promise<CompressionResult> {
	return defaultCompressionManager.compress(data, options);
}

/**
 * 便捷函数：解压缩数据
 */
export async function decompressData(data: Buffer, type: CompressionType): Promise<Buffer> {
	return defaultCompressionManager.decompress(data, type);
}

/**
 * 便捷函数：检测压缩类型
 */
export function detectCompressionType(data: Buffer): CompressionType {
	return defaultCompressionManager.detectCompressionType(data);
}

/**
 * 便捷函数：估算压缩效果
 */
export async function estimateCompression(data: Buffer | string): Promise<{ estimatedRatio: number; recommendedType: CompressionType }> {
	return defaultCompressionManager.estimateCompression(data);
}
