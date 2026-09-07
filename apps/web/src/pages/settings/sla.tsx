import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasScope } from '../../lib/api';
import { useAuth } from '../../lib/providers';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  FormError,
  Input,
  Skeleton,
} from '../../components/ui';
import { Modal } from '../../components/modal';
import { useToast } from '../../components/toast';

interface SlaPolicy {
  id: string;
  name: string;
  entity: 'lead' | 'deal' | 'task';
  metric: 'first_response' | 'resolution';
  hours: number;
  isActive: boolean;
}

interface SlaBreach {
  policyId: string;
  policyName: string;
  entity: string;
  recordId: string;
  recordName: string;
  hoursOverdue: number;
  ageHours: number;
}

export function SlaPage(): React.JSX.Element {
  const { user } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const canManage = hasScope(user, 'org:manage');

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [entity, setEntity] = useState<'lead' | 'deal' | 'task'>('lead');
  const [metric, setMetric] = useState<'first_response' | 'resolution'>('first_response');
  const [hours, setHours] = useState('24');
  const [formError, setFormError] = useState<string | null>(null);

  const policiesQuery = useQuery({
    queryKey: ['sla-policies'],
    queryFn: () => api<SlaPolicy[]>('/sla-policies'),
  });
  const breachesQuery = useQuery({
    queryKey: ['sla-breaches'],
    queryFn: () => api<{ breaches: SlaBreach[] }>('/sla-policies/breaches/list'),
  });

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ['sla-policies'] });
    void queryClient.invalidateQueries({ queryKey: ['sla-breaches'] });
  }

  const createMutation = useMutation({
    mutationFn: () =>
      api<{ policy: SlaPolicy }>('/sla-policies', {
        method: 'POST',
        body: { name: name.trim(), entity, metric, hours: Number(hours) },
      }),
    onSuccess: () => {
      setCreateOpen(false);
      setName('');
      setFormError(null);
      refresh();
      notify('success', 'SLA policy created');
    },
    onError: (err: Error) => setFormError(err.message || 'Creation failed'),
  });

  const toggleMutation = useMutation({
    mutationFn: (policy: SlaPolicy) =>
      api(`/sla-policies/${policy.id}`, {
        method: 'PATCH',
        body: { isActive: !policy.isActive },
      }),
    onSuccess: () => {
      refresh();
      notify('success', 'SLA policy updated');
    },
    onError: (err: Error) => notify('error', err.message || 'Update failed'),
  });

  const policies = policiesQuery.data ?? [];
  const breaches = breachesQuery.data?.breaches ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">SLAs</h1>
          <p className="mt-1 text-xs text-text-secondary">
            Response and resolution targets, evaluated on demand. Worst breaches first.
          </p>
        </div>
        {canManage && (
          <Button variant="primary" onClick={() => setCreateOpen(true)} className="h-9 text-xs">
            + New Policy
          </Button>
        )}
      </div>

      <Card title="Breaches" description="Open records past their active policy window.">
        {breachesQuery.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : breachesQuery.isError ? (
          <div className="rounded bg-danger-soft p-4 text-sm text-danger">
            Could not load breaches: {breachesQuery.error?.message}
          </div>
        ) : breaches.length === 0 ? (
          <EmptyState title="No breaches" description="Everything is inside its SLA window." />
        ) : (
          <ul className="flex flex-col gap-2 text-xs">
            {breaches.slice(0, 50).map((breach) => (
              <li
                key={`${breach.policyId}:${breach.recordId}`}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-4 py-3"
              >
                <Badge tone="danger">{breach.hoursOverdue}h over</Badge>
                <span className="text-sm font-medium text-text-primary">{breach.recordName}</span>
                <span className="text-text-secondary">
                  {breach.entity} · {breach.policyName}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Policies" description="">
        {policiesQuery.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : policiesQuery.isError ? (
          <div className="rounded bg-danger-soft p-4 text-sm text-danger">
            Could not load policies: {policiesQuery.error?.message}
          </div>
        ) : policies.length === 0 ? (
          <EmptyState title="No policies" description="Create one to start tracking SLAs." />
        ) : (
          <ul className="flex flex-col gap-2 text-xs">
            {policies.map((policy) => (
              <li
                key={policy.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-4 py-3"
              >
                <span className="text-sm font-medium text-text-primary">{policy.name}</span>
                <Badge tone={policy.isActive ? 'success' : 'neutral'}>
                  {policy.isActive ? 'active' : 'off'}
                </Badge>
                <span className="text-text-secondary">
                  {policy.entity} · {policy.metric.replace('_', ' ')} · {policy.hours}h
                </span>
                {canManage && (
                  <Button
                    variant="ghost"
                    onClick={() => toggleMutation.mutate(policy)}
                    className="ml-auto h-7 text-xs"
                  >
                    {policy.isActive ? 'Deactivate' : 'Activate'}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New SLA policy">
        <div className="flex flex-col gap-3">
          <Field label="Name" htmlFor="sla-name">
            <Input
              id="sla-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="First touch 4h"
            />
          </Field>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Field label="Entity" htmlFor="sla-entity">
              <select
                id="sla-entity"
                value={entity}
                onChange={(e) => setEntity(e.target.value as typeof entity)}
                className="h-9 rounded border border-border bg-surface px-2 text-xs"
              >
                {(['lead', 'deal', 'task'] as const).map((en) => (
                  <option key={en} value={en}>
                    {en}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Metric" htmlFor="sla-metric">
              <select
                id="sla-metric"
                value={metric}
                onChange={(e) => setMetric(e.target.value as typeof metric)}
                className="h-9 rounded border border-border bg-surface px-2 text-xs"
              >
                <option value="first_response">first response</option>
                <option value="resolution">resolution</option>
              </select>
            </Field>
            <Field label="Hours" htmlFor="sla-hours">
              <Input
                id="sla-hours"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                placeholder="24"
              />
            </Field>
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
                if (!Number.isInteger(Number(hours)) || Number(hours) < 1) {
                  setFormError('Hours must be a positive whole number');
                  return;
                }
                createMutation.mutate();
              }}
              className="h-9 text-xs"
            >
              Create Policy
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
