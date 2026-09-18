import crypto from 'crypto';
import { IDatabase, DoctorEntity } from '../../infra/db/database.interface';
import { ICacheService } from '../../infra/cache/cache.interface';
import { SearchDoctorsQuery } from './search.schema';

export interface SearchResult {
  doctors: DoctorEntity[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  cached: boolean;
}

export class SearchService {
  constructor(
    private db: IDatabase,
    private cache: ICacheService
  ) {}

  async searchDoctors(query: SearchDoctorsQuery): Promise<SearchResult> {
    const hash = crypto.createHash('sha256').update(JSON.stringify(query)).digest('hex').substring(0, 16);
    const cacheKey = `doctor:search:${hash}`;

    const cached = await this.cache.get<{ doctors: DoctorEntity[]; total: number }>(cacheKey);
    if (cached) {
      return {
        doctors: cached.doctors,
        total: cached.total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.ceil(cached.total / query.limit),
        cached: true
      };
    }

    const { doctors, total } = await this.db.doctors.search({
      specialty: query.specialty,
      language: query.language,
      minRating: query.minRating,
      availableFrom: query.availableFrom ? new Date(query.availableFrom) : undefined,
      availableTo: query.availableTo ? new Date(query.availableTo) : undefined,
      page: query.page,
      limit: query.limit
    });

    await this.cache.set(cacheKey, { doctors, total }, 60); // 60s TTL

    return {
      doctors,
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
      cached: false
    };
  }
}
