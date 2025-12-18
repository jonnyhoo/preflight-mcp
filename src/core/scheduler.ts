import cron, { type ScheduledTask } from "node-cron";

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
		console.log("[PreflightScheduler] started");
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
				
				console.log(`[PreflightScheduler] Scheduled job ${jobName} with cron: ${cronExpression}`);
			},
		};
	}

	private async executeJob(jobName: string, job: Job): Promise<void> {
		const jobTask = this.tasks.get(jobName);
		if (!jobTask) {
			console.error(`[PreflightScheduler] Job ${jobName} not found in task registry`);
			return;
		}

		try {
			const startTime = Date.now();
			console.log(`[PreflightScheduler] Executing job: ${jobName}`);
			
			await job.run();
			
			const duration = Date.now() - startTime;
			jobTask.lastRun = new Date();
			jobTask.retries = 0; // 重置重试计数
			jobTask.lastError = undefined;
			
			console.log(`[PreflightScheduler] Job ${jobName} completed successfully in ${duration}ms`);
		} catch (error) {
			jobTask.lastError = error instanceof Error ? error : new Error(String(error));
			
			console.error(`[PreflightScheduler] Job ${jobName} failed:`, error);
			
			// 重试逻辑
			const maxRetries = job.getMaxRetries();
			if (jobTask.retries < maxRetries) {
				jobTask.retries++;
				const delay = job.getRetryDelay() * Math.pow(2, jobTask.retries - 1); // 指数退避
				
				console.log(`[PreflightScheduler] Retrying job ${jobName} (${jobTask.retries}/${maxRetries}) in ${delay}ms`);
				
				setTimeout(async () => {
					await this.executeJob(jobName, job);
				}, delay);
			} else {
				console.error(`[PreflightScheduler] Job ${jobName} failed after ${maxRetries} retries`);
			}
		}
	}

	async stop() {
		if (!this.isRunning) {
			return;
		}

		for (const [name, jobTask] of this.tasks) {
			jobTask.task.stop();
			console.log(`[PreflightScheduler] Stopped job: ${name}`);
		}
		
		this.isRunning = false;
		console.log("[PreflightScheduler] stopped");
	}

	async clear() {
		for (const [name, jobTask] of this.tasks) {
			jobTask.task.destroy();
			console.log(`[PreflightScheduler] Destroyed job: ${name}`);
		}
		
		this.tasks.clear();
		console.log("[PreflightScheduler] cleared all tasks");
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
