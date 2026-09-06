import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate } from '@tanstack/react-router';
import { api, type AuthResponse } from '../lib/api';
import { useAuth } from '../lib/providers';
import { Button, Field, FormError, Input } from '../components/ui';
import { useToast } from '../components/toast';
import { AuthLayout } from './login';

const signupSchema = z.object({
  orgName: z.string().trim().min(2, 'Workspace name needs at least 2 characters').max(100),
  name: z.string().trim().min(1, 'Your name is required').max(100),
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(12, 'Use at least 12 characters').max(200),
});

type SignupValues = z.infer<typeof signupSchema>;

export function SignupPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { setSession, refresh } = useAuth();
  const { notify } = useToast();
  const [formError, setFormError] = useState<string | null>(null);
  const form = useForm<SignupValues>({ resolver: zodResolver(signupSchema) });

  async function submit(values: SignupValues): Promise<void> {
    setFormError(null);
    try {
      const auth = await api<AuthResponse>('/auth/signup', { method: 'POST', body: values });
      setSession(auth);
      await refresh();
      notify('success', `Workspace ${auth.org.name} created`);
      void navigate({ to: '/' });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Signup failed');
    }
  }

  return (
    <AuthLayout title="Create your workspace">
      <form onSubmit={form.handleSubmit(submit)} className="flex flex-col gap-4" noValidate>
        <Field
          label="Workspace name"
          htmlFor="orgName"
          error={form.formState.errors.orgName?.message}
        >
          <Input id="orgName" autoComplete="organization" {...form.register('orgName')} />
        </Field>
        <Field label="Your name" htmlFor="name" error={form.formState.errors.name?.message}>
          <Input id="name" autoComplete="name" {...form.register('name')} />
        </Field>
        <Field label="Work email" htmlFor="email" error={form.formState.errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" {...form.register('email')} />
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
          {form.formState.isSubmitting ? 'Creating…' : 'Create workspace'}
        </Button>
      </form>
      <p className="text-sm text-text-secondary">
        Already have a workspace?{' '}
        <Link to="/login" className="text-accent hover:underline">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
