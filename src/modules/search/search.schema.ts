import { z } from 'zod';

export const searchDoctorsQuerySchema = z.object({
  specialty: z.string().optional(),
  language: z.string().optional(),
  minRating: z.coerce.number().min(0).max(5).optional(),
  availableFrom: z.string().datetime().optional(),
  availableTo: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10)
});

export type SearchDoctorsQuery = z.infer<typeof searchDoctorsQuerySchema>;
