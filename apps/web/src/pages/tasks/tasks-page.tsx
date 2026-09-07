import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasScope } from '../../lib/api';
import { useAuth } from '../../lib/providers';
import type { SerializedActivity, SerializedTask } from '../../lib/crm-types';
import { Badge, Button, Card, EmptyState, Field, Input, Skeleton } from '../../components/ui';
import { Modal } from '../../components/modal';
import { useToast } from '../../components/toast';

interface TasksListResponse {
  tasks: SerializedTask[];
  nextCursor: string | null;
}

interface ActivitiesListResponse {
  activities: SerializedActivity[];
  nextCursor: string | null;
}

type TaskFilter = 'open' | 'overdue' | 'reminders' | 'completed' | 'all';

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function TasksPage(): React.JSX.Element {
  const { user } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<TaskFilter>('open');
  const [createOpen, setCreateOpen] = useState(false);

  const canManage = hasScope(user, 'tasks:manage');
  const canLogActivities = hasScope(user, 'activities:manage');

  const params = new URLSearchParams();
  if (filter === 'open' || filter === 'completed') params.set('status', filter);
  if (filter === 'overdue') params.set('overdue', 'true');
  if (filter === 'reminders') params.set('remindersDue', 'true');
  const queryKey = ['tasks', filter];

  const tasksQuery = useQuery({
    queryKey,
    queryFn: () => api<TasksListResponse>(`/tasks?${params.toString()}`),
  });

  const activitiesQuery = useQuery({
    queryKey: ['activities-recent'],
    queryFn: () => api<ActivitiesListResponse>('/activities?limit=20'),
  });

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    void queryClient.invalidateQueries({ queryKey: ['activities-recent'] });
  }

  const completeMutation = useMutation({
    mutationFn: (id: string) =>
      api<{ task: SerializedTask; changed: boolean }>(`/tasks/${id}/complete`, { method: 'POST' }),
    onSuccess: (result) => {
      refresh();
      notify('success', result.changed ? 'Task completed' : 'Task was already completed');
    },
    onError: (err: Error) => notify('error', err.message || 'Failed to complete task'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/tasks/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      notify('success', 'Task deleted');
    },
    onError: (err: Error) => notify('error', err.message || 'Failed to delete task'),
  });

  const dispatchMutation = useMutation({
    mutationFn: () =>
      api<{ ownersNotified: number; tasksIncluded: number }>('/tasks/reminders/dispatch', {
        method: 'POST',
      }),
    onSuccess: (result) => {
      refresh();
      notify(
        'success',
        result.ownersNotified === 0
          ? 'Nothing due — no digests sent'
          : `Sent ${result.ownersNotified} digest${result.ownersNotified === 1 ? '' : 's'} covering ${result.tasksIncluded} task${result.tasksIncluded === 1 ? '' : 's'}`,
      );
    },
    onError: (err: Error) => notify('error', err.message || 'Digest dispatch failed'),
  });

  const tasks = tasksQuery.data?.tasks ?? [];
  const activities = activitiesQuery.data?.activities ?? [];

  const tabs: Array<{ key: TaskFilter; label: string }> = [
    { key: 'open', label: 'Open' },
    { key: 'overdue', label: 'Overdue' },
    { key: 'reminders', label: 'Reminders' },
    { key: 'completed', label: 'Completed' },
    { key: 'all', label: 'All' },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Tasks</h1>
          <p className="mt-1 text-xs text-text-secondary" aria-live="polite">
            {tasks.length} task{tasks.length === 1 ? '' : 's'} in view
            {tasks.some((t) => t.overdue) && (
              <span className="ml-2 font-semibold text-danger">
                {tasks.filter((t) => t.overdue).length} overdue
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          {canManage && (
            <Button
              variant="secondary"
              onClick={() => dispatchMutation.mutate()}
              disabled={dispatchMutation.isPending}
              className="h-9 text-xs"
              title="Send reminder digests now instead of waiting for the daily run"
            >
              {dispatchMutation.isPending ? 'Sending…' : 'Send digests'}
            </Button>
          )}
          {canManage && (
            <Button variant="primary" onClick={() => setCreateOpen(true)} className="h-9 text-xs">
              + New Task
            </Button>
          )}
        </div>
      </div>

      <div className="flex gap-2" role="group" aria-label="Task filters">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setFilter(tab.key)}
            aria-pressed={filter === tab.key}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
              filter === tab.key
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:bg-surface-raised hover:text-text-primary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <Card title="Task list" description="Overdue open tasks are flagged amber.">
        {tasksQuery.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : tasksQuery.isError ? (
          <div className="rounded bg-danger-soft p-4 text-sm text-danger">
            Could not load tasks: {tasksQuery.error?.message}
          </div>
        ) : tasks.length === 0 ? (
          <EmptyState
            title="No tasks here"
            description="Create a task or pick another filter."
            action={
              canManage ? (
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  New Task
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {tasks.map((task) => (
              <li
                key={task.id}
                aria-label={`Task ${task.title}`}
                className={`flex flex-col gap-2 rounded-lg border px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${
                  task.overdue ? 'border-warning bg-warning-soft/40' : 'border-border'
                }`}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-text-primary">
                      {task.title}
                    </span>
                    <Badge tone={task.status === 'completed' ? 'success' : 'neutral'}>
                      {task.status.toUpperCase()}
                    </Badge>
                    {task.overdue && <Badge tone="warning">overdue</Badge>}
                    {task.reminderDue && <Badge tone="info">reminder</Badge>}
                    <Badge tone="neutral">{task.priority}</Badge>
                    {task.recurrence && (
                      <Badge tone="info">repeats {task.recurrence.frequency}</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-text-secondary">
                    Due {formatDate(task.dueAt)}
                    {task.owner ? ` · ${task.owner.name}` : ''}
                    {task.contact ? ` · ${task.contact.name}` : ''}
                  </p>
                </div>
                {canManage && task.status === 'open' && (
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="primary"
                      onClick={() => completeMutation.mutate(task.id)}
                      disabled={completeMutation.isPending}
                      className="h-8 text-xs"
                    >
                      Complete
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => deleteMutation.mutate(task.id)}
                      disabled={deleteMutation.isPending}
                      className="h-8 text-xs text-danger"
                      aria-label={`Delete ${task.title}`}
                    >
                      Delete
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Recent activity"
        description="Calls, meetings, emails, and task completions across your records."
      >
        {activitiesQuery.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : activities.length === 0 ? (
          <p className="text-xs italic text-text-secondary">No activity logged yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-xs">
            {activities.map((activity) => (
              <li
                key={activity.id}
                className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2"
              >
                <span>
                  <Badge tone={activity.type === 'task' ? 'success' : 'info'}>
                    {activity.type}
                  </Badge>{' '}
                  <span className="font-medium">{activity.subject ?? '(no subject)'}</span>
                  {activity.conflictFlag && (
                    <span className="ml-2 font-semibold text-warning">sync conflict</span>
                  )}
                  {activity.syncStatus === 'cancelled' && (
                    <span className="ml-2 text-text-secondary">(cancelled in provider)</span>
                  )}
                </span>
                <span className="shrink-0 text-text-secondary">
                  {formatDate(activity.occurredAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {canLogActivities && <LogActivityForm onLogged={refresh} />}
      </Card>

      <CreateTaskModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={refresh} />
    </div>
  );
}

function CreateTaskModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}): React.JSX.Element {
  const { notify } = useToast();
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [remindAt, setRemindAt] = useState('');
  const [priority, setPriority] = useState('normal');
  const [recurrence, setRecurrence] = useState('none');
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!title.trim()) throw new Error('Title is required');
      const body: Record<string, unknown> = { title: title.trim(), priority };
      if (dueAt) body['dueAt'] = new Date(dueAt).toISOString();
      if (remindAt) body['remindAt'] = new Date(remindAt).toISOString();
      if (recurrence !== 'none') body['recurrence'] = { frequency: recurrence, interval: 1 };
      return api('/tasks', { method: 'POST', body });
    },
    onSuccess: () => {
      setTitle('');
      setDueAt('');
      setRemindAt('');
      setPriority('normal');
      setRecurrence('none');
      setError(null);
      onClose();
      onCreated();
      notify('success', `Task "${title.trim()}" created`);
    },
    onError: (err: Error) => setError(err.message || 'Failed to create task'),
  });

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    createMutation.mutate();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New Task"
      description="Tasks open unassigned to you."
    >
      <form onSubmit={submit} className="flex flex-col gap-3 pt-2">
        {error && (
          <div role="alert" className="rounded bg-danger-soft p-3 text-xs text-danger">
            {error}
          </div>
        )}
        <Field label="Title" htmlFor="new-task-title">
          <Input
            id="new-task-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Follow up on proposal"
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Due date" htmlFor="new-task-due">
            <Input
              id="new-task-due"
              type="date"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
            />
          </Field>
          <Field label="Remind date" htmlFor="new-task-remind">
            <Input
              id="new-task-remind"
              type="date"
              value={remindAt}
              onChange={(e) => setRemindAt(e.target.value)}
            />
          </Field>
        </div>
        <Field label="Priority" htmlFor="new-task-priority">
          <select
            id="new-task-priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            className="h-9 rounded border border-border bg-surface px-2 text-xs"
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
        </Field>
        <Field label="Repeats" htmlFor="new-task-recurrence">
          <select
            id="new-task-recurrence"
            value={recurrence}
            onChange={(e) => setRecurrence(e.target.value)}
            className="h-9 rounded border border-border bg-surface px-2 text-xs"
          >
            <option value="none">Does not repeat</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Creating…' : 'Create Task'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function LogActivityForm({ onLogged }: { onLogged: () => void }): React.JSX.Element {
  const { notify } = useToast();
  const [type, setType] = useState('call');
  const [subject, setSubject] = useState('');
  const [error, setError] = useState<string | null>(null);

  const logMutation = useMutation({
    mutationFn: async () => {
      if (!subject.trim()) throw new Error('Subject is required');
      return api('/activities', {
        method: 'POST',
        body: { type, subject: subject.trim() },
      });
    },
    onSuccess: () => {
      setSubject('');
      setError(null);
      onLogged();
      notify('success', 'Activity logged');
    },
    onError: (err: Error) => setError(err.message || 'Failed to log activity'),
  });

  return (
    <form
      className="mt-3 flex flex-col gap-2 rounded border border-dashed border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        logMutation.mutate();
      }}
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[140px_1fr_auto]">
        <label className="flex flex-col gap-1 text-xs font-medium text-text-secondary">
          Type
          <select
            aria-label="Activity type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="h-9 rounded border border-border bg-surface px-2 text-xs text-text-primary"
          >
            <option value="call">Call</option>
            <option value="meeting">Meeting</option>
            <option value="email">Email</option>
          </select>
        </label>
        <Field label="Subject" htmlFor="log-activity-subject">
          <Input
            id="log-activity-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Discovery call with Acme"
          />
        </Field>
        <div className="flex items-end">
          <Button
            type="submit"
            variant="secondary"
            disabled={logMutation.isPending}
            className="h-9 text-xs"
          >
            {logMutation.isPending ? 'Logging…' : 'Log activity'}
          </Button>
        </div>
      </div>
      {error && (
        <div role="alert" className="rounded bg-danger-soft p-2 text-xs text-danger">
          {error}
        </div>
      )}
    </form>
  );
}
