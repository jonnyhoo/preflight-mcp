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
	running: boolean;
	retryTimeout?: NodeJS.Timeout;
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

		// Start any tasks that were scheduled while the scheduler was stopped.
		for (const [name, jobTask] of this.tasks) {
			jobTask.task.start();
			logger.debug(`Started job: ${name}`);
		}

		logger.info('Scheduler started');
	}

	build(JobClass: JobConstructor) {
		const job = new JobClass();
		const jobName = job.getName();
		
		return {
				schedule: (cronExpression: string) => {
					const task = cron.createTask(cronExpression, async () => {
						await this.executeJob(jobName, job);
					});

					const jobTask: JobTask = {
						job,
						task,
						cronExpression,
						retries: 0,
						running: false
					};

					this.tasks.set(jobName, jobTask);

					if (this.isRunning) {
						task.start();
					}
					
					logger.info(`Scheduled job ${jobName}`, { cronExpression });
				},
		};
	}

	private async executeJob(jobName: string, job: Job, isRetry = false): Promise<void> {
		const jobTask = this.tasks.get(jobName);
		if (!jobTask) {
			logger.error(`Job ${jobName} not found in task registry`);
			return;
		}

		if (!this.isRunning) {
			// Scheduler stopped: don't execute or schedule retries.
			return;
		}

		// Avoid overlapping executions.
		if (jobTask.running) {
			return;
		}

		// If a retry is already scheduled, let it run instead of piling up executions from cron.
		if (!isRetry && jobTask.retryTimeout) {
			return;
		}

		jobTask.running = true;
		try {
			const startTime = Date.now();
			logger.debug(`Executing job: ${jobName}`);
			
			await job.run();
			
			const duration = Date.now() - startTime;
			jobTask.lastRun = new Date();
			jobTask.retries = 0;
			jobTask.lastError = undefined;

			if (jobTask.retryTimeout) {
				clearTimeout(jobTask.retryTimeout);
				jobTask.retryTimeout = undefined;
			}
			
			logger.info(`Job ${jobName} completed`, { durationMs: duration });
		} catch (error) {
			jobTask.lastError = error instanceof Error ? error : new Error(String(error));
			
			logger.error(`Job ${jobName} failed`, error instanceof Error ? error : undefined);
			
			if (!this.isRunning) {
				return;
			}

			const maxRetries = job.getMaxRetries();
			if (jobTask.retries < maxRetries) {
				jobTask.retries++;
				const delay = job.getRetryDelay() * Math.pow(2, jobTask.retries - 1);
				
				logger.info(`Retrying job ${jobName}`, { attempt: jobTask.retries, maxRetries, delayMs: delay });

				if (jobTask.retryTimeout) {
					clearTimeout(jobTask.retryTimeout);
				}
				jobTask.retryTimeout = setTimeout(() => {
					jobTask.retryTimeout = undefined;
					void this.executeJob(jobName, job, true);
				}, delay);
				jobTask.retryTimeout.unref?.();
			} else {
				logger.error(`Job ${jobName} failed after ${maxRetries} retries`);
			}
		} finally {
			jobTask.running = false;
		}
	}

	async stop() {
		if (!this.isRunning) {
			return;
		}

		// Mark stopped first so in-flight jobs won't schedule retries.
		this.isRunning = false;

		for (const [name, jobTask] of this.tasks) {
			jobTask.task.stop();

			if (jobTask.retryTimeout) {
				clearTimeout(jobTask.retryTimeout);
				jobTask.retryTimeout = undefined;
			}
			jobTask.running = false;

			logger.debug(`Stopped job: ${name}`);
		}
		
		logger.info('Scheduler stopped');
	}

	async clear() {
		for (const [name, jobTask] of this.tasks) {
			if (jobTask.retryTimeout) {
				clearTimeout(jobTask.retryTimeout);
				jobTask.retryTimeout = undefined;
			}
			jobTask.running = false;

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

		const status = jobTask.task.getStatus() as string;

		return {
			scheduled: !['stopped', 'destroyed'].includes(status),
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
