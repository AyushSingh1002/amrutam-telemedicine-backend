import { z } from 'zod';

export const reserveSlotSchema = z.object({
  slotId: z.string().uuid(),
  amountCents: z.coerce.number().int().positive().default(50000) // Default 500.00 INR
});

export const confirmBookingSchema = z.object({
  consultationId: z.string().uuid(),
  paymentSuccess: z.boolean().default(true),
  forceFail: z.boolean().optional()
});

export type ReserveSlotInput = z.infer<typeof reserveSlotSchema>;
export type ConfirmBookingInput = z.infer<typeof confirmBookingSchema>;
