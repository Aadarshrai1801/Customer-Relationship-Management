import { Link, useNavigate } from '@tanstack/react-router';
import { api, hasScope } from '../lib/api';
import { useAuth } from '../lib/providers';
import { useTheme } from '../lib/theme';
import { Button } from '../components/ui';
import { useToast } from '../components/toast';
import { CommandPalette } from './command-palette';
import { NotificationsPopover } from './notifications-popover';

const NAV: Array<{ to: string; label: string; scope?: string }> = [
  { to: '/', label: 'Home' },
  { to: '/leads', label: 'Leads', scope: 'leads:read' },
  { to: '/deals', label: 'Deals', scope: 'deals:read' },
  { to: '/tasks', label: 'Tasks', scope: 'tasks:read' },
  { to: '/contacts', label: 'Contacts', scope: 'contacts:read' },
  { to: '/accounts', label: 'Accounts', scope: 'accounts:read' },
  { to: '/duplicates', label: 'Duplicates', scope: 'contacts:read' },
  { to: '/imports', label: 'Imports', scope: 'contacts:manage' },
  { to: '/settings/custom-fields', label: 'Custom Fields', scope: 'custom_fields:read' },
  { to: '/settings/users', label: 'Users', scope: 'users:read' },
  { to: '/settings/roles', label: 'Roles', scope: 'roles:read' },
  { to: '/settings/audit', label: 'Audit log', scope: 'audit:read' },
  { to: '/settings/profile', label: 'Settings' },
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
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-4">
          <div className="flex items-center gap-6">
            <Link to="/" className="text-base font-semibold text-accent flex items-center gap-1.5">
              <span>Nexus CRM</span>
            </Link>
            <nav aria-label="Primary" className="hidden items-center gap-1 lg:flex">
              {visibleNav.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  activeOptions={{ exact: item.to === '/' }}
                  activeProps={{ className: 'bg-surface-raised text-text-primary font-medium' }}
                  className="rounded px-2.5 py-1.5 text-xs text-text-secondary hover:bg-surface-raised hover:text-text-primary transition-colors"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <NotificationsPopover />
            <CommandPalette />
            <span className="hidden text-xs text-text-secondary xl:block">
              {user?.name} · {org?.name}
            </span>
            <Button
              variant="ghost"
              onClick={toggle}
              aria-label="Toggle dark mode"
              title="Toggle dark mode"
              className="text-xs h-8 px-2.5"
            >
              {theme === 'light' ? '🌙 Dark' : '☀️ Light'}
            </Button>
            <Button variant="secondary" onClick={() => void logout()} className="text-xs h-8 px-3">
              Sign out
            </Button>
          </div>
        </div>
        <nav
          aria-label="Primary mobile"
          className="flex gap-1 overflow-x-auto border-t border-border px-4 py-2 lg:hidden"
        >
          {visibleNav.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.to === '/' }}
              activeProps={{ className: 'bg-surface-raised text-text-primary font-medium' }}
              className="whitespace-nowrap rounded px-2.5 py-1 text-xs text-text-secondary hover:bg-surface-raised hover:text-text-primary"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main id="main" className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8">
        {children}
      </main>
    </div>
  );
}
