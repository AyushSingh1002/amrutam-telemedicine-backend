import { z } from 'zod';

export const auditLogsQuerySchema = z.object({
  entityType: z.string().optional(),
  entityId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

export type AuditLogsQuery = z.infer<typeof auditLogsQuerySchema>;
