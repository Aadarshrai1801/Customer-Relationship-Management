import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import * as Dialog from '@radix-ui/react-dialog';
import { useTheme } from '../lib/theme';
import { useAuth } from '../lib/providers';
import { hasScope } from '../lib/api';

interface PaletteItem {
  id: string;
  category: 'Recent' | 'Navigation' | 'Actions';
  label: string;
  hint?: string;
  scope?: string;
  keywords?: string;
  onSelect: () => void;
}

const RECENT_KEY = 'nexus-palette-recent';

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function CommandPalette(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentIds, setRecentIds] = useState<string[]>(() => readRecent());
  const navigate = useNavigate();
  const { toggle, theme } = useTheme();
  const { user } = useAuth();

  // Listen for Cmd+K / Ctrl+K
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const items: PaletteItem[] = [
    {
      id: 'nav-home',
      category: 'Navigation',
      label: 'Home dashboard',
      hint: 'Stats, pipeline, tasks',
      keywords: 'home overview dashboard start',
      onSelect: () => void navigate({ to: '/' }),
    },
    {
      id: 'nav-deals',
      category: 'Navigation',
      label: 'Deals pipeline',
      hint: 'Kanban board & forecast',
      scope: 'deals:read',
      keywords: 'deals pipeline kanban forecast sales',
      onSelect: () => void navigate({ to: '/deals' }),
    },
    {
      id: 'nav-leads',
      category: 'Navigation',
      label: 'Leads',
      hint: 'Browse & qualify sales leads',
      scope: 'leads:read',
      keywords: 'leads qualify inbound',
      onSelect: () => void navigate({ to: '/leads' }),
    },
    {
      id: 'nav-contacts',
      category: 'Navigation',
      label: 'Contacts',
      hint: 'Browse & search contacts',
      scope: 'contacts:read',
      keywords: 'contacts people search',
      onSelect: () => void navigate({ to: '/contacts' }),
    },
    {
      id: 'nav-accounts',
      category: 'Navigation',
      label: 'Accounts',
      hint: 'Browse & search accounts',
      scope: 'accounts:read',
      keywords: 'accounts companies organizations',
      onSelect: () => void navigate({ to: '/accounts' }),
    },
    {
      id: 'nav-tasks',
      category: 'Navigation',
      label: 'Tasks',
      hint: 'Open, overdue & reminders',
      scope: 'tasks:read',
      keywords: 'tasks todo overdue reminders',
      onSelect: () => void navigate({ to: '/tasks' }),
    },
    {
      id: 'nav-emails',
      category: 'Navigation',
      label: 'Emails',
      hint: 'Log, templates & sync',
      scope: 'activities:read',
      keywords: 'emails inbox templates compose',
      onSelect: () => void navigate({ to: '/emails' }),
    },
    {
      id: 'nav-sequences',
      category: 'Navigation',
      label: 'Sequences',
      hint: 'Cadences & enrollments',
      scope: 'activities:read',
      keywords: 'sequences cadence outreach',
      onSelect: () => void navigate({ to: '/sequences' }),
    },
    {
      id: 'nav-reports',
      category: 'Navigation',
      label: 'Reports',
      hint: 'Forecast, pipeline & activity',
      scope: 'reports:read',
      keywords: 'reports dashboards forecast analytics',
      onSelect: () => void navigate({ to: '/reports' }),
    },
    {
      id: 'nav-duplicates',
      category: 'Navigation',
      label: 'Duplicates queue',
      hint: 'Review flagged duplicate records',
      scope: 'contacts:read',
      keywords: 'duplicates merge dedup queue',
      onSelect: () => void navigate({ to: '/duplicates' }),
    },
    {
      id: 'nav-imports',
      category: 'Navigation',
      label: 'Imports & exports',
      hint: 'Bulk CSV / VCF import wizard',
      scope: 'contacts:manage',
      keywords: 'imports csv bulk upload export',
      onSelect: () => void navigate({ to: '/imports' }),
    },
    {
      id: 'nav-web-to-lead',
      category: 'Navigation',
      label: 'Web-to-Lead ingestion',
      hint: 'Embed forms and HTML snippets',
      scope: 'leads:manage',
      keywords: 'web form embed lead capture',
      onSelect: () => void navigate({ to: '/settings/web-to-lead' }),
    },
    {
      id: 'nav-lead-routing',
      category: 'Navigation',
      label: 'Lead routing & availability',
      hint: 'Round-robin assignment and PTO status',
      scope: 'leads:read',
      keywords: 'routing round robin assignment availability',
      onSelect: () => void navigate({ to: '/settings/lead-routing' }),
    },
    {
      id: 'nav-custom-fields',
      category: 'Navigation',
      label: 'Custom fields admin',
      hint: 'Manage custom & formula fields',
      scope: 'custom_fields:read',
      keywords: 'custom fields formula admin',
      onSelect: () => void navigate({ to: '/settings/custom-fields' }),
    },
    {
      id: 'nav-workflows',
      category: 'Navigation',
      label: 'Workflows',
      hint: 'Trigger → condition → action',
      scope: 'workflows:read',
      keywords: 'workflows automation rules',
      onSelect: () => void navigate({ to: '/settings/workflows' }),
    },
    {
      id: 'nav-scheduling',
      category: 'Navigation',
      label: 'Scheduling',
      hint: 'Booking links & availability',
      scope: 'activities:read',
      keywords: 'scheduling booking calendar meetings',
      onSelect: () => void navigate({ to: '/settings/scheduling' }),
    },
    {
      id: 'nav-approvals',
      category: 'Navigation',
      label: 'Approvals',
      hint: 'Deal approval processes',
      scope: 'deals:read',
      keywords: 'approvals deals signoff',
      onSelect: () => void navigate({ to: '/settings/approvals' }),
    },
    {
      id: 'nav-territories',
      category: 'Navigation',
      label: 'Territories',
      hint: 'Geography & segment rules',
      scope: 'contacts:read',
      keywords: 'territories geography segments',
      onSelect: () => void navigate({ to: '/settings/territories' }),
    },
    {
      id: 'nav-sla',
      category: 'Navigation',
      label: 'SLAs',
      hint: 'Response & resolution targets',
      scope: 'org:read',
      keywords: 'sla targets response',
      onSelect: () => void navigate({ to: '/settings/sla' }),
    },
    {
      id: 'nav-users',
      category: 'Navigation',
      label: 'Users directory',
      hint: 'Manage team members and roles',
      scope: 'users:read',
      keywords: 'users team members directory',
      onSelect: () => void navigate({ to: '/settings/users' }),
    },
    {
      id: 'nav-roles',
      category: 'Navigation',
      label: 'Roles & permissions',
      hint: 'RBAC scopes & access',
      scope: 'roles:read',
      keywords: 'roles permissions rbac access',
      onSelect: () => void navigate({ to: '/settings/roles' }),
    },
    {
      id: 'nav-billing',
      category: 'Navigation',
      label: 'Billing',
      hint: 'Plan, seats & invoices',
      scope: 'org:manage',
      keywords: 'billing plan seats invoices subscription',
      onSelect: () => void navigate({ to: '/settings/billing' }),
    },
    {
      id: 'nav-audit',
      category: 'Navigation',
      label: 'Audit log',
      hint: 'View change history and logs',
      scope: 'audit:read',
      keywords: 'audit log history changes',
      onSelect: () => void navigate({ to: '/settings/audit' }),
    },
    {
      id: 'nav-security',
      category: 'Navigation',
      label: 'Security',
      hint: '2FA, sessions & policies',
      keywords: 'security 2fa sessions policy',
      onSelect: () => void navigate({ to: '/settings/security' }),
    },
    {
      id: 'nav-notifications',
      category: 'Navigation',
      label: 'Notification preferences',
      hint: 'Channels & digests',
      scope: 'notifications:read',
      keywords: 'notifications preferences digest email push',
      onSelect: () => void navigate({ to: '/settings/notifications' }),
    },
    {
      id: 'nav-profile',
      category: 'Navigation',
      label: 'Profile settings',
      hint: 'Manage your name, password, and sessions',
      keywords: 'profile password sessions account',
      onSelect: () => void navigate({ to: '/settings/profile' }),
    },
    {
      id: 'act-new-deal',
      category: 'Actions',
      label: 'Create deal',
      hint: 'Add to the pipeline',
      scope: 'deals:manage',
      keywords: 'new deal create pipeline',
      onSelect: () => void navigate({ to: '/deals' }),
    },
    {
      id: 'act-new-lead',
      category: 'Actions',
      label: 'Create lead',
      hint: 'Capture inbound interest',
      scope: 'leads:manage',
      keywords: 'new lead create capture',
      onSelect: () => void navigate({ to: '/leads' }),
    },
    {
      id: 'act-new-task',
      category: 'Actions',
      label: 'Create task',
      hint: 'Follow-ups & reminders',
      scope: 'tasks:manage',
      keywords: 'new task create todo followup',
      onSelect: () => void navigate({ to: '/tasks' }),
    },
    {
      id: 'act-new-contact',
      category: 'Actions',
      label: 'Create contact',
      hint: 'Add a new person to Nexus',
      scope: 'contacts:manage',
      keywords: 'new contact create person',
      onSelect: () => void navigate({ to: '/contacts', search: { create: 'true' } as any }),
    },
    {
      id: 'act-new-account',
      category: 'Actions',
      label: 'Create account',
      hint: 'Add a new organization',
      scope: 'accounts:manage',
      keywords: 'new account create company organization',
      onSelect: () => void navigate({ to: '/accounts', search: { create: 'true' } as any }),
    },
    {
      id: 'act-theme',
      category: 'Actions',
      label: `Switch to ${theme === 'dark' ? 'Light' : 'Dark'} mode`,
      hint: 'Toggle UI color theme',
      keywords: 'theme dark light mode appearance',
      onSelect: toggle,
    },
  ];

  const visibleItems = items.filter((item) => !item.scope || hasScope(user, item.scope));

  const q = query.trim().toLowerCase();
  const filtered = q
    ? visibleItems.filter(
        (i) =>
          i.label.toLowerCase().includes(q) ||
          (i.hint && i.hint.toLowerCase().includes(q)) ||
          (i.keywords && i.keywords.toLowerCase().includes(q)),
      )
    : visibleItems;

  // Recent section (only when not searching): most-used destinations first.
  const recentItems: PaletteItem[] = !q
    ? recentIds
        .map((id) => visibleItems.find((i) => i.id === id))
        .filter((i): i is PaletteItem => Boolean(i))
        .slice(0, 4)
        .map((i) => ({ ...i, category: 'Recent' as const }))
    : [];
  const recentIdSet = new Set(recentItems.map((i) => i.id));
  const ordered = [...recentItems, ...filtered.filter((i) => !recentIdSet.has(i.id))];

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, open]);

  useEffect(() => {
    if (open) setRecentIds(readRecent());
  }, [open]);

  function executeItem(item: PaletteItem) {
    setOpen(false);
    setQuery('');
    setRecentIds((prev) => {
      const next = [item.id, ...prev.filter((id) => id !== item.id)].slice(0, 5);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable — ignore
      }
      return next;
    });
    item.onSelect();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % (ordered.length || 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + (ordered.length || 1)) % (ordered.length || 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (ordered[selectedIndex]) {
        executeItem(ordered[selectedIndex]);
      }
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full max-w-md items-center gap-2.5 rounded-xl border border-border bg-surface-raised/80 py-2 pr-2 pl-3.5 text-left text-[13px] text-text-tertiary shadow-subtle transition-all hover:border-border-strong hover:bg-surface-raised hover:text-text-secondary"
        title="Open command palette (Ctrl+K or Cmd+K)"
      >
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="h-4 w-4 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <span className="flex-1 truncate">Search, jump to, or run a command…</span>
        <kbd className="shrink-0 rounded-md border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] font-semibold text-text-secondary">
          ⌘K
        </kbd>
      </button>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="animate-enter fixed inset-0 z-50 bg-black/55 backdrop-blur-[3px]" />
          <Dialog.Content className="animate-pop fixed top-[12vh] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-surface shadow-prominent">
            <Dialog.Title className="sr-only">Command Palette</Dialog.Title>
            <div className="flex items-center gap-2.5 border-b border-border px-4">
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                className="h-4 w-4 shrink-0 text-text-tertiary"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <input
                type="text"
                autoFocus
                placeholder="Type a command or navigate..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                className="h-12 w-full bg-transparent text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
              />
            </div>
            <div className="max-h-80 overflow-y-auto p-2">
              {ordered.length === 0 ? (
                <p className="p-6 text-center text-[13px] text-text-secondary">
                  No matching commands. Try &quot;deal&quot;, &quot;task&quot; or
                  &quot;report&quot;.
                </p>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {ordered.map((item, index) => {
                    const isSelected = index === selectedIndex;
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => executeItem(item)}
                          className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left text-[13px] transition-colors ${
                            isSelected
                              ? 'bg-accent text-white shadow-[0_4px_12px_-2px_rgb(79_70_229/0.5)]'
                              : 'text-text-primary hover:bg-surface-raised'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] uppercase font-semibold ${
                                isSelected
                                  ? 'bg-white/20 text-white'
                                  : 'bg-surface-raised text-text-secondary'
                              }`}
                            >
                              {item.category}
                            </span>
                            <span className="font-medium">{item.label}</span>
                          </div>
                          {item.hint && (
                            <span
                              className={`text-[11px] ${
                                isSelected ? 'text-white/80' : 'text-text-secondary'
                              }`}
                            >
                              {item.hint}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="border-t border-border bg-surface-raised/50 px-3 py-2 text-[11px] text-text-secondary flex justify-between">
              <span>Navigate with ↑ and ↓</span>
              <span>Select with ↵</span>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
