import type { Server } from 'node:http';
import request from 'supertest';

const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025';

export interface MailpitMessage {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
  Text?: string;
}

export async function findEmail(
  toFragment: string,
  subjectFragment: string,
): Promise<MailpitMessage> {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    const res = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=100`);
    const data = (await res.json()) as { messages?: MailpitMessage[] };
    const match = (data.messages ?? []).find(
      (m) =>
        m.To?.some((t) => t.Address.includes(toFragment)) && m.Subject.includes(subjectFragment),
    );
    if (match) {
      const full = (await (
        await fetch(`${MAILPIT_URL}/api/v1/message/${match.ID}`)
      ).json()) as MailpitMessage;
      return { ...match, Text: full.Text };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`email not found (to~${toFragment} subject~${subjectFragment})`);
}

export function extractToken(text: string | undefined, path: string): string {
  const match = text?.match(new RegExp(`${path}\\?token=([A-Za-z0-9_-]+)`));
  if (!match?.[1]) throw new Error(`token not found in email body for ${path}`);
  return match[1];
}

export async function loginAgent(
  server: Server,
  email: string,
  password: string,
  orgSlug?: string,
): Promise<request.Agent> {
  const agent = request.agent(server);
  const res = await agent.post('/v1/auth/login').send({ email, password, orgSlug });
  if (res.status !== 200) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return agent;
}

export async function inviteAndAccept(
  server: Server,
  ownerAgent: request.Agent,
  input: { email: string; roleKey: string; name: string; password?: string },
): Promise<{ id: string; email: string }> {
  const created = await ownerAgent
    .post('/v1/auth/invites')
    .send({ email: input.email, roleKey: input.roleKey });
  if (created.status !== 201) {
    throw new Error(
      `invite failed for ${input.email}: ${created.status} ${JSON.stringify(created.body)}`,
    );
  }
  const delivered = await findEmail(input.email, 'invited to join');
  const token = extractToken(delivered.Text, '/accept-invite');
  const accept = await request(server)
    .post('/v1/auth/invites/accept')
    .send({ token, name: input.name, password: input.password ?? 'member-pass-12' });
  if (accept.status !== 201) {
    throw new Error(
      `accept failed for ${input.email}: ${accept.status} ${JSON.stringify(accept.body)}`,
    );
  }
  return accept.body.user as { id: string; email: string };
}
