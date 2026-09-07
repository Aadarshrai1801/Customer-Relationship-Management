import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../lib/providers';
import { api } from '../lib/api';
import { Badge, Card } from '../components/ui';
import type { OnboardingStatus } from './welcome';

export function HomePage(): React.JSX.Element {
  const { user, org } = useAuth();
  const statusQuery = useQuery({
    queryKey: ['onboarding-status'],
    queryFn: () => api<OnboardingStatus>('/onboarding/status'),
  });
  const showGettingStarted = statusQuery.data !== undefined && statusQuery.data.complete === false;

  return (
    <>
      <div>
        <h1 className="text-3xl font-semibold">Good to see you, {user?.name?.split(' ')[0]}</h1>
        <p className="mt-1 text-sm text-text-secondary">
          {org?.name} · {user?.email}
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {showGettingStarted && (
          <Card
            title="Getting started"
            description={`${statusQuery.data?.doneCount ?? 0} of ${statusQuery.data?.total ?? 0} setup steps done.`}
          >
            <Link to="/welcome" className="text-sm font-semibold text-accent hover:underline">
              Continue setup →
            </Link>
          </Card>
        )}
        <Card title="Your access" description="Role and session status for this workspace.">
          <dl className="flex flex-col gap-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-text-secondary">Role</dt>
              <dd className="font-medium">{user?.role.name}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-text-secondary">Status</dt>
              <dd>
                <Badge tone={user?.status === 'active' ? 'success' : 'warning'}>
                  {user?.status}
                </Badge>
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-text-secondary">Two-factor</dt>
              <dd>
                <Badge tone={user?.twoFactorEnrolled ? 'success' : 'neutral'}>
                  {user?.twoFactorEnrolled ? 'On' : 'Off'}
                </Badge>
              </dd>
            </div>
          </dl>
        </Card>
        <Card title="Security checklist" description="Hardening steps for this workspace.">
          <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
            <li>
              <Link to="/settings/security" className="text-accent hover:underline">
                {user?.twoFactorEnrolled
                  ? 'Manage two-factor authentication'
                  : 'Turn on two-factor authentication'}
              </Link>
            </li>
            <li>
              <Link to="/settings/privacy" className="text-accent hover:underline">
                Export or erase your personal data
              </Link>
            </li>
            <li>
              <Link to="/settings/audit" className="text-accent hover:underline">
                Review the audit log
              </Link>
            </li>
          </ul>
        </Card>
      </div>
    </>
  );
}
