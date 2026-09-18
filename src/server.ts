import { buildApp } from './app';
import { config } from './config/env';
import { logger } from './infra/observability/logger';

async function main() {
  try {
    const app = await buildApp();

    const address = await app.listen({
      port: config.PORT,
      host: config.HOST
    });

    logger.info(`Amrutam Telemedicine Backend running at ${address}`);
    logger.info(`Metrics available at ${address}/metrics`);
    logger.info(`Health check available at ${address}/healthz`);

    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
    signals.forEach((signal) => {
      process.on(signal, async () => {
        logger.info(`Received ${signal}, initiating graceful shutdown...`);
        try {
          await app.close();
          const container = (app as any).container;
          if (container?.queue) {
            await container.queue.close();
          }
          logger.info('Graceful shutdown completed successfully');
          process.exit(0);
        } catch (err) {
          logger.error({ err }, 'Error during graceful shutdown');
          process.exit(1);
        }
      });
    });
  } catch (err) {
    logger.fatal({ err }, 'Fatal error bootstrapping Amrutam Telemedicine Backend');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
