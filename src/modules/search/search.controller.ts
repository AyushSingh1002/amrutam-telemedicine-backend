import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { SearchService } from './search.service';
import { searchDoctorsQuerySchema } from './search.schema';

export function createSearchRoutes(searchService: SearchService): FastifyPluginAsync {
  return async (fastify: FastifyInstance) => {
    fastify.get('/doctors', async (request, reply) => {
      const validated = searchDoctorsQuerySchema.parse(request.query);
      const result = await searchService.searchDoctors(validated);
      return reply.send(result);
    });
  };
}
