export interface JobOptions {
  delay?: number;
  attempts?: number;
  backoff?: {
    type: 'fixed' | 'exponential';
    delay: number;
  };
}

export interface IQueueService {
  addJob<T>(queueName: string, jobName: string, data: T, opts?: JobOptions): Promise<string>;
  registerWorker<T>(
    queueName: string,
    processor: (data: T) => Promise<void>,
    concurrency?: number
  ): void;
  close(): Promise<void>;
}
