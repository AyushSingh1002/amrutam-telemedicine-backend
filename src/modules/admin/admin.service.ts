import { IDatabase, AuditLogEntity } from '../../infra/db/database.interface';
import { ICacheService } from '../../infra/cache/cache.interface';
import { AuditService } from '../audit/audit.service';
import { AuditLogsQuery } from './admin.schema';

export interface AdminAnalytics {
  consultationsPerDay: number;
  noShowRatePercentage: number;
  averageTimeToBookHours: number;
  doctorUtilizationPercentage: number;
  totalConsultations: number;
  totalDoctors: number;
  totalPatients: number;
  source: 'cached_rollup' | 'fresh_calculation';
}

export class AdminService {
  constructor(
    private db: IDatabase,
    private cache: ICacheService,
    private auditService: AuditService
  ) {}

  async getAnalytics(): Promise<AdminAnalytics> {
    const cacheKey = 'admin:analytics:rollup';
    const cached = await this.cache.get<Omit<AdminAnalytics, 'source'>>(cacheKey);

    if (cached) {
      return {
        ...cached,
        source: 'cached_rollup'
      };
    }

    // Materialize/compute aggregate analytics and cache
    const fresh = await this.db.admin.getAnalytics();
    await this.cache.set(cacheKey, fresh, 3600); // 1 hour TTL

    return {
      ...fresh,
      source: 'fresh_calculation'
    };
  }

  async getAuditLogs(query: AuditLogsQuery): Promise<AuditLogEntity[]> {
    return await this.auditService.getAuditTrail(query);
  }
}
