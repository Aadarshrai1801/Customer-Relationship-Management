import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, API_URL, hasScope } from '../../lib/api';
import { useAuth } from '../../lib/providers';
import type { CustomFieldDef, SerializedAccount } from '../../lib/crm-types';
import { Button, Card, EmptyState, Field, Input, Skeleton } from '../../components/ui';
import { Modal } from '../../components/modal';
import { CustomFieldsForm } from '../../components/custom-fields-renderer';
import { useToast } from '../../components/toast';

interface AccountListResponse {
  accounts: SerializedAccount[];
  nextCursor: string | null;
}

export function AccountsListPage(): React.JSX.Element {
  const { user } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [industryFilter, setIndustryFilter] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SerializedAccount | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [phone, setPhone] = useState('');
  const [industry, setIndustry] = useState('');
  const [domainsInput, setDomainsInput] = useState('');
  const [parentId, setParentId] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [customFields, setCustomFields] = useState<Record<string, unknown>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const canManage = hasScope(user, 'accounts:manage');

  // Load custom field definitions for account
  const customFieldDefs = useQuery({
    queryKey: ['custom-fields', 'account'],
    queryFn: () => api<CustomFieldDef[]>('/custom-fields?entityType=account'),
  });

  // Load accounts list
  const accountsQuery = useQuery({
    queryKey: ['accounts-list', debouncedSearch, industryFilter, cursor],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '25' });
      if (debouncedSearch.trim()) params.set('q', debouncedSearch.trim());
      if (industryFilter.trim()) params.set('industry', industryFilter.trim());
      if (cursor) params.set('cursor', cursor);
      return api<AccountListResponse>(`/accounts?${params.toString()}`);
    },
  });

  // Create account mutation
  const createMutation = useMutation({
    mutationFn: async () => {
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const domains = domainsInput
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean);

      return api<{ account: SerializedAccount }>('/accounts', {
        method: 'POST',
        body: {
          name,
          website: website || undefined,
          phone: phone || undefined,
          industry: industry || undefined,
          domains,
          parentId: parentId || undefined,
          tags,
          customFields,
        },
      });
    },
    onSuccess: () => {
      notify('success', 'Account created successfully');
      setCreateModalOpen(false);
      resetForm();
      void queryClient.invalidateQueries({ queryKey: ['accounts-list'] });
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : 'Failed to create account');
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return api(`/accounts/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      notify('success', 'Account deleted');
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['accounts-list'] });
    },
    onError: (err) => {
      notify('error', err instanceof Error ? err.message : 'Failed to delete account');
    },
  });

  function resetForm(): void {
    setName('');
    setWebsite('');
    setPhone('');
    setIndustry('');
    setDomainsInput('');
    setParentId('');
    setTagsInput('');
    setCustomFields({});
    setFormError(null);
  }

  function handleSearchSubmit(e: React.FormEvent): void {
    e.preventDefault();
    setCursor(null);
    setDebouncedSearch(search);
  }

  function handleExport(): void {
    window.open(`${API_URL}/v1/accounts-export`, '_blank');
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Accounts</h1>
          <p className="mt-0.5 text-xs text-text-secondary">
            Manage company profiles, subsidiaries, and client accounts.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={handleExport} className="text-xs">
            Export CSV
          </Button>
          <Link to="/imports" search={{ entityType: 'account' }}>
            <Button variant="secondary" className="text-xs">
              Import
            </Button>
          </Link>
          {canManage && (
            <Button
              variant="primary"
              onClick={() => {
                resetForm();
                setCreateModalOpen(true);
              }}
              className="text-xs"
            >
              + New Account
            </Button>
          )}
        </div>
      </div>

      {/* Filters bar */}
      <Card title="Filter Accounts">
        <form onSubmit={handleSearchSubmit} className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <label htmlFor="search-accounts" className="mb-1 block text-xs font-medium text-text-secondary">
              Search by company name or website
            </label>
            <Input
              id="search-accounts"
              placeholder="e.g. Acme Corp or acme.com"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="industry-filter" className="mb-1 block text-xs font-medium text-text-secondary">
              Industry
            </label>
            <Input
              id="industry-filter"
              placeholder="e.g. Technology, Healthcare"
              value={industryFilter}
              onChange={(e) => {
                setIndustryFilter(e.target.value);
                setCursor(null);
              }}
              className="w-48"
            />
          </div>
          <Button type="submit" variant="secondary" className="h-9">
            Apply
          </Button>
          {(debouncedSearch || industryFilter) && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setSearch('');
                setDebouncedSearch('');
                setIndustryFilter('');
                setCursor(null);
              }}
              className="h-9 text-xs text-text-secondary"
            >
              Clear filters
            </Button>
          )}
        </form>
      </Card>

      {/* Accounts Table */}
      {accountsQuery.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : accountsQuery.isError ? (
        <div className="rounded bg-danger-soft p-4 text-sm text-danger">
          Could not load accounts: {accountsQuery.error?.message}
        </div>
      ) : !accountsQuery.data || accountsQuery.data.accounts.length === 0 ? (
        <EmptyState
          title="No accounts found"
          description="Get started by creating an account or importing company data."
          action={
            canManage ? (
              <Button variant="primary" onClick={() => setCreateModalOpen(true)}>
                Create First Account
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-subtle">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border bg-surface-raised text-text-secondary">
                <tr>
                  <th className="px-4 py-3 font-medium">Company Name</th>
                  <th className="px-4 py-3 font-medium">Industry</th>
                  <th className="px-4 py-3 font-medium">Website</th>
                  <th className="px-4 py-3 font-medium">Phone</th>
                  <th className="px-4 py-3 font-medium">Parent Company</th>
                  <th className="px-4 py-3 font-medium">Contacts</th>
                  <th className="px-4 py-3 font-medium">Owner</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {accountsQuery.data.accounts.map((acc) => (
                  <tr key={acc.id} className="hover:bg-surface-raised/50 transition-colors">
                    <td className="px-4 py-3">
                      <Link
                        to="/accounts/$id"
                        params={{ id: acc.id }}
                        className="font-semibold text-accent hover:underline"
                      >
                        {acc.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-text-primary">{acc.industry || '—'}</td>
                    <td className="px-4 py-3">
                      {acc.website ? (
                        <a
                          href={acc.website.startsWith('http') ? acc.website : `https://${acc.website}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-accent hover:underline truncate max-w-[150px] inline-block"
                        >
                          {acc.website.replace(/^https?:\/\//, '')}
                        </a>
                      ) : (
                        <span className="text-text-secondary">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{acc.phone || '—'}</td>
                    <td className="px-4 py-3">
                      {acc.parent ? (
                        <Link
                          to="/accounts/$id"
                          params={{ id: acc.parent.id }}
                          className="text-accent hover:underline"
                        >
                          {acc.parent.name}
                        </Link>
                      ) : (
                        <span className="text-text-secondary">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {acc.contactCount} contacts
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {acc.owner?.name ?? 'Unassigned'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <Link to="/accounts/$id" params={{ id: acc.id }}>
                          <Button variant="ghost" className="h-7 px-2 text-xs">
                            View
                          </Button>
                        </Link>
                        {canManage && (
                          <Button
                            variant="ghost"
                            onClick={() => setDeleteTarget(acc)}
                            className="h-7 px-2 text-xs text-danger hover:bg-danger-soft"
                          >
                            Delete
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between border-t border-border px-4 py-3 text-xs text-text-secondary">
            <span>Showing {accountsQuery.data.accounts.length} records</span>
            {accountsQuery.data.nextCursor && (
              <Button
                variant="secondary"
                onClick={() => setCursor(accountsQuery.data?.nextCursor ?? null)}
                className="text-xs"
              >
                Load Next Page →
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Create Account Modal */}
      <Modal
        open={createModalOpen}
        onOpenChange={setCreateModalOpen}
        size="2xl"
        title="Create Account"
        description="Add a new company or client account. Required: Name."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setFormError(null);
            if (!name.trim()) {
              setFormError('Account name is required');
              return;
            }
            createMutation.mutate();
          }}
          className="flex flex-col gap-4"
        >
          {formError && (
            <div role="alert" className="rounded bg-danger-soft p-3 text-xs text-danger">
              {formError}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Company Name *" htmlFor="a-name">
              <Input
                id="a-name"
                required
                placeholder="Acme Corporation"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>

            <Field label="Industry" htmlFor="a-industry">
              <Input
                id="a-industry"
                placeholder="e.g. Software, Finance, Healthcare"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
              />
            </Field>

            <Field label="Website" htmlFor="a-website">
              <Input
                id="a-website"
                placeholder="https://acme.com"
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
              />
            </Field>

            <Field label="Phone" htmlFor="a-phone">
              <Input
                id="a-phone"
                placeholder="+1 555-0100"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </Field>

            <Field label="Parent Company (Hierarchy)" htmlFor="a-parent">
              <select
                id="a-parent"
                value={parentId}
                onChange={(e) => setParentId(e.target.value)}
                className="h-9 rounded border border-border bg-surface px-3 text-sm text-text-primary"
              >
                <option value="">-- None (Top-Level Account) --</option>
                {accountsQuery.data?.accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Domains (comma-separated)" htmlFor="a-domains" hint="e.g. acme.com, acme.co.uk">
              <Input
                id="a-domains"
                placeholder="acme.com, acme.org"
                value={domainsInput}
                onChange={(e) => setDomainsInput(e.target.value)}
              />
            </Field>

            <div className="sm:col-span-2">
              <Field label="Tags (comma-separated)" htmlFor="a-tags">
                <Input
                  id="a-tags"
                  placeholder="enterprise, priority, tier-1"
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                />
              </Field>
            </div>
          </div>

          {/* Custom Fields */}
          {customFieldDefs.data && customFieldDefs.data.length > 0 && (
            <CustomFieldsForm
              defs={customFieldDefs.data}
              values={customFields}
              onChange={(k, val) => setCustomFields((prev) => ({ ...prev, [k]: val }))}
            />
          )}

          <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setCreateModalOpen(false)}
              disabled={createMutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Creating...' : 'Create Account'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete Confirmation */}
      <Modal
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        size="sm"
        title="Delete Account"
        description={`Are you sure you want to delete ${deleteTarget?.name}?`}
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs text-text-secondary">
            Deleting an account with child accounts is guarded by the system. Associated contacts
            will become unassigned from this account.
          </p>
          <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Confirm Delete'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
