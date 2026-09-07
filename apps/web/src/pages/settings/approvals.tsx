import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Badge, Button, Card, EmptyState, Field, Input, Skeleton } from '../../components/ui';
import { Modal } from '../../components/modal';
import { useToast } from '../../components/toast';

interface Approval {
  id: string;
  requester: { id: string; name: string } | null;
  decidedBy: { id: string; name: string } | null;
  entityType: string;
  entityId: string;
  action: string;
  payload: Record<string, unknown>;
  status: string;
  reason: string | null;
  decidedAt: string | null;
  createdAt: string;
}

type Filter = 'pending' | 'approved' | 'rejected';

export function ApprovalsPage(): React.JSX.Element {
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('pending');
  const [rejectTarget, setRejectTarget] = useState<Approval | null>(null);
  const [reason, setReason] = useState('');

  const approvalsQuery = useQuery<Approval[], Error>({
    queryKey: ['approvals', filter],
    queryFn: () => api<Approval[]>(`/approvals?status=${filter}`),
    retry: false,
  });

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ['approvals'] });
  }

  const approveMutation = useMutation({
    mutationFn: (id: string) => api(`/approvals/${id}/approve`, { method: 'POST', body: {} }),
    onSuccess: () => {
      refresh();
      notify('success', 'Approval granted');
    },
    onError: (err: Error) => notify('error', err.message || 'Approval failed'),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, rejectReason }: { id: string; rejectReason?: string }) =>
      api(`/approvals/${id}/reject`, {
        method: 'POST',
        body: rejectReason ? { reason: rejectReason } : {},
      }),
    onSuccess: () => {
      setRejectTarget(null);
      setReason('');
      refresh();
      notify('success', 'Approval rejected');
    },
    onError: (err: Error) => notify('error', err.message || 'Rejection failed'),
  });

  const approvals = approvalsQuery.data ?? [];
  const forbidden =
    approvalsQuery.isError &&
    /forbidden|not allowed|403/i.test(approvalsQuery.error?.message ?? '');

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-text-primary">Approvals</h1>
        <p className="mt-1 text-xs text-text-secondary">
          Owners and admins review requests here. Requesters can never approve their own requests —
          including high-discount quotes, which stay blocked until approved.
        </p>
      </div>

      <div className="flex gap-2" role="group" aria-label="Approval status">
        {(['pending', 'approved', 'rejected'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(s)}
            aria-pressed={filter === s}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
              filter === s
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:bg-surface-raised hover:text-text-primary'
            }`}
          >
            {s[0]!.toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      <Card title="Requests" description="">
        {approvalsQuery.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : forbidden ? (
          <EmptyState
            title="Reviewers only"
            description="Only workspace owners and admins can review approvals."
          />
        ) : approvalsQuery.isError ? (
          <div className="rounded bg-danger-soft p-4 text-sm text-danger">
            Could not load approvals: {approvalsQuery.error?.message}
          </div>
        ) : approvals.length === 0 ? (
          <EmptyState title="Nothing here" description={`No ${filter} approvals.`} />
        ) : (
          <ul className="flex flex-col gap-2 text-xs">
            {approvals.map((approval) => (
              <li
                key={approval.id}
                className="flex flex-col gap-2 rounded-lg border border-border px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    tone={
                      approval.status === 'approved'
                        ? 'success'
                        : approval.status === 'rejected'
                          ? 'danger'
                          : 'warning'
                    }
                  >
                    {approval.status}
                  </Badge>
                  <span className="text-sm font-medium text-text-primary">{approval.action}</span>
                  <span className="text-text-secondary">
                    {approval.entityType} · requested by {approval.requester?.name ?? '—'}
                  </span>
                </div>
                {approval.decidedBy && (
                  <p className="text-text-secondary">
                    Decided by {approval.decidedBy.name}
                    {approval.reason ? ` — ${approval.reason}` : ''}
                  </p>
                )}
                {approval.status === 'pending' && (
                  <div className="flex gap-2">
                    <Button
                      variant="primary"
                      onClick={() => approveMutation.mutate(approval.id)}
                      className="h-7 text-xs"
                    >
                      Approve
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setRejectTarget(approval)}
                      className="h-7 text-xs text-danger"
                    >
                      Reject
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={rejectTarget !== null}
        onClose={() => setRejectTarget(null)}
        title="Reject request"
      >
        <div className="flex flex-col gap-3">
          <Field label="Reason (optional)" htmlFor="approval-reason">
            <Input
              id="approval-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this rejected?"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRejectTarget(null)} className="h-9 text-xs">
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (rejectTarget) {
                  rejectMutation.mutate({
                    id: rejectTarget.id,
                    rejectReason: reason.trim() || undefined,
                  });
                }
              }}
              className="h-9 text-xs"
            >
              Reject request
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
