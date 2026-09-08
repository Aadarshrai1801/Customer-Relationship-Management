import { clsx } from 'clsx';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}): React.JSX.Element {
  return (
    <button
      className={clsx(
        'inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg font-semibold whitespace-nowrap transition-all duration-150',
        'outline-none focus-visible:ring-4 focus-visible:ring-[var(--accent-ring)]',
        'disabled:pointer-events-none disabled:opacity-50',
        'active:scale-[0.98]',
        size === 'sm' && 'h-8 px-3 text-[13px]',
        size === 'md' && 'h-9.5 min-h-9 px-4 py-2 text-sm',
        size === 'lg' && 'h-11 px-5 text-[15px]',
        variant === 'primary' &&
          'bg-accent text-white shadow-[0_1px_2px_rgb(79_70_229/0.3),0_4px_12px_-2px_rgb(79_70_229/0.4)] hover:bg-accent-hover hover:shadow-[0_1px_2px_rgb(79_70_229/0.3),0_8px_20px_-4px_rgb(79_70_229/0.5)]',
        variant === 'secondary' &&
          'border border-border bg-surface text-text-primary shadow-subtle hover:border-border-strong hover:bg-surface-raised',
        variant === 'danger' &&
          'bg-danger text-white shadow-[0_1px_2px_rgb(220_38_38/0.3)] hover:brightness-110',
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
        'h-10 w-full rounded-lg border border-border bg-surface px-3.5 text-sm text-text-primary shadow-subtle transition-all duration-150',
        'placeholder:text-text-tertiary hover:border-border-strong',
        'outline-none focus:border-accent focus:ring-4 focus:ring-[var(--accent-ring)]',
        'disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-surface-raised',
        className,
      )}
      {...props}
    />
  );
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <select
      className={clsx(
        'h-10 rounded-lg border border-border bg-surface px-3 pr-8 text-sm text-text-primary shadow-subtle transition-all',
        'hover:border-border-strong outline-none focus:border-accent focus:ring-4 focus:ring-[var(--accent-ring)]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
    </select>
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
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[13px] font-semibold text-text-primary">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-text-secondary">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs font-medium text-danger">
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
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <section
      className={clsx(
        'animate-enter rounded-2xl border border-border bg-surface p-5 shadow-subtle sm:p-6',
        className,
      )}
    >
      {(typeof title === 'string' ? title.length > 0 : Boolean(title)) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold tracking-tight text-text-primary">{title}</h2>
            {description ? (
              <div className="mt-1 text-[13px] leading-relaxed text-text-secondary">
                {description}
              </div>
            ) : null}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="animate-enter flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-1 text-[11px] font-bold tracking-[0.08em] text-accent uppercase">
            {eyebrow}
          </p>
        )}
        <h1 className="text-[26px] leading-tight font-bold tracking-tight text-text-primary sm:text-[30px]">
          {title}
        </h1>
        {description && (
          <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-text-secondary">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="animate-enter flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border-strong/70 bg-surface px-6 py-14 text-center shadow-subtle">
      <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-2xl border border-border bg-surface-raised text-xl shadow-subtle">
        {icon ?? <span aria-hidden>✦</span>}
      </div>
      <p className="text-[15px] font-semibold tracking-tight text-text-primary">{title}</p>
      <p className="max-w-md text-[13px] leading-relaxed text-text-secondary">{description}</p>
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }): React.JSX.Element {
  return (
    <div
      aria-hidden
      className={clsx(
        'animate-pulse rounded-xl border border-border/60 bg-gradient-to-r from-surface-raised via-surface-sunken to-surface-raised',
        className,
      )}
    />
  );
}

export function FormError({ message }: { message: string | null }): React.JSX.Element | null {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-lg border border-danger/25 bg-danger-soft px-3.5 py-2.5 text-[13px] font-medium text-danger"
    >
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
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold whitespace-nowrap',
        tone === 'neutral' && 'border-border bg-surface-raised text-text-secondary',
        tone === 'success' && 'border-success/25 bg-success-soft text-success',
        tone === 'warning' && 'border-warning/25 bg-warning-soft text-warning',
        tone === 'danger' && 'border-danger/25 bg-danger-soft text-danger',
        tone === 'info' && 'border-accent/25 bg-accent-soft text-accent',
      )}
    >
      <span
        aria-hidden
        className={clsx(
          'h-1.5 w-1.5 rounded-full',
          tone === 'neutral' && 'bg-text-tertiary',
          tone === 'success' && 'bg-success',
          tone === 'warning' && 'bg-warning',
          tone === 'danger' && 'bg-danger',
          tone === 'info' && 'bg-accent',
        )}
      />
      {children}
    </span>
  );
}

export function Avatar({
  name,
  size = 'md',
  className,
}: {
  name: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}): React.JSX.Element {
  const initials = name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  // Stable hue from name — keeps avatars colorful but consistent.
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return (
    <span
      aria-hidden
      title={name}
      className={clsx(
        'inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white',
        size === 'sm' && 'h-7 w-7 text-[11px]',
        size === 'md' && 'h-9 w-9 text-xs',
        size === 'lg' && 'h-11 w-11 text-sm',
        className,
      )}
      style={{
        background: `linear-gradient(135deg, hsl(${hue} 65% 52%), hsl(${(hue + 40) % 360} 65% 42%))`,
      }}
    >
      {initials || '•'}
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-subtle">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold tracking-wide text-text-secondary uppercase">{label}</p>
        {icon && <span className="text-base">{icon}</span>}
      </div>
      <p className="mt-1.5 text-2xl font-bold tracking-tight text-text-primary">{value}</p>
      {hint && <div className="mt-1 text-xs text-text-secondary">{hint}</div>}
    </div>
  );
}
