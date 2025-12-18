import cron, { type ScheduledTask } from "node-cron";
import { logger } from '../logging/logger.js';

export abstract class Job {
	abstract run(): Promise<unknown>;
	abstract getName(): string;
	
	// 可选的失败重试配置
	getMaxRetries(): number {
		return 3;
	}
	
	getRetryDelay(): number {
		return 1000; // 1秒
	}
}

type JobConstructor = new () => Job;

interface JobTask {
	job: Job;
	task: ScheduledTask;
	cronExpression: string;
	retries: number;
	lastRun?: Date;
	lastError?: Error;
}

export class Scheduler {
	private tasks: Map<string, JobTask> = new Map();
	private isRunning = false;

	async start() {
		if (this.isRunning) {
			return;
		}
		
		this.isRunning = true;
		logger.info('Scheduler started');
	}

	build(JobClass: JobConstructor) {
		const job = new JobClass();
		const jobName = job.getName();
		
		return {
			schedule: (cronExpression: string) => {
				const task = cron.schedule(cronExpression, async () => {
					await this.executeJob(jobName, job);
				});

				const jobTask: JobTask = {
					job,
					task,
					cronExpression,
					retries: 0
				};

				this.tasks.set(jobName, jobTask);
				task.start();
				
				logger.info(`Scheduled job ${jobName}`, { cronExpression });
			},
		};
	}

	private async executeJob(jobName: string, job: Job): Promise<void> {
		const jobTask = this.tasks.get(jobName);
		if (!jobTask) {
			logger.error(`Job ${jobName} not found in task registry`);
			return;
		}

		try {
			const startTime = Date.now();
			logger.debug(`Executing job: ${jobName}`);
			
			await job.run();
			
			const duration = Date.now() - startTime;
			jobTask.lastRun = new Date();
			jobTask.retries = 0;
			jobTask.lastError = undefined;
			
			logger.info(`Job ${jobName} completed`, { durationMs: duration });
		} catch (error) {
			jobTask.lastError = error instanceof Error ? error : new Error(String(error));
			
			logger.error(`Job ${jobName} failed`, error instanceof Error ? error : undefined);
			
			const maxRetries = job.getMaxRetries();
			if (jobTask.retries < maxRetries) {
				jobTask.retries++;
				const delay = job.getRetryDelay() * Math.pow(2, jobTask.retries - 1);
				
				logger.info(`Retrying job ${jobName}`, { attempt: jobTask.retries, maxRetries, delayMs: delay });
				
				setTimeout(async () => {
					await this.executeJob(jobName, job);
				}, delay);
			} else {
				logger.error(`Job ${jobName} failed after ${maxRetries} retries`);
			}
		}
	}

	async stop() {
		if (!this.isRunning) {
			return;
		}

		for (const [name, jobTask] of this.tasks) {
			jobTask.task.stop();
			logger.debug(`Stopped job: ${name}`);
		}
		
		this.isRunning = false;
		logger.info('Scheduler stopped');
	}

	async clear() {
		for (const [name, jobTask] of this.tasks) {
			jobTask.task.destroy();
			logger.debug(`Destroyed job: ${name}`);
		}
		
		this.tasks.clear();
		logger.info('Scheduler cleared all tasks');
	}

	// 获取任务状态
	getJobStatus(name: string): {
		scheduled: boolean;
		lastRun?: Date;
		lastError?: Error;
		retries: number;
		cronExpression: string;
	} | null {
		const jobTask = this.tasks.get(name);
		if (!jobTask) {
			return null;
		}

		return {
			scheduled: jobTask.task.getStatus() === 'scheduled',
			lastRun: jobTask.lastRun,
			lastError: jobTask.lastError,
			retries: jobTask.retries,
			cronExpression: jobTask.cronExpression
		};
	}

	// 获取所有任务状态
	getAllJobsStatus(): Record<string, {
		scheduled: boolean;
		lastRun?: Date;
		lastError?: Error;
		retries: number;
		cronExpression: string;
	}> {
		const status: Record<string, any> = {};
		for (const [name] of this.tasks) {
			status[name] = this.getJobStatus(name);
		}
		return status;
	}
}

// 单例实例
export const PreflightScheduler = new Scheduler();
