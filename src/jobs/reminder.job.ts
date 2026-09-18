import { IQueueService } from '../infra/queue/queue.interface';
import { INotificationProvider, ReminderEvent } from '../infra/providers/notification.interface';
import { logger } from '../infra/observability/logger';

export const REMINDER_QUEUE_NAME = 'reminders';

export function setupReminderWorker(queue: IQueueService, notificationProvider: INotificationProvider): void {
  queue.registerWorker<ReminderEvent>(
    REMINDER_QUEUE_NAME,
    async (data) => {
      logger.info({ consultationId: data.consultationId }, 'Processing consultation reminder notification');
      await notificationProvider.sendReminder(data);
    }
  );
}
