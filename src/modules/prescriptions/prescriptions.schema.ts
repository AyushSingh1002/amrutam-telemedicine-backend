import { z } from 'zod';

export const medicationItemSchema = z.object({
  name: z.string().min(1),
  dosage: z.string().min(1),
  frequency: z.string().min(1),
  duration: z.string().min(1)
});

export const issuePrescriptionSchema = z.object({
  clinicalNotes: z.string().min(1, 'Clinical notes are required'),
  medications: z.array(medicationItemSchema).min(1, 'At least one medication must be prescribed')
});

export type IssuePrescriptionInput = z.infer<typeof issuePrescriptionSchema>;
