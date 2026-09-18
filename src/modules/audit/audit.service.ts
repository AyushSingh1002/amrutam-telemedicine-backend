import { IDatabase, AuditLogEntity } from '../../infra/db/database.interface';
import { logger } from '../../infra/observability/logger';

export class AuditService {
  constructor(private db: IDatabase) {}

  async record(params: {
    actorId?: string | null;
    action: string;
    entityType: string;
    entityId: string;
    before?: any;
    after?: any;
  }): Promise<AuditLogEntity> {
    logger.info(
      {
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        actorId: params.actorId
      },
      `AuditLog: ${params.action}`
    );

    return await this.db.auditLogs.append({
      actorId: params.actorId,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId,
      before: params.before,
      after: params.after
    });
  }

  async getAuditTrail(filters: {
    entityType?: string;
    entityId?: string;
    actorId?: string;
    limit?: number;
  }): Promise<AuditLogEntity[]> {
    return await this.db.auditLogs.query(filters);
  }
}
