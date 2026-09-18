import { IQueueService } from '../infra/queue/queue.interface';
import { INotificationProvider, AppointmentConfirmationEvent } from '../infra/providers/notification.interface';
import { logger } from '../infra/observability/logger';

export const NOTIFICATION_QUEUE_NAME = 'notifications';

export function setupNotificationWorker(queue: IQueueService, notificationProvider: INotificationProvider): void {
  queue.registerWorker<AppointmentConfirmationEvent>(
    NOTIFICATION_QUEUE_NAME,
    async (data) => {
      logger.info({ consultationId: data.consultationId }, 'Processing appointment confirmation notification');
      await notificationProvider.sendAppointmentConfirmation({
        ...data,
        startTime: new Date(data.startTime)
      });
    }
  );
}
