import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { IQueueService, JobOptions } from './queue.interface';
import { logger } from '../observability/logger';

export class BullMQQueueService implements IQueueService {
  private redisConnection: Redis;
  private queues = new Map<string, Queue>();
  private workers: Worker[] = [];

  constructor(redisUrl: string) {
    this.redisConnection = new Redis(redisUrl, {
      maxRetriesPerRequest: null
    });
  }

  private getQueue(name: string): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.redisConnection,
        defaultJobOptions: {
          attempts: 5,
          backoff: {
            type: 'exponential',
            delay: 2000
          },
          removeOnComplete: 100,
          removeOnFail: 500
        }
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  async addJob<T>(queueName: string, jobName: string, data: T, opts?: JobOptions): Promise<string> {
    const queue = this.getQueue(queueName);
    const job = await queue.add(jobName, data, opts);
    logger.debug({ queueName, jobName, jobId: job.id }, 'BullMQ: Job enqueued');
    return job.id || '';
  }

  registerWorker<T>(
    queueName: string,
    processor: (data: T) => Promise<void>,
    concurrency: number = 5
  ): void {
    const worker = new Worker(
      queueName,
      async (job) => {
        logger.info({ queueName, jobId: job.id, jobName: job.name }, 'BullMQ: processing job');
        await processor(job.data);
      },
      {
        connection: this.redisConnection,
        concurrency
      }
    );

    worker.on('failed', (job, err) => {
      logger.error({ queueName, jobId: job?.id, err: err.message }, 'BullMQ: job failed');
    });

    this.workers.push(worker);
  }

  async close(): Promise<void> {
    for (const worker of this.workers) {
      await worker.close();
    }
    for (const queue of this.queues.values()) {
      await queue.close();
    }
    await this.redisConnection.quit();
  }
}
