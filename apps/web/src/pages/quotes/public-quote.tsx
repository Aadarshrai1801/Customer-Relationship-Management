import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { API_URL } from '../../lib/api';
import { Button, Card, EmptyState, Field, Input, Skeleton } from '../../components/ui';

interface PublicQuote {
  id: string;
  number: string;
  lines: Array<{ name: string; quantity: string; unitPrice: string; lineTotal: string }>;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  currency: string;
  validUntil: string | null;
  status: string;
  signature: { name?: string; at?: string } | null;
  expired: boolean;
}

async function publicApi<T>(
  path: string,
  init?: Omit<RequestInit, 'body'> & { body?: unknown },
): Promise<T> {
  const { body, ...rest } = init ?? {};
  const res = await fetch(`${API_URL}/v1${path}`, {
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...rest,
  });
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    throw new Error(
      (data as { message?: string } | null)?.message ?? `Request failed (${res.status})`,
    );
  }
  return data as T;
}

export function PublicQuotePage(): React.JSX.Element {
  const { token } = useParams({ strict: false }) as { token: string };
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const quoteQuery = useQuery({
    queryKey: ['public-quote', token],
    queryFn: () => publicApi<PublicQuote>(`/quotes-public/${token}`),
    retry: false,
  });

  async function decide(action: 'accept' | 'decline'): Promise<void> {
    setError(null);
    try {
      if (action === 'accept') {
        if (!name.trim()) throw new Error('Your name is required to accept');
        await publicApi(`/quotes-public/${token}/accept`, {
          method: 'POST',
          body: { name: name.trim() },
        });
        setDone('accepted');
      } else {
        await publicApi(`/quotes-public/${token}/decline`, {
          method: 'POST',
          body: reason.trim() ? { reason: reason.trim() } : {},
        });
        setDone('declined');
      }
      await quoteQuery.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decision failed');
    }
  }

  if (quoteQuery.isLoading) {
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-8">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </main>
    );
  }

  if (quoteQuery.isError || !quoteQuery.data) {
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-8">
        <EmptyState title="Quote not available" description="The link may be wrong or expired." />
      </main>
    );
  }

  const quote = quoteQuery.data;
  const money = (value: number): string =>
    `${quote.currency} ${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-8">
      <div>
        <p className="text-xs text-text-secondary">Nexus CRM · Quote {quote.number}</p>
        <h1 className="text-2xl font-bold tracking-tight text-text-primary">
          {money(quote.total)}
        </h1>
        <p className="mt-1 text-xs text-text-secondary">
          Status: {quote.status}
          {quote.validUntil && ` · valid until ${new Date(quote.validUntil).toLocaleDateString()}`}
        </p>
      </div>

      <Card title="Line items" description="">
        <ul className="flex flex-col gap-2 text-xs">
          {quote.lines.map((line, idx) => (
            <li key={idx} className="flex justify-between gap-2">
              <span>
                {line.name} × {line.quantity}
              </span>
              <span>
                {quote.currency} {Number(line.lineTotal).toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
        <dl className="mt-3 flex flex-col gap-1 text-xs">
          <div className="flex justify-between">
            <dt className="text-text-secondary">Subtotal</dt>
            <dd>{money(quote.subtotal)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-text-secondary">Discount</dt>
            <dd>−{money(quote.discountTotal)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-text-secondary">Tax</dt>
            <dd>{money(quote.taxTotal)}</dd>
          </div>
          <div className="flex justify-between font-semibold">
            <dt>Total</dt>
            <dd>{money(quote.total)}</dd>
          </div>
        </dl>
      </Card>

      {quote.signature?.name && (
        <p className="text-xs text-text-secondary">
          Signed by {quote.signature.name}
          {quote.signature.at ? ` on ${new Date(String(quote.signature.at)).toLocaleString()}` : ''}
          .
        </p>
      )}

      {error && (
        <div role="alert" className="rounded bg-danger-soft p-3 text-xs text-danger">
          {error}
        </div>
      )}
      {done && (
        <div role="status" className="rounded bg-success-soft p-3 text-xs text-success">
          Quote {done} — thank you.
        </div>
      )}

      {!done && quote.status === 'sent' && !quote.expired && (
        <Card title="Your decision" description="Accepting records your name as signature.">
          <div className="flex flex-col gap-2">
            <Field label="Your name" htmlFor="quote-signer">
              <Input
                id="quote-signer"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Buyer"
              />
            </Field>
            <div className="flex gap-2">
              <Button
                variant="primary"
                onClick={() => void decide('accept')}
                className="h-9 text-xs"
              >
                Accept & sign
              </Button>
            </div>
            <Field label="Decline reason (optional)" htmlFor="quote-reason">
              <Input
                id="quote-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Budget timing"
              />
            </Field>
            <div>
              <Button
                variant="ghost"
                onClick={() => void decide('decline')}
                className="h-9 text-xs text-danger"
              >
                Decline quote
              </Button>
            </div>
          </div>
        </Card>
      )}
    </main>
  );
}
