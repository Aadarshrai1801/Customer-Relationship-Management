import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, API_URL, hasScope } from '../../lib/api';
import { useAuth } from '../../lib/providers';
import type {
  ContactWarning,
  CustomFieldDef,
  LifecycleStage,
  SerializedAccount,
  SerializedContact,
} from '../../lib/crm-types';
import { Badge, Button, Card, EmptyState, Field, Input, Skeleton } from '../../components/ui';
import { Modal } from '../../components/modal';
import { CustomFieldsForm } from '../../components/custom-fields-renderer';
import { useToast } from '../../components/toast';

interface ContactListResponse {
  contacts: SerializedContact[];
  nextCursor: string | null;
}

const LIFECYCLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All Stages' },
  { value: 'lead', label: 'Lead' },
  { value: 'mql', label: 'MQL' },
  { value: 'sql', label: 'SQL' },
  { value: 'opportunity', label: 'Opportunity' },
  { value: 'customer', label: 'Customer' },
  { value: 'evangelist', label: 'Evangelist' },
  { value: 'other', label: 'Other' },
];

export function ContactsListPage(): React.JSX.Element {
  const { user } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [stageFilter, setStageFilter] = useState<string>('all');
  const [tagFilter, setTagFilter] = useState<string>('');
  const [cursor, setCursor] = useState<string | null>(null);

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SerializedContact | null>(null);
  const [duplicateWarning, setDuplicateWarning] = useState<ContactWarning | null>(null);
  const [createdContactId, setCreatedContactId] = useState<string | null>(null);

  // Form state for new contact
  const [name, setName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [title, setTitle] = useState('');
  const [accountId, setAccountId] = useState('');
  const [lifecycleStage, setLifecycleStage] = useState<LifecycleStage>('lead');
  const [tagsInput, setTagsInput] = useState('');
  const [customFields, setCustomFields] = useState<Record<string, unknown>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const canManage = hasScope(user, 'contacts:manage');

  // Load custom field definitions for contact
  const customFieldDefs = useQuery({
    queryKey: ['custom-fields', 'contact'],
    queryFn: () => api<CustomFieldDef[]>('/custom-fields?entityType=contact'),
  });

  // Load accounts for association dropdown
  const accountsQuery = useQuery({
    queryKey: ['accounts-select'],
    queryFn: () => api<{ accounts: SerializedAccount[] }>('/accounts?limit=100'),
  });

  // Load contacts list
  const contactsQuery = useQuery({
    queryKey: ['contacts-list', debouncedSearch, stageFilter, tagFilter, cursor],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '25' });
      if (debouncedSearch.trim()) params.set('q', debouncedSearch.trim());
      if (stageFilter !== 'all') params.set('lifecycleStage', stageFilter);
      if (tagFilter.trim()) params.set('tag', tagFilter.trim());
      if (cursor) params.set('cursor', cursor);
      return api<ContactListResponse>(`/contacts?${params.toString()}`);
    },
  });

  // Create contact mutation
  const createMutation = useMutation({
    mutationFn: async () => {
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      return api<{ contact: SerializedContact; warnings: ContactWarning[] }>('/contacts', {
        method: 'POST',
        body: {
          name,
          firstName: firstName || undefined,
          lastName: lastName || undefined,
          email,
          phone: phone || undefined,
          title: title || undefined,
          accountId: accountId || undefined,
          lifecycleStage,
          tags,
          customFields,
        },
      });
    },
    onSuccess: (res) => {
      notify('success', 'Contact created successfully');
      setCreateModalOpen(false);
      resetForm();
      void queryClient.invalidateQueries({ queryKey: ['contacts-list'] });

      // If warnings exist (e.g. DUPLICATE_EMAIL), display modal
      if (res.warnings && res.warnings.length > 0) {
        setDuplicateWarning(res.warnings[0]!);
        setCreatedContactId(res.contact.id);
      }
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : 'Failed to create contact');
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return api(`/contacts/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      notify('success', 'Contact deleted');
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['contacts-list'] });
    },
    onError: (err) => {
      notify('error', err instanceof Error ? err.message : 'Failed to delete contact');
    },
  });

  function resetForm(): void {
    setName('');
    setFirstName('');
    setLastName('');
    setEmail('');
    setPhone('');
    setTitle('');
    setAccountId('');
    setLifecycleStage('lead');
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
    const params = new URLSearchParams();
    if (stageFilter !== 'all') params.set('lifecycleStage', stageFilter);
    window.open(`${API_URL}/v1/contacts-export?${params.toString()}`, '_blank');
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Contacts</h1>
          <p className="mt-0.5 text-xs text-text-secondary">
            Manage people, leads, and customer relationships.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={handleExport} className="text-xs">
            Export CSV
          </Button>
          <Link to="/imports" search={{ entityType: 'contact' }}>
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
              + New Contact
            </Button>
          )}
        </div>
      </div>

      {/* Filters bar */}
      <Card title="Filter Contacts">
        <form onSubmit={handleSearchSubmit} className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <label htmlFor="search-contacts" className="mb-1 block text-xs font-medium text-text-secondary">
              Search by name or email
            </label>
            <Input
              id="search-contacts"
              placeholder="e.g. Sarah Connor or sarah@domain.com"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="stage-filter" className="mb-1 block text-xs font-medium text-text-secondary">
              Lifecycle Stage
            </label>
            <select
              id="stage-filter"
              value={stageFilter}
              onChange={(e) => {
                setStageFilter(e.target.value);
                setCursor(null);
              }}
              className="h-9 rounded border border-border bg-surface px-3 text-sm text-text-primary"
            >
              {LIFECYCLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="tag-filter" className="mb-1 block text-xs font-medium text-text-secondary">
              Tag
            </label>
            <Input
              id="tag-filter"
              placeholder="Filter by tag"
              value={tagFilter}
              onChange={(e) => {
                setTagFilter(e.target.value);
                setCursor(null);
              }}
              className="w-36"
            />
          </div>
          <Button type="submit" variant="secondary" className="h-9">
            Apply
          </Button>
          {(debouncedSearch || stageFilter !== 'all' || tagFilter) && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setSearch('');
                setDebouncedSearch('');
                setStageFilter('all');
                setTagFilter('');
                setCursor(null);
              }}
              className="h-9 text-xs text-text-secondary"
            >
              Clear filters
            </Button>
          )}
        </form>
      </Card>

      {/* Contacts Table */}
      {contactsQuery.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : contactsQuery.isError ? (
        <div className="rounded bg-danger-soft p-4 text-sm text-danger">
          Could not load contacts: {contactsQuery.error?.message}
        </div>
      ) : !contactsQuery.data || contactsQuery.data.contacts.length === 0 ? (
        <EmptyState
          title="No contacts found"
          description="Get started by creating your first contact or importing a CSV file."
          action={
            canManage ? (
              <Button variant="primary" onClick={() => setCreateModalOpen(true)}>
                Create First Contact
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
                  <th className="px-4 py-3 font-medium">Name & Email</th>
                  <th className="px-4 py-3 font-medium">Title & Company</th>
                  <th className="px-4 py-3 font-medium">Stage</th>
                  <th className="px-4 py-3 font-medium">Owner</th>
                  <th className="px-4 py-3 font-medium">Tags</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {contactsQuery.data.contacts.map((contact) => (
                  <tr key={contact.id} className="hover:bg-surface-raised/50 transition-colors">
                    <td className="px-4 py-3">
                      <Link
                        to="/contacts/$id"
                        params={{ id: contact.id }}
                        className="font-semibold text-accent hover:underline"
                      >
                        {contact.name}
                      </Link>
                      <p className="text-[11px] text-text-secondary">{contact.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-text-primary">{contact.title || '—'}</p>
                      {contact.account ? (
                        <Link
                          to="/accounts/$id"
                          params={{ id: contact.account.id }}
                          className="text-[11px] text-accent hover:underline"
                        >
                          {contact.account.name}
                        </Link>
                      ) : (
                        <span className="text-[11px] text-text-secondary">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        tone={
                          contact.lifecycleStage === 'customer'
                            ? 'success'
                            : contact.lifecycleStage === 'opportunity'
                              ? 'info'
                              : contact.lifecycleStage === 'lead'
                                ? 'warning'
                                : 'neutral'
                        }
                      >
                        {contact.lifecycleStage}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {contact.owner?.name ?? 'Unassigned'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1 max-w-[150px]">
                        {contact.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-text-secondary"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <Link to="/contacts/$id" params={{ id: contact.id }}>
                          <Button variant="ghost" className="h-7 px-2 text-xs">
                            View
                          </Button>
                        </Link>
                        {canManage && (
                          <Button
                            variant="ghost"
                            onClick={() => setDeleteTarget(contact)}
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
            <span>Showing {contactsQuery.data.contacts.length} records</span>
            {contactsQuery.data.nextCursor && (
              <Button
                variant="secondary"
                onClick={() => setCursor(contactsQuery.data?.nextCursor ?? null)}
                className="text-xs"
              >
                Load Next Page →
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Create Contact Modal */}
      <Modal
        open={createModalOpen}
        onOpenChange={setCreateModalOpen}
        size="2xl"
        title="Create Contact"
        description="Add a new contact record. Required fields: Name and Email."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setFormError(null);
            if (!name.trim()) {
              setFormError('Name is required');
              return;
            }
            if (!email.trim()) {
              setFormError('Email is required');
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
            <Field label="Full Name *" htmlFor="c-name">
              <Input
                id="c-name"
                required
                placeholder="Jane Doe"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>

            <Field label="Email Address *" htmlFor="c-email">
              <Input
                id="c-email"
                type="email"
                required
                placeholder="jane@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>

            <Field label="First Name" htmlFor="c-first-name">
              <Input
                id="c-first-name"
                placeholder="Jane"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </Field>

            <Field label="Last Name" htmlFor="c-last-name">
              <Input
                id="c-last-name"
                placeholder="Doe"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </Field>

            <Field label="Job Title" htmlFor="c-title">
              <Input
                id="c-title"
                placeholder="VP Engineering"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>

            <Field label="Phone" htmlFor="c-phone">
              <Input
                id="c-phone"
                placeholder="+1 555-0199"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </Field>

            <Field label="Company / Account" htmlFor="c-account">
              <select
                id="c-account"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                className="h-9 rounded border border-border bg-surface px-3 text-sm text-text-primary"
              >
                <option value="">-- None (No Account) --</option>
                {accountsQuery.data?.accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Lifecycle Stage" htmlFor="c-stage">
              <select
                id="c-stage"
                value={lifecycleStage}
                onChange={(e) => setLifecycleStage(e.target.value as LifecycleStage)}
                className="h-9 rounded border border-border bg-surface px-3 text-sm text-text-primary"
              >
                {LIFECYCLE_OPTIONS.filter((o) => o.value !== 'all').map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </Field>

            <div className="sm:col-span-2">
              <Field label="Tags (comma-separated)" htmlFor="c-tags" hint="e.g. VIP, decision-maker, 2026-summit">
                <Input
                  id="c-tags"
                  placeholder="VIP, decision-maker"
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                />
              </Field>
            </div>
          </div>

          {/* Dynamic Custom Fields Section */}
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
              {createMutation.isPending ? 'Creating...' : 'Create Contact'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Duplicate Warning Modal (Per Acceptance Criteria: Duplicate warning before save / on match, non-blocking) */}
      <Modal
        open={Boolean(duplicateWarning)}
        onOpenChange={(open) => {
          if (!open) setDuplicateWarning(null);
        }}
        size="md"
        title="Duplicate Contact Detected"
        description="A potential duplicate contact was detected during creation."
      >
        <div className="flex flex-col gap-3">
          <div className="rounded border border-warning/40 bg-warning-soft p-3 text-xs text-warning">
            <p className="font-semibold">{duplicateWarning?.message}</p>
            <p className="mt-1">
              Confidence level:{' '}
              <Badge tone="warning">{duplicateWarning?.confidence ?? 'High'}</Badge>
            </p>
          </div>

          <p className="text-xs text-text-secondary">
            The contact record was created successfully. You can review existing records in the
            Deduplication Queue or merge them directly.
          </p>

          <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setDuplicateWarning(null)}
              className="text-xs"
            >
              Dismiss
            </Button>
            <Link to="/duplicates">
              <Button variant="primary" className="text-xs">
                Go to Dedup Queue
              </Button>
            </Link>
            {createdContactId && (
              <Link to="/contacts/$id" params={{ id: createdContactId }}>
                <Button variant="secondary" className="text-xs">
                  View Created Contact
                </Button>
              </Link>
            )}
          </div>
        </div>
      </Modal>

      {/* Delete Confirmation Modal */}
      <Modal
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        size="sm"
        title="Delete Contact"
        description={`Are you sure you want to delete ${deleteTarget?.name}?`}
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs text-text-secondary">
            This contact will be soft-deleted. Notes and activity records will be retained in audit logs.
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
