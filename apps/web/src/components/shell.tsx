import { Link, useNavigate } from '@tanstack/react-router';
import { api, hasScope } from '../lib/api';
import { useAuth } from '../lib/providers';
import { useTheme } from '../lib/theme';
import { Button } from '../components/ui';
import { useToast } from '../components/toast';

const NAV: Array<{ to: string; label: string; scope?: string }> = [
  { to: '/', label: 'Home' },
  { to: '/settings/profile', label: 'Profile' },
  { to: '/settings/users', label: 'Users', scope: 'users:read' },
  { to: '/settings/roles', label: 'Roles', scope: 'roles:read' },
  { to: '/settings/sso', label: 'Single sign-on', scope: 'org:manage' },
  { to: '/settings/org', label: 'Workspace', scope: 'org:read' },
  { to: '/settings/audit', label: 'Audit log', scope: 'audit:read' },
  { to: '/settings/privacy', label: 'Privacy' },
];

export function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { user, org, clear } = useAuth();
  const { theme, toggle } = useTheme();
  const { notify } = useToast();
  const navigate = useNavigate();

  async function logout(): Promise<void> {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch {
      // Session may already be gone; clear locally regardless.
    }
    clear();
    notify('success', 'Signed out');
    void navigate({ to: '/login' });
  }

  const visibleNav = NAV.filter((item) => !item.scope || hasScope(user, item.scope));

  return (
    <div className="min-h-screen bg-surface text-text-primary">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-accent focus:px-4 focus:py-2 focus:text-white"
      >
        Skip to content
      </a>
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4">
          <div className="flex items-center gap-6">
            <Link to="/" className="text-base font-semibold text-accent">
              Nexus CRM
            </Link>
            <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
              {visibleNav.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  activeOptions={{ exact: item.to === '/' }}
                  activeProps={{ className: 'bg-surface-raised text-text-primary' }}
                  className="rounded px-3 py-1.5 text-sm text-text-secondary hover:bg-surface-raised hover:text-text-primary"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-text-secondary sm:block">
              {user?.name} · {org?.name}
            </span>
            <Button
              variant="ghost"
              onClick={toggle}
              aria-label="Toggle dark mode"
              title="Toggle dark mode"
            >
              {theme === 'light' ? 'Dark' : 'Light'}
            </Button>
            <Button variant="secondary" onClick={() => void logout()}>
              Sign out
            </Button>
          </div>
        </div>
        <nav
          aria-label="Primary mobile"
          className="flex gap-1 overflow-x-auto border-t border-border px-4 py-2 md:hidden"
        >
          {visibleNav.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.to === '/' }}
              activeProps={{ className: 'bg-surface-raised text-text-primary' }}
              className="whitespace-nowrap rounded px-3 py-1.5 text-sm text-text-secondary"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main id="main" className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
        {children}
      </main>
    </div>
  );
}
