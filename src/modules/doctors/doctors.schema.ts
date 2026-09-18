import { z } from 'zod';

export const createSlotSchema = z.object({
  startTime: z.string().datetime(),
  endTime: z.string().datetime()
}).refine(
  (data) => new Date(data.startTime) < new Date(data.endTime),
  { message: 'startTime must be strictly before endTime', path: ['endTime'] }
);

export type CreateSlotInput = z.infer<typeof createSlotSchema>;
