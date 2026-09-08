import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasScope } from '../lib/api';
import { useAuth } from '../lib/providers';
import { Avatar, Badge, Button, Card, PageHeader, Skeleton, Stat } from '../components/ui';
import { useToast } from '../components/toast';
import type { OnboardingStatus } from './welcome';
import type {
  ForecastResponse,
  PipelineWithStages,
  SerializedActivity,
  SerializedContact,
  SerializedDeal,
  SerializedLead,
  SerializedTask,
} from '../lib/crm-types';

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function todayLabel(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount).toLocaleString()}`;
  }
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function dueLabel(iso: string | null): string {
  if (!iso) return 'No due date';
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(d);
  due.setHours(0, 0, 0, 0);
  const diff = Math.round((due.getTime() - today.getTime()) / 86400000);
  const formatted = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (diff < 0) return `Overdue · ${formatted}`;
  if (diff === 0) return 'Due today';
  if (diff === 1) return 'Due tomorrow';
  return `Due ${formatted}`;
}

export function HomePage(): React.JSX.Element {
  const { user, org } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const firstName = user?.name?.split(' ')[0] ?? 'there';

  const canReadDeals = hasScope(user, 'deals:read');
  const canManageDeals = hasScope(user, 'deals:manage');
  const canReadTasks = hasScope(user, 'tasks:read');
  const canManageTasks = hasScope(user, 'tasks:manage');
  const canReadContacts = hasScope(user, 'contacts:read');
  const canManageContacts = hasScope(user, 'contacts:manage');
  const canReadLeads = hasScope(user, 'leads:read');
  const canReadActivities = hasScope(user, 'activities:read');

  const statusQuery = useQuery({
    queryKey: ['onboarding-status'],
    queryFn: () => api<OnboardingStatus>('/onboarding/status'),
  });

  const pipelinesQuery = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => api<PipelineWithStages[]>('/pipelines'),
    enabled: canReadDeals,
    retry: false,
    staleTime: 60_000,
  });
  const pipelines = pipelinesQuery.data ?? [];
  const defaultPipelineId =
    pipelines.find((p) => p.pipeline.isDefault)?.pipeline.id ?? pipelines[0]?.pipeline.id ?? null;

  const forecastQuery = useQuery({
    queryKey: ['deals-forecast-home', defaultPipelineId],
    queryFn: () =>
      api<ForecastResponse>(`/deals/forecast/by-pipeline?pipelineId=${defaultPipelineId}`),
    enabled: canReadDeals && defaultPipelineId !== null,
    retry: false,
    staleTime: 60_000,
  });

  const stalledQuery = useQuery({
    queryKey: ['deals-stalled-home'],
    queryFn: () =>
      api<{ deals: Array<{ id: string; daysInactive: number }> }>('/deals/stalled?limit=5'),
    enabled: canReadDeals,
    retry: false,
    staleTime: 60_000,
  });

  const dealsQuery = useQuery({
    queryKey: ['deals-recent-home'],
    queryFn: () => api<{ deals: SerializedDeal[]; nextCursor: string | null }>('/deals?limit=6'),
    enabled: canReadDeals,
    retry: false,
    staleTime: 30_000,
  });

  const tasksQuery = useQuery({
    queryKey: ['tasks-open-home'],
    queryFn: () =>
      api<{ tasks: SerializedTask[]; nextCursor: string | null }>('/tasks?status=open'),
    enabled: canReadTasks,
    retry: false,
    staleTime: 30_000,
  });

  const activitiesQuery = useQuery({
    queryKey: ['activities-recent-home'],
    queryFn: () =>
      api<{ activities: SerializedActivity[]; nextCursor: string | null }>('/activities?limit=8'),
    enabled: canReadActivities,
    retry: false,
    staleTime: 30_000,
  });

  const contactsQuery = useQuery({
    queryKey: ['contacts-recent-home'],
    queryFn: () =>
      api<{ contacts: SerializedContact[]; nextCursor: string | null }>('/contacts?limit=5'),
    enabled: canReadContacts,
    retry: false,
    staleTime: 60_000,
  });

  const leadsQuery = useQuery({
    queryKey: ['leads-new-home'],
    queryFn: () =>
      api<{ leads: SerializedLead[]; nextCursor: string | null }>('/leads?limit=6&status=new'),
    enabled: canReadLeads,
    retry: false,
    staleTime: 60_000,
  });

  const completeMutation = useMutation({
    mutationFn: (id: string) => api(`/tasks/${id}/complete`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tasks-open-home'] });
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
      notify('success', 'Task completed');
    },
    onError: (err: Error) => notify('error', err.message || 'Could not complete task'),
  });

  const forecast = forecastQuery.data;
  const stalledIds = new Set((stalledQuery.data?.deals ?? []).map((d) => d.id));
  const openTasks = (tasksQuery.data?.tasks ?? []).slice().sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (!a.dueAt) return 1;
    if (!b.dueAt) return -1;
    return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
  });
  const overdueCount = openTasks.filter((t) => t.overdue).length;
  const newLeads = leadsQuery.data?.leads ?? [];
  const recentDeals = dealsQuery.data?.deals ?? [];
  const recentContacts = contactsQuery.data?.contacts ?? [];
  const recentActivity = activitiesQuery.data?.activities ?? [];

  const maxStageTotal = Math.max(1, ...(forecast?.stages.map((s) => s.totalBaseAmount) ?? [1]));

  const showGettingStarted = statusQuery.data !== undefined && statusQuery.data.complete === false;
  const setupPercent =
    statusQuery.data && statusQuery.data.total > 0
      ? Math.round((statusQuery.data.doneCount / statusQuery.data.total) * 100)
      : 100;

  return (
    <>
      <PageHeader
        eyebrow={`${todayLabel()} · ${org?.name ?? 'Workspace'}`}
        title={`${greeting()}, ${firstName}`}
        description="Your pipeline, tasks and recent activity — pick up right where you left off."
        actions={
          <>
            {canManageContacts && (
              <Link to="/contacts">
                <Button variant="secondary" size="sm">
                  + New contact
                </Button>
              </Link>
            )}
            {canManageTasks && (
              <Link to="/tasks">
                <Button variant="secondary" size="sm">
                  + New task
                </Button>
              </Link>
            )}
            {canManageDeals && (
              <Link to="/deals">
                <Button variant="primary" size="sm">
                  + New deal
                </Button>
              </Link>
            )}
          </>
        }
      />

      {/* Stats */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-live="polite">
        {forecastQuery.isLoading ? (
          <>
            <Skeleton className="h-[104px]" />
            <Skeleton className="h-[104px]" />
            <Skeleton className="h-[104px]" />
            <Skeleton className="h-[104px]" />
          </>
        ) : (
          <>
            <Stat
              label="Open pipeline"
              value={forecast ? money(forecast.totals.totalBaseAmount, forecast.baseCurrency) : '—'}
              hint={
                forecast ? (
                  <>
                    <span className="font-semibold text-accent">
                      {money(forecast.totals.weightedValue, forecast.baseCurrency)}
                    </span>{' '}
                    weighted
                  </>
                ) : (
                  'Connect deals to see value'
                )
              }
              icon="◈"
            />
            <Stat
              label="Open deals"
              value={forecast ? String(forecast.totals.dealCount) : '—'}
              hint={
                stalledQuery.data && stalledQuery.data.deals.length > 0 ? (
                  <span className="font-medium text-warning">
                    {stalledQuery.data.deals.length} stalled — needs activity
                  </span>
                ) : (
                  'Across the default pipeline'
                )
              }
              icon="▦"
            />
            <Stat
              label="My open tasks"
              value={canReadTasks ? String(openTasks.length) : '—'}
              hint={
                overdueCount > 0 ? (
                  <span className="font-semibold text-danger">{overdueCount} overdue</span>
                ) : (
                  'Nothing overdue. Nice.'
                )
              }
              icon="✓"
            />
            <Stat
              label="New leads"
              value={canReadLeads ? String(newLeads.length) : '—'}
              hint="Unworked inbound — qualify fast"
              icon="✦"
            />
          </>
        )}
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        {/* Main column */}
        <div className="flex min-w-0 flex-col gap-4">
          <Card
            title="Pipeline snapshot"
            description={
              forecast ? `${forecast.pipeline.name} · sums per stage` : 'Deal stages at a glance'
            }
            actions={
              <Link
                to="/deals"
                className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-accent hover:bg-accent-soft"
              >
                Open board →
              </Link>
            }
          >
            {!canReadDeals ? (
              <p className="text-sm text-text-secondary">You don&apos;t have deal access.</p>
            ) : forecastQuery.isLoading ? (
              <Skeleton className="h-40 w-full" />
            ) : !forecast || forecast.stages.length === 0 ? (
              <p className="text-sm text-text-secondary">
                No pipeline data yet. Create a deal to light up this board.
              </p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {forecast.stages.map((s) => (
                  <li key={s.stage.id}>
                    <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                      <span className="truncate font-semibold text-text-primary">
                        {s.stage.name}
                        <span className="ml-1.5 font-normal text-text-secondary">
                          {s.dealCount}
                        </span>
                      </span>
                      <span className="shrink-0 font-medium text-text-secondary">
                        {money(s.totalBaseAmount, forecast.baseCurrency)}
                      </span>
                    </div>
                    <div
                      role="progressbar"
                      aria-valuenow={Math.round((s.totalBaseAmount / maxStageTotal) * 100)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`${s.stage.name} value share`}
                      className="h-2 overflow-hidden rounded-full bg-surface-sunken"
                    >
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-[#6366f1] to-[#4338ca] transition-all"
                        style={{
                          width: `${Math.max(4, (s.totalBaseAmount / maxStageTotal) * 100)}%`,
                        }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card
            title="Today's focus"
            description={
              openTasks.length > 0
                ? `${openTasks.length} open · ${overdueCount} overdue — oldest first`
                : 'Tasks due soon'
            }
            actions={
              <Link
                to="/tasks"
                className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-accent hover:bg-accent-soft"
              >
                All tasks →
              </Link>
            }
          >
            {!canReadTasks ? (
              <p className="text-sm text-text-secondary">You don&apos;t have task access.</p>
            ) : tasksQuery.isLoading ? (
              <Skeleton className="h-36 w-full" />
            ) : openTasks.length === 0 ? (
              <p className="text-sm text-text-secondary">
                Inbox zero. Create a follow-up so nothing slips.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {openTasks.slice(0, 6).map((task) => (
                  <li
                    key={task.id}
                    className={`flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 transition-colors ${
                      task.overdue
                        ? 'border-warning/40 bg-warning-soft/50'
                        : 'border-border hover:border-border-strong'
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-semibold text-text-primary">
                        {task.title}
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-text-secondary">
                        <span className={task.overdue ? 'font-semibold text-warning' : ''}>
                          {dueLabel(task.dueAt)}
                        </span>
                        {task.contact && <span>· {task.contact.name}</span>}
                        {task.deal && <span>· {task.deal.name}</span>}
                        {stalledIds.size > 0 && task.deal && stalledIds.has(task.deal.id) && (
                          <Badge tone="warning">stalled deal</Badge>
                        )}
                      </p>
                    </div>
                    {canManageTasks && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => completeMutation.mutate(task.id)}
                        disabled={completeMutation.isPending}
                        aria-label={`Complete ${task.title}`}
                      >
                        Done
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card
              title="Fresh deals"
              description="Most recently updated"
              actions={
                <Link
                  to="/deals"
                  className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-accent hover:bg-accent-soft"
                >
                  View all →
                </Link>
              }
            >
              {dealsQuery.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : recentDeals.length === 0 ? (
                <p className="text-[13px] text-text-secondary">No deals yet.</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {recentDeals.slice(0, 5).map((deal) => (
                    <li key={deal.id}>
                      <Link
                        to="/deals/$id"
                        params={{ id: deal.id }}
                        className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 transition-colors hover:bg-surface-raised"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-semibold text-text-primary">
                            {deal.name}
                          </span>
                          <span className="block truncate text-[11px] text-text-secondary">
                            {deal.stage.name} · {deal.owner?.name ?? 'Unassigned'}
                          </span>
                        </span>
                        <span className="shrink-0 text-[13px] font-bold">
                          {money(deal.amount, deal.currency)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card
              title="Recent activity"
              description="Calls, emails, meetings"
              actions={
                <Link
                  to="/tasks"
                  className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-accent hover:bg-accent-soft"
                >
                  Log more →
                </Link>
              }
            >
              {activitiesQuery.isLoading ? (
                <Skeleton className="h-32 w-full" />
              ) : recentActivity.length === 0 ? (
                <p className="text-[13px] text-text-secondary">No activity logged yet.</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {recentActivity.slice(0, 5).map((a) => (
                    <li
                      key={a.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-border/70 px-2.5 py-2"
                    >
                      <span className="min-w-0">
                        <Badge tone={a.type === 'task' ? 'success' : 'info'}>{a.type}</Badge>{' '}
                        <span className="text-[13px] font-medium">
                          {a.subject ?? '(no subject)'}
                        </span>
                      </span>
                      <span className="shrink-0 text-[11px] text-text-secondary">
                        {timeAgo(a.occurredAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>

        {/* Side column */}
        <div className="flex min-w-0 flex-col gap-4">
          {showGettingStarted && (
            <Card
              title="Getting started"
              description={`${statusQuery.data?.doneCount ?? 0} of ${statusQuery.data?.total ?? 0} setup steps done`}
              actions={
                <Link
                  to="/welcome"
                  className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover"
                >
                  Continue
                </Link>
              }
            >
              <div
                role="progressbar"
                aria-valuenow={setupPercent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Setup progress"
                className="h-2 overflow-hidden rounded-full bg-surface-sunken"
              >
                <div
                  className="h-full rounded-full bg-gradient-to-r from-[#6366f1] to-[#22d3ee] transition-all"
                  style={{ width: `${setupPercent}%` }}
                />
              </div>
              <ul className="mt-3 flex flex-col gap-1.5">
                {(statusQuery.data?.steps ?? []).slice(0, 4).map((step) => (
                  <li key={step.key}>
                    <Link
                      to={step.link}
                      className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-[13px] transition-colors hover:bg-surface-raised"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span aria-hidden>{step.done ? '✅' : '○'}</span>
                        <span className="truncate font-medium">{step.label}</span>
                      </span>
                      {!step.done && <span className="shrink-0 text-accent">→</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="Quick actions" description="Jump straight into work">
            <div className="grid grid-cols-2 gap-2">
              {canManageDeals && (
                <Link
                  to="/deals"
                  className="rounded-xl border border-border p-3 transition-all hover:-translate-y-px hover:border-accent/40 hover:shadow-medium"
                >
                  <p aria-hidden className="text-lg">
                    ◈
                  </p>
                  <p className="mt-1 text-[13px] font-semibold">New deal</p>
                  <p className="text-[11px] text-text-secondary">Add to pipeline</p>
                </Link>
              )}
              {canManageContacts && (
                <Link
                  to="/contacts"
                  className="rounded-xl border border-border p-3 transition-all hover:-translate-y-px hover:border-accent/40 hover:shadow-medium"
                >
                  <p aria-hidden className="text-lg">
                    ○
                  </p>
                  <p className="mt-1 text-[13px] font-semibold">New contact</p>
                  <p className="text-[11px] text-text-secondary">Add a person</p>
                </Link>
              )}
              {canReadLeads && (
                <Link
                  to="/leads"
                  className="rounded-xl border border-border p-3 transition-all hover:-translate-y-px hover:border-accent/40 hover:shadow-medium"
                >
                  <p aria-hidden className="text-lg">
                    ✦
                  </p>
                  <p className="mt-1 text-[13px] font-semibold">Qualify leads</p>
                  <p className="text-[11px] text-text-secondary">{newLeads.length} new waiting</p>
                </Link>
              )}
              {canManageTasks && (
                <Link
                  to="/tasks"
                  className="rounded-xl border border-border p-3 transition-all hover:-translate-y-px hover:border-accent/40 hover:shadow-medium"
                >
                  <p aria-hidden className="text-lg">
                    ✓
                  </p>
                  <p className="mt-1 text-[13px] font-semibold">My tasks</p>
                  <p className="text-[11px] text-text-secondary">
                    {overdueCount > 0 ? `${overdueCount} overdue` : 'All clear'}
                  </p>
                </Link>
              )}
              <Link
                to="/reports"
                className="rounded-xl border border-border p-3 transition-all hover:-translate-y-px hover:border-accent/40 hover:shadow-medium"
              >
                <p aria-hidden className="text-lg">
                  ▦
                </p>
                <p className="mt-1 text-[13px] font-semibold">Reports</p>
                <p className="text-[11px] text-text-secondary">Forecast & activity</p>
              </Link>
              <Link
                to="/imports"
                className="rounded-xl border border-border p-3 transition-all hover:-translate-y-px hover:border-accent/40 hover:shadow-medium"
              >
                <p aria-hidden className="text-lg">
                  ⇪
                </p>
                <p className="mt-1 text-[13px] font-semibold">Import</p>
                <p className="text-[11px] text-text-secondary">CSV bulk upload</p>
              </Link>
            </div>
          </Card>

          <Card
            title="New people"
            description="Latest contacts"
            actions={
              <Link
                to="/contacts"
                className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-accent hover:bg-accent-soft"
              >
                View all →
              </Link>
            }
          >
            {contactsQuery.isLoading ? (
              <Skeleton className="h-28 w-full" />
            ) : recentContacts.length === 0 ? (
              <p className="text-[13px] text-text-secondary">No contacts yet.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {recentContacts.map((c) => (
                  <li key={c.id}>
                    <Link
                      to="/contacts/$id"
                      params={{ id: c.id }}
                      className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-raised"
                    >
                      <Avatar name={c.name} size="sm" />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-semibold">{c.name}</span>
                        <span className="block truncate text-[11px] text-text-secondary">
                          {c.title ?? c.email}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Your access" description="Role and session status">
            <dl className="flex flex-col gap-2 text-[13px]">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-text-secondary">Role</dt>
                <dd className="font-semibold">{user?.role.name}</dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-text-secondary">Status</dt>
                <dd>
                  <Badge tone={user?.status === 'active' ? 'success' : 'warning'}>
                    {user?.status}
                  </Badge>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-text-secondary">Two-factor</dt>
                <dd>
                  <Badge tone={user?.twoFactorEnrolled ? 'success' : 'neutral'}>
                    {user?.twoFactorEnrolled ? 'On' : 'Off'}
                  </Badge>
                </dd>
              </div>
            </dl>
            <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
              <Link
                to="/settings/security"
                className="text-xs font-semibold text-accent hover:underline"
              >
                Security →
              </Link>
              <Link
                to="/settings/audit"
                className="text-xs font-semibold text-accent hover:underline"
              >
                Audit log →
              </Link>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
