import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { API_URL } from '../../lib/api';
import { Button, Card, EmptyState, Field, Input, Skeleton } from '../../components/ui';

interface AvailabilitySlot {
  startsAt: string;
  endsAt: string;
}

interface AvailabilityResponse {
  link: { name: string; durationMinutes: number; description: string | null };
  slots: AvailabilitySlot[];
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

export function PublicBookingPage(): React.JSX.Element {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const [name, setName] = useState('');
  const [bookerEmail, setBookerEmail] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState(false);

  const availabilityQuery = useQuery({
    queryKey: ['public-availability', slug],
    queryFn: () => publicApi<AvailabilityResponse>(`/book/${slug}/availability`),
    retry: false,
  });

  async function book(): Promise<void> {
    setError(null);
    try {
      if (!name.trim()) throw new Error('Your name is required');
      if (!bookerEmail.trim()) throw new Error('Your email is required');
      if (!startsAt) throw new Error('Pick a time slot');
      await publicApi(`/book/${slug}`, {
        method: 'POST',
        body: {
          name: name.trim(),
          email: bookerEmail.trim(),
          startsAt,
          notes: notes.trim() || undefined,
        },
      });
      setBooked(true);
      await availabilityQuery.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Booking failed');
    }
  }

  if (availabilityQuery.isLoading) {
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-8">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </main>
    );
  }

  if (availabilityQuery.isError || !availabilityQuery.data) {
    return (
      <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-8">
        <EmptyState
          title="Booking link not available"
          description="The link may be wrong, expired, or deactivated."
        />
      </main>
    );
  }

  const { link, slots } = availabilityQuery.data;

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-8">
      <div>
        <p className="text-xs text-text-secondary">Nexus CRM · Book a meeting</p>
        <h1 className="text-2xl font-bold tracking-tight text-text-primary">{link.name}</h1>
        <p className="mt-1 text-xs text-text-secondary">
          {link.durationMinutes} minutes
          {link.description ? ` · ${link.description}` : ''}
        </p>
      </div>

      {booked && (
        <div role="status" className="rounded bg-success-soft p-3 text-xs text-success">
          Booked — check your inbox for a confirmation.
        </div>
      )}
      {error && (
        <div role="alert" className="rounded bg-danger-soft p-3 text-xs text-danger">
          {error}
        </div>
      )}

      {!booked && (
        <Card title="Pick a time" description="Weekdays 9:00–17:00 UTC.">
          {slots.length === 0 ? (
            <p className="text-xs italic text-text-secondary">No open slots right now.</p>
          ) : (
            <div className="flex flex-col gap-3">
              <Field label="Time slot" htmlFor="booking-slot">
                <select
                  id="booking-slot"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                  className="h-9 rounded border border-border bg-surface px-2 text-xs"
                >
                  <option value="">Select a slot…</option>
                  {slots.slice(0, 60).map((s) => (
                    <option key={s.startsAt} value={s.startsAt}>
                      {new Date(s.startsAt).toLocaleString()}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Your name" htmlFor="booking-name">
                <Input
                  id="booking-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jane Buyer"
                />
              </Field>
              <Field label="Work email" htmlFor="booking-email">
                <Input
                  id="booking-email"
                  value={bookerEmail}
                  onChange={(e) => setBookerEmail(e.target.value)}
                  placeholder="jane@company.com"
                />
              </Field>
              <Field label="Notes (optional)" htmlFor="booking-notes">
                <Input
                  id="booking-notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="What should we cover?"
                />
              </Field>
              <div>
                <Button variant="primary" onClick={() => void book()} className="h-9 text-xs">
                  Book meeting
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}
    </main>
  );
}
