import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasScope } from '../../lib/api';
import { useAuth } from '../../lib/providers';
import { Badge, Button, Card, EmptyState, Field, Input, Skeleton } from '../../components/ui';
import { Modal } from '../../components/modal';
import { useToast } from '../../components/toast';

interface WorkflowDto {
  id: string;
  owner: { id: string; name: string } | null;
  name: string;
  isActive: boolean;
  trigger: Record<string, unknown>;
  conditions: Array<Record<string, unknown>>;
  actions: Array<Record<string, unknown>>;
  maxRuns: number;
}

interface WorkflowsResponse {
  workflows: WorkflowDto[];
  nextCursor: string | null;
}

interface RunDto {
  id: string;
  status: string;
  error: string | null;
  actionResults: Array<Record<string, unknown>>;
  createdAt: string;
}

interface RunsResponse {
  runs: RunDto[];
  nextCursor: string | null;
}

const TRIGGER_KINDS = ['record.created', 'field.changed', 'stage.changed', 'time.elapsed'] as const;
const ENTITIES = ['deal', 'contact', 'task'] as const;
const OPERATORS = ['equals', 'not_equals', 'greater_than', 'less_than', 'contains'] as const;
const ACTION_TYPES = ['create_task', 'update_field', 'send_email', 'call_webhook'] as const;

function triggerSummary(trigger: Record<string, unknown>): string {
  const kind = String(trigger['kind'] ?? '?');
  const entity = String(trigger['entity'] ?? '');
  const extra =
    typeof trigger['field'] === 'string'
      ? ` ${trigger['field']}`
      : typeof trigger['toStageKey'] === 'string'
        ? ` → ${trigger['toStageKey']}`
        : typeof trigger['hoursAfter'] === 'number'
          ? ` +${String(trigger['hoursAfter'])}h`
          : '';
  return `${kind} ${entity}${extra}`.trim();
}

export function WorkflowsPage(): React.JSX.Element {
  const { user } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const canManage = hasScope(user, 'workflows:manage');

  const workflowsQuery = useQuery({
    queryKey: ['workflows'],
    queryFn: () => api<WorkflowsResponse>('/workflows'),
  });

  const runsQuery = useQuery({
    queryKey: ['workflow-runs', selectedId],
    queryFn: () => api<RunsResponse>(`/workflows/${selectedId}/runs?limit=20`),
    enabled: selectedId !== null,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api(`/workflows/${id}`, { method: 'PATCH', body: { isActive } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
      notify('success', 'Workflow updated');
    },
    onError: (err: Error) => notify('error', err.message || 'Update failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/workflows/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setSelectedId(null);
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
      notify('success', 'Workflow deleted');
    },
    onError: (err: Error) => notify('error', err.message || 'Delete failed'),
  });

  const boards = workflowsQuery.data?.workflows ?? [];
  const selected = boards.find((b) => b.id === selectedId) ?? null;
  const runs = runsQuery.data?.runs ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Workflows</h1>
          <p className="mt-1 text-xs text-text-secondary">
            Trigger → conditions → actions. Cascades stop after each rule&apos;s max runs.
          </p>
        </div>
        {canManage && (
          <Button variant="primary" onClick={() => setCreateOpen(true)} className="h-9 text-xs">
            + New Workflow
          </Button>
        )}
      </div>

      <Card title="Automation rules" description="">
        {workflowsQuery.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : boards.length === 0 ? (
          <EmptyState
            title="No workflows yet"
            description="Automate follow-ups, alerts, and syncs."
          />
        ) : (
          <ul className="flex flex-col gap-2 text-xs">
            {boards.map((flow) => (
              <li
                key={flow.id}
                aria-label={`Workflow ${flow.name}`}
                className="flex flex-col gap-1 rounded border border-border px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <button
                  type="button"
                  onClick={() => setSelectedId(flow.id)}
                  className="text-left font-medium hover:underline"
                >
                  {flow.name}
                </button>
                <span className="flex items-center gap-2 text-text-secondary">
                  <span>{triggerSummary(flow.trigger)}</span>
                  <Badge tone={flow.isActive ? 'success' : 'neutral'}>
                    {flow.isActive ? 'active' : 'paused'}
                  </Badge>
                  <span>
                    {flow.actions.length} action{flow.actions.length === 1 ? '' : 's'}
                  </span>
                  {canManage && (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          toggleMutation.mutate({ id: flow.id, isActive: !flow.isActive })
                        }
                        className="rounded px-1.5 py-0.5 text-accent hover:bg-surface-raised"
                        aria-label={`${flow.isActive ? 'Pause' : 'Resume'} workflow ${flow.name}`}
                      >
                        {flow.isActive ? 'Pause' : 'Resume'}
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteMutation.mutate(flow.id)}
                        className="rounded px-1.5 py-0.5 text-danger hover:bg-danger-soft"
                        aria-label={`Delete workflow ${flow.name}`}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {selected && (
        <Card
          title={`Runs · ${selected.name}`}
          description="Latest executions with per-action results."
        >
          {runsQuery.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : runs.length === 0 ? (
            <p className="text-xs italic text-text-secondary">No runs yet.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-xs">
              {runs.map((run) => (
                <li key={run.id} className="rounded border border-border px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Badge
                      tone={
                        run.status === 'success'
                          ? 'success'
                          : run.status === 'failed'
                            ? 'danger'
                            : 'neutral'
                      }
                    >
                      {run.status}
                    </Badge>
                    <span className="text-text-secondary">
                      {new Date(run.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {run.error && <p className="mt-1 text-danger">{run.error}</p>}
                  {run.actionResults.length > 0 && (
                    <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-surface-sunken p-2 text-[11px]">
                      {JSON.stringify(run.actionResults, null, 1)}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <CreateWorkflowModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => void queryClient.invalidateQueries({ queryKey: ['workflows'] })}
      />
    </div>
  );
}

interface DraftCondition {
  field: string;
  operator: string;
  value: string;
}

interface DraftAction {
  type: string;
  title: string;
  field: string;
  value: string;
  to: string;
  subject: string;
  body: string;
  url: string;
}

const EMPTY_ACTION: DraftAction = {
  type: 'create_task',
  title: '',
  field: 'priority',
  value: '',
  to: '',
  subject: '',
  body: '',
  url: '',
};

function CreateWorkflowModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}): React.JSX.Element {
  const { notify } = useToast();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<string>('record.created');
  const [entity, setEntity] = useState<string>('contact');
  const [field, setField] = useState('probability');
  const [toStageKey, setToStageKey] = useState('proposal');
  const [hoursAfter, setHoursAfter] = useState('24');
  const [conditions, setConditions] = useState<DraftCondition[]>([]);
  const [actions, setActions] = useState<DraftAction[]>([{ ...EMPTY_ACTION }]);
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: async (): Promise<{ workflow: WorkflowDto }> => {
      if (!name.trim()) throw new Error('Name is required');
      if (actions.length === 0) throw new Error('Add at least one action');
      const trigger: Record<string, unknown> = { kind, entity };
      if (kind === 'field.changed') trigger['field'] = field.trim() || 'probability';
      if (kind === 'stage.changed') trigger['toStageKey'] = toStageKey.trim() || undefined;
      if (kind === 'time.elapsed') {
        const hours = Number(hoursAfter);
        if (!Number.isFinite(hours) || hours <= 0) throw new Error('Hours must be positive');
        trigger['hoursAfter'] = hours;
      }
      const parsedActions = actions.map((a, idx) => {
        if (a.type === 'create_task') {
          if (!a.title.trim()) throw new Error(`Action ${idx + 1}: title is required`);
          return { type: 'create_task', title: a.title.trim() };
        }
        if (a.type === 'update_field') {
          if (!a.field.trim()) throw new Error(`Action ${idx + 1}: field is required`);
          return { type: 'update_field', entity, field: a.field.trim(), value: a.value };
        }
        if (a.type === 'send_email') {
          if (!a.to.trim() || !a.subject.trim() || !a.body.trim()) {
            throw new Error(`Action ${idx + 1}: recipient, subject, and body are required`);
          }
          return {
            type: 'send_email',
            to: a.to.trim(),
            subject: a.subject.trim(),
            body: a.body.trim(),
          };
        }
        if (!a.url.trim()) throw new Error(`Action ${idx + 1}: URL is required`);
        return { type: 'call_webhook', url: a.url.trim() };
      });
      return api<{ workflow: WorkflowDto }>('/workflows', {
        method: 'POST',
        body: {
          name: name.trim(),
          trigger,
          conditions: conditions
            .filter((c) => c.field.trim())
            .map((c) => ({ field: c.field.trim(), operator: c.operator, value: c.value })),
          actions: parsedActions,
        },
      });
    },
    onSuccess: ({ workflow }) => {
      setName('');
      setConditions([]);
      setActions([{ ...EMPTY_ACTION }]);
      setError(null);
      onClose();
      onCreated();
      notify('success', `Workflow "${workflow.name}" created`);
    },
    onError: (err: Error) => setError(err.message || 'Failed to create workflow'),
  });

  function patchAction(idx: number, patch: Partial<DraftAction>): void {
    setActions((prev) => prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New Workflow"
      description="Trigger → optional conditions → actions."
      size="lg"
    >
      <form
        className="flex flex-col gap-3 pt-2"
        onSubmit={(e) => {
          e.preventDefault();
          createMutation.mutate();
        }}
      >
        {error && (
          <div role="alert" className="rounded bg-danger-soft p-3 text-xs text-danger">
            {error}
          </div>
        )}
        <Field label="Workflow name" htmlFor="wf-name">
          <Input
            id="wf-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Welcome new contacts"
          />
        </Field>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Field label="Trigger" htmlFor="wf-kind">
            <select
              id="wf-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className="h-9 rounded border border-border bg-surface px-2 text-xs"
            >
              {TRIGGER_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Entity" htmlFor="wf-entity">
            <select
              id="wf-entity"
              value={entity}
              onChange={(e) => setEntity(e.target.value)}
              className="h-9 rounded border border-border bg-surface px-2 text-xs"
            >
              {ENTITIES.map((en) => (
                <option key={en} value={en}>
                  {en}
                </option>
              ))}
            </select>
          </Field>
          {kind === 'field.changed' && (
            <Field label="Changed field" htmlFor="wf-field">
              <Input id="wf-field" value={field} onChange={(e) => setField(e.target.value)} />
            </Field>
          )}
          {kind === 'stage.changed' && (
            <Field label="To stage key" htmlFor="wf-stage">
              <Input
                id="wf-stage"
                value={toStageKey}
                onChange={(e) => setToStageKey(e.target.value)}
              />
            </Field>
          )}
          {kind === 'time.elapsed' && (
            <Field label="Hours after created" htmlFor="wf-hours">
              <Input
                id="wf-hours"
                inputMode="numeric"
                value={hoursAfter}
                onChange={(e) => setHoursAfter(e.target.value)}
              />
            </Field>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold">Conditions (all must match)</span>
            <Button
              type="button"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() =>
                setConditions((prev) => [...prev, { field: '', operator: 'equals', value: '' }])
              }
            >
              + Add condition
            </Button>
          </div>
          {conditions.map((c, idx) => (
            <div key={idx} className="grid grid-cols-[1fr_110px_1fr_auto] items-end gap-1">
              <Field label={idx === 0 ? 'Field' : ''} htmlFor={`wf-cond-field-${idx}`}>
                <Input
                  id={`wf-cond-field-${idx}`}
                  value={c.field}
                  onChange={(e) =>
                    setConditions((prev) =>
                      prev.map((row, i) => (i === idx ? { ...row, field: e.target.value } : row)),
                    )
                  }
                  placeholder="amount"
                />
              </Field>
              <Field label={idx === 0 ? 'Operator' : ''} htmlFor={`wf-cond-op-${idx}`}>
                <select
                  id={`wf-cond-op-${idx}`}
                  value={c.operator}
                  onChange={(e) =>
                    setConditions((prev) =>
                      prev.map((row, i) =>
                        i === idx ? { ...row, operator: e.target.value } : row,
                      ),
                    )
                  }
                  className="h-9 rounded border border-border bg-surface px-1 text-xs"
                >
                  {OPERATORS.map((op) => (
                    <option key={op} value={op}>
                      {op}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={idx === 0 ? 'Value' : ''} htmlFor={`wf-cond-value-${idx}`}>
                <Input
                  id={`wf-cond-value-${idx}`}
                  value={c.value}
                  onChange={(e) =>
                    setConditions((prev) =>
                      prev.map((row, i) => (i === idx ? { ...row, value: e.target.value } : row)),
                    )
                  }
                  placeholder="1000"
                />
              </Field>
              <Button
                type="button"
                variant="ghost"
                className="h-9 px-2 text-xs text-danger"
                onClick={() => setConditions((prev) => prev.filter((_, i) => i !== idx))}
                aria-label={`Remove condition ${idx + 1}`}
              >
                ✕
              </Button>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold">Actions (run in order)</span>
            <Button
              type="button"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => setActions((prev) => [...prev, { ...EMPTY_ACTION }])}
            >
              + Add action
            </Button>
          </div>
          {actions.map((a, idx) => (
            <div key={idx} className="flex flex-col gap-2 rounded border border-border p-2">
              <div className="grid grid-cols-[130px_1fr_auto] items-end gap-1">
                <Field label={idx === 0 ? 'Type' : ''} htmlFor={`wf-act-type-${idx}`}>
                  <select
                    id={`wf-act-type-${idx}`}
                    value={a.type}
                    onChange={(e) => patchAction(idx, { type: e.target.value })}
                    className="h-9 rounded border border-border bg-surface px-1 text-xs"
                  >
                    {ACTION_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </Field>
                {a.type === 'create_task' && (
                  <Field label={idx === 0 ? 'Task title' : ''} htmlFor={`wf-act-title-${idx}`}>
                    <Input
                      id={`wf-act-title-${idx}`}
                      value={a.title}
                      onChange={(e) => patchAction(idx, { title: e.target.value })}
                      placeholder="Follow up"
                    />
                  </Field>
                )}
                {a.type === 'update_field' && (
                  <>
                    <Field label={idx === 0 ? 'Field' : ''} htmlFor={`wf-act-field-${idx}`}>
                      <Input
                        id={`wf-act-field-${idx}`}
                        value={a.field}
                        onChange={(e) => patchAction(idx, { field: e.target.value })}
                        placeholder="priority"
                      />
                    </Field>
                    <Field label={idx === 0 ? 'Value' : ''} htmlFor={`wf-act-value-${idx}`}>
                      <Input
                        id={`wf-act-value-${idx}`}
                        value={a.value}
                        onChange={(e) => patchAction(idx, { value: e.target.value })}
                        placeholder="high"
                      />
                    </Field>
                  </>
                )}
                {a.type === 'send_email' && (
                  <>
                    <Field label={idx === 0 ? 'To' : ''} htmlFor={`wf-act-to-${idx}`}>
                      <Input
                        id={`wf-act-to-${idx}`}
                        value={a.to}
                        onChange={(e) => patchAction(idx, { to: e.target.value })}
                        placeholder="owner or address"
                      />
                    </Field>
                    <Field label={idx === 0 ? 'Subject' : ''} htmlFor={`wf-act-subject-${idx}`}>
                      <Input
                        id={`wf-act-subject-${idx}`}
                        value={a.subject}
                        onChange={(e) => patchAction(idx, { subject: e.target.value })}
                        placeholder="Heads up"
                      />
                    </Field>
                  </>
                )}
                {a.type === 'call_webhook' && (
                  <Field label={idx === 0 ? 'URL' : ''} htmlFor={`wf-act-url-${idx}`}>
                    <Input
                      id={`wf-act-url-${idx}`}
                      value={a.url}
                      onChange={(e) => patchAction(idx, { url: e.target.value })}
                      placeholder="https://…"
                    />
                  </Field>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  className="h-9 px-2 text-xs text-danger"
                  onClick={() => setActions((prev) => prev.filter((_, i) => i !== idx))}
                  aria-label={`Remove action ${idx + 1}`}
                >
                  ✕
                </Button>
              </div>
              {a.type === 'send_email' && (
                <Field label="Body" htmlFor={`wf-act-body-${idx}`}>
                  <Input
                    id={`wf-act-body-${idx}`}
                    value={a.body}
                    onChange={(e) => patchAction(idx, { body: e.target.value })}
                    placeholder="Something happened."
                  />
                </Field>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Creating…' : 'Create Workflow'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
