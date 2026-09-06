import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasScope } from '../../lib/api';
import { useAuth } from '../../lib/providers';
import type { DuplicateCandidate } from '../../lib/crm-types';
import { Badge, Button, Card, EmptyState, Skeleton } from '../../components/ui';
import { MergePickerModal } from '../../components/merge-picker-modal';
import { useToast } from '../../components/toast';

export function DedupQueuePage(): React.JSX.Element {
  const { user } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();

  const [entityFilter, setEntityFilter] = useState<'all' | 'contact' | 'account'>('all');
  const [confidenceFilter, setConfidenceFilter] = useState<'all' | 'exact' | 'high' | 'medium'>('all');
  const [statusFilter, setStatusFilter] = useState<'pending' | 'dismissed' | 'merged'>('pending');

  const [activeMergeCandidate, setActiveMergeCandidate] = useState<DuplicateCandidate | null>(null);

  const canManageContacts = hasScope(user, 'contacts:manage');
  const canManageAccounts = hasScope(user, 'accounts:manage');

  const candidatesQuery = useQuery({
    queryKey: ['dedup-candidates', entityFilter, confidenceFilter, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (entityFilter !== 'all') params.set('entityType', entityFilter);
      if (confidenceFilter !== 'all') params.set('confidence', confidenceFilter);
      params.set('status', statusFilter);
      return api<DuplicateCandidate[]>(`/duplicates?${params.toString()}`);
    },
  });

  const dismissMutation = useMutation({
    mutationFn: async (candidateId: string) => {
      return api(`/duplicates/${candidateId}/dismiss`, { method: 'POST' });
    },
    onSuccess: () => {
      notify('success', 'Candidate dismissed');
      void queryClient.invalidateQueries({ queryKey: ['dedup-candidates'] });
    },
    onError: (err) => {
      notify('error', err instanceof Error ? err.message : 'Failed to dismiss candidate');
    },
  });

  function formatSignals(signals: Record<string, unknown>): string[] {
    const list: string[] = [];
    if (signals['matchedOn']) {
      const m = signals['matchedOn'];
      if (Array.isArray(m)) list.push(`Matched on: ${m.join(', ')}`);
      else list.push(`Matched on: ${String(m)}`);
    }
    if (signals['email']) list.push(`Email match: ${signals['email']}`);
    if (signals['phone']) list.push(`Phone match: ${signals['phone']}`);
    if (signals['similarity']) {
      const sim = Number(signals['similarity']);
      list.push(`Name similarity: ${Math.round(sim * 100)}%`);
    }
    if (signals['domain']) list.push(`Domain match: ${signals['domain']}`);
    return list.length > 0 ? list : ['Fuzzy match detected'];
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">
            Deduplication Review Queue
          </h1>
          <p className="mt-0.5 text-xs text-text-secondary">
            AI and rule-based candidate pairs detected on record creation and nightly scans.
          </p>
        </div>
      </div>

      {/* Filter Card */}
      <Card title="Filter Duplicate Candidates">
        <div className="flex flex-wrap items-end gap-3 text-xs">
          <div>
            <label htmlFor="filter-entity" className="mb-1 block font-medium text-text-secondary">
              Record Type
            </label>
            <select
              id="filter-entity"
              value={entityFilter}
              onChange={(e) => setEntityFilter(e.target.value as any)}
              className="h-9 rounded border border-border bg-surface px-3 text-sm text-text-primary"
            >
              <option value="all">All Types</option>
              <option value="contact">Contacts</option>
              <option value="account">Accounts</option>
            </select>
          </div>

          <div>
            <label htmlFor="filter-confidence" className="mb-1 block font-medium text-text-secondary">
              Confidence Score
            </label>
            <select
              id="filter-confidence"
              value={confidenceFilter}
              onChange={(e) => setConfidenceFilter(e.target.value as any)}
              className="h-9 rounded border border-border bg-surface px-3 text-sm text-text-primary"
            >
              <option value="all">All Confidence Levels</option>
              <option value="exact">Exact (100%)</option>
              <option value="high">High (&gt;80%)</option>
              <option value="medium">Medium (&gt;50%)</option>
            </select>
          </div>

          <div>
            <label htmlFor="filter-status" className="mb-1 block font-medium text-text-secondary">
              Candidate Status
            </label>
            <select
              id="filter-status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              className="h-9 rounded border border-border bg-surface px-3 text-sm text-text-primary"
            >
              <option value="pending">Pending Review</option>
              <option value="dismissed">Dismissed</option>
              <option value="merged">Merged</option>
            </select>
          </div>
        </div>
      </Card>

      {/* Candidates Feed */}
      {candidatesQuery.isLoading ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : candidatesQuery.isError ? (
        <div className="rounded bg-danger-soft p-4 text-sm text-danger">
          Could not load duplicate candidates: {candidatesQuery.error?.message}
        </div>
      ) : !candidatesQuery.data || candidatesQuery.data.length === 0 ? (
        <EmptyState
          title="No duplicates found"
          description={
            statusFilter === 'pending'
              ? 'Your CRM database is clean! No unresolved duplicates detected.'
              : `No ${statusFilter} candidates match your filters.`
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          {candidatesQuery.data.map((candidate) => {
            const [recA, recB] = candidate.records;
            const signals = formatSignals(candidate.signals);
            const canMergeThis =
              candidate.entityType === 'contact' ? canManageContacts : canManageAccounts;

            return (
              <div
                key={candidate.id}
                className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-5 shadow-subtle transition-all hover:border-border-strong"
              >
                {/* Card Header */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">
                      {candidate.entityType}
                    </span>
                    <Badge
                      tone={
                        candidate.confidence === 'exact'
                          ? 'success'
                          : candidate.confidence === 'high'
                            ? 'warning'
                            : 'info'
                      }
                    >
                      {candidate.confidence.toUpperCase()} CONFIDENCE
                    </Badge>
                    <span className="text-xs text-text-secondary">
                      Detected {new Date(candidate.createdAt).toLocaleDateString()}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-1">
                    {signals.map((sig, idx) => (
                      <span
                        key={idx}
                        className="rounded bg-surface-raised px-2 py-0.5 text-[11px] font-medium text-text-secondary"
                      >
                        {sig}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Comparison Grid */}
                <div className="grid gap-4 md:grid-cols-2">
                  {/* Record A */}
                  <div className="flex flex-col gap-1 rounded-lg border border-border/80 bg-surface-raised/40 p-3 text-xs">
                    <span className="font-semibold text-text-secondary">Candidate A</span>
                    <Link
                      to={candidate.entityType === 'contact' ? '/contacts/$id' : '/accounts/$id'}
                      params={{ id: recA?.id ?? '' }}
                      className="text-sm font-bold text-accent hover:underline"
                    >
                      {recA?.name || 'Unnamed Record'}
                    </Link>
                    {recA?.email && (
                      <span className="text-text-secondary">Email / URL: {recA.email}</span>
                    )}
                    <span className="text-[11px] text-text-secondary font-mono">
                      ID: {recA?.id.slice(0, 8)}…
                    </span>
                  </div>

                  {/* Record B */}
                  <div className="flex flex-col gap-1 rounded-lg border border-border/80 bg-surface-raised/40 p-3 text-xs">
                    <span className="font-semibold text-text-secondary">Candidate B</span>
                    <Link
                      to={candidate.entityType === 'contact' ? '/contacts/$id' : '/accounts/$id'}
                      params={{ id: recB?.id ?? '' }}
                      className="text-sm font-bold text-accent hover:underline"
                    >
                      {recB?.name || 'Unnamed Record'}
                    </Link>
                    {recB?.email && (
                      <span className="text-text-secondary">Email / URL: {recB.email}</span>
                    )}
                    <span className="text-[11px] text-text-secondary font-mono">
                      ID: {recB?.id.slice(0, 8)}…
                    </span>
                  </div>
                </div>

                {/* Card Actions */}
                {candidate.status === 'pending' && (
                  <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/60">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => dismissMutation.mutate(candidate.id)}
                      disabled={dismissMutation.isPending}
                      className="text-xs text-text-secondary"
                    >
                      Dismiss Match
                    </Button>
                    {canMergeThis && (
                      <Button
                        type="button"
                        variant="primary"
                        onClick={() => setActiveMergeCandidate(candidate)}
                        className="text-xs"
                      >
                        Review &amp; Merge →
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Per-Field Merge Picker Modal */}
      {activeMergeCandidate && (
        <MergePickerModal
          open={Boolean(activeMergeCandidate)}
          onOpenChange={(open) => {
            if (!open) setActiveMergeCandidate(null);
          }}
          entityType={activeMergeCandidate.entityType}
          primaryId={activeMergeCandidate.records[0]?.id ?? ''}
          secondaryId={activeMergeCandidate.records[1]?.id ?? ''}
          primaryName={activeMergeCandidate.records[0]?.name}
          secondaryName={activeMergeCandidate.records[1]?.name}
          onSuccess={() => {
            setActiveMergeCandidate(null);
            void queryClient.invalidateQueries({ queryKey: ['dedup-candidates'] });
          }}
        />
      )}
    </div>
  );
}
