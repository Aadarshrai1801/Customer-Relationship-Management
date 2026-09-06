import { useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasScope } from '../../lib/api';
import { useAuth } from '../../lib/providers';
import type {
  CustomFieldDef,
  SerializedAccount,
  SerializedContact,
} from '../../lib/crm-types';
import { Badge, Button, Card, EmptyState, Field, Input, Skeleton } from '../../components/ui';
import { Breadcrumbs } from '../../components/breadcrumbs';
import { InlineEdit } from '../../components/inline-edit';
import { CustomFieldsRenderer } from '../../components/custom-fields-renderer';
import { MergePickerModal } from '../../components/merge-picker-modal';
import { Modal } from '../../components/modal';
import { useToast } from '../../components/toast';

export function AccountDetailPage(): React.JSX.Element {
  const { id } = useParams({ strict: false }) as { id: string };
  const { user } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [mergePickerOpen, setMergePickerOpen] = useState(false);
  const [mergeTargetAccountId, setMergeTargetAccountId] = useState('');
  const [candidateSelectOpen, setCandidateSelectOpen] = useState(false);

  // Quick contact create modal state
  const [createContactOpen, setCreateContactOpen] = useState(false);
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactTitle, setContactTitle] = useState('');

  const canManage = hasScope(user, 'accounts:manage');
  const canManageContacts = hasScope(user, 'contacts:manage');
  const userFieldRules = (user?.role.permissions?.fields as Record<string, 'edit' | 'read' | 'none'>) ?? {};

  // Fetch account record
  const accountQuery = useQuery({
    queryKey: ['account', id],
    queryFn: () => api<SerializedAccount>(`/accounts/${id}`),
    enabled: Boolean(id),
  });

  // Fetch all accounts for parent picker
  const allAccountsQuery = useQuery({
    queryKey: ['accounts-select'],
    queryFn: () => api<{ accounts: SerializedAccount[] }>('/accounts?limit=100'),
  });

  // Fetch custom field definitions for account
  const customFieldDefs = useQuery({
    queryKey: ['custom-fields', 'account'],
    queryFn: () => api<CustomFieldDef[]>('/custom-fields?entityType=account'),
  });

  // Fetch associated contacts
  const contactsQuery = useQuery({
    queryKey: ['account-contacts', id],
    queryFn: () => api<{ contacts: SerializedContact[] }>(`/contacts?accountId=${id}&limit=50`),
    enabled: Boolean(id),
  });

  // Accounts for merge target selection
  const accountsForMergeQuery = useQuery({
    queryKey: ['accounts-for-merge', id],
    queryFn: () => api<{ accounts: SerializedAccount[] }>('/accounts?limit=50'),
    enabled: candidateSelectOpen,
  });

  // Update account field mutation
  const updateFieldMutation = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      return api<SerializedAccount>(`/accounts/${id}`, {
        method: 'PATCH',
        body: patch,
      });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['account', id], updated);
      notify('success', 'Account updated');
      void queryClient.invalidateQueries({ queryKey: ['accounts-list'] });
    },
    onError: (err) => {
      notify('error', err instanceof Error ? err.message : 'Update failed');
      throw err;
    },
  });

  // Quick contact create mutation
  const createContactMutation = useMutation({
    mutationFn: async () => {
      return api<{ contact: SerializedContact }>('/contacts', {
        method: 'POST',
        body: {
          name: contactName,
          email: contactEmail,
          title: contactTitle || undefined,
          accountId: id,
          lifecycleStage: 'lead',
        },
      });
    },
    onSuccess: () => {
      notify('success', 'Contact created and associated');
      setCreateContactOpen(false);
      setContactName('');
      setContactEmail('');
      setContactTitle('');
      void queryClient.invalidateQueries({ queryKey: ['account-contacts', id] });
      void queryClient.invalidateQueries({ queryKey: ['account', id] });
    },
    onError: (err) => {
      notify('error', err instanceof Error ? err.message : 'Failed to create contact');
    },
  });

  // Delete account mutation
  const deleteAccountMutation = useMutation({
    mutationFn: async () => {
      return api(`/accounts/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      notify('success', 'Account deleted');
      void navigate({ to: '/accounts' });
    },
    onError: (err) => {
      notify('error', err instanceof Error ? err.message : 'Failed to delete account');
    },
  });

  if (accountQuery.isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-32 w-full" />
        <div className="grid gap-6 md:grid-cols-2">
          <Skeleton className="h-80 w-full" />
          <Skeleton className="h-80 w-full" />
        </div>
      </div>
    );
  }

  if (accountQuery.isError || !accountQuery.data) {
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumbs items={[{ label: 'Accounts', to: '/accounts' }, { label: 'Not Found' }]} />
        <EmptyState
          title="Account not found"
          description="The account may have been deleted or you lack permission to view it."
          action={
            <Link to="/accounts">
              <Button variant="primary">Return to Accounts</Button>
            </Link>
          }
        />
      </div>
    );
  }

  const account = accountQuery.data;
  const parentOptions = (allAccountsQuery.data?.accounts ?? [])
    .filter((a) => a.id !== account.id)
    .map((a) => ({ value: a.id, label: a.name }));

  async function handleSaveField(fieldName: string, value: unknown): Promise<void> {
    await updateFieldMutation.mutateAsync({ [fieldName]: value });
  }

  async function handleSaveCustomField(key: string, val: unknown): Promise<void> {
    const nextCustom = { ...account.customFields, [key]: val };
    await updateFieldMutation.mutateAsync({ customFields: nextCustom });
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Breadcrumbs */}
      <Breadcrumbs
        items={[
          { label: 'Accounts', to: '/accounts' },
          { label: account.name },
        ]}
      />

      {/* Header Banner */}
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-border bg-surface p-6 shadow-subtle">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">{account.name}</h1>
            {account.industry && <Badge tone="info">{account.industry}</Badge>}
          </div>
          <p className="text-sm text-text-secondary">
            {account.website ? (
              <a
                href={account.website.startsWith('http') ? account.website : `https://${account.website}`}
                target="_blank"
                rel="noreferrer"
                className="text-accent hover:underline"
              >
                {account.website}
              </a>
            ) : (
              'No website'
            )}
            {' · '}
            Owner: {account.owner?.name ?? 'Unassigned'}
          </p>
        </div>

        {/* Header Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {canManage && (
            <>
              <Button
                variant="secondary"
                onClick={() => setCandidateSelectOpen(true)}
                className="text-xs"
              >
                Merge...
              </Button>
              <Button
                variant="ghost"
                onClick={() => setDeleteModalOpen(true)}
                className="text-xs text-danger hover:bg-danger-soft"
              >
                Delete
              </Button>
            </>
          )}
        </div>
      </div>

      {/* 2-Column Grid */}
      <div className="grid gap-6 lg:grid-cols-12">
        {/* Left Column: Information, Hierarchy, and Custom Fields */}
        <div className="flex flex-col gap-6 lg:col-span-7">
          {/* Account Information Card */}
          <Card title="Company Information" description="Click any field to edit directly.">
            <div className="grid gap-3 sm:grid-cols-2">
              <InlineEdit
                label="Company Name"
                value={account.name}
                readOnly={!canManage || userFieldRules['name'] === 'read'}
                onSave={(val) => handleSaveField('name', val)}
              />

              <InlineEdit
                label="Industry"
                value={account.industry}
                readOnly={!canManage || userFieldRules['industry'] === 'read'}
                onSave={(val) => handleSaveField('industry', val || null)}
              />

              <InlineEdit
                label="Website"
                value={account.website}
                readOnly={!canManage || userFieldRules['website'] === 'read'}
                onSave={(val) => handleSaveField('website', val || null)}
              />

              <InlineEdit
                label="Phone"
                value={account.phone}
                readOnly={!canManage || userFieldRules['phone'] === 'read'}
                onSave={(val) => handleSaveField('phone', val || null)}
              />

              <InlineEdit
                label="Parent Company (Hierarchy)"
                type="select"
                options={parentOptions}
                value={account.parentId}
                readOnly={!canManage || userFieldRules['parentId'] === 'read'}
                renderDisplay={() =>
                  account.parent ? (
                    <Link
                      to="/accounts/$id"
                      params={{ id: account.parent.id }}
                      className="text-accent hover:underline"
                    >
                      {account.parent.name}
                    </Link>
                  ) : null
                }
                onSave={(val) => handleSaveField('parentId', val || null)}
              />

              <InlineEdit
                label="Domains"
                placeholder="None (e.g. acme.com)"
                value={account.domains.join(', ')}
                readOnly={!canManage || userFieldRules['domains'] === 'read'}
                onSave={async (val) => {
                  const domains = val
                    .split(',')
                    .map((d) => d.trim().toLowerCase())
                    .filter(Boolean);
                  await handleSaveField('domains', domains);
                }}
              />

              <div className="sm:col-span-2">
                <InlineEdit
                  label="Tags"
                  placeholder="No tags"
                  value={account.tags.join(', ')}
                  readOnly={!canManage || userFieldRules['tags'] === 'read'}
                  renderDisplay={() =>
                    account.tags.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {account.tags.map((t) => (
                          <Badge key={t} tone="neutral">
                            {t}
                          </Badge>
                        ))}
                      </div>
                    ) : null
                  }
                  onSave={async (val) => {
                    const tags = val
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean);
                    await handleSaveField('tags', tags);
                  }}
                />
              </div>
            </div>
          </Card>

          {/* Hierarchy Card */}
          <Card
            title="Corporate Hierarchy"
            description="Parent organization and subsidiary relationships."
          >
            <div className="flex flex-col gap-3 text-xs">
              <div>
                <span className="font-semibold text-text-secondary">Parent Company:</span>{' '}
                {account.parent ? (
                  <Link
                    to="/accounts/$id"
                    params={{ id: account.parent.id }}
                    className="font-medium text-accent hover:underline"
                  >
                    {account.parent.name}
                  </Link>
                ) : (
                  <span className="text-text-secondary italic">None (Top-Level Account)</span>
                )}
              </div>

              <div>
                <span className="font-semibold text-text-secondary">
                  Subsidiaries / Child Accounts ({account.children.length}):
                </span>
                {account.children.length === 0 ? (
                  <p className="mt-1 text-text-secondary italic">No subsidiaries linked.</p>
                ) : (
                  <ul className="mt-1 flex flex-wrap gap-2">
                    {account.children.map((child) => (
                      <li key={child.id}>
                        <Link
                          to="/accounts/$id"
                          params={{ id: child.id }}
                          className="inline-flex items-center gap-1 rounded border border-border bg-surface-raised px-2.5 py-1 font-medium text-accent hover:bg-accent-soft/30"
                        >
                          🏢 {child.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Card>

          {/* Custom & Computed Fields Card */}
          <Card
            title="Custom & Computed Fields"
            description="Account properties including dynamic formulas."
          >
            <CustomFieldsRenderer
              defs={customFieldDefs.data ?? []}
              values={account.customFields ?? {}}
              computedValues={account.computedFields ?? {}}
              fieldPermissions={userFieldRules}
              canManage={canManage}
              onSaveField={handleSaveCustomField}
            />
          </Card>
        </div>

        {/* Right Column: Associated Contacts */}
        <div className="flex flex-col gap-4 lg:col-span-5">
          <Card
            title={`Contacts (${contactsQuery.data?.contacts.length ?? 0})`}
            description="People associated with this company."
            actions={
              canManageContacts && (
                <Button
                  variant="secondary"
                  onClick={() => setCreateContactOpen(true)}
                  className="h-7 text-xs"
                >
                  + Add Contact
                </Button>
              )
            }
          >
            {contactsQuery.isLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : !contactsQuery.data || contactsQuery.data.contacts.length === 0 ? (
              <EmptyState
                title="No contacts at this company"
                description="Add the first contact associated with this account."
                action={
                  canManageContacts ? (
                    <Button
                      variant="primary"
                      onClick={() => setCreateContactOpen(true)}
                      className="text-xs"
                    >
                      Add Contact
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-border text-text-secondary">
                    <tr>
                      <th className="py-2 font-medium">Name</th>
                      <th className="py-2 font-medium">Title</th>
                      <th className="py-2 font-medium">Stage</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {contactsQuery.data.contacts.map((c) => (
                      <tr key={c.id} className="hover:bg-surface-raised/50">
                        <td className="py-2">
                          <Link
                            to="/contacts/$id"
                            params={{ id: c.id }}
                            className="font-medium text-accent hover:underline"
                          >
                            {c.name}
                          </Link>
                          <p className="text-[11px] text-text-secondary">{c.email}</p>
                        </td>
                        <td className="py-2 text-text-secondary">{c.title || '—'}</td>
                        <td className="py-2">
                          <Badge tone="neutral">{c.lifecycleStage}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* Quick Add Contact Modal */}
      <Modal
        open={createContactOpen}
        onOpenChange={setCreateContactOpen}
        size="md"
        title="Add Contact to Account"
        description={`Create a new contact associated with ${account.name}.`}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (contactName.trim() && contactEmail.trim()) {
              createContactMutation.mutate();
            }
          }}
          className="flex flex-col gap-3"
        >
          <Field label="Full Name *" htmlFor="qc-name">
            <Input
              id="qc-name"
              required
              placeholder="John Smith"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
            />
          </Field>

          <Field label="Email Address *" htmlFor="qc-email">
            <Input
              id="qc-email"
              type="email"
              required
              placeholder="john@company.com"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
            />
          </Field>

          <Field label="Job Title" htmlFor="qc-title">
            <Input
              id="qc-title"
              placeholder="Director of Sales"
              value={contactTitle}
              onChange={(e) => setContactTitle(e.target.value)}
            />
          </Field>

          <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setCreateContactOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={createContactMutation.isPending}
            >
              {createContactMutation.isPending ? 'Adding...' : 'Add Contact'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Select Merge Candidate Modal */}
      <Modal
        open={candidateSelectOpen}
        onOpenChange={setCandidateSelectOpen}
        size="md"
        title="Select Account to Merge"
        description="Choose another company account to merge with this record."
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs text-text-secondary">
            Select the account you would like to compare and merge into{' '}
            <strong className="text-text-primary">{account.name}</strong>.
          </p>

          <select
            value={mergeTargetAccountId}
            onChange={(e) => setMergeTargetAccountId(e.target.value)}
            className="h-9 rounded border border-border bg-surface px-3 text-xs text-text-primary"
          >
            <option value="">-- Choose account --</option>
            {accountsForMergeQuery.data?.accounts
              .filter((a) => a.id !== account.id)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.website || 'No website'})
                </option>
              ))}
          </select>

          <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setCandidateSelectOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={!mergeTargetAccountId}
              onClick={() => {
                setCandidateSelectOpen(false);
                setMergePickerOpen(true);
              }}
            >
              Open Merge Picker →
            </Button>
          </div>
        </div>
      </Modal>

      {/* Per-Field Merge Picker Modal */}
      {mergePickerOpen && mergeTargetAccountId && (
        <MergePickerModal
          open={mergePickerOpen}
          onOpenChange={setMergePickerOpen}
          entityType="account"
          primaryId={account.id}
          secondaryId={mergeTargetAccountId}
          primaryName={account.name}
          secondaryName={
            accountsForMergeQuery.data?.accounts.find((a) => a.id === mergeTargetAccountId)?.name
          }
          onSuccess={(winnerId) => {
            if (winnerId === account.id) {
              void queryClient.invalidateQueries({ queryKey: ['account', id] });
            } else {
              void navigate({ to: '/accounts/$id', params: { id: winnerId } });
            }
          }}
        />
      )}

      {/* Delete Account Confirmation */}
      <Modal
        open={deleteModalOpen}
        onOpenChange={setDeleteModalOpen}
        size="sm"
        title="Delete Account"
        description={`Are you sure you want to delete ${account.name}?`}
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs text-text-secondary">
            This account will be soft-deleted. Accounts with child accounts cannot be deleted until
            children are reassigned.
          </p>
          <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setDeleteModalOpen(false)}
              disabled={deleteAccountMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => deleteAccountMutation.mutate()}
              disabled={deleteAccountMutation.isPending}
            >
              {deleteAccountMutation.isPending ? 'Deleting...' : 'Confirm Delete'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
