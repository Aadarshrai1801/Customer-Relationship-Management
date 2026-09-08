import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate } from '@tanstack/react-router';
import { api, ApiError, type AuthResponse } from '../lib/api';
import { useAuth } from '../lib/providers';
import { Button, Field, FormError, Input } from '../components/ui';
import { useToast } from '../components/toast';

const loginSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

const codeSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

type LoginValues = z.infer<typeof loginSchema>;

interface OrgChoice {
  slug: string;
  name: string;
  status: string;
}

export function LoginPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { setSession, refresh } = useAuth();
  const { notify } = useToast();
  const [step, setStep] = useState<'credentials' | 'choose-org' | 'two-factor'>('credentials');
  const [orgs, setOrgs] = useState<OrgChoice[]>([]);
  const [pending, setPending] = useState<LoginValues | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const credentialsForm = useForm<LoginValues>({ resolver: zodResolver(loginSchema) });
  const codeForm = useForm<{ code: string }>({ resolver: zodResolver(codeSchema) });

  async function submitCredentials(values: LoginValues, orgSlug?: string): Promise<void> {
    setFormError(null);
    try {
      const auth = await api<AuthResponse>('/auth/login', {
        method: 'POST',
        body: { ...values, orgSlug },
      });
      if (auth.twoFactor.required && !auth.twoFactor.verified) {
        setPending(values);
        setSession(auth);
        setStep('two-factor');
        return;
      }
      setSession(auth);
      // Authoritative refresh before navigating: guarantees the session cache
      // is populated (avoids a stale-read race with the route transition).
      await refresh();
      notify('success', `Welcome back, ${auth.user.name}`);
      void navigate({ to: '/' });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MULTIPLE_ORGS') {
        setPending(values);
        setOrgs((err.details as { orgs: OrgChoice[] }).orgs);
        setStep('choose-org');
        return;
      }
      setFormError(err instanceof Error ? err.message : 'Login failed');
    }
  }

  async function submitCode({ code }: { code: string }): Promise<void> {
    setFormError(null);
    try {
      await api('/auth/2fa/verify', { method: 'POST', body: { code } });
      const me = await api<{ user: AuthResponse['user']; org: AuthResponse['org'] }>('/auth/me');
      setSession({ ...me, twoFactor: { enrolled: true, required: true, verified: true } });
      await refresh();
      notify('success', 'Signed in');
      void navigate({ to: '/' });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Verification failed');
    }
  }

  if (step === 'choose-org') {
    return (
      <AuthLayout title="Choose a workspace">
        <p className="text-sm text-text-secondary">
          {pending?.email} belongs to more than one workspace.
        </p>
        <div className="flex flex-col gap-2">
          {orgs.map((org) => (
            <button
              key={org.slug}
              type="button"
              onClick={() => pending && void submitCredentials(pending, org.slug)}
              className="rounded-lg border border-border bg-surface px-4 py-3 text-left hover:bg-surface-raised"
            >
              <span className="block text-sm font-medium">{org.name}</span>
              <span className="block text-xs text-text-secondary">{org.slug}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setStep('credentials')}
          className="text-sm text-accent hover:underline"
        >
          Back to sign in
        </button>
      </AuthLayout>
    );
  }

  if (step === 'two-factor') {
    return (
      <AuthLayout title="Two-factor verification">
        <form
          onSubmit={codeForm.handleSubmit(submitCode)}
          className="flex flex-col gap-4"
          noValidate
        >
          <Field
            label="Authentication code"
            htmlFor="code"
            error={codeForm.formState.errors.code?.message}
            hint="Enter the 6-digit code from your authenticator app."
          >
            <Input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              {...codeForm.register('code')}
            />
          </Field>
          <FormError message={formError} />
          <Button type="submit" disabled={codeForm.formState.isSubmitting}>
            {codeForm.formState.isSubmitting ? 'Verifying…' : 'Verify'}
          </Button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Sign in to Nexus">
      <form
        onSubmit={credentialsForm.handleSubmit((v) => submitCredentials(v))}
        className="flex flex-col gap-4"
        noValidate
      >
        <Field
          label="Email"
          htmlFor="email"
          error={credentialsForm.formState.errors.email?.message}
        >
          <Input
            id="email"
            type="email"
            autoComplete="email"
            {...credentialsForm.register('email')}
          />
        </Field>
        <Field
          label="Password"
          htmlFor="password"
          error={credentialsForm.formState.errors.password?.message}
        >
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            {...credentialsForm.register('password')}
          />
        </Field>
        <FormError message={formError} />
        <Button type="submit" disabled={credentialsForm.formState.isSubmitting}>
          {credentialsForm.formState.isSubmitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <SsoSignIn />
      <div className="flex items-center justify-between text-sm">
        <Link to="/reset-password" className="text-accent hover:underline">
          Forgot password?
        </Link>
        <Link to="/signup" className="text-accent hover:underline">
          Create workspace
        </Link>
      </div>
    </AuthLayout>
  );
}

export function SsoSignIn(): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [options, setOptions] = useState<
    Array<{ orgSlug: string; orgName: string; providers: Array<'saml' | 'oidc'> }>
  >([]);
  const [error, setError] = useState<string | null>(null);

  async function lookup(): Promise<void> {
    setError(null);
    try {
      const res = await api<{
        orgs: Array<{ orgSlug: string; orgName: string; providers: Array<'saml' | 'oidc'> }>;
      }>(`/auth/sso/resolve?email=${encodeURIComponent(email)}`);
      setOptions(res.orgs);
      if (res.orgs.length === 0) setError('No SSO workspace found for that email domain.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lookup failed');
    }
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-surface-raised p-4">
      <p className="text-[13px] font-semibold text-text-primary">Single sign-on</p>
      <div className="flex gap-2">
        <Input
          aria-label="Work email for SSO lookup"
          type="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Button type="button" variant="secondary" onClick={() => void lookup()}>
          Find
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {options.map((org) => (
        <div key={org.orgSlug} className="flex items-center justify-between gap-2 text-sm">
          <span>{org.orgName}</span>
          <span className="flex gap-2">
            {org.providers.map((provider) => (
              <a
                key={provider}
                className="text-accent hover:underline"
                href={`${apiBase()}/auth/sso/${provider}/${org.orgSlug}/start`}
              >
                Continue with {provider.toUpperCase()}
              </a>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

function apiBase(): string {
  return import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
}

export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <main className="grid min-h-screen w-full lg:grid-cols-[1.05fr_1fr]">
      {/* Brand panel */}
      <div className="relative hidden overflow-hidden bg-[#12101f] text-white lg:flex lg:flex-col lg:justify-between lg:p-10">
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-br from-[#4f46e5] via-[#6d28d9] to-[#0ea5e9] opacity-90"
        />
        <div
          aria-hidden
          className="absolute -top-24 -right-24 h-96 w-96 rounded-full bg-white/15 blur-3xl"
        />
        <div
          aria-hidden
          className="absolute -bottom-32 -left-16 h-[420px] w-[420px] rounded-full bg-[#22d3ee]/25 blur-3xl"
        />
        <div className="relative flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/95 text-lg font-extrabold text-[#4338ca] shadow-lg">
            N
          </span>
          <span className="text-[17px] font-bold tracking-tight">Nexus CRM</span>
        </div>
        <div className="relative max-w-md">
          <p className="inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-white/10 px-3 py-1 text-[11px] font-bold tracking-[0.08em] uppercase backdrop-blur">
            ✦ The CRM reps actually use
          </p>
          <h2 className="mt-4 text-4xl leading-[1.1] font-bold tracking-tight">
            Pipeline, inbox & reports — in one calm workspace.
          </h2>
          <ul className="mt-6 flex flex-col gap-3 text-sm text-white/85">
            {[
              ['⌘K', 'Command palette for everything'],
              ['◈', 'Kanban pipeline with drag & drop'],
              ['◐', 'Full dark mode parity'],
            ].map(([icon, text]) => (
              <li key={text} className="flex items-center gap-2.5">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/12 text-sm backdrop-blur">
                  {icon}
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-white/60">
          Trusted by revenue teams · SSO, audit logs & RBAC built in
        </p>
      </div>

      {/* Form column */}
      <div className="flex items-center justify-center bg-surface-raised px-4 py-10 sm:px-8">
        <div className="animate-enter w-full max-w-[420px]">
          <div className="mb-6 flex items-center gap-2.5 lg:hidden">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#6366f1] to-[#4338ca] text-lg font-extrabold text-white shadow-md">
              N
            </span>
            <span className="text-[15px] font-bold tracking-tight text-text-primary">
              Nexus CRM
            </span>
          </div>
          <div className="rounded-2xl border border-border bg-surface p-6 shadow-medium sm:p-8">
            <h1 className="text-[24px] font-bold tracking-tight text-text-primary">{title}</h1>
            {subtitle && <p className="mt-1.5 text-sm text-text-secondary">{subtitle}</p>}
            <div className="mt-6">{children}</div>
          </div>
          <p className="mt-5 text-center text-xs text-text-tertiary">
            Protected by SSO, 2FA & audit logging
          </p>
        </div>
      </div>
    </main>
  );
}
