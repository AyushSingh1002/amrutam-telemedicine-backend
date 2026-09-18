import { IQueueService, JobOptions } from './queue.interface';
import { logger } from '../observability/logger';
import crypto from 'crypto';

export class MemoryQueueService implements IQueueService {
  private workers = new Map<string, (data: any) => Promise<void>>();
  public jobsEnqueued: Array<{ queueName: string; jobName: string; data: any }> = [];

  async addJob<T>(queueName: string, jobName: string, data: T, opts?: JobOptions): Promise<string> {
    const jobId = `mem_${crypto.randomUUID()}`;
    this.jobsEnqueued.push({ queueName, jobName, data });
    logger.debug({ queueName, jobName, jobId }, 'MemoryQueue: Job added');

    const worker = this.workers.get(queueName);
    if (worker) {
      // Execute asynchronously or delayed
      if (opts?.delay && opts.delay > 0) {
        setTimeout(async () => {
          try {
            await worker(data);
          } catch (err) {
            logger.error({ queueName, err: (err as Error).message }, 'MemoryQueue: job error');
          }
        }, Math.min(opts.delay, 100)); // speed up delay in tests
      } else {
        setImmediate(async () => {
          try {
            await worker(data);
          } catch (err) {
            logger.error({ queueName, err: (err as Error).message }, 'MemoryQueue: job error');
          }
        });
      }
    }

    return jobId;
  }

  registerWorker<T>(
    queueName: string,
    processor: (data: T) => Promise<void>,
    _concurrency?: number
  ): void {
    this.workers.set(queueName, processor);
  }

  async close(): Promise<void> {
    this.workers.clear();
    this.jobsEnqueued = [];
  }
}
