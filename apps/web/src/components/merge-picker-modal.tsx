import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { MergePreview } from '../lib/crm-types';
import { Modal } from './modal';
import { Badge, Button, EmptyState, Skeleton } from './ui';
import { useToast } from './toast';

export interface MergePickerModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: 'contact' | 'account';
  primaryId: string;
  secondaryId: string;
  primaryName?: string;
  secondaryName?: string;
  onSuccess: (winnerId: string) => void;
}

export function MergePickerModal({
  open,
  onOpenChange,
  entityType,
  primaryId,
  secondaryId,
  primaryName,
  secondaryName,
  onSuccess,
}: MergePickerModalProps): React.JSX.Element {
  const { notify } = useToast();
  const [winnerId, setWinnerId] = useState(primaryId);
  const [loserId, setLoserId] = useState(secondaryId);
  const [choices, setChoices] = useState<Record<string, 'winner' | 'loser'>>({});

  useEffect(() => {
    setWinnerId(primaryId);
    setLoserId(secondaryId);
    setChoices({});
  }, [primaryId, secondaryId, open]);

  const previewQuery = useQuery({
    queryKey: ['merge-preview', entityType, winnerId, loserId],
    queryFn: () => {
      const endpoint = entityType === 'contact' ? 'contacts' : 'accounts';
      return api<MergePreview>(`/${endpoint}/${winnerId}/merge-preview?loserId=${loserId}`);
    },
    enabled: open && Boolean(winnerId) && Boolean(loserId),
  });

  const conflicts = previewQuery.data?.fields.filter((f) => f.conflict) ?? [];
  const nonConflicts = previewQuery.data?.fields.filter((f) => !f.conflict) ?? [];

  // Initialize default choices when preview loads
  useEffect(() => {
    if (previewQuery.data) {
      const initial: Record<string, 'winner' | 'loser'> = {};
      for (const field of previewQuery.data.fields) {
        if (field.conflict) {
          // Default to winner if not yet set
          initial[field.field] = choices[field.field] ?? 'winner';
        }
      }
      setChoices((prev) => ({ ...initial, ...prev }));
    }
  }, [previewQuery.data]);

  const mergeMutation = useMutation({
    mutationFn: async () => {
      const endpoint = entityType === 'contact' ? 'contacts' : 'accounts';
      return api(`/${endpoint}/${winnerId}/merge`, {
        method: 'POST',
        body: {
          loserId,
          fieldChoices: choices,
        },
      });
    },
    onSuccess: () => {
      notify('success', `Merged ${entityType} successfully`);
      onOpenChange(false);
      onSuccess(winnerId);
    },
    onError: (err) => {
      notify('error', err instanceof Error ? err.message : 'Merge failed');
    },
  });

  function handleSwap(): void {
    const nextWinner = loserId;
    const nextLoser = winnerId;
    setWinnerId(nextWinner);
    setLoserId(nextLoser);
    // Invert choices when swapped
    const inverted: Record<string, 'winner' | 'loser'> = {};
    for (const [k, v] of Object.entries(choices)) {
      inverted[k] = v === 'winner' ? 'loser' : 'winner';
    }
    setChoices(inverted);
  }

  const allConflictsResolved = conflicts.every(
    (c) => choices[c.field] === 'winner' || choices[c.field] === 'loser',
  );

  function formatValue(val: unknown): string {
    if (val === null || val === undefined || val === '') return '—';
    if (typeof val === 'object') {
      if ('amount' in (val as Record<string, unknown>)) {
        const c = val as { amount: number; currency?: string };
        return `${c.currency ?? 'USD'} ${c.amount}`;
      }
      return JSON.stringify(val);
    }
    return String(val);
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="3xl"
      title={`Merge ${entityType === 'contact' ? 'Contacts' : 'Accounts'}`}
      description="Select which values win for conflicting fields. All activity history and tags are preserved."
    >
      {previewQuery.isLoading ? (
        <div className="flex flex-col gap-3 py-6">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : previewQuery.isError ? (
        <div className="rounded bg-danger-soft p-4 text-sm text-danger">
          Could not load merge preview: {previewQuery.error?.message}
        </div>
      ) : !previewQuery.data ? (
        <EmptyState title="No preview available" description="Could not load record details." />
      ) : (
        <div className="flex flex-col gap-4">
          {/* Header comparison / swap bar */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface-raised p-3">
            <div className="flex items-center gap-2">
              <Badge tone="success">Primary (Winner)</Badge>
              <span className="font-semibold text-text-primary">
                {winnerId === primaryId ? primaryName ?? winnerId.slice(0, 8) : secondaryName ?? winnerId.slice(0, 8)}
              </span>
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={handleSwap}
              className="text-xs"
              title="Swap which record is the primary winner"
            >
              ⇄ Swap primary
            </Button>
            <div className="flex items-center gap-2">
              <Badge tone="neutral">Secondary (Will be archived)</Badge>
              <span className="font-medium text-text-secondary">
                {loserId === primaryId ? primaryName ?? loserId.slice(0, 8) : secondaryName ?? loserId.slice(0, 8)}
              </span>
            </div>
          </div>

          {/* Preserved data notice */}
          <div className="rounded border border-accent/20 bg-accent-soft/30 p-2.5 text-xs text-text-secondary">
            <p className="font-medium text-text-primary">History preservation guaranteed:</p>
            <ul className="mt-1 list-disc pl-4 space-y-0.5">
              <li>All notes and timeline activity from both records are preserved in the winner.</li>
              <li>
                Tags from both records will be merged: [
                {previewQuery.data.tags.merged.join(', ') || 'No tags'}].
              </li>
              {previewQuery.data.notesMoved !== undefined && (
                <li>{previewQuery.data.notesMoved} notes will be transferred.</li>
              )}
              {previewQuery.data.contactsMoved !== undefined && (
                <li>{previewQuery.data.contactsMoved} associated contacts will be linked to the winner.</li>
              )}
            </ul>
          </div>

          {/* Conflicts Resolution Table */}
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-warning">
              Conflicting Fields ({conflicts.length}) — Explicit Choice Required
            </h4>
            {conflicts.length === 0 ? (
              <p className="rounded border border-border p-3 text-xs text-text-secondary">
                No conflicts detected. Primary record values will be kept for all fields.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-warning/40">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-border bg-surface-raised text-text-secondary">
                    <tr>
                      <th className="px-3 py-2 font-medium">Field</th>
                      <th className="px-3 py-2 font-medium">Primary Record Value</th>
                      <th className="px-3 py-2 font-medium">Secondary Record Value</th>
                      <th className="px-3 py-2 font-medium">Winning Choice</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {conflicts.map((c) => {
                      const choice = choices[c.field] ?? 'winner';
                      return (
                        <tr key={c.field} className="hover:bg-surface-raised/50">
                          <td className="px-3 py-2 font-medium text-text-primary">{c.field}</td>
                          <td className="px-3 py-2 font-mono text-text-primary">
                            {formatValue(c.winner)}
                          </td>
                          <td className="px-3 py-2 font-mono text-text-secondary">
                            {formatValue(c.loser)}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => setChoices((prev) => ({ ...prev, [c.field]: 'winner' }))}
                                className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                                  choice === 'winner'
                                    ? 'bg-accent text-white'
                                    : 'border border-border bg-surface text-text-secondary hover:bg-surface-raised'
                                }`}
                              >
                                Primary
                              </button>
                              <button
                                type="button"
                                onClick={() => setChoices((prev) => ({ ...prev, [c.field]: 'loser' }))}
                                className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
                                  choice === 'loser'
                                    ? 'bg-accent text-white'
                                    : 'border border-border bg-surface text-text-secondary hover:bg-surface-raised'
                                }`}
                              >
                                Secondary
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Agreeing Fields */}
          {nonConflicts.length > 0 && (
            <details className="text-xs text-text-secondary">
              <summary className="cursor-pointer font-medium hover:text-text-primary">
                View matching / non-conflicting fields ({nonConflicts.length})
              </summary>
              <div className="mt-2 max-h-40 overflow-y-auto rounded border border-border p-2">
                <table className="w-full text-left">
                  <tbody className="divide-y divide-border/50">
                    {nonConflicts.map((nc) => (
                      <tr key={nc.field}>
                        <td className="py-1 font-medium">{nc.field}</td>
                        <td className="py-1 font-mono text-text-primary">
                          {formatValue(nc.winner ?? nc.loser)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={mergeMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => void mergeMutation.mutate()}
              disabled={!allConflictsResolved || mergeMutation.isPending}
            >
              {mergeMutation.isPending ? 'Merging...' : 'Confirm & Merge Records'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
