import { useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasScope, type DirectoryUser } from '../../lib/api';
import { useAuth } from '../../lib/providers';
import type {
  CatalogProduct,
  CustomFieldDef,
  DealLineItem,
  PipelineWithStages,
  SerializedDeal,
} from '../../lib/crm-types';
import { Badge, Button, Card, EmptyState, Field, Input, Skeleton } from '../../components/ui';
import { Modal } from '../../components/modal';
import { InlineEdit } from '../../components/inline-edit';
import { CommentsThread } from '../../components/comments-thread';
import { AttachmentsCard } from '../../components/attachments-card';
import { CustomFieldsRenderer } from '../../components/custom-fields-renderer';
import { useToast } from '../../components/toast';

interface StageHistoryEntry {
  id: string;
  fromStageName: string | null;
  toStageName: string;
  enteredAt: string;
  exitedAt: string | null;
  durationSeconds: number | null;
}

function money(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function DealDetailPage(): React.JSX.Element {
  const { id } = useParams({ strict: false }) as { id: string };
  const { user } = useAuth();
  const { notify } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [wonOpen, setWonOpen] = useState(false);
  const [lossOpen, setLossOpen] = useState(false);
  const [lossReason, setLossReason] = useState('');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pendingStageId, setPendingStageId] = useState<string | null>(null);

  const canManage = hasScope(user, 'deals:manage');

  const dealQuery = useQuery({
    queryKey: ['deal', id],
    queryFn: () => api<SerializedDeal>(`/deals/${id}`),
  });
  const historyQuery = useQuery({
    queryKey: ['deal-history', id],
    queryFn: () => api<StageHistoryEntry[]>(`/deals/${id}/history`),
  });
  const lineItemsQuery = useQuery({
    queryKey: ['deal-line-items', id],
    queryFn: () => api<DealLineItem[]>(`/deals/${id}/line-items`),
  });
  const pipelinesQuery = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => api<PipelineWithStages[]>('/pipelines'),
  });
  const customFieldDefs = useQuery({
    queryKey: ['custom-fields', 'deal'],
    queryFn: () => api<CustomFieldDef[]>('/custom-fields?entityType=deal'),
  });
  const usersQuery = useQuery({
    queryKey: ['users-list'],
    queryFn: () => api<{ users: DirectoryUser[] }>('/users'),
  });
  const accountsQuery = useQuery({
    queryKey: ['accounts-list'],
    queryFn: () => api<{ accounts: Array<{ id: string; name: string }> }>('/accounts?limit=200'),
  });
  const contactsQuery = useQuery({
    queryKey: ['contacts-list'],
    queryFn: () => api<{ contacts: Array<{ id: string; name: string }> }>('/contacts?limit=200'),
  });

  const deal = dealQuery.data ?? null;
  const pipeline = pipelinesQuery.data?.find((p) => p.pipeline.id === deal?.pipeline.id) ?? null;

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ['deal', id] });
    void queryClient.invalidateQueries({ queryKey: ['deal-history', id] });
    void queryClient.invalidateQueries({ queryKey: ['deal-line-items', id] });
    void queryClient.invalidateQueries({ queryKey: ['deals-board'] });
    void queryClient.invalidateQueries({ queryKey: ['deals-forecast'] });
  }

  const updateMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ deal: SerializedDeal }>(`/deals/${id}`, { method: 'PATCH', body }),
    onSuccess: ({ deal: updated }) => {
      queryClient.setQueryData(['deal', id], updated);
      refresh();
      notify('success', 'Deal updated');
    },
    onError: (err: Error) => {
      notify('error', err.message || 'Failed to update deal');
    },
  });

  const stageMutation = useMutation({
    mutationFn: (body: { stageId: string; lossReason?: string }) =>
      api<{ deal: SerializedDeal; changed: boolean }>(`/deals/${id}/stage`, {
        method: 'POST',
        body,
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(['deal', id], result.deal);
      refresh();
      notify('success', result.changed ? 'Deal stage updated' : 'Deal already in that stage');
    },
    onError: (err: Error) => {
      notify('error', err.message || 'Stage update failed');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api(`/deals/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      notify('success', 'Deal deleted');
      void navigate({ to: '/deals' });
    },
    onError: (err: Error) => {
      notify('error', err.message || 'Failed to delete deal');
    },
  });

  async function saveField(field: string, raw: string | null): Promise<void> {
    if (field === 'amount') {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Amount must be 0 or more');
      await updateMutation.mutateAsync({ amount: parsed });
      return;
    }
    if (field === 'probability') {
      if (raw === null || raw === '') {
        await updateMutation.mutateAsync({ probability: null });
        return;
      }
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
        throw new Error('Probability must be a whole number 0–100');
      }
      await updateMutation.mutateAsync({ probability: parsed });
      return;
    }
    if (field === 'expectedCloseDate') {
      await updateMutation.mutateAsync({ expectedCloseDate: raw || null });
      return;
    }
    await updateMutation.mutateAsync({ [field]: raw });
  }

  function requestStage(stageId: string): void {
    if (!deal || stageId === deal.stage.id) return;
    const target = pipeline?.stages.find((s) => s.id === stageId);
    if (!target) return;
    if (target.isClosedLost) {
      setLossReason('');
      setPendingStageId(stageId);
      setLossOpen(true);
      return;
    }
    if (target.isClosedWon && (lineItemsQuery.data ?? []).length === 0) {
      setPendingStageId(stageId);
      setWonOpen(true);
      return;
    }
    stageMutation.mutate({ stageId });
  }

  if (dealQuery.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (dealQuery.isError || !deal) {
    return (
      <EmptyState
        title="Deal not found"
        description="It may have been deleted or you may not have access to it."
        action={
          <Link to="/deals">
            <Button variant="secondary">Back to pipeline</Button>
          </Link>
        }
      />
    );
  }

  const stages = pipeline?.stages ?? [];
  const currentIdx = stages.findIndex((s) => s.id === deal.stage.id);
  const lineItems = lineItemsQuery.data ?? [];
  const history = historyQuery.data ?? [];
  const usersList = usersQuery.data?.users ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Link to="/deals" className="text-xs text-accent hover:underline">
            ← Back to pipeline
          </Link>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-text-primary">{deal.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
            <span className="font-semibold text-text-primary">
              {money(deal.amount, deal.currency)}
            </span>
            {deal.currency !== deal.baseCurrency && (
              <span>· {money(deal.baseAmount, deal.baseCurrency)} base</span>
            )}
            <Badge
              tone={deal.status === 'won' ? 'success' : deal.status === 'lost' ? 'danger' : 'info'}
            >
              {deal.status.toUpperCase()}
            </Badge>
            <Badge tone="info">{deal.effectiveProbability}%</Badge>
            {deal.closeDateStatus === 'overdue' && <Badge tone="warning">overdue</Badge>}
            {deal.closeDateStatus === 'due-soon' && <Badge tone="neutral">due soon</Badge>}
          </div>
        </div>
        {canManage && (
          <Button variant="danger" onClick={() => setDeleteOpen(true)} className="h-9 text-xs">
            Delete deal
          </Button>
        )}
      </div>

      {deal.status === 'lost' && deal.lossReason && (
        <div
          role="note"
          className="rounded-lg border border-danger bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          Lost: {deal.lossReason}
        </div>
      )}

      <Card
        title="Pipeline stage"
        description="Click a stage to move the deal. Closed stages confirm first."
      >
        {stages.length === 0 ? (
          <Skeleton className="h-12 w-full" />
        ) : (
          <div
            className="grid gap-1 rounded-lg bg-surface-sunken p-1"
            style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}
            role="group"
            aria-label="Deal stages"
          >
            {stages.map((stage, idx) => {
              const isCurrent = stage.id === deal.stage.id;
              const isPast = currentIdx >= 0 && idx < currentIdx;
              return (
                <button
                  key={stage.id}
                  type="button"
                  disabled={!canManage}
                  onClick={() => requestStage(stage.id)}
                  aria-current={isCurrent ? 'step' : undefined}
                  className={`flex flex-col items-center justify-center rounded px-1 py-2 text-xs transition-colors ${
                    isCurrent
                      ? 'bg-accent font-semibold text-white shadow-sm'
                      : isPast
                        ? 'bg-accent-soft font-medium text-accent'
                        : 'text-text-secondary hover:bg-surface-raised hover:text-text-primary'
                  } ${canManage ? 'cursor-pointer' : 'cursor-default'}`}
                >
                  <span className="text-[10px] opacity-80">Stage {idx + 1}</span>
                  <span>{stage.name}</span>
                  <span className="text-[10px] opacity-80">{stage.probability}%</span>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Card title="Deal details" description="Click any field to edit it inline.">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <InlineEdit
                label="Deal name"
                value={deal.name}
                readOnly={!canManage}
                onSave={(val) => saveField('name', val)}
              />
              <InlineEdit
                label={`Amount (${deal.currency})`}
                value={deal.amount}
                type="number"
                readOnly={!canManage}
                onSave={(val) => saveField('amount', val)}
              />
              <InlineEdit
                label="Close probability override (%)"
                value={deal.probability}
                type="number"
                readOnly={!canManage}
                onSave={(val) => saveField('probability', val || null)}
              />
              <InlineEdit
                label="Expected close date"
                value={deal.expectedCloseDate ? deal.expectedCloseDate.slice(0, 10) : ''}
                type="date"
                readOnly={!canManage}
                onSave={(val) => saveField('expectedCloseDate', val || null)}
              />
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label
                  htmlFor="deal-account"
                  className="mb-1 block text-xs font-medium text-text-secondary"
                >
                  Account
                </label>
                <select
                  id="deal-account"
                  value={deal.account?.id ?? ''}
                  disabled={!canManage}
                  onChange={(e) => updateMutation.mutate({ accountId: e.target.value || null })}
                  className="h-9 w-full rounded border border-border bg-surface px-2 text-xs"
                >
                  <option value="">No account</option>
                  {(accountsQuery.data?.accounts ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor="deal-contact"
                  className="mb-1 block text-xs font-medium text-text-secondary"
                >
                  Contact
                </label>
                <select
                  id="deal-contact"
                  value={deal.contact?.id ?? ''}
                  disabled={!canManage}
                  onChange={(e) => updateMutation.mutate({ contactId: e.target.value || null })}
                  className="h-9 w-full rounded border border-border bg-surface px-2 text-xs"
                >
                  <option value="">No contact</option>
                  {(contactsQuery.data?.contacts ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor="deal-owner"
                  className="mb-1 block text-xs font-medium text-text-secondary"
                >
                  Owner
                </label>
                <select
                  id="deal-owner"
                  value={deal.owner?.id ?? ''}
                  disabled={!canManage}
                  onChange={(e) => updateMutation.mutate({ ownerId: e.target.value || null })}
                  className="h-9 w-full rounded border border-border bg-surface px-2 text-xs"
                >
                  <option value="">Unassigned</option>
                  {usersList.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label
                  htmlFor="deal-forecast-category"
                  className="mb-1 block text-xs font-medium text-text-secondary"
                >
                  Forecast category
                </label>
                <select
                  id="deal-forecast-category"
                  value={String(deal.forecastCategory ?? 'pipeline')}
                  disabled={!canManage}
                  onChange={(e) => updateMutation.mutate({ forecastCategory: e.target.value })}
                  className="h-9 w-full rounded border border-border bg-surface px-2 text-xs"
                >
                  <option value="pipeline">Pipeline</option>
                  <option value="best_case">Best case</option>
                  <option value="commit">Commit</option>
                </select>
              </div>
            </div>
          </Card>

          <Card title="Custom fields" description="Deal-specific attributes.">
            <CustomFieldsRenderer
              defs={customFieldDefs.data ?? []}
              values={deal.customFields}
              computedValues={deal.computedFields}
              canManage={canManage}
              onSaveField={async (key, value) => {
                await updateMutation.mutateAsync({ customFields: { [key]: value } });
              }}
            />
          </Card>

          <Card
            title="Stage history"
            description="Every stage the deal has passed through, with time-in-stage."
          >
            {history.length === 0 ? (
              <p className="text-xs italic text-text-secondary">No stage history yet.</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {history.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex flex-wrap items-center gap-2 rounded border border-border px-3 py-2 text-xs"
                  >
                    <span className="font-medium">
                      {entry.fromStageName ?? 'Created'} → {entry.toStageName}
                    </span>
                    <span className="text-text-secondary">
                      {new Date(entry.enteredAt).toLocaleString()}
                      {entry.durationSeconds != null &&
                        ` · ${formatDuration(entry.durationSeconds)} in stage`}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-6">
          <Card title="Forecast" description="This deal's contribution.">
            <dl className="flex flex-col gap-2 text-xs">
              <div className="flex justify-between gap-2">
                <dt className="text-text-secondary">Base value</dt>
                <dd className="font-medium">{money(deal.baseAmount, deal.baseCurrency)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-text-secondary">Probability</dt>
                <dd className="font-medium">{deal.effectiveProbability}%</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-text-secondary">Weighted</dt>
                <dd className="font-medium text-accent">
                  {money(deal.weightedValue, deal.baseCurrency)}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-text-secondary">Rate snapshot</dt>
                <dd className="font-medium">
                  {deal.exchangeRate} · {deal.exchangeRateDate}
                </dd>
              </div>
            </dl>
          </Card>

          <Card
            title="Products & line items"
            description={
              lineItems.length === 0
                ? 'None yet — add the first line below.'
                : `${lineItems.length} line item${lineItems.length === 1 ? '' : 's'}`
            }
          >
            <LineItemsCard
              dealId={deal.id}
              dealCurrency={deal.currency}
              items={lineItems}
              canManage={canManage}
            />
          </Card>

          <CommentsThread entityType="deal" entityId={deal.id} />
          <AttachmentsCard entityType="deal" entityId={deal.id} />
        </div>
      </div>

      <Modal
        open={lossOpen}
        onClose={() => {
          setLossOpen(false);
          setPendingStageId(null);
        }}
        title="Close as lost"
        description="A loss reason is required. The move is stored together with the reason."
      >
        <div className="flex flex-col gap-3 pt-2">
          <Field label="Loss reason" htmlFor="detail-loss-reason">
            <Input
              id="detail-loss-reason"
              value={lossReason}
              onChange={(e) => setLossReason(e.target.value)}
              placeholder="e.g. Chose a competitor"
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                setLossOpen(false);
                setPendingStageId(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pendingStageId && lossReason.trim()) {
                  stageMutation.mutate({ stageId: pendingStageId, lossReason: lossReason.trim() });
                  setLossOpen(false);
                  setPendingStageId(null);
                }
              }}
              disabled={!lossReason.trim() || stageMutation.isPending}
            >
              {stageMutation.isPending ? 'Moving…' : 'Move to lost'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={wonOpen}
        onClose={() => {
          setWonOpen(false);
          setPendingStageId(null);
        }}
        title="Close as won"
        description={
          lineItems.length === 0
            ? 'This deal has no products or line items yet. Add them in “Products & line items” below, or proceed — this does not block the move.'
            : 'Confirm closing this deal as won.'
        }
      >
        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="secondary"
            onClick={() => {
              setWonOpen(false);
              setPendingStageId(null);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              if (pendingStageId) stageMutation.mutate({ stageId: pendingStageId });
              setWonOpen(false);
              setPendingStageId(null);
            }}
          >
            Confirm won
          </Button>
        </div>
      </Modal>

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Delete deal"
        description={`Delete "${deal.name}"? This action cannot be undone.`}
      >
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? 'Deleting…' : 'Delete deal'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)}m`;
  if (totalSeconds < 86400) return `${Math.floor(totalSeconds / 3600)}h`;
  return `${Math.floor(totalSeconds / 86400)}d`;
}

function LineItemsCard({
  dealId,
  dealCurrency,
  items,
  canManage,
}: {
  dealId: string;
  dealCurrency: string;
  items: DealLineItem[];
  canManage: boolean;
}): React.JSX.Element {
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'catalog' | 'custom'>('catalog');
  const [productId, setProductId] = useState('');
  const [customName, setCustomName] = useState('');
  const [customPrice, setCustomPrice] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [discountPct, setDiscountPct] = useState('0');
  const [taxPct, setTaxPct] = useState('0');
  const [formError, setFormError] = useState<string | null>(null);

  const productsQuery = useQuery({
    queryKey: ['products-catalog'],
    queryFn: () => api<CatalogProduct[]>('/products'),
  });
  const catalog = (productsQuery.data ?? []).filter((p) => p.isActive);

  async function refreshItems(): Promise<void> {
    await queryClient.invalidateQueries({ queryKey: ['deal-line-items', dealId] });
  }

  const addMutation = useMutation({
    mutationFn: async () => {
      const qty = Number(quantity);
      if (!Number.isFinite(qty) || qty <= 0) throw new Error('Quantity must be greater than 0');
      const discount = Number(discountPct) || 0;
      const tax = Number(taxPct) || 0;
      if (discount < 0 || discount > 100) throw new Error('Discount must be between 0 and 100%');
      if (tax < 0 || tax > 100) throw new Error('Tax must be between 0 and 100%');

      let resolvedProductId: string | undefined;
      const body: Record<string, unknown> = {
        quantity: qty,
        discountRate: discount / 100,
        taxRate: tax / 100,
      };
      if (mode === 'catalog') {
        if (!productId) throw new Error('Choose a catalog product first');
        resolvedProductId = productId;
        body['productId'] = productId;
      } else {
        if (!customName.trim()) throw new Error('Line name is required');
        const price = Number(customPrice);
        if (!Number.isFinite(price) || price < 0) throw new Error('Unit price must be 0 or more');
        body['name'] = customName.trim();
        body['unitPrice'] = price;
        body['currency'] = dealCurrency;
      }
      return api<{ lineItem: DealLineItem }>(`/deals/${dealId}/line-items`, {
        method: 'POST',
        body,
      }).then((result) => ({ result, resolvedProductId }));
    },
    onSuccess: () => {
      setProductId('');
      setCustomName('');
      setCustomPrice('');
      setQuantity('1');
      setDiscountPct('0');
      setTaxPct('0');
      setFormError(null);
      void refreshItems();
      notify('success', 'Line item added');
    },
    onError: (err: Error) => {
      setFormError(err.message || 'Failed to add line item');
    },
  });

  const removeMutation = useMutation({
    mutationFn: (lineId: string) =>
      api(`/deals/${dealId}/line-items/${lineId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void refreshItems();
      notify('success', 'Line item removed');
    },
    onError: (err: Error) => {
      notify('error', err.message || 'Failed to remove line item');
    },
  });

  const total = items.reduce((sum, item) => sum + Number(item.lineTotal || 0), 0);
  const currency = items[0]?.currency ?? dealCurrency;

  return (
    <div className="flex flex-col gap-3">
      {items.length === 0 ? (
        <p className="text-xs italic text-text-secondary">No products attached.</p>
      ) : (
        <>
          <ul className="flex flex-col gap-2 text-xs">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2"
              >
                <span className="font-medium">{item.name}</span>
                <span className="flex items-center gap-2 text-text-secondary">
                  <span>
                    {item.quantity} × {money(Number(item.unitPrice), item.currency)}
                    {Number(item.discountRate) > 0 &&
                      ` (−${Math.round(Number(item.discountRate) * 100)}%)`}
                    {` = ${money(Number(item.lineTotal), item.currency)}`}
                  </span>
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => removeMutation.mutate(item.id)}
                      className="rounded px-1.5 py-0.5 text-danger hover:bg-danger-soft"
                      aria-label={`Remove ${item.name}`}
                    >
                      Remove
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-right text-xs font-semibold">
            Total: {money(Math.round(total * 100) / 100, currency)}
          </p>
        </>
      )}

      {canManage && (
        <form
          className="flex flex-col gap-2 rounded border border-dashed border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            addMutation.mutate();
          }}
        >
          <div className="flex gap-2 text-xs" role="group" aria-label="Line item source">
            <button
              type="button"
              onClick={() => setMode('catalog')}
              aria-pressed={mode === 'catalog'}
              className={`rounded px-2 py-1 font-semibold ${mode === 'catalog' ? 'bg-accent text-white' : 'bg-surface-raised'}`}
            >
              Catalog product
            </button>
            <button
              type="button"
              onClick={() => setMode('custom')}
              aria-pressed={mode === 'custom'}
              className={`rounded px-2 py-1 font-semibold ${mode === 'custom' ? 'bg-accent text-white' : 'bg-surface-raised'}`}
            >
              Custom line
            </button>
          </div>

          {mode === 'catalog' ? (
            <Field label="Product" htmlFor="line-product">
              <select
                id="line-product"
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
                className="h-9 rounded border border-border bg-surface px-2 text-xs"
              >
                <option value="">Select a product…</option>
                {catalog.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {money(Number(p.unitPrice), p.currency)}
                  </option>
                ))}
              </select>
            </Field>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Line name" htmlFor="line-name">
                <Input
                  id="line-name"
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  placeholder="Onboarding package"
                />
              </Field>
              <Field label={`Unit price (${dealCurrency})`} htmlFor="line-price">
                <Input
                  id="line-price"
                  inputMode="decimal"
                  value={customPrice}
                  onChange={(e) => setCustomPrice(e.target.value)}
                  placeholder="750"
                />
              </Field>
            </div>
          )}

          <div className="grid grid-cols-3 gap-2">
            <Field label="Qty" htmlFor="line-qty">
              <Input
                id="line-qty"
                inputMode="decimal"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </Field>
            <Field label="Discount %" htmlFor="line-discount">
              <Input
                id="line-discount"
                inputMode="decimal"
                value={discountPct}
                onChange={(e) => setDiscountPct(e.target.value)}
              />
            </Field>
            <Field label="Tax %" htmlFor="line-tax">
              <Input
                id="line-tax"
                inputMode="decimal"
                value={taxPct}
                onChange={(e) => setTaxPct(e.target.value)}
              />
            </Field>
          </div>

          {formError && (
            <div role="alert" className="rounded bg-danger-soft p-2 text-xs text-danger">
              {formError}
            </div>
          )}
          <div className="flex justify-end">
            <Button type="submit" variant="secondary" disabled={addMutation.isPending}>
              {addMutation.isPending ? 'Adding…' : 'Add line item'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
