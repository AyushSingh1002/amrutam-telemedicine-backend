import { IQueueService } from '../infra/queue/queue.interface';
import { IDatabase } from '../infra/db/database.interface';
import { ICacheService } from '../infra/cache/cache.interface';
import { logger } from '../infra/observability/logger';

export const ANALYTICS_ROLLUP_QUEUE_NAME = 'analytics-rollup';

export function setupAnalyticsRollupWorker(
  queue: IQueueService,
  db: IDatabase,
  cache: ICacheService
): void {
  queue.registerWorker<{ timestamp: number }>(
    ANALYTICS_ROLLUP_QUEUE_NAME,
    async () => {
      logger.info('Executing scheduled analytics rollup worker');
      const stats = await db.admin.getAnalytics();
      await cache.set('admin:analytics:rollup', stats, 3600); // 1 hour cache
      logger.info({ stats }, 'Analytics rollup completed and cached');
    }
  );
}
