import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { api } from '../../lib/api';
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

const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') });
const passwordSchema = z.object({ password: z.string().min(1, 'Password is required') });

export function SecurityPage(): React.JSX.Element {
  const { user, refresh } = useAuth();
  const { notify } = useToast();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const codeForm = useForm<{ code: string }>({ resolver: zodResolver(codeSchema) });
  const passwordForm = useForm<{ password: string }>({ resolver: zodResolver(passwordSchema) });

  async function startSetup(): Promise<void> {
    setError(null);
    try {
      const res = await api<{ secret: string; otpauthUrl: string }>('/auth/2fa/setup', {
        method: 'POST',
      });
      setSetup(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed');
    }
  }

  async function enable({ code }: { code: string }): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const res = await api<{ backupCodes: string[] }>('/auth/2fa/enable', {
        method: 'POST',
        body: { code },
      });
      setBackupCodes(res.backupCodes);
      setSetup(null);
      codeForm.reset();
      await refresh();
      notify('success', 'Two-factor authentication enabled');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setBusy(false);
    }
  }

  async function disable({ password }: { password: string }): Promise<void> {
    setError(null);
    try {
      await api('/auth/2fa/disable', { method: 'POST', body: { password } });
      setConfirmDisable(false);
      await refresh();
      notify('success', 'Two-factor authentication disabled');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disable');
    }
  }

  async function regenerate({ password }: { password: string }): Promise<void> {
    setError(null);
    try {
      const res = await api<{ backupCodes: string[] }>('/auth/2fa/backup-codes/regenerate', {
        method: 'POST',
        body: { password },
      });
      setBackupCodes(res.backupCodes);
      setConfirmRegenerate(false);
      notify('success', 'New backup codes issued — old ones no longer work');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not regenerate codes');
    }
  }

  if (!user) return <Skeleton className="h-48 w-full" />;

  return (
    <div className="flex flex-col gap-4">
      <Card
        title="Two-factor authentication"
        description="TOTP codes from an authenticator app, plus single-use backup codes."
        actions={
          <Badge tone={user.twoFactorEnrolled ? 'success' : 'neutral'}>
            {user.twoFactorEnrolled ? 'Enabled' : 'Disabled'}
          </Badge>
        }
      >
        {user.twoFactorEnrolled ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setConfirmRegenerate(true)}>
              Regenerate backup codes
            </Button>
            <Button variant="danger" onClick={() => setConfirmDisable(true)}>
              Disable 2FA
            </Button>
          </div>
        ) : setup ? (
          <div className="flex max-w-md flex-col gap-4">
            <div className="rounded-lg border border-border bg-surface-raised p-4">
              <p className="text-sm font-medium">1. Add this secret to your authenticator app</p>
              <p className="mt-2 break-all rounded bg-surface-sunken p-2 font-mono text-xs">
                {setup.secret}
              </p>
              <p className="mt-2 break-all text-xs text-text-secondary">{setup.otpauthUrl}</p>
            </div>
            <form onSubmit={codeForm.handleSubmit(enable)} className="flex flex-col gap-4">
              <Field
                label="Authentication code"
                htmlFor="tfa-code"
                error={codeForm.formState.errors.code?.message}
                hint="Enter the 6-digit code from your authenticator app to confirm."
              >
                <Input
                  id="tfa-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  {...codeForm.register('code')}
                />
              </Field>
              <FormError message={error} />
              <div>
                <Button type="submit" disabled={busy}>
                  {busy ? 'Verifying…' : 'Enable 2FA'}
                </Button>
              </div>
            </form>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <FormError message={error} />
            <div>
              <Button onClick={() => void startSetup()}>Set up authenticator app</Button>
            </div>
          </div>
        )}
      </Card>

      {backupCodes && (
        <Card
          title="Backup codes — save these now"
          description="Each code works once. They will not be shown again."
        >
          <ul className="grid grid-cols-2 gap-2 font-mono text-sm">
            {backupCodes.map((code) => (
              <li key={code} className="rounded bg-surface-sunken px-3 py-2">
                {code}
              </li>
            ))}
          </ul>
          <div className="mt-4">
            <Button
              variant="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(backupCodes.join('\n'));
                notify('success', 'Backup codes copied');
              }}
            >
              Copy all
            </Button>
          </div>
        </Card>
      )}

      {!user.twoFactorEnrolled && !setup && !backupCodes && (
        <EmptyState
          title="Extra sign-in protection"
          description="If someone learns your password, they still cannot sign in without a code from your phone."
        />
      )}

      <Modal
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        title="Disable two-factor authentication"
        description="Your account will be protected by password alone. Confirm with your password."
      >
        <PasswordConfirmForm
          submitLabel="Disable 2FA"
          onSubmit={disable}
          error={error}
          form={passwordForm}
        />
      </Modal>
      <Modal
        open={confirmRegenerate}
        onOpenChange={setConfirmRegenerate}
        title="Regenerate backup codes"
        description="Old codes stop working immediately. Confirm with your password."
      >
        <PasswordConfirmForm
          submitLabel="Regenerate codes"
          onSubmit={regenerate}
          error={error}
          form={passwordForm}
        />
      </Modal>
    </div>
  );
}

function PasswordConfirmForm({
  submitLabel,
  onSubmit,
  error,
  form,
}: {
  submitLabel: string;
  onSubmit: (values: { password: string }) => Promise<void>;
  error: string | null;
  form: ReturnType<typeof useForm<{ password: string }>>;
}): React.JSX.Element {
  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <Field
        label="Current password"
        htmlFor="confirm-password"
        error={form.formState.errors.password?.message}
      >
        <Input
          id="confirm-password"
          type="password"
          autoComplete="current-password"
          {...form.register('password')}
        />
      </Field>
      <FormError message={error} />
      <div>
        <Button type="submit" variant="danger" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? 'Working…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
