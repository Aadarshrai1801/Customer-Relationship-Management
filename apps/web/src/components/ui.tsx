import { clsx } from 'clsx';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

export function Button({
  variant = 'primary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
}): React.JSX.Element {
  return (
    <button
      className={clsx(
        'inline-flex h-9 items-center justify-center gap-2 rounded px-4 text-sm font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-accent text-white hover:bg-accent-hover',
        variant === 'secondary' &&
          'border border-border bg-surface text-text-primary hover:bg-surface-raised',
        variant === 'danger' && 'bg-danger text-white hover:brightness-110',
        variant === 'ghost' &&
          'text-text-secondary hover:bg-surface-raised hover:text-text-primary',
        className,
      )}
      {...props}
    />
  );
}

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <input
      className={clsx(
        'h-9 w-full rounded border border-border bg-surface px-3 text-sm text-text-primary',
        'placeholder:text-text-secondary/70 hover:border-border-strong',
        className,
      )}
      {...props}
    />
  );
}

export function Field({
  label,
  htmlFor,
  error,
  children,
  hint,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium text-text-primary">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-text-secondary">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <section className="rounded-lg border border-border bg-surface p-6 shadow-subtle">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">{title}</h2>
          {description && <p className="mt-1 text-sm text-text-secondary">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border-strong bg-surface-raised px-6 py-12 text-center">
      <p className="text-base font-medium">{title}</p>
      <p className="max-w-md text-sm text-text-secondary">{description}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }): React.JSX.Element {
  return <div aria-hidden className={clsx('animate-pulse rounded bg-surface-sunken', className)} />;
}

export function FormError({ message }: { message: string | null }): React.JSX.Element | null {
  if (!message) return null;
  return (
    <p role="alert" className="rounded bg-danger-soft px-3 py-2 text-sm text-danger">
      {message}
    </p>
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
  children: ReactNode;
}): React.JSX.Element {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        tone === 'neutral' && 'bg-surface-sunken text-text-secondary',
        tone === 'success' && 'bg-success-soft text-success',
        tone === 'warning' && 'bg-warning-soft text-warning',
        tone === 'danger' && 'bg-danger-soft text-danger',
        tone === 'info' && 'bg-accent-soft text-accent',
      )}
    >
      {children}
    </span>
  );
}
