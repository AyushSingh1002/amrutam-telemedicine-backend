import Redis from 'ioredis';
import { ICacheService } from './cache.interface';
import { logger } from '../observability/logger';

export class RedisCacheService implements ICacheService {
  private client: Redis;

  constructor(redisUrl: string) {
    this.client = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      lazyConnect: true
    });

    this.client.on('error', (err) => {
      logger.error({ err: err.message }, 'Redis connection error');
    });
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect();
      logger.info('Connected to Redis Cache');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Failed to connect to Redis, cache operations will degrade gracefully');
    }
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const data = await this.client.get(key);
      if (!data) return null;
      return JSON.parse(data) as T;
    } catch (err) {
      logger.warn({ key, err: (err as Error).message }, 'Redis get error');
      return null;
    }
  }

  async set(key: string, value: any, ttlSeconds: number = 60): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      if (ttlSeconds > 0) {
        await this.client.set(key, serialized, 'EX', ttlSeconds);
      } else {
        await this.client.set(key, serialized);
      }
    } catch (err) {
      logger.warn({ key, err: (err as Error).message }, 'Redis set error');
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (err) {
      logger.warn({ key, err: (err as Error).message }, 'Redis del error');
    }
  }

  async delByPattern(pattern: string): Promise<void> {
    try {
      const stream = this.client.scanStream({ match: pattern, count: 100 });
      stream.on('data', async (keys: string[]) => {
        if (keys.length > 0) {
          const pipeline = this.client.pipeline();
          keys.forEach((key) => pipeline.del(key));
          await pipeline.exec();
        }
      });
    } catch (err) {
      logger.warn({ pattern, err: (err as Error).message }, 'Redis delByPattern error');
    }
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.client.ping();
      return res === 'PONG';
    } catch {
      return false;
    }
  }
}
