import { INotificationProvider, AppointmentConfirmationEvent, ReminderEvent, PrescriptionEvent } from './notification.interface';
import { logger } from '../observability/logger';

export class ConsoleNotificationProvider implements INotificationProvider {
  async sendAppointmentConfirmation(event: AppointmentConfirmationEvent): Promise<boolean> {
    logger.info(
      {
        recipient: event.patientEmail,
        consultationId: event.consultationId,
        meetingLink: event.meetingLink
      },
      `[NOTIFICATION] Appointment Confirmed for ${event.patientName} with Dr. ${event.doctorName} at ${event.startTime.toISOString()}`
    );
    return true;
  }

  async sendReminder(event: ReminderEvent): Promise<boolean> {
    logger.info(
      {
        recipient: event.recipientEmail,
        consultationId: event.consultationId,
        minutesBefore: event.minutesBefore
      },
      `[NOTIFICATION] Reminder: Your consultation starts in ${event.minutesBefore} minutes`
    );
    return true;
  }

  async sendPrescriptionIssued(event: PrescriptionEvent): Promise<boolean> {
    logger.info(
      {
        recipient: event.patientEmail,
        consultationId: event.consultationId
      },
      `[NOTIFICATION] Dr. ${event.doctorName} has issued your consultation prescription`
    );
    return true;
  }
}
