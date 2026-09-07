import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasScope, type DirectoryUser } from '../../lib/api';
import { useAuth } from '../../lib/providers';
import type {
  DealLineItem,
  ForecastResponse,
  PipelineWithStages,
  SerializedDeal,
} from '../../lib/crm-types';
import { Badge, Button, Card, EmptyState, Field, Input, Skeleton } from '../../components/ui';
import { Modal } from '../../components/modal';
import { useToast } from '../../components/toast';

interface DealsListResponse {
  deals: SerializedDeal[];
  nextCursor: string | null;
}

function money(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function PipelineBoardPage(): React.JSX.Element {
  const { user } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();

  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [minProbability, setMinProbability] = useState(0);
  const [closeFrom, setCloseFrom] = useState('');
  const [closeTo, setCloseTo] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [lossPrompt, setLossPrompt] = useState<{ deal: SerializedDeal; stageId: string } | null>(
    null,
  );
  const [wonPrompt, setWonPrompt] = useState<{ deal: SerializedDeal; stageId: string } | null>(
    null,
  );
  const [lossReason, setLossReason] = useState('');
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const canManage = hasScope(user, 'deals:manage');

  const pipelinesQuery = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => api<PipelineWithStages[]>('/pipelines'),
  });
  const pipelines = pipelinesQuery.data ?? [];
  const activePipelineId =
    pipelineId ??
    pipelines.find((p) => p.pipeline.isDefault)?.pipeline.id ??
    pipelines[0]?.pipeline.id ??
    null;
  const activePipeline = pipelines.find((p) => p.pipeline.id === activePipelineId) ?? null;

  const usersQuery = useQuery({
    queryKey: ['users-list'],
    queryFn: () => api<{ users: DirectoryUser[] }>('/users'),
    enabled: hasScope(user, 'users:read'),
  });

  const dealsKey = ['deals-board', activePipelineId, ownerFilter, statusFilter];
  const dealsQuery = useQuery({
    queryKey: dealsKey,
    queryFn: () => {
      const params = new URLSearchParams({ limit: '200' });
      if (activePipelineId) params.set('pipelineId', activePipelineId);
      if (ownerFilter !== 'all') params.set('ownerId', ownerFilter);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      return api<DealsListResponse>(`/deals?${params.toString()}`);
    },
    enabled: activePipelineId !== null,
  });

  const forecastQuery = useQuery({
    queryKey: ['deals-forecast', activePipelineId, ownerFilter, statusFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (activePipelineId) params.set('pipelineId', activePipelineId);
      if (ownerFilter !== 'all') params.set('ownerId', ownerFilter);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      return api<ForecastResponse>(`/deals/forecast/by-pipeline?${params.toString()}`);
    },
    enabled: activePipelineId !== null,
  });

  const deals = useMemo(() => {
    const all = dealsQuery.data?.deals ?? [];
    return all.filter((deal) => {
      if (deal.effectiveProbability < minProbability) return false;
      if (closeFrom && deal.expectedCloseDate && deal.expectedCloseDate.slice(0, 10) < closeFrom) {
        return false;
      }
      if (closeTo && deal.expectedCloseDate && deal.expectedCloseDate.slice(0, 10) > closeTo) {
        return false;
      }
      if ((closeFrom || closeTo) && !deal.expectedCloseDate) return false;
      return true;
    });
  }, [dealsQuery.data, minProbability, closeFrom, closeTo]);

  const byStage = useMemo(() => {
    const map = new Map<string, SerializedDeal[]>();
    for (const deal of deals) {
      const list = map.get(deal.stage.id) ?? [];
      list.push(deal);
      map.set(deal.stage.id, list);
    }
    return map;
  }, [deals]);

  const moveMutation = useMutation({
    mutationFn: (input: { id: string; stageId: string; lossReason?: string }) =>
      api<{ deal: SerializedDeal; changed: boolean }>(`/deals/${input.id}/stage`, {
        method: 'POST',
        body: {
          stageId: input.stageId,
          ...(input.lossReason ? { lossReason: input.lossReason } : {}),
        },
      }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: dealsKey });
      const previous = queryClient.getQueryData<DealsListResponse>(dealsKey);
      queryClient.setQueryData<DealsListResponse>(dealsKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          deals: old.deals.map((deal) =>
            deal.id === input.id ? { ...deal, stage: { ...deal.stage, id: input.stageId } } : deal,
          ),
        };
      });
      return { previous };
    },
    onError: (err: Error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(dealsKey, context.previous);
      notify(
        'error',
        `Stage update failed (${err.message || 'unknown error'}) — change was rolled back`,
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: dealsKey });
      void queryClient.invalidateQueries({ queryKey: ['deals-forecast'] });
    },
    onSuccess: () => {
      notify('success', 'Deal stage updated');
    },
  });

  async function requestMove(deal: SerializedDeal, stageId: string): Promise<void> {
    if (stageId === deal.stage.id) return;
    const target = activePipeline?.stages.find((s) => s.id === stageId);
    if (!target) return;
    if (target.isClosedLost) {
      setLossReason('');
      setLossPrompt({ deal, stageId });
      return;
    }
    if (target.isClosedWon) {
      const items = await api<DealLineItem[]>(`/deals/${deal.id}/line-items`).catch(() => null);
      if (items && items.length === 0) {
        setWonPrompt({ deal, stageId });
        return;
      }
    }
    moveMutation.mutate({ id: deal.id, stageId });
  }

  function confirmLossMove(): void {
    if (!lossPrompt || !lossReason.trim()) return;
    moveMutation.mutate({
      id: lossPrompt.deal.id,
      stageId: lossPrompt.stageId,
      lossReason: lossReason.trim(),
    });
    setLossPrompt(null);
  }

  const forecast = forecastQuery.data;
  const usersList = usersQuery.data?.users ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Pipeline</h1>
          {forecast && (
            <p className="mt-1 text-xs text-text-secondary" aria-live="polite">
              {forecast.totals.dealCount} open deals ·{' '}
              {money(forecast.totals.totalBaseAmount, forecast.baseCurrency)} pipeline ·{' '}
              <span className="font-semibold text-accent">
                {money(forecast.totals.weightedValue, forecast.baseCurrency)} weighted
              </span>
            </p>
          )}
        </div>
        {canManage && (
          <Button variant="primary" onClick={() => setCreateOpen(true)} className="h-9 text-xs">
            + New Deal
          </Button>
        )}
      </div>

      <Card title="" description="">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label
              htmlFor="board-pipeline"
              className="mb-1 block text-xs font-medium text-text-secondary"
            >
              Pipeline
            </label>
            <select
              id="board-pipeline"
              value={activePipelineId ?? ''}
              onChange={(e) => setPipelineId(e.target.value || null)}
              className="h-9 rounded border border-border bg-surface px-2.5 text-xs"
            >
              {pipelines.map((p) => (
                <option key={p.pipeline.id} value={p.pipeline.id}>
                  {p.pipeline.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="board-owner"
              className="mb-1 block text-xs font-medium text-text-secondary"
            >
              Rep
            </label>
            <select
              id="board-owner"
              value={ownerFilter}
              onChange={(e) => setOwnerFilter(e.target.value)}
              className="h-9 rounded border border-border bg-surface px-2.5 text-xs"
            >
              <option value="all">All reps</option>
              {usersList.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="board-status"
              className="mb-1 block text-xs font-medium text-text-secondary"
            >
              Status
            </label>
            <select
              id="board-status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-9 rounded border border-border bg-surface px-2.5 text-xs"
            >
              <option value="all">All</option>
              <option value="open">Open</option>
              <option value="won">Won</option>
              <option value="lost">Lost</option>
            </select>
          </div>
          <div>
            <label
              htmlFor="board-probability"
              className="mb-1 block text-xs font-medium text-text-secondary"
            >
              Min probability ({minProbability}%)
            </label>
            <input
              id="board-probability"
              type="range"
              min={0}
              max={100}
              step={10}
              value={minProbability}
              onChange={(e) => setMinProbability(Number(e.target.value))}
              className="h-9 w-32 accent-[var(--accent)]"
            />
          </div>
          <div>
            <label
              htmlFor="board-from"
              className="mb-1 block text-xs font-medium text-text-secondary"
            >
              Close from
            </label>
            <input
              id="board-from"
              type="date"
              value={closeFrom}
              onChange={(e) => setCloseFrom(e.target.value)}
              className="h-9 rounded border border-border bg-surface px-2 text-xs"
            />
          </div>
          <div>
            <label
              htmlFor="board-to"
              className="mb-1 block text-xs font-medium text-text-secondary"
            >
              Close to
            </label>
            <input
              id="board-to"
              type="date"
              value={closeTo}
              onChange={(e) => setCloseTo(e.target.value)}
              className="h-9 rounded border border-border bg-surface px-2 text-xs"
            />
          </div>
        </div>
      </Card>

      {pipelinesQuery.isLoading || dealsQuery.isLoading ? (
        <div className="grid auto-cols-[280px] grid-flow-col gap-3 overflow-x-auto pb-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-64 w-[280px]" />
          ))}
        </div>
      ) : !activePipeline || activePipeline.stages.length === 0 ? (
        <EmptyState
          title="No pipeline stages"
          description="Create stages for this pipeline before tracking deals on the board."
        />
      ) : (
        <div
          className="grid auto-cols-[280px] grid-flow-col gap-3 overflow-x-auto pb-2"
          role="list"
          aria-label="Pipeline stages"
        >
          {activePipeline.stages.map((stage) => {
            const summary = forecast?.stages.find((s) => s.stage.id === stage.id);
            const cards = byStage.get(stage.id) ?? [];
            return (
              <section
                key={stage.id}
                role="listitem"
                aria-label={`${stage.name} column`}
                onDragOver={(e) => {
                  if (canManage) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const dealId = e.dataTransfer.getData('text/deal-id');
                  const deal = deals.find((d) => d.id === dealId);
                  if (deal) void requestMove(deal, stage.id);
                  setDraggingId(null);
                }}
                className="flex max-h-[70vh] flex-col rounded-lg border border-border bg-surface-raised/60"
              >
                <header className="border-b border-border px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-xs font-semibold text-text-primary">{stage.name}</h2>
                    {stage.isClosedWon && <Badge tone="success">Won</Badge>}
                    {stage.isClosedLost && <Badge tone="danger">Lost</Badge>}
                  </div>
                  <p className="mt-0.5 text-[11px] text-text-secondary" aria-live="polite">
                    {summary ? (
                      <>
                        {summary.dealCount} ·{' '}
                        {money(summary.totalBaseAmount, forecast?.baseCurrency ?? 'USD')} ·{' '}
                        <span className="font-medium text-accent">
                          {money(summary.weightedValue, forecast?.baseCurrency ?? 'USD')}
                        </span>
                        {summary.overdueCount > 0 && (
                          <span className="ml-1 font-medium text-warning">
                            · {summary.overdueCount} overdue
                          </span>
                        )}
                      </>
                    ) : (
                      `${cards.length} deals`
                    )}
                  </p>
                </header>
                <div className="flex flex-col gap-2 overflow-y-auto p-2">
                  {cards.length === 0 ? (
                    <p className="rounded border border-dashed border-border px-3 py-6 text-center text-[11px] text-text-secondary">
                      No deals — drop cards here
                    </p>
                  ) : (
                    cards.map((deal) => (
                      <DealCard
                        key={deal.id}
                        deal={deal}
                        stages={activePipeline.stages}
                        canManage={canManage}
                        dragging={draggingId === deal.id}
                        onDragStart={() => setDraggingId(deal.id)}
                        onDragEnd={() => setDraggingId(null)}
                        onMove={(stageId) => void requestMove(deal, stageId)}
                      />
                    ))
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <CreateDealModal
        open={createOpen}
        pipelineId={activePipelineId}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          void queryClient.invalidateQueries({ queryKey: ['deals-board'] });
          void queryClient.invalidateQueries({ queryKey: ['deals-forecast'] });
        }}
      />

      <Modal
        open={lossPrompt !== null}
        onClose={() => setLossPrompt(null)}
        title="Close as lost"
        description={`A loss reason is required to move "${lossPrompt?.deal.name}" to a closed-lost stage.`}
      >
        <div className="flex flex-col gap-3 pt-2">
          <Field label="Loss reason" htmlFor="loss-reason">
            <Input
              id="loss-reason"
              value={lossReason}
              onChange={(e) => setLossReason(e.target.value)}
              placeholder="e.g. Chose a competitor"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setLossPrompt(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={confirmLossMove}
              disabled={!lossReason.trim() || moveMutation.isPending}
            >
              {moveMutation.isPending ? 'Moving…' : 'Move to lost'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={wonPrompt !== null}
        onClose={() => setWonPrompt(null)}
        title="Close as won"
        description={`"${wonPrompt?.deal.name}" has no products or line items yet. You can proceed — this does not block the move.`}
      >
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setWonPrompt(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              if (wonPrompt)
                moveMutation.mutate({ id: wonPrompt.deal.id, stageId: wonPrompt.stageId });
              setWonPrompt(null);
            }}
          >
            Proceed without products
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function DealCard({
  deal,
  stages,
  canManage,
  dragging,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  deal: SerializedDeal;
  stages: PipelineWithStages['stages'];
  canManage: boolean;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (stageId: string) => void;
}): React.JSX.Element {
  return (
    <article
      aria-label={`Deal ${deal.name}`}
      draggable={canManage}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/deal-id', deal.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={`rounded-lg border bg-surface p-3 shadow-subtle transition-opacity ${
        dragging ? 'opacity-40' : ''
      } ${deal.closeDateStatus === 'overdue' ? 'border-l-4 border-l-warning' : 'border-border'}`}
    >
      <p className="text-xs font-semibold text-text-primary">
        <Link to="/deals/$id" params={{ id: deal.id }} className="hover:underline">
          {deal.name}
        </Link>
      </p>
      <p className="mt-0.5 text-[11px] text-text-secondary">
        {money(deal.amount, deal.currency)}
        {deal.currency !== deal.baseCurrency && (
          <span> · {money(deal.baseAmount, deal.baseCurrency)}</span>
        )}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Badge tone="info">{deal.effectiveProbability}%</Badge>
        <span className="text-[11px] font-medium text-accent">
          {money(deal.weightedValue, deal.baseCurrency)}
        </span>
        {deal.closeDateStatus === 'overdue' && <Badge tone="warning">overdue</Badge>}
        {deal.closeDateStatus === 'due-soon' && <Badge tone="neutral">due soon</Badge>}
      </div>
      {deal.owner && <p className="mt-1 text-[11px] text-text-secondary">{deal.owner.name}</p>}
      {canManage && (
        <label className="mt-2 block text-[11px] text-text-secondary">
          Move to
          <select
            aria-label={`Move ${deal.name} to stage`}
            value={deal.stage.id}
            onChange={(e) => onMove(e.target.value)}
            className="ml-1 h-7 rounded border border-border bg-surface px-1 text-[11px]"
          >
            {stages.map((stage) => (
              <option key={stage.id} value={stage.id}>
                {stage.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </article>
  );
}

function CreateDealModal({
  open,
  pipelineId,
  onClose,
  onCreated,
}: {
  open: boolean;
  pipelineId: string | null;
  onClose: () => void;
  onCreated: () => void;
}): React.JSX.Element {
  const { notify } = useToast();
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('1000');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    const parsed = Number(amount);
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    if (!Number.isFinite(parsed) || parsed < 0) {
      setError('Amount must be a number greater than or equal to 0');
      return;
    }
    setPending(true);
    try {
      await api('/deals', {
        method: 'POST',
        body: { name: name.trim(), amount: parsed, ...(pipelineId ? { pipelineId } : {}) },
      });
      notify('success', `Deal "${name.trim()}" created`);
      setName('');
      setAmount('1000');
      onClose();
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New Deal"
      description="Deals open in the pipeline's first stage."
    >
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3 pt-2">
        {error && (
          <div role="alert" className="rounded bg-danger-soft p-3 text-xs text-danger">
            {error}
          </div>
        )}
        <Field label="Deal name" htmlFor="new-deal-name">
          <Input
            id="new-deal-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme expansion"
          />
        </Field>
        <Field label="Amount (USD)" htmlFor="new-deal-amount">
          <Input
            id="new-deal-amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="1000"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Creating…' : 'Create Deal'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
