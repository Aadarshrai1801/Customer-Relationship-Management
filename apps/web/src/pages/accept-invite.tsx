import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { api, type AuthResponse } from '../lib/api';
import { useAuth } from '../lib/providers';
import { Button, Field, FormError, Input, Skeleton } from '../components/ui';
import { useToast } from '../components/toast';
import { AuthLayout } from './login';

const acceptSchema = z.object({
  token: z.string().min(20),
  name: z.string().trim().min(1, 'Your name is required').max(100),
  password: z.string().min(12, 'Use at least 12 characters').max(200),
});

interface InvitePreview {
  orgName: string;
  email: string;
  roleName: string;
  expiresAt: string;
}

export function AcceptInvitePage(): React.JSX.Element {
  const search = useSearch({ strict: false }) as { token?: string };
  const navigate = useNavigate();
  const { setSession, refresh } = useAuth();
  const { notify } = useToast();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<{ token: string; name: string; password: string }>({
    resolver: zodResolver(acceptSchema),
    defaultValues: { token: search.token ?? '', name: '', password: '' },
  });

  useEffect(() => {
    if (!search.token) {
      setPreviewError('This invitation link is missing its token.');
      return;
    }
    api<InvitePreview>(`/auth/invites/${search.token}`)
      .then(setPreview)
      .catch((err: unknown) =>
        setPreviewError(err instanceof Error ? err.message : 'Invitation not found'),
      );
  }, [search.token]);

  async function submit(values: { token: string; name: string; password: string }): Promise<void> {
    setFormError(null);
    try {
      const auth = await api<AuthResponse>('/auth/invites/accept', {
        method: 'POST',
        body: values,
      });
      setSession(auth);
      await refresh();
      notify('success', `Joined ${auth.org.name}`);
      void navigate({ to: '/' });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not accept the invitation');
    }
  }

  if (previewError) {
    return (
      <AuthLayout title="Invitation unavailable">
        <p role="alert" className="text-sm text-danger">
          {previewError}
        </p>
        <Link to="/login" className="text-sm text-accent hover:underline">
          Back to sign in
        </Link>
      </AuthLayout>
    );
  }

  if (!preview) {
    return (
      <AuthLayout title="Loading invitation">
        <Skeleton className="h-24 w-full" />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={`Join ${preview.orgName}`}>
      <p className="text-sm text-text-secondary">
        You were invited as <strong>{preview.roleName}</strong> for {preview.email}.
      </p>
      <form onSubmit={form.handleSubmit(submit)} className="flex flex-col gap-4" noValidate>
        <Field label="Your name" htmlFor="name" error={form.formState.errors.name?.message}>
          <Input id="name" autoComplete="name" {...form.register('name')} />
        </Field>
        <Field
          label="Password"
          htmlFor="password"
          error={form.formState.errors.password?.message}
          hint="At least 12 characters."
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            {...form.register('password')}
          />
        </Field>
        <FormError message={formError} />
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? 'Joining…' : 'Accept invitation'}
        </Button>
      </form>
    </AuthLayout>
  );
}
