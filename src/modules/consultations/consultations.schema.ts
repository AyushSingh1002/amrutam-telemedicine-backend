import { z } from 'zod';

export const updateConsultationStatusSchema = z.object({
  status: z.enum(['in_progress', 'completed', 'cancelled', 'no_show']),
  expectedVersion: z.coerce.number().int().positive()
});

export type UpdateConsultationStatusInput = z.infer<typeof updateConsultationStatusSchema>;
