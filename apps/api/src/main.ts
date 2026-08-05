import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  app.setGlobalPrefix('api');
  // 兜底 CORS：主力走 Next.js rewrites 同源代理；直接 curl API 调试也不受阻
  app.enableCors({ origin: 'http://localhost:3000', credentials: false });
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '127.0.0.1');
  console.log(`API listening on http://127.0.0.1:${port}/api`);
}

void bootstrap();
