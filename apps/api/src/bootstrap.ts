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
  app.enableCors({
    origin: (process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(','),
    credentials: true,
  });
}
