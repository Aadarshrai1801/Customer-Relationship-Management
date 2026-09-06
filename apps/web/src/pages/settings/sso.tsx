import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, type SsoConfigSummary } from '../../lib/api';
import { queryClient } from '../../lib/providers';
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

const oidcSchema = z.object({
  issuer: z.string().trim().min(1, 'Issuer is required'),
  clientId: z.string().trim().min(1, 'Client ID is required'),
  clientSecret: z.string().min(1, 'Client secret is required'),
  domains: z.string().trim(),
  defaultRoleKey: z.string().trim().min(1).default('rep'),
});

const samlSchema = z.object({
  idpMetadataXml: z.string().trim().min(100, 'Paste the IdP metadata XML'),
  domains: z.string().trim(),
  defaultRoleKey: z.string().trim().min(1).default('rep'),
});

export function SsoPage(): React.JSX.Element {
  const { notify } = useToast();
  const [provider, setProvider] = useState<'oidc' | 'saml' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const configs = useQuery({
    queryKey: ['sso-configs'],
    queryFn: () => api<SsoConfigSummary[]>('/sso/configs'),
  });

  const oidcForm = useForm<z.input<typeof oidcSchema>>({
    resolver: zodResolver(oidcSchema),
    defaultValues: {
      issuer: '',
      clientId: '',
      clientSecret: '',
      domains: '',
      defaultRoleKey: 'rep',
    },
  });
  const samlForm = useForm<z.input<typeof samlSchema>>({
    resolver: zodResolver(samlSchema),
    defaultValues: { idpMetadataXml: '', domains: '', defaultRoleKey: 'rep' },
  });

  const createMutation = useMutation({
    mutationFn: (body: unknown) => api('/sso/configs', { method: 'POST', body }),
    onSuccess: async () => {
      setProvider(null);
      await queryClient.invalidateQueries({ queryKey: ['sso-configs'] });
      notify('success', 'Sign-on provider added (disabled until you enable it)');
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Create failed'),
  });

  async function toggle(config: SsoConfigSummary): Promise<void> {
    setError(null);
    try {
      await api(`/sso/configs/${config.id}`, {
        method: 'PATCH',
        body: { enabled: !config.enabled },
      });
      await queryClient.invalidateQueries({ queryKey: ['sso-configs'] });
      notify('success', config.enabled ? 'Provider disabled' : 'Provider enabled');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    }
  }

  async function remove(config: SsoConfigSummary): Promise<void> {
    setError(null);
    try {
      await api(`/sso/configs/${config.id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['sso-configs'] });
      notify('success', 'Provider removed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Single sign-on"
        description="Google Workspace via OpenID Connect, Okta and Azure AD via SAML 2.0."
        actions={
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setProvider('oidc')}>
              Add OIDC
            </Button>
            <Button variant="secondary" onClick={() => setProvider('saml')}>
              Add SAML
            </Button>
          </div>
        }
      >
        <FormError message={error} />
        {configs.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : !configs.data || configs.data.length === 0 ? (
          <EmptyState
            title="No sign-on providers"
            description="Password sign-in stays available until you enable a provider and enforce SSO-only."
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {configs.data.map((config) => (
              <li
                key={config.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4"
              >
                <div>
                  <p className="font-medium">
                    {config.provider.toUpperCase()}{' '}
                    <Badge tone={config.enabled ? 'success' : 'neutral'}>
                      {config.enabled ? 'enabled' : 'disabled'}
                    </Badge>
                  </p>
                  <p className="mt-1 text-xs text-text-secondary">
                    {config.issuer ?? config.idpSsoUrl} · default role {config.defaultRoleKey}
                    {config.domains.length > 0 && ` · ${config.domains.join(', ')}`}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => void toggle(config)}>
                    {config.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button variant="danger" onClick={() => void remove(config)}>
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={provider === 'oidc'}
        onOpenChange={(open) => {
          if (!open) setProvider(null);
        }}
        title="Add OpenID Connect provider"
        description="Issuer, client ID, and secret come from your identity provider's app registration."
      >
        <form
          onSubmit={oidcForm.handleSubmit((v) =>
            createMutation.mutate({
              provider: 'oidc',
              domains: splitList(v.domains),
              defaultRoleKey: v.defaultRoleKey,
              oidc: { issuer: v.issuer, clientId: v.clientId, clientSecret: v.clientSecret },
            }),
          )}
          className="flex flex-col gap-4"
        >
          <Field
            label="Issuer URL"
            htmlFor="oidc-issuer"
            error={oidcForm.formState.errors.issuer?.message}
          >
            <Input
              id="oidc-issuer"
              placeholder="https://accounts.google.com"
              {...oidcForm.register('issuer')}
            />
          </Field>
          <Field
            label="Client ID"
            htmlFor="oidc-client"
            error={oidcForm.formState.errors.clientId?.message}
          >
            <Input id="oidc-client" {...oidcForm.register('clientId')} />
          </Field>
          <Field
            label="Client secret"
            htmlFor="oidc-secret"
            error={oidcForm.formState.errors.clientSecret?.message}
          >
            <Input
              id="oidc-secret"
              type="password"
              autoComplete="new-password"
              {...oidcForm.register('clientSecret')}
            />
          </Field>
          <Field
            label="Email domains"
            htmlFor="oidc-domains"
            hint="Comma-separated, for workspace discovery."
          >
            <Input id="oidc-domains" placeholder="company.com" {...oidcForm.register('domains')} />
          </Field>
          <FormError message={error} />
          <div>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Validating…' : 'Add provider'}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        open={provider === 'saml'}
        onOpenChange={(open) => {
          if (!open) setProvider(null);
        }}
        title="Add SAML provider"
        description="Paste your identity provider's metadata XML. Nexus validates it before saving."
      >
        <form
          onSubmit={samlForm.handleSubmit((v) =>
            createMutation.mutate({
              provider: 'saml',
              domains: splitList(v.domains),
              defaultRoleKey: v.defaultRoleKey,
              saml: { idpMetadataXml: v.idpMetadataXml },
            }),
          )}
          className="flex flex-col gap-4"
        >
          <Field
            label="IdP metadata XML"
            htmlFor="saml-xml"
            error={samlForm.formState.errors.idpMetadataXml?.message}
          >
            <textarea
              id="saml-xml"
              rows={6}
              className="w-full rounded border border-border bg-surface px-3 py-2 font-mono text-xs"
              {...samlForm.register('idpMetadataXml')}
            />
          </Field>
          <Field
            label="Email domains"
            htmlFor="saml-domains"
            hint="Comma-separated, for workspace discovery."
          >
            <Input id="saml-domains" placeholder="company.com" {...samlForm.register('domains')} />
          </Field>
          <FormError message={error} />
          <div>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Validating…' : 'Add provider'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function splitList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}
