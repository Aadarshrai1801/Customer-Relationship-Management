import { useState, useTransition } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasScope } from '../../lib/api';
import { useAuth } from '../../lib/providers';
import type {
  CustomFieldDef,
  LeadSource,
  LeadStatus,
  SerializedLead,
} from '../../lib/crm-types';
import { Badge, Button, Card, EmptyState, Field, Input, Skeleton } from '../../components/ui';
import { Modal } from '../../components/modal';
import { CustomFieldsForm } from '../../components/custom-fields-renderer';
import { useToast } from '../../components/toast';
import { LeadConversionModal } from './lead-conversion-modal';

interface LeadsListResponse {
  items: SerializedLead[];
  nextCursor: string | null;
  total: number;
}

interface UserSummary {
  id: string;
  name: string;
  email: string;
}

const STATUS_TABS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'unqualified', label: 'Unqualified' },
  { value: 'converted', label: 'Converted' },
];

const SOURCES: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All Sources' },
  { value: 'website', label: 'Website' },
  { value: 'referral', label: 'Referral' },
  { value: 'event', label: 'Event' },
  { value: 'outbound', label: 'Outbound' },
  { value: 'campaign', label: 'Campaign' },
  { value: 'other', label: 'Other' },
];

export function LeadsListPage(): React.JSX.Element {
  const { user } = useAuth();
  const { notify } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [, startTransition] = useTransition();

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [ownerFilter, setOwnerFilter] = useState<string>('all');
  const [cursor, setCursor] = useState<string | null>(null);

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [convertTarget, setConvertTarget] = useState<SerializedLead | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SerializedLead | null>(null);

  // Create lead form state
  const [name, setName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [company, setCompany] = useState('');
  const [title, setTitle] = useState('');
  const [source, setSource] = useState<LeadSource>('website');
  const [notes, setNotes] = useState('');
  const [customFields, setCustomFields] = useState<Record<string, unknown>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const canManage = hasScope(user, 'leads:manage');
  const canManageRouting = hasScope(user, 'lead_routing:manage');

  // Query custom field definitions for lead
  const customFieldDefs = useQuery({
    queryKey: ['custom-fields', 'lead'],
    queryFn: () => api<CustomFieldDef[]>('/custom-fields?entityType=lead'),
  });

  // Query users for owner filter
  const usersQuery = useQuery({
    queryKey: ['users-list'],
    queryFn: () => api<{ users: UserSummary[] }>('/users'),
  });

  // Query leads list
  const leadsQuery = useQuery({
    queryKey: ['leads-list', debouncedSearch, statusFilter, sourceFilter, ownerFilter, cursor],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '25' });
      if (debouncedSearch.trim()) params.set('q', debouncedSearch.trim());
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (sourceFilter !== 'all') params.set('source', sourceFilter);
      if (ownerFilter !== 'all') params.set('ownerId', ownerFilter);
      if (cursor) params.set('cursor', cursor);
      return api<LeadsListResponse>(`/leads?${params.toString()}`);
    },
  });

  // Create lead mutation
  const createMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: name.trim() || `${firstName.trim()} ${lastName.trim()}`.trim() || undefined,
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
        email: email.trim().toLowerCase(),
        phone: phone.trim() || undefined,
        company: company.trim() || undefined,
        title: title.trim() || undefined,
        source,
        notes: notes.trim() || undefined,
        customFields,
      };
      return api<{ lead: SerializedLead; deduplicated: boolean }>('/leads', {
        method: 'POST',
        body: payload,
      });
    },
    onSuccess: (data) => {
      if (data.deduplicated) {
        notify('success', 'Lead already submitted within 5 minutes (deduplicated).');
      } else {
        notify('success', `Lead "${data.lead.name}" created successfully.`);
      }
      void queryClient.invalidateQueries({ queryKey: ['leads-list'] });
      setCreateModalOpen(false);
      resetForm();
      void navigate({ to: `/leads/${data.lead.id}` });
    },
    onError: (err: Error) => {
      setFormError(err.message || 'Failed to create lead');
    },
  });

  // Delete lead mutation
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api(`/leads/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      notify('success', 'Lead deleted');
      void queryClient.invalidateQueries({ queryKey: ['leads-list'] });
      setDeleteTarget(null);
    },
    onError: (err: Error) => {
      notify('error', err.message || 'Failed to delete lead');
    },
  });

  const resetForm = () => {
    setName('');
    setFirstName('');
    setLastName('');
    setEmail('');
    setPhone('');
    setCompany('');
    setTitle('');
    setSource('website');
    setNotes('');
    setCustomFields({});
    setFormError(null);
  };

  const handleSearchChange = (val: string) => {
    setSearch(val);
    startTransition(() => {
      setDebouncedSearch(val);
      setCursor(null);
    });
  };

  const statusTone = (status: LeadStatus): 'neutral' | 'success' | 'warning' | 'danger' | 'info' => {
    switch (status) {
      case 'new':
        return 'info';
      case 'contacted':
        return 'warning';
      case 'qualified':
        return 'success';
      case 'converted':
        return 'neutral';
      case 'unqualified':
        return 'danger';
    }
  };

  const leads = leadsQuery.data?.items ?? [];
  const total = leadsQuery.data?.total ?? 0;
  const usersList = usersQuery.data?.users ?? [];

  return (
    <div className="flex flex-col gap-6">
      {/* Page Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">Leads</h1>
            <span className="rounded-full bg-surface-raised px-2.5 py-0.5 text-xs font-semibold text-text-secondary border border-border">
              {total}
            </span>
          </div>
          <p className="mt-1 text-xs text-text-secondary">
            Capture, route, qualify, and convert inbound sales prospects.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canManageRouting && (
            <Link to="/settings/lead-routing">
              <Button variant="secondary" className="text-xs h-9">
                <span className="mr-1">⚙️</span> Routing Rules
              </Button>
            </Link>
          )}
          {canManage && (
            <Link to="/settings/web-to-lead">
              <Button variant="secondary" className="text-xs h-9">
                <span className="mr-1">🌐</span> Web-to-Lead
              </Button>
            </Link>
          )}
          {canManage && (
            <Button
              variant="primary"
              onClick={() => {
                resetForm();
                setCreateModalOpen(true);
              }}
              className="text-xs h-9"
            >
              + New Lead
            </Button>
          )}
        </div>
      </div>

      {/* Status Filter Tabs */}
      <div className="flex gap-1 overflow-x-auto border-b border-border pb-px">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => {
              setStatusFilter(tab.value);
              setCursor(null);
            }}
            className={`px-4 py-2 text-xs font-medium border-b-2 whitespace-nowrap transition-colors ${
              statusFilter === tab.value
                ? 'border-accent text-accent font-semibold'
                : 'border-transparent text-text-secondary hover:border-border-strong hover:text-text-primary'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Filter Toolbar */}
      <Card title="" description="">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex-1 max-w-sm">
            <Input
              type="search"
              placeholder="Search name, email, company..."
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="h-9 text-xs"
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* Source Filter */}
            <select
              value={sourceFilter}
              onChange={(e) => {
                setSourceFilter(e.target.value);
                setCursor(null);
              }}
              aria-label="Filter by source"
              className="h-9 rounded border border-border bg-surface px-2.5 text-xs text-text-primary hover:border-border-strong"
            >
              {SOURCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>

            {/* Owner Filter */}
            <select
              value={ownerFilter}
              onChange={(e) => {
                setOwnerFilter(e.target.value);
                setCursor(null);
              }}
              aria-label="Filter by owner"
              className="h-9 rounded border border-border bg-surface px-2.5 text-xs text-text-primary hover:border-border-strong"
            >
              <option value="all">All Owners</option>
              {usersList.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Card>

      {/* Leads Table */}
      {leadsQuery.isLoading ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : leads.length === 0 ? (
        <EmptyState
          title="No leads found"
          description={
            debouncedSearch || statusFilter !== 'all' || sourceFilter !== 'all'
              ? 'Try adjusting your search query or filters.'
              : 'Add your first lead manually or configure Web-to-Lead ingestion.'
          }
          action={
            canManage ? (
              <Button
                variant="primary"
                onClick={() => {
                  resetForm();
                  setCreateModalOpen(true);
                }}
              >
                Create Lead
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-subtle">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-border bg-surface-raised/50 text-text-secondary font-medium">
                  <th className="py-3 px-4">Name</th>
                  <th className="py-3 px-4">Company</th>
                  <th className="py-3 px-4">Email / Phone</th>
                  <th className="py-3 px-4">Status</th>
                  <th className="py-3 px-4">Source</th>
                  <th className="py-3 px-4">Assigned Rep</th>
                  <th className="py-3 px-4">Created</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {leads.map((lead) => (
                  <tr
                    key={lead.id}
                    className="hover:bg-surface-raised/40 transition-colors group"
                  >
                    <td className="py-3 px-4">
                      <Link
                        to="/leads/$id"
                        params={{ id: lead.id }}
                        className="font-medium text-accent hover:underline flex items-center gap-1.5"
                      >
                        {lead.name}
                        {lead.status === 'converted' && (
                          <span className="text-[10px] text-success font-semibold">✓ Converted</span>
                        )}
                      </Link>
                      {lead.title && (
                        <p className="text-[11px] text-text-secondary">{lead.title}</p>
                      )}
                    </td>
                    <td className="py-3 px-4 text-text-primary font-medium">
                      {lead.company || <span className="text-text-secondary/50">—</span>}
                    </td>
                    <td className="py-3 px-4">
                      <div className="text-text-primary font-mono text-[11px]">{lead.email}</div>
                      {lead.phone && (
                        <div className="text-text-secondary text-[11px]">{lead.phone}</div>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <Badge tone={statusTone(lead.status)}>
                        {lead.status.toUpperCase()}
                      </Badge>
                    </td>
                    <td className="py-3 px-4">
                      <span className="rounded bg-surface-sunken px-2 py-0.5 text-[11px] font-medium text-text-secondary capitalize">
                        {lead.source}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      {lead.owner ? (
                        <span className="text-text-primary font-medium">{lead.owner.name}</span>
                      ) : (
                        <span className="text-text-secondary italic">Unassigned</span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-text-secondary text-[11px]">
                      {new Date(lead.createdAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {lead.status !== 'converted' && canManage && (
                          <Button
                            variant="secondary"
                            onClick={() => setConvertTarget(lead)}
                            className="text-[11px] h-7 px-2"
                            title="Convert lead to Contact and Account"
                          >
                            Convert
                          </Button>
                        )}
                        {canManage && (
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(lead)}
                            className="text-text-secondary hover:text-danger p-1 rounded transition-colors"
                            title="Delete lead"
                          >
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* New Lead Modal */}
      <Modal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="Create New Lead"
        description="Enter the prospect's details. The lead will be routed automatically if rules are active."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setFormError(null);
            createMutation.mutate();
          }}
          className="flex flex-col gap-4 pt-2 max-h-[75vh] overflow-y-auto px-1"
        >
          {formError && (
            <div role="alert" className="rounded bg-danger-soft p-3 text-xs text-danger">
              {formError}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="First Name" htmlFor="leadFirstName">
              <Input
                id="leadFirstName"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="John"
              />
            </Field>
            <Field label="Last Name" htmlFor="leadLastName">
              <Input
                id="leadLastName"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                placeholder="Doe"
              />
            </Field>
          </div>

          <Field label="Full / Display Name" htmlFor="leadName" hint="Leave blank to combine first and last name">
            <Input
              id="leadName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="John Doe"
            />
          </Field>

          <Field label="Email Address *" htmlFor="leadEmail">
            <Input
              id="leadEmail"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="john@example.com"
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Phone" htmlFor="leadPhone">
              <Input
                id="leadPhone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 (555) 000-0000"
              />
            </Field>
            <Field label="Company" htmlFor="leadCompany">
              <Input
                id="leadCompany"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="Acme Corp"
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Title / Job Role" htmlFor="leadTitle">
              <Input
                id="leadTitle"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="VP of Growth"
              />
            </Field>
            <Field label="Source" htmlFor="leadSource">
              <select
                id="leadSource"
                value={source}
                onChange={(e) => setSource(e.target.value as LeadSource)}
                className="h-9 w-full rounded border border-border bg-surface px-3 text-xs text-text-primary focus:border-accent"
              >
                <option value="website">Website</option>
                <option value="referral">Referral</option>
                <option value="event">Event</option>
                <option value="outbound">Outbound</option>
                <option value="campaign">Campaign</option>
                <option value="other">Other</option>
              </select>
            </Field>
          </div>

          <Field label="Notes" htmlFor="leadNotes">
            <textarea
              id="leadNotes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Initial context, prospect requirements, discovery notes..."
              className="w-full rounded border border-border bg-surface p-2.5 text-xs text-text-primary hover:border-border-strong focus:border-accent focus:outline-none"
            />
          </Field>

          {/* Custom Fields */}
          {customFieldDefs.data && customFieldDefs.data.length > 0 && (
            <div className="border-t border-border pt-3">
              <p className="mb-2 text-xs font-semibold text-text-primary">Custom Fields</p>
              <CustomFieldsForm
                defs={customFieldDefs.data}
                values={customFields}
                onChange={(key, val) => setCustomFields((prev) => ({ ...prev, [key]: val }))}
              />
            </div>
          )}

          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setCreateModalOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? 'Creating...' : 'Create Lead'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Lead Conversion Modal */}
      {convertTarget && (
        <LeadConversionModal
          lead={convertTarget}
          isOpen={!!convertTarget}
          onClose={() => setConvertTarget(null)}
        />
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <Modal
          open={!!deleteTarget}
          onClose={() => setDeleteTarget(null)}
          title="Delete Lead"
          description={`Are you sure you want to delete lead "${deleteTarget.name}"? This action cannot be undone.`}
        >
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete Lead'}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
