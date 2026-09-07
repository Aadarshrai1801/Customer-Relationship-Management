import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasScope } from '../../lib/api';
import { useAuth } from '../../lib/providers';
import { Badge, Button, Card, EmptyState, Field, Input, Skeleton } from '../../components/ui';
import { Modal } from '../../components/modal';
import { useToast } from '../../components/toast';

interface SequenceDto {
  id: string;
  name: string;
  isActive: boolean;
  steps: Array<Record<string, unknown>>;
  enrolled: number;
}

interface EnrollmentDto {
  id: string;
  contact: { id: string; name: string; email: string } | null;
  status: string;
  currentStep: number;
  nextRunAt: string;
}

interface DraftStep {
  kind: string;
  days: string;
  subject: string;
  body: string;
}

export function SequencesPage(): React.JSX.Element {
  const { user } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const canManage = hasScope(user, 'activities:manage');

  const sequencesQuery = useQuery({
    queryKey: ['sequences'],
    queryFn: () => api<SequenceDto[]>('/sequences'),
  });

  const enrollmentsQuery = useQuery({
    queryKey: ['sequence-enrollments', selectedId],
    queryFn: () => api<EnrollmentDto[]>(`/sequences/${selectedId}/enrollments`),
    enabled: selectedId !== null,
  });

  const sequences = sequencesQuery.data ?? [];
  const selected = sequences.find((s) => s.id === selectedId) ?? null;
  const enrollments = enrollmentsQuery.data ?? [];

  async function setEnrollmentStatus(
    id: string,
    action: 'pause' | 'resume' | 'cancel',
  ): Promise<void> {
    try {
      await api(`/sequences/enrollments/${id}/${action}`, { method: 'POST' });
      void queryClient.invalidateQueries({ queryKey: ['sequence-enrollments', selectedId] });
      notify('success', `Enrollment ${action}d`);
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Update failed');
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Sequences</h1>
          <p className="mt-1 text-xs text-text-secondary">
            Drip cadences. A contact reply auto-pauses its enrollment.
          </p>
        </div>
        {canManage && (
          <Button variant="primary" onClick={() => setCreateOpen(true)} className="h-9 text-xs">
            + New Sequence
          </Button>
        )}
      </div>

      <Card title="Cadences" description="">
        {sequencesQuery.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : sequences.length === 0 ? (
          <EmptyState
            title="No sequences yet"
            description="Build a drip with email and wait steps."
          />
        ) : (
          <ul className="flex flex-col gap-2 text-xs">
            {sequences.map((sequence) => (
              <li
                key={sequence.id}
                aria-label={`Sequence ${sequence.name}`}
                className="flex flex-col gap-1 rounded border border-border px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
              >
                <button
                  type="button"
                  onClick={() => setSelectedId(sequence.id)}
                  className="text-left font-medium hover:underline"
                >
                  {sequence.name}
                </button>
                <span className="flex items-center gap-2 text-text-secondary">
                  <Badge tone={sequence.isActive ? 'success' : 'neutral'}>
                    {sequence.isActive ? 'active' : 'paused'}
                  </Badge>
                  <span>{sequence.steps.length} steps</span>
                  <span>{sequence.enrolled} enrolled</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {selected && (
        <Card title={`Enrollments · ${selected.name}`} description="">
          {enrollmentsQuery.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : enrollments.length === 0 ? (
            <p className="text-xs italic text-text-secondary">Nobody enrolled yet.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-xs">
              {enrollments.map((enrollment) => (
                <li
                  key={enrollment.id}
                  className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2"
                >
                  <span>
                    <span className="font-medium">{enrollment.contact?.name ?? '(gone)'}</span>{' '}
                    <Badge
                      tone={
                        enrollment.status === 'active'
                          ? 'success'
                          : enrollment.status === 'completed'
                            ? 'info'
                            : 'warning'
                      }
                    >
                      {enrollment.status}
                    </Badge>{' '}
                    <span className="text-text-secondary">step {enrollment.currentStep + 1}</span>
                  </span>
                  {canManage && enrollment.status === 'active' && (
                    <span className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => void setEnrollmentStatus(enrollment.id, 'pause')}
                        className="rounded px-1.5 py-0.5 text-accent hover:bg-surface-raised"
                      >
                        Pause
                      </button>
                      <button
                        type="button"
                        onClick={() => void setEnrollmentStatus(enrollment.id, 'cancel')}
                        className="rounded px-1.5 py-0.5 text-danger hover:bg-danger-soft"
                      >
                        Cancel
                      </button>
                    </span>
                  )}
                  {canManage && enrollment.status === 'paused' && (
                    <button
                      type="button"
                      onClick={() => void setEnrollmentStatus(enrollment.id, 'resume')}
                      className="rounded px-1.5 py-0.5 text-accent hover:bg-surface-raised"
                    >
                      Resume
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canManage && (
            <EnrollForm
              sequenceId={selected.id}
              onEnrolled={() => {
                void queryClient.invalidateQueries({
                  queryKey: ['sequence-enrollments', selectedId],
                });
                void queryClient.invalidateQueries({ queryKey: ['sequences'] });
              }}
            />
          )}
        </Card>
      )}

      <CreateSequenceModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => void queryClient.invalidateQueries({ queryKey: ['sequences'] })}
      />
    </div>
  );
}

function EnrollForm({
  sequenceId,
  onEnrolled,
}: {
  sequenceId: string;
  onEnrolled: () => void;
}): React.JSX.Element {
  const { notify } = useToast();
  const [contactId, setContactId] = useState('');
  const contactsQuery = useQuery({
    queryKey: ['contacts-list'],
    queryFn: () => api<{ contacts: Array<{ id: string; name: string }> }>('/contacts?limit=200'),
  });

  async function enroll(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!contactId) return;
    try {
      await api(`/sequences/${sequenceId}/enrollments`, { method: 'POST', body: { contactId } });
      setContactId('');
      onEnrolled();
      notify('success', 'Contact enrolled');
    } catch (err) {
      notify('error', err instanceof Error ? err.message : 'Enroll failed');
    }
  }

  return (
    <form onSubmit={(e) => void enroll(e)} className="mt-3 flex items-end gap-2">
      <Field label="Contact" htmlFor="enroll-contact">
        <select
          id="enroll-contact"
          value={contactId}
          onChange={(e) => setContactId(e.target.value)}
          className="h-9 rounded border border-border bg-surface px-2 text-xs"
        >
          <option value="">Select a contact…</option>
          {(contactsQuery.data?.contacts ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Button type="submit" variant="secondary" disabled={!contactId} className="h-9 text-xs">
        Enroll
      </Button>
    </form>
  );
}

function CreateSequenceModal({
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
  const [steps, setSteps] = useState<DraftStep[]>([
    { kind: 'send_email', days: '3', subject: '', body: '' },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      if (!name.trim()) throw new Error('Name is required');
      if (steps.length === 0) throw new Error('Add at least one step');
      const parsed = steps.map((step, idx) => {
        if (step.kind === 'wait') {
          const days = Number(step.days);
          if (!Number.isInteger(days) || days < 1)
            throw new Error(`Step ${idx + 1}: days must be ≥ 1`);
          return { kind: 'wait', days };
        }
        if (!step.subject.trim() || !step.body.trim()) {
          throw new Error(`Step ${idx + 1}: subject and body are required`);
        }
        return { kind: 'send_email', subject: step.subject.trim(), body: step.body.trim() };
      });
      const created = await api<{ sequence: SequenceDto }>('/sequences', {
        method: 'POST',
        body: { name: name.trim(), steps: parsed },
      });
      setName('');
      setSteps([{ kind: 'send_email', days: '3', subject: '', body: '' }]);
      onClose();
      onCreated();
      notify('success', `Sequence "${created.sequence.name}" created`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setPending(false);
    }
  }

  function patchStep(idx: number, patch: Partial<DraftStep>): void {
    setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New Sequence"
      description="Emails send in order with waits between."
      size="lg"
    >
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3 pt-2">
        {error && (
          <div role="alert" className="rounded bg-danger-soft p-3 text-xs text-danger">
            {error}
          </div>
        )}
        <Field label="Name" htmlFor="new-sequence-name">
          <Input
            id="new-sequence-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Post-demo drip"
          />
        </Field>
        {steps.map((step, idx) => (
          <div key={idx} className="flex flex-col gap-2 rounded border border-border p-2">
            <div className="grid grid-cols-[130px_1fr_auto] items-end gap-1">
              <Field label={idx === 0 ? 'Kind' : ''} htmlFor={`seq-kind-${idx}`}>
                <select
                  id={`seq-kind-${idx}`}
                  value={step.kind}
                  onChange={(e) => patchStep(idx, { kind: e.target.value })}
                  className="h-9 rounded border border-border bg-surface px-1 text-xs"
                >
                  <option value="send_email">Send email</option>
                  <option value="wait">Wait</option>
                </select>
              </Field>
              {step.kind === 'wait' ? (
                <Field label={idx === 0 ? 'Days' : ''} htmlFor={`seq-days-${idx}`}>
                  <Input
                    id={`seq-days-${idx}`}
                    inputMode="numeric"
                    value={step.days}
                    onChange={(e) => patchStep(idx, { days: e.target.value })}
                  />
                </Field>
              ) : (
                <Field label={idx === 0 ? 'Subject' : ''} htmlFor={`seq-subject-${idx}`}>
                  <Input
                    id={`seq-subject-${idx}`}
                    value={step.subject}
                    onChange={(e) => patchStep(idx, { subject: e.target.value })}
                    placeholder="Checking in"
                  />
                </Field>
              )}
              <Button
                type="button"
                variant="ghost"
                className="h-9 px-2 text-xs text-danger"
                onClick={() => setSteps((prev) => prev.filter((_, i) => i !== idx))}
                aria-label={`Remove step ${idx + 1}`}
              >
                ✕
              </Button>
            </div>
            {step.kind === 'send_email' && (
              <Field label="Body" htmlFor={`seq-body-${idx}`}>
                <Input
                  id={`seq-body-${idx}`}
                  value={step.body}
                  onChange={(e) => patchStep(idx, { body: e.target.value })}
                  placeholder="Hi {{contactName}}…"
                />
              </Field>
            )}
          </div>
        ))}
        <div>
          <Button
            type="button"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() =>
              setSteps((prev) => [...prev, { kind: 'wait', days: '3', subject: '', body: '' }])
            }
          >
            + Add step
          </Button>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {pending ? 'Creating…' : 'Create Sequence'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
