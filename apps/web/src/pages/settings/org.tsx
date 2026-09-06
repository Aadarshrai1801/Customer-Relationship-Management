import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, hasScope, type OrgDetails } from '../../lib/api';
import { queryClient, useAuth } from '../../lib/providers';
import { Badge, Card, FormError, Skeleton } from '../../components/ui';
import { useToast } from '../../components/toast';

export function OrgPage(): React.JSX.Element {
  const { user } = useAuth();
  const { notify } = useToast();
  const [error, setError] = useState<string | null>(null);

  const org = useQuery({
    queryKey: ['org'],
    queryFn: () => api<OrgDetails>('/org'),
  });

  const canManage = hasScope(user, 'org:manage');

  const policyMutation = useMutation({
    mutationFn: (body: { twoFactorPolicy?: string; ssoOnly?: boolean }) =>
      api('/org/security', { method: 'PATCH', body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['org'] });
      notify('success', 'Security policy updated');
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Update failed'),
  });

  if (org.isLoading || !org.data) return <Skeleton className="h-48 w-full" />;

  const security = org.data.securitySettings;

  return (
    <div className="flex flex-col gap-4">
      <Card title={org.data.name} description={`Slug ${org.data.slug} · plan ${org.data.planTier}`}>
        <dl className="flex flex-col gap-2 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-text-secondary">Two-factor policy</dt>
            <dd>
              <Badge tone={security.twoFactorPolicy === 'off' ? 'warning' : 'success'}>
                {security.twoFactorPolicy}
              </Badge>
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-text-secondary">SSO-only sign-in</dt>
            <dd>
              <Badge tone={security.ssoOnly ? 'info' : 'neutral'}>
                {security.ssoOnly ? 'enforced' : 'off'}
              </Badge>
            </dd>
          </div>
        </dl>
      </Card>

      {canManage && (
        <Card
          title="Security policy"
          description="Required 2FA applies at next sign-in. SSO-only blocks password sign-in entirely."
        >
          <FormError message={error} />
          <div className="flex flex-col gap-4">
            <div>
              <label htmlFor="tfa-policy" className="mb-1 block text-sm font-medium">
                Two-factor policy
              </label>
              <select
                id="tfa-policy"
                value={security.twoFactorPolicy}
                onChange={(e) => {
                  setError(null);
                  policyMutation.mutate({ twoFactorPolicy: e.target.value });
                }}
                className="h-9 rounded border border-border bg-surface px-3 text-sm"
              >
                <option value="optional">Optional</option>
                <option value="required">Required</option>
                <option value="off">Off</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <input
                id="sso-only"
                type="checkbox"
                checked={security.ssoOnly}
                onChange={(e) => {
                  setError(null);
                  policyMutation.mutate({ ssoOnly: e.target.checked });
                }}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              <label htmlFor="sso-only" className="text-sm font-medium">
                Enforce SSO-only sign-in
              </label>
            </div>
            <p className="text-xs text-text-secondary">
              Enabling SSO-only requires at least one enabled sign-on provider, so you cannot lock
              the workspace out.
            </p>
          </div>
        </Card>
      )}
    </div>
  );
}
