export interface AppointmentConfirmationEvent {
  consultationId: string;
  patientEmail: string;
  patientName: string;
  doctorName: string;
  startTime: Date;
  meetingLink: string;
}

export interface ReminderEvent {
  consultationId: string;
  recipientEmail: string;
  minutesBefore: number;
}

export interface PrescriptionEvent {
  consultationId: string;
  patientEmail: string;
  doctorName: string;
}

export interface INotificationProvider {
  sendAppointmentConfirmation(event: AppointmentConfirmationEvent): Promise<boolean>;
  sendReminder(event: ReminderEvent): Promise<boolean>;
  sendPrescriptionIssued(event: PrescriptionEvent): Promise<boolean>;
}
