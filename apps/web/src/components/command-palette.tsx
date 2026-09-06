import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import * as Dialog from '@radix-ui/react-dialog';
import { useTheme } from '../lib/theme';
import { useAuth } from '../lib/providers';
import { hasScope } from '../lib/api';

interface PaletteItem {
  id: string;
  category: 'Navigation' | 'Actions';
  label: string;
  hint?: string;
  scope?: string;
  onSelect: () => void;
}

export function CommandPalette(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
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
      label: 'Home',
      hint: 'Go to workspace overview',
      onSelect: () => void navigate({ to: '/' }),
    },
    {
      id: 'nav-contacts',
      category: 'Navigation',
      label: 'Contacts',
      hint: 'Browse & search contacts',
      scope: 'contacts:read',
      onSelect: () => void navigate({ to: '/contacts' }),
    },
    {
      id: 'nav-accounts',
      category: 'Navigation',
      label: 'Accounts',
      hint: 'Browse & search accounts',
      scope: 'accounts:read',
      onSelect: () => void navigate({ to: '/accounts' }),
    },
    {
      id: 'nav-duplicates',
      category: 'Navigation',
      label: 'Duplicates & Deduplication Queue',
      hint: 'Review flagged duplicate records',
      scope: 'contacts:read',
      onSelect: () => void navigate({ to: '/duplicates' }),
    },
    {
      id: 'nav-imports',
      category: 'Navigation',
      label: 'Imports & Exports',
      hint: 'Bulk CSV / VCF import wizard',
      scope: 'contacts:manage',
      onSelect: () => void navigate({ to: '/imports' }),
    },
    {
      id: 'nav-custom-fields',
      category: 'Navigation',
      label: 'Custom Fields Admin',
      hint: 'Manage custom & formula fields',
      scope: 'custom_fields:read',
      onSelect: () => void navigate({ to: '/settings/custom-fields' }),
    },
    {
      id: 'nav-audit',
      category: 'Navigation',
      label: 'Audit Log',
      hint: 'View change history and logs',
      scope: 'audit:read',
      onSelect: () => void navigate({ to: '/settings/audit' }),
    },
    {
      id: 'nav-users',
      category: 'Navigation',
      label: 'Users Directory',
      hint: 'Manage team members and roles',
      scope: 'users:read',
      onSelect: () => void navigate({ to: '/settings/users' }),
    },
    {
      id: 'nav-profile',
      category: 'Navigation',
      label: 'Profile Settings',
      hint: 'Manage your name, password, and sessions',
      onSelect: () => void navigate({ to: '/settings/profile' }),
    },
    {
      id: 'act-new-contact',
      category: 'Actions',
      label: 'Create Contact',
      hint: 'Add a new person to Nexus',
      scope: 'contacts:manage',
      onSelect: () => void navigate({ to: '/contacts', search: { create: 'true' } as any }),
    },
    {
      id: 'act-new-account',
      category: 'Actions',
      label: 'Create Account',
      hint: 'Add a new organization',
      scope: 'accounts:manage',
      onSelect: () => void navigate({ to: '/accounts', search: { create: 'true' } as any }),
    },
    {
      id: 'act-theme',
      category: 'Actions',
      label: `Switch to ${theme === 'dark' ? 'Light' : 'Dark'} Mode`,
      hint: 'Toggle UI color theme',
      onSelect: toggle,
    },
  ];

  const visibleItems = items.filter(
    (item) => !item.scope || hasScope(user, item.scope),
  );

  const filtered = query.trim()
    ? visibleItems.filter(
        (i) =>
          i.label.toLowerCase().includes(query.toLowerCase()) ||
          (i.hint && i.hint.toLowerCase().includes(query.toLowerCase())),
      )
    : visibleItems;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  function executeItem(item: PaletteItem) {
    setOpen(false);
    setQuery('');
    item.onSelect();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % (filtered.length || 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + (filtered.length || 1)) % (filtered.length || 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        executeItem(filtered[selectedIndex]);
      }
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hidden items-center gap-2 rounded border border-border bg-surface-raised px-2.5 py-1 text-xs text-text-secondary transition-colors hover:border-border-strong sm:flex"
        title="Open command palette (Ctrl+K or Cmd+K)"
      >
        <span>Search or command...</span>
        <kbd className="rounded border border-border bg-surface px-1 py-0.5 text-[10px] font-mono">
          ⌘K
        </kbd>
      </button>

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs" />
          <Dialog.Content className="fixed left-1/2 top-1/4 z-50 w-full max-w-lg -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-prominent">
            <Dialog.Title className="sr-only">Command Palette</Dialog.Title>
            <div className="border-b border-border p-3">
              <input
                type="text"
                autoFocus
                placeholder="Type a command or navigate..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-secondary focus:outline-none"
              />
            </div>
            <div className="max-h-80 overflow-y-auto p-2">
              {filtered.length === 0 ? (
                <p className="p-4 text-center text-xs text-text-secondary">No matching commands.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {filtered.map((item, index) => {
                    const isSelected = index === selectedIndex;
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => executeItem(item)}
                          className={`flex w-full items-center justify-between rounded px-3 py-2 text-left text-xs transition-colors ${
                            isSelected
                              ? 'bg-accent text-white'
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
