import { useEffect, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { clsx } from 'clsx';
import { api, hasScope } from '../lib/api';
import { useAuth } from '../lib/providers';
import { useTheme } from '../lib/theme';
import { Avatar } from '../components/ui';
import { useToast } from '../components/toast';
import { CommandPalette } from './command-palette';
import { NotificationsPopover } from './notifications-popover';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  scope?: string;
}

interface NavSection {
  heading: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    heading: 'Overview',
    items: [{ to: '/', label: 'Home', icon: 'home' }],
  },
  {
    heading: 'Sales',
    items: [
      { to: '/leads', label: 'Leads', icon: 'spark', scope: 'leads:read' },
      { to: '/deals', label: 'Deals', icon: 'kanban', scope: 'deals:read' },
      { to: '/contacts', label: 'Contacts', icon: 'users', scope: 'contacts:read' },
      { to: '/accounts', label: 'Accounts', icon: 'briefcase', scope: 'accounts:read' },
    ],
  },
  {
    heading: 'Work',
    items: [
      { to: '/tasks', label: 'Tasks', icon: 'check', scope: 'tasks:read' },
      { to: '/emails', label: 'Emails', icon: 'mail', scope: 'activities:read' },
      { to: '/sequences', label: 'Sequences', icon: 'layers', scope: 'activities:read' },
      { to: '/reports', label: 'Reports', icon: 'chart', scope: 'reports:read' },
    ],
  },
  {
    heading: 'Data',
    items: [
      { to: '/duplicates', label: 'Duplicates', icon: 'copy', scope: 'contacts:read' },
      { to: '/imports', label: 'Imports', icon: 'upload', scope: 'contacts:manage' },
      {
        to: '/settings/custom-fields',
        label: 'Custom fields',
        icon: 'sliders',
        scope: 'custom_fields:read',
      },
      {
        to: '/settings/web-to-lead',
        label: 'Web to lead',
        icon: 'globe',
        scope: 'leads:manage',
      },
      {
        to: '/settings/lead-routing',
        label: 'Lead routing',
        icon: 'route',
        scope: 'leads:read',
      },
    ],
  },
  {
    heading: 'Automation',
    items: [
      {
        to: '/settings/workflows',
        label: 'Workflows',
        icon: 'zap',
        scope: 'workflows:read',
      },
      {
        to: '/settings/scheduling',
        label: 'Scheduling',
        icon: 'calendar',
        scope: 'activities:read',
      },
      {
        to: '/settings/approvals',
        label: 'Approvals',
        icon: 'shield-check',
        scope: 'deals:read',
      },
      {
        to: '/settings/territories',
        label: 'Territories',
        icon: 'map',
        scope: 'contacts:read',
      },
      { to: '/settings/sla', label: 'SLAs', icon: 'clock', scope: 'org:read' },
    ],
  },
  {
    heading: 'Administration',
    items: [
      { to: '/settings/users', label: 'Users', icon: 'user', scope: 'users:read' },
      { to: '/settings/roles', label: 'Roles', icon: 'key', scope: 'roles:read' },
      { to: '/settings/billing', label: 'Billing', icon: 'card', scope: 'org:manage' },
      { to: '/settings/audit', label: 'Audit log', icon: 'list', scope: 'audit:read' },
      { to: '/settings/security', label: 'Security', icon: 'lock' },
      { to: '/settings/org', label: 'Workspace', icon: 'gear', scope: 'org:read' },
      { to: '/settings/sso', label: 'SSO', icon: 'login', scope: 'org:manage' },
      { to: '/settings/privacy', label: 'Privacy', icon: 'eye', scope: 'org:read' },
      {
        to: '/settings/notifications',
        label: 'Notifications',
        icon: 'bell',
        scope: 'notifications:read',
      },
      { to: '/settings/profile', label: 'Profile', icon: 'smile' },
    ],
  },
];

const ICON_PATHS: Record<string, React.ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5M5 9.5V21h5v-6h4v6h5V9.5" />,
  spark: (
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
  ),
  kanban: <path d="M4 4h16v16H4zM8 8v8M12 8v5M16 8v8" />,
  users: (
    <path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 19v-1a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  ),
  briefcase: <path d="M4 8h16v12H4zM9 8V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3M4 13h16" />,
  check: <path d="M4 12.5 9.5 18 20 6.5" />,
  mail: <path d="M3 5h18v14H3zM3 7l9 6 9-6" />,
  layers: <path d="m12 3 9 5-9 5-9-5 9-5ZM3 13l9 5 9-5" />,
  chart: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  copy: <path d="M9 9h11v11H9zM5 15H4V4h11v1" />,
  upload: <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />,
  sliders: <path d="M4 8h10M18 8h2M4 16h4M12 16h8M14 5v6M8 13v6" />,
  globe: (
    <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3Z" />
  ),
  route: (
    <path d="M6 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 16v-3a4 4 0 0 1 4-4h7" />
  ),
  zap: <path d="M13 3 4 14h6l-1 7 9-11h-6l1-7Z" />,
  calendar: <path d="M4 6h16v15H4zM4 10h16M8 3v4M16 3v4" />,
  'shield-check': <path d="M12 3 5 6v5c0 5 3.4 8.4 7 10 3.6-1.6 7-5 7-10V6l-7-3ZM9 12l2 2 4-4" />,
  map: <path d="m9 4-5 2v14l5-2 6 2 5-2V4l-5 2-6-2ZM9 4v14M15 6v14" />,
  clock: <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v5l3 2" />,
  user: <path d="M19 21v-1a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v1M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />,
  key: <path d="m15 9 6 6-3 3-6-6M15 9a4 4 0 1 0-5.7 5.7L4 20l4-1 1.3-1.3A4 4 0 0 0 15 9Z" />,
  card: <path d="M3 6h18v12H3zM3 10h18M7 15h4" />,
  list: <path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" />,
  lock: <path d="M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5zM12 15v3" />,
  gear: (
    <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.07-.4.1-.8.1-1.2Z" />
  ),
  login: <path d="M14 4h-9v16h9M10 12h11M18 8l3 4-3 4" />,
  eye: (
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
  ),
  bell: <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6ZM10 20a2 2 0 0 0 4 0" />,
  smile: (
    <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM8.5 14.5c1 1 2.2 1.5 3.5 1.5s2.5-.5 3.5-1.5M9 9.5h.01M15 9.5h.01" />
  ),
};

function NavIcon({ name, className }: { name: string; className?: string }): React.JSX.Element {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? 'h-4 w-4 shrink-0'}
    >
      {ICON_PATHS[name] ?? ICON_PATHS.home}
    </svg>
  );
}

function BrandMark(): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-[#6366f1] to-[#4338ca] text-[15px] font-extrabold text-white shadow-[0_4px_12px_-2px_rgb(79_70_229/0.5)]"
    >
      N
    </span>
  );
}

const COLLAPSE_KEY = 'nexus-sidebar-collapsed';

export function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { user, org, clear } = useAuth();
  const { theme, toggle } = useTheme();
  const { notify } = useToast();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      // storage unavailable — ignore
    }
  }, [collapsed]);

  // Close mobile drawer on viewport growth to desktop.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = (e: MediaQueryListEvent): void => {
      if (e.matches) setMobileOpen(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

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

  const sections = SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => !item.scope || hasScope(user, item.scope)),
  })).filter((section) => section.items.length > 0);

  const sidebarBody = (opts: { onNavigate?: () => void; compact?: boolean }) => (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-3 py-4">
        <nav aria-label="Primary" className="flex flex-col gap-5">
          {sections.map((section) => (
            <div key={section.heading}>
              {!opts.compact && (
                <p className="mb-1.5 px-2 text-[10px] font-bold tracking-[0.1em] text-text-tertiary uppercase">
                  {section.heading}
                </p>
              )}
              <ul className="flex flex-col gap-0.5">
                {section.items.map((item) => (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      onClick={() => opts.onNavigate?.()}
                      title={opts.compact ? `${section.heading} · ${item.label}` : undefined}
                      activeOptions={{ exact: item.to === '/' }}
                      activeProps={{
                        className:
                          'bg-sidebar-active text-accent font-semibold shadow-[inset_2px_0_0_var(--accent)]',
                      }}
                      className={clsx(
                        'group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium text-text-secondary transition-all duration-150',
                        'hover:bg-surface-raised hover:text-text-primary',
                        opts.compact && 'justify-center px-0',
                      )}
                    >
                      <NavIcon
                        name={item.icon}
                        className="h-[18px] w-[18px] shrink-0 opacity-80 group-hover:opacity-100"
                      />
                      {!opts.compact && <span className="truncate">{item.label}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
      {!opts.compact && (
        <div className="border-t border-border p-3">
          <div className="rounded-xl border border-border bg-surface-raised/70 p-3">
            <p className="text-xs font-semibold text-text-primary">Need a hand?</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-text-secondary">
              Press <kbd className="rounded border border-border bg-surface px-1 font-mono">⌘K</kbd>{' '}
              to jump anywhere.
            </p>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-surface-raised text-text-primary lg:flex">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside
        className={clsx(
          'sticky top-0 hidden h-screen shrink-0 border-r border-border bg-sidebar transition-all duration-200 lg:flex lg:flex-col',
          collapsed ? 'w-[68px]' : 'w-[248px]',
        )}
        aria-label="Sidebar"
      >
        <div
          className={clsx(
            'flex h-16 items-center gap-2.5 border-b border-border px-4',
            collapsed && 'justify-center px-2',
          )}
        >
          <Link to="/" className="flex min-w-0 items-center gap-2.5" aria-label="Nexus CRM home">
            <BrandMark />
            {!collapsed && (
              <span className="min-w-0">
                <span className="block truncate text-[15px] font-bold tracking-tight">
                  Nexus CRM
                </span>
                <span className="block truncate text-[11px] font-medium text-text-secondary">
                  {org?.name ?? 'Workspace'}
                </span>
              </span>
            )}
          </Link>
        </div>
        <div className="min-h-0 flex-1">{sidebarBody({ compact: collapsed })}</div>
        <div className="border-t border-border p-2">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="flex w-full items-center justify-center gap-2 rounded-lg px-2 py-2 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
          >
            <span aria-hidden>{collapsed ? '→' : '←'}</span>
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-50 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
        >
          <button
            type="button"
            aria-label="Close navigation menu"
            onClick={() => setMobileOpen(false)}
            className="absolute inset-0 cursor-default bg-black/50 backdrop-blur-[2px]"
          />
          <div className="animate-pop absolute inset-y-0 left-0 flex w-[280px] flex-col border-r border-border bg-sidebar shadow-prominent">
            <div className="flex h-16 items-center justify-between border-b border-border px-4">
              <Link
                to="/"
                onClick={() => setMobileOpen(false)}
                className="flex items-center gap-2.5"
              >
                <BrandMark />
                <span className="text-[15px] font-bold tracking-tight">Nexus CRM</span>
              </Link>
              <button
                type="button"
                onClick={() => setMobileOpen(false)}
                aria-label="Close menu"
                className="rounded-lg px-2.5 py-1.5 text-lg text-text-secondary hover:bg-surface-raised hover:text-text-primary"
              >
                ×
              </button>
            </div>
            <div className="min-h-0 flex-1">
              {sidebarBody({ onNavigate: () => setMobileOpen(false) })}
            </div>
          </div>
        </div>
      )}

      {/* Content column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-border bg-surface/85 backdrop-blur-md">
          <div className="mx-auto flex h-16 w-full max-w-[1280px] items-center gap-2.5 px-4 sm:px-6">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation menu"
              className="rounded-lg border border-border bg-surface p-2 text-text-secondary shadow-subtle hover:text-text-primary lg:hidden"
            >
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
              >
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              className="hidden rounded-lg border border-border bg-surface p-2 text-text-secondary shadow-subtle hover:text-text-primary lg:block"
            >
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
              >
                <path d="M4 6h16M4 12h16M4 18h10" />
              </svg>
            </button>
            <div className="min-w-0 flex-1">
              <CommandPalette />
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <NotificationsPopover />
              <button
                type="button"
                onClick={toggle}
                aria-label="Toggle dark mode"
                title="Toggle dark mode"
                className="rounded-lg p-2 text-[17px] leading-none text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
              >
                <span aria-hidden>{theme === 'light' ? '◐' : '☀'}</span>
              </button>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setUserMenuOpen((o) => !o)}
                  aria-haspopup="menu"
                  aria-expanded={userMenuOpen}
                  aria-label="Account menu"
                  className="flex items-center gap-2 rounded-xl border border-transparent p-1 pr-1.5 transition-colors hover:border-border hover:bg-surface-raised"
                >
                  <Avatar name={user?.name ?? '?'} size="sm" />
                  <span className="hidden max-w-[140px] truncate text-left text-xs xl:block">
                    <span className="block truncate font-semibold text-text-primary">
                      {user?.name ?? '—'}
                    </span>
                    <span className="block truncate text-[11px] text-text-secondary">
                      {user?.role.name ?? org?.name ?? ''}
                    </span>
                  </span>
                </button>
                {userMenuOpen && (
                  <>
                    <button
                      type="button"
                      aria-label="Close account menu"
                      onClick={() => setUserMenuOpen(false)}
                      className="fixed inset-0 z-10 cursor-default"
                    />
                    <div
                      role="menu"
                      className="animate-pop absolute right-0 z-20 mt-2 w-60 overflow-hidden rounded-xl border border-border bg-surface-overlay shadow-prominent"
                    >
                      <div className="flex items-center gap-2.5 border-b border-border p-3.5">
                        <Avatar name={user?.name ?? '?'} size="md" />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">{user?.name}</p>
                          <p className="truncate text-xs text-text-secondary">{user?.email}</p>
                        </div>
                      </div>
                      <div className="p-1.5">
                        <Link
                          to="/settings/profile"
                          onClick={() => setUserMenuOpen(false)}
                          className="block rounded-lg px-3 py-2 text-[13px] font-medium text-text-secondary hover:bg-surface-raised hover:text-text-primary"
                        >
                          Profile settings
                        </Link>
                        <Link
                          to="/settings/billing"
                          onClick={() => setUserMenuOpen(false)}
                          className="block rounded-lg px-3 py-2 text-[13px] font-medium text-text-secondary hover:bg-surface-raised hover:text-text-primary"
                        >
                          Workspace & billing
                        </Link>
                        <button
                          type="button"
                          onClick={() => {
                            setUserMenuOpen(false);
                            void logout();
                          }}
                          className="block w-full rounded-lg px-3 py-2 text-left text-[13px] font-semibold text-danger hover:bg-danger-soft"
                        >
                          Sign out
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </header>
        <main
          id="main"
          className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col gap-5 px-4 py-6 sm:px-6 lg:py-8"
        >
          {children}
        </main>
        <footer className="border-t border-border/70 py-4">
          <p className="mx-auto max-w-[1280px] px-6 text-center text-[11px] text-text-tertiary">
            {org?.name ?? 'Nexus CRM'} · Press{' '}
            <kbd className="rounded border border-border bg-surface px-1 font-mono">⌘K</kbd> for
            quick actions
          </p>
        </footer>
      </div>
    </div>
  );
}
