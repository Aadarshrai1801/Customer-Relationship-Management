import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { urlencoded } from 'express';
import helmet from 'helmet';
import { requestContextMiddleware } from './common/request-context';

export function configureApp(app: INestApplication): void {
  app.use(helmet());
  app.use(cookieParser());
  app.use(requestContextMiddleware);
  // SAML IdPs POST form-encoded assertion responses to the ACS endpoint.
  app.use(urlencoded({ extended: false }));
  app.setGlobalPrefix('v1');
  const envOrigins = (process.env.WEB_ORIGIN ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const allowedOrigins = Array.from(
    new Set(['http://localhost:5173', 'http://localhost:5174', ...envOrigins]),
  );
  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });
}
