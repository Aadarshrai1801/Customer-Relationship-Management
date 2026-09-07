import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export interface PushMessage {
  token: string;
  title: string;
  body: string;
}

export interface PushProvider {
  readonly name: string;
  send(message: PushMessage): Promise<{ messageId: string }>;
}

/**
 * Module 14 (PRD 4.16 P1): push delivery behind an interface. The stub
 * records nothing externally and always succeeds — swap in FCM/APNs when
 * keys exist (same pattern as the billing provider).
 */
@Injectable()
export class StubPushProvider implements PushProvider {
  readonly name = 'stub-push';

  async send(message: PushMessage): Promise<{ messageId: string }> {
    if (!message.token) throw new Error('Push token is required');
    return { messageId: `pushstub_${randomUUID().replace(/-/g, '').slice(0, 24)}` };
  }
}

export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

export function providePushProvider() {
  return {
    provide: PUSH_PROVIDER,
    useFactory: () => new StubPushProvider(),
  };
}
