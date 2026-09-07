import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Badge, Card, EmptyState, Skeleton } from '../components/ui';

export interface OnboardingStep {
  key: string;
  label: string;
  description: string;
  done: boolean;
  link: string;
}

export interface OnboardingStatus {
  steps: OnboardingStep[];
  doneCount: number;
  total: number;
  complete: boolean;
}

export function WelcomePage(): React.JSX.Element {
  const statusQuery = useQuery({
    queryKey: ['onboarding-status'],
    queryFn: () => api<OnboardingStatus>('/onboarding/status'),
  });

  if (statusQuery.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (statusQuery.isError || !statusQuery.data) {
    return (
      <EmptyState
        title="Could not load setup checklist"
        description={statusQuery.error?.message ?? 'Try again in a moment.'}
      />
    );
  }

  const status = statusQuery.data;
  const percent = status.total === 0 ? 100 : Math.round((status.doneCount / status.total) * 100);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-text-primary">Get started</h1>
        <p className="mt-1 text-xs text-text-secondary" aria-live="polite">
          {status.complete
            ? 'Setup complete — nice work.'
            : `${status.doneCount} of ${status.total} steps done`}
        </p>
      </div>

      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Setup progress"
        className="h-2 overflow-hidden rounded bg-surface-sunken"
      >
        <div className="h-full bg-accent transition-all" style={{ width: `${percent}%` }} />
      </div>

      <Card title="Setup checklist" description="Each step links to the page that completes it.">
        <ul className="flex flex-col gap-2">
          {status.steps.map((step) => (
            <li
              key={step.key}
              aria-label={`Step ${step.label}`}
              className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <span aria-hidden>{step.done ? '✅' : '⬜'}</span>
                <div>
                  <p className="text-sm font-medium text-text-primary">
                    {step.label} {step.done && <Badge tone="success">done</Badge>}
                  </p>
                  <p className="text-xs text-text-secondary">{step.description}</p>
                </div>
              </div>
              {!step.done && (
                <Link
                  to={step.link}
                  className="shrink-0 rounded bg-surface-raised px-3 py-1.5 text-xs font-semibold text-accent hover:underline"
                >
                  Do it
                </Link>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
