import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { api } from '../lib/api';
import { Button, Field, FormError, Input } from '../components/ui';
import { AuthLayout } from './login';

const emailSchema = z.object({ email: z.string().email('Enter a valid email address') });
const resetSchema = z.object({
  token: z.string().min(20),
  newPassword: z.string().min(1, 'New password is required').max(200),
});

export function ResetPasswordPage(): React.JSX.Element {
  const search = useSearch({ strict: false }) as { token?: string };
  const navigate = useNavigate();
  const [sent, setSent] = useState(false);
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const emailForm = useForm<{ email: string }>({ resolver: zodResolver(emailSchema) });
  const resetForm = useForm<{ token: string; newPassword: string }>({
    resolver: zodResolver(resetSchema),
    defaultValues: { token: search.token ?? '' },
  });

  async function requestReset({ email }: { email: string }): Promise<void> {
    setFormError(null);
    try {
      await api('/auth/password/request', { method: 'POST', body: { email } });
      setSent(true);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Request failed');
    }
  }

  async function confirmReset(values: { token: string; newPassword: string }): Promise<void> {
    setFormError(null);
    try {
      await api('/auth/password/confirm', { method: 'POST', body: values });
      setDone(true);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Reset failed');
    }
  }

  if (done) {
    return (
      <AuthLayout title="Password updated">
        <p className="text-sm text-text-secondary">
          Your password was changed. All other sessions were signed out.
        </p>
        <Link to="/login" className="text-sm text-accent hover:underline">
          Back to sign in
        </Link>
      </AuthLayout>
    );
  }

  if (search.token) {
    return (
      <AuthLayout title="Choose a new password">
        <form onSubmit={resetForm.handleSubmit(confirmReset)} className="flex flex-col gap-4">
          <Field
            label="New password"
            htmlFor="newPassword"
            error={resetForm.formState.errors.newPassword?.message}
          >
            <Input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              {...resetForm.register('newPassword')}
            />
          </Field>
          <FormError message={formError} />
          <Button type="submit" disabled={resetForm.formState.isSubmitting}>
            {resetForm.formState.isSubmitting ? 'Saving…' : 'Save new password'}
          </Button>
        </form>
      </AuthLayout>
    );
  }

  if (sent) {
    return (
      <AuthLayout title="Check your inbox">
        <p className="text-sm text-text-secondary">
          If an account exists for that email, a reset link is on its way. It expires in one hour.
        </p>
        <button
          type="button"
          onClick={() => void navigate({ to: '/login' })}
          className="text-left text-sm text-accent hover:underline"
        >
          Back to sign in
        </button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Reset your password">
      <form onSubmit={emailForm.handleSubmit(requestReset)} className="flex flex-col gap-4">
        <Field
          label="Work email"
          htmlFor="reset-email"
          error={emailForm.formState.errors.email?.message}
        >
          <Input
            id="reset-email"
            type="email"
            autoComplete="email"
            {...emailForm.register('email')}
          />
        </Field>
        <FormError message={formError} />
        <Button type="submit" disabled={emailForm.formState.isSubmitting}>
          {emailForm.formState.isSubmitting ? 'Sending…' : 'Send reset link'}
        </Button>
      </form>
    </AuthLayout>
  );
}
