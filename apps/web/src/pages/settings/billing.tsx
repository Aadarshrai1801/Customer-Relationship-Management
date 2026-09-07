import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasScope } from '../../lib/api';
import { useAuth } from '../../lib/providers';
import { Badge, Button, Card, EmptyState, Field, Input, Skeleton } from '../../components/ui';
import { useToast } from '../../components/toast';

interface Subscription {
  id: string;
  plan: string;
  seats: number;
  status: string;
  unitPrice: number;
  currency: string;
  mrr: number;
  activeUsers: number;
  cycleStart: string;
  cycleEnd: string;
  provider: string;
}

interface SeatPreview {
  plan: string;
  previousPlan: string;
  seats: number;
  previousSeats: number;
  seatDelta: number;
  unitPrice: number;
  currency: string;
  daysRemainingInCycle: number;
  proratedCharge: number;
  newMrr: number;
}

interface Invoice {
  id: string;
  number: string;
  amount: string;
  currency: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  createdAt: string;
}

const PLANS = ['trial', 'starter', 'growth', 'enterprise'] as const;

function money(amount: number | string, currency: string): string {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  return `${currency} ${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function BillingPage(): React.JSX.Element {
  const { user } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const canManage = hasScope(user, 'org:manage');

  const subscriptionQuery = useQuery({
    queryKey: ['billing-subscription'],
    queryFn: () => api<Subscription>('/billing/subscription'),
  });

  const invoicesQuery = useQuery({
    queryKey: ['billing-invoices'],
    queryFn: () => api<Invoice[]>('/billing/invoices'),
  });

  const [plan, setPlan] = useState<string | null>(null);
  const [seats, setSeats] = useState<string | null>(null);
  const [preview, setPreview] = useState<SeatPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const sub = subscriptionQuery.data ?? null;
  const activePlan = plan ?? sub?.plan ?? 'trial';
  const activeSeats = seats ?? (sub ? String(sub.seats) : '1');

  useEffect(() => {
    if (!sub || !canManage) return;
    const seatsNum = Number(activeSeats);
    if (!Number.isInteger(seatsNum) || seatsNum < 1) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    if (activePlan === sub.plan && seatsNum === sub.seats) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    setPreviewing(true);
    const timer = setTimeout(() => {
      api<SeatPreview>('/billing/seats/preview', {
        method: 'POST',
        body: { plan: activePlan, seats: seatsNum },
      })
        .then((result) => {
          setPreview(result);
          setPreviewError(null);
        })
        .catch((err: Error) => {
          setPreview(null);
          setPreviewError(err.message || 'Preview failed');
        })
        .finally(() => setPreviewing(false));
    }, 400);
    return () => clearTimeout(timer);
  }, [activePlan, activeSeats, sub, canManage]);

  const applyMutation = useMutation({
    mutationFn: () =>
      api<{ charged: number }>('/billing/seats', {
        method: 'POST',
        body: { plan: activePlan, seats: Number(activeSeats) },
      }),
    onSuccess: (result) => {
      setPreview(null);
      void queryClient.invalidateQueries({ queryKey: ['billing-subscription'] });
      void queryClient.invalidateQueries({ queryKey: ['billing-invoices'] });
      notify(
        'success',
        result.charged > 0
          ? `Seats updated — charged ${money(result.charged, 'USD')}`
          : 'Seats updated',
      );
    },
    onError: (err: Error) => notify('error', err.message || 'Seat change failed'),
  });

  const invoices = invoicesQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold tracking-tight text-text-primary">Billing</h1>

      <Card title="Subscription" description="Per-seat monthly billing, prorated to the cycle.">
        {subscriptionQuery.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : subscriptionQuery.isError || !sub ? (
          <div className="rounded bg-danger-soft p-4 text-sm text-danger">
            Could not load subscription: {subscriptionQuery.error?.message}
          </div>
        ) : (
          <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
            <div>
              <dt className="text-text-secondary">Plan</dt>
              <dd className="font-semibold capitalize">{sub.plan}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">Seats</dt>
              <dd className="font-semibold">{sub.seats}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">MRR</dt>
              <dd className="font-semibold">{money(sub.mrr, sub.currency)}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">Active users</dt>
              <dd className="font-semibold">{sub.activeUsers}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">Cycle ends</dt>
              <dd className="font-semibold">{new Date(sub.cycleEnd).toLocaleDateString()}</dd>
            </div>
            <div>
              <dt className="text-text-secondary">Provider</dt>
              <dd>
                <Badge tone={sub.provider === 'stub' ? 'warning' : 'success'}>{sub.provider}</Badge>
              </dd>
            </div>
          </dl>
        )}
      </Card>

      {canManage && sub && (
        <Card
          title="Change seats"
          description="Preview shows the prorated charge before you confirm."
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Field label="Plan" htmlFor="billing-plan">
              <select
                id="billing-plan"
                value={activePlan}
                onChange={(e) => setPlan(e.target.value)}
                className="h-9 rounded border border-border bg-surface px-2 text-xs"
              >
                {PLANS.map((p) => (
                  <option key={p} value={p} className="capitalize">
                    {p}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Seats" htmlFor="billing-seats">
              <Input
                id="billing-seats"
                inputMode="numeric"
                value={activeSeats}
                onChange={(e) => setSeats(e.target.value)}
              />
            </Field>
          </div>
          <div className="mt-3 rounded border border-border p-3 text-xs" aria-live="polite">
            {previewing ? (
              <span className="italic text-text-secondary">Calculating preview…</span>
            ) : previewError ? (
              <span role="alert" className="text-danger">
                {previewError}
              </span>
            ) : preview ? (
              <span>
                {preview.seatDelta >= 0 ? 'Charge' : 'Credit'} of{' '}
                <strong>{money(Math.abs(preview.proratedCharge), preview.currency)}</strong> for{' '}
                {preview.daysRemainingInCycle} remaining days · new MRR{' '}
                <strong>{money(preview.newMrr, preview.currency)}</strong>
              </span>
            ) : (
              <span className="italic text-text-secondary">
                No changes — adjust plan or seats to preview.
              </span>
            )}
          </div>
          <div className="mt-2 flex justify-end">
            <Button
              type="button"
              variant="primary"
              className="h-9 text-xs"
              disabled={!preview || applyMutation.isPending}
              onClick={() => applyMutation.mutate()}
            >
              {applyMutation.isPending ? 'Applying…' : 'Confirm change'}
            </Button>
          </div>
        </Card>
      )}

      <Card title="Invoices" description="Confirmed seat and plan changes.">
        {invoicesQuery.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : invoices.length === 0 ? (
          <EmptyState title="No invoices yet" description="Seat upgrades create invoices here." />
        ) : (
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-text-secondary">
                <th className="py-1 pr-2">Number</th>
                <th className="py-1 pr-2 text-right">Amount</th>
                <th className="py-1 pr-2">Status</th>
                <th className="py-1">Date</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.id} className="border-t border-border">
                  <td className="py-1.5 pr-2 font-medium">{invoice.number}</td>
                  <td className="py-1.5 pr-2 text-right">
                    {money(invoice.amount, invoice.currency)}
                  </td>
                  <td className="py-1.5 pr-2">
                    <Badge tone={invoice.status === 'paid' ? 'success' : 'neutral'}>
                      {invoice.status}
                    </Badge>
                  </td>
                  <td className="py-1.5">{new Date(invoice.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
