import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasScope } from '../../lib/api';
import { useAuth } from '../../lib/providers';
import { Button, Card, EmptyState, Field, FormError, Input, Skeleton } from '../../components/ui';
import { Modal } from '../../components/modal';
import { useToast } from '../../components/toast';

interface TerritoryRule {
  field: 'company' | 'email_domain' | 'title' | 'name';
  operator: 'equals' | 'not_equals' | 'contains';
  value: string;
}

interface Territory {
  id: string;
  owner: { id: string; name: string } | null;
  name: string;
  rules: Array<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
}

const FIELDS: TerritoryRule['field'][] = ['company', 'email_domain', 'title', 'name'];
const OPERATORS: TerritoryRule['operator'][] = ['equals', 'not_equals', 'contains'];

const EMPTY_RULE: TerritoryRule = { field: 'email_domain', operator: 'equals', value: '' };

export function TerritoriesPage(): React.JSX.Element {
  const { user } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const canManage = hasScope(user, 'contacts:manage');

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [rules, setRules] = useState<TerritoryRule[]>([{ ...EMPTY_RULE }]);
  const [formError, setFormError] = useState<string | null>(null);

  const territoriesQuery = useQuery({
    queryKey: ['territories'],
    queryFn: () => api<Territory[]>('/territories'),
  });

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ['territories'] });
  }

  const createMutation = useMutation({
    mutationFn: () =>
      api<{ territory: Territory }>('/territories', {
        method: 'POST',
        body: { name: name.trim(), rules },
      }),
    onSuccess: () => {
      setCreateOpen(false);
      setName('');
      setRules([{ ...EMPTY_RULE }]);
      setFormError(null);
      refresh();
      notify('success', 'Territory created');
    },
    onError: (err: Error) => setFormError(err.message || 'Creation failed'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/territories/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      notify('success', 'Territory deleted');
    },
    onError: (err: Error) => notify('error', err.message || 'Delete failed'),
  });

  function updateRule(index: number, patch: Partial<TerritoryRule>): void {
    setRules((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  const territories = territoriesQuery.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Territories</h1>
          <p className="mt-1 text-xs text-text-secondary">
            Rule-based segments for assignment suggestions. All rules in a territory must match
            (AND).
          </p>
        </div>
        {canManage && (
          <Button variant="primary" onClick={() => setCreateOpen(true)} className="h-9 text-xs">
            + New Territory
          </Button>
        )}
      </div>

      <Card title="All territories" description="">
        {territoriesQuery.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : territoriesQuery.isError ? (
          <div className="rounded bg-danger-soft p-4 text-sm text-danger">
            Could not load territories: {territoriesQuery.error?.message}
          </div>
        ) : territories.length === 0 ? (
          <EmptyState
            title="No territories"
            description="Create one to start segmenting contacts and leads."
          />
        ) : (
          <ul className="flex flex-col gap-2 text-xs">
            {territories.map((territory) => (
              <li
                key={territory.id}
                className="flex flex-col gap-1 rounded-lg border border-border px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-text-primary">{territory.name}</span>
                  {territory.owner && (
                    <span className="text-text-secondary">· {territory.owner.name}</span>
                  )}
                  {canManage && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        if (window.confirm(`Delete "${territory.name}"?`)) {
                          deleteMutation.mutate(territory.id);
                        }
                      }}
                      className="ml-auto h-7 text-xs text-danger"
                    >
                      Delete
                    </Button>
                  )}
                </div>
                <ul className="flex flex-col gap-1 text-text-secondary">
                  {territory.rules.map((rule, idx) => (
                    <li key={idx}>
                      {String(rule.field)} {String(rule.operator)} “{String(rule.value)}”
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New territory">
        <div className="flex flex-col gap-3">
          <Field label="Name" htmlFor="territory-name">
            <Input
              id="territory-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="EMEA Enterprise"
            />
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-text-primary">Rules (all must match)</span>
            {rules.map((rule, idx) => (
              <div key={idx} className="grid grid-cols-[1fr_1fr_2fr_auto] items-center gap-2">
                <select
                  aria-label={`Rule ${idx + 1} field`}
                  value={rule.field}
                  onChange={(e) =>
                    updateRule(idx, { field: e.target.value as TerritoryRule['field'] })
                  }
                  className="h-9 rounded border border-border bg-surface px-2 text-xs"
                >
                  {FIELDS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Rule ${idx + 1} operator`}
                  value={rule.operator}
                  onChange={(e) =>
                    updateRule(idx, { operator: e.target.value as TerritoryRule['operator'] })
                  }
                  className="h-9 rounded border border-border bg-surface px-2 text-xs"
                >
                  {OPERATORS.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
                <Input
                  aria-label={`Rule ${idx + 1} value`}
                  value={rule.value}
                  onChange={(e) => updateRule(idx, { value: e.target.value })}
                  placeholder="acme.com"
                />
                <Button
                  variant="ghost"
                  onClick={() => setRules((prev) => prev.filter((_, i) => i !== idx))}
                  className="h-9 text-xs"
                  aria-label={`Remove rule ${idx + 1}`}
                >
                  ✕
                </Button>
              </div>
            ))}
            {rules.length < 10 && (
              <div>
                <Button
                  variant="ghost"
                  onClick={() => setRules((prev) => [...prev, { ...EMPTY_RULE }])}
                  className="h-7 text-xs"
                >
                  + Add rule
                </Button>
              </div>
            )}
          </div>
          <FormError message={formError} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreateOpen(false)} className="h-9 text-xs">
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (!name.trim()) {
                  setFormError('Name is required');
                  return;
                }
                if (rules.length === 0 || rules.some((r) => !r.value.trim())) {
                  setFormError('Every rule needs a value');
                  return;
                }
                createMutation.mutate();
              }}
              className="h-9 text-xs"
            >
              Create Territory
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
