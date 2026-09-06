import { useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasScope } from '../../lib/api';
import { useAuth } from '../../lib/providers';
import type {
  CustomFieldDef,
  LeadAssignmentLog,
  LeadSource,
  LeadStatus,
  SerializedLead,
} from '../../lib/crm-types';
import { Badge, Button, Card, Field, Input, Skeleton } from '../../components/ui';
import { Modal } from '../../components/modal';
import { InlineEdit } from '../../components/inline-edit';
import { CustomFieldsRenderer } from '../../components/custom-fields-renderer';
import { useToast } from '../../components/toast';
import { LeadConversionModal } from './lead-conversion-modal';

interface UserSummary {
  id: string;
  name: string;
  email: string;
}

const STAGES: Array<{ status: LeadStatus; label: string }> = [
  { status: 'new', label: 'New' },
  { status: 'contacted', label: 'Contacted' },
  { status: 'qualified', label: 'Qualified' },
  { status: 'converted', label: 'Converted' },
];

export function LeadDetailPage(): React.JSX.Element {
  const { id } = useParams({ strict: false }) as { id: string };
  const { user } = useAuth();
  const { notify } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [convertModalOpen, setConvertModalOpen] = useState(false);
  const [reassignModalOpen, setReassignModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [reassignUserId, setReassignUserId] = useState('');
  const [reassignReason, setReassignReason] = useState('');

  const canManage = hasScope(user, 'leads:manage');

  // Query lead detail
  const leadQuery = useQuery({
    queryKey: ['lead', id],
    queryFn: () => api<SerializedLead>(`/leads/${id}`),
  });

  // Query assignment history
  const historyQuery = useQuery({
    queryKey: ['lead-history', id],
    queryFn: () => api<LeadAssignmentLog[]>(`/leads/${id}/assignment-history`),
  });

  // Query custom field definitions for lead
  const customFieldDefs = useQuery({
    queryKey: ['custom-fields', 'lead'],
    queryFn: () => api<CustomFieldDef[]>('/custom-fields?entityType=lead'),
  });

  // Query users for reassignment
  const usersQuery = useQuery({
    queryKey: ['users-list'],
    queryFn: () => api<{ users: UserSummary[] }>('/users'),
  });

  // Update lead mutation (used for inline edits and status changes)
  const updateMutation = useMutation({
    mutationFn: (data: Partial<SerializedLead>) =>
      api<SerializedLead>(`/leads/${id}`, { method: 'PATCH', body: data }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['lead', id], updated);
      void queryClient.invalidateQueries({ queryKey: ['leads-list'] });
      notify('success', 'Lead updated');
    },
    onError: (err: Error) => {
      notify('error', err.message || 'Failed to update lead');
    },
  });

  // Reassign mutation
  const reassignMutation = useMutation({
    mutationFn: () =>
      api(`/leads/${id}/reassign`, {
        method: 'POST',
        body: { assignedToUserId: reassignUserId, reason: reassignReason || undefined },
      }),
    onSuccess: () => {
      notify('success', 'Lead reassigned');
      void queryClient.invalidateQueries({ queryKey: ['lead', id] });
      void queryClient.invalidateQueries({ queryKey: ['lead-history', id] });
      void queryClient.invalidateQueries({ queryKey: ['leads-list'] });
      setReassignModalOpen(false);
      setReassignReason('');
    },
    onError: (err: Error) => {
      notify('error', err.message || 'Failed to reassign lead');
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: () => api(`/leads/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      notify('success', 'Lead deleted');
      void queryClient.invalidateQueries({ queryKey: ['leads-list'] });
      void navigate({ to: '/leads' });
    },
    onError: (err: Error) => {
      notify('error', err.message || 'Failed to delete lead');
    },
  });

  if (leadQuery.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-28 w-full" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Skeleton className="h-72 md:col-span-2" />
          <Skeleton className="h-72" />
        </div>
      </div>
    );
  }

  if (leadQuery.isError || !leadQuery.data) {
    return (
      <div className="rounded-lg border border-danger-soft bg-danger-soft/20 p-8 text-center">
        <p className="text-base font-semibold text-danger">Lead not found or inaccessible</p>
        <Link to="/leads" className="mt-4 inline-block text-xs text-accent hover:underline">
          ← Back to Leads
        </Link>
      </div>
    );
  }

  const lead = leadQuery.data;
  const history = historyQuery.data ?? [];
  const users = usersQuery.data?.users ?? [];

  const handleFieldSave = async (key: string, value: unknown) => {
    await updateMutation.mutateAsync({ [key]: value });
  };

  const handleCustomFieldSave = async (fieldKey: string, value: unknown) => {
    const nextCustom = { ...lead.customFields, [fieldKey]: value };
    await updateMutation.mutateAsync({ customFields: nextCustom });
  };

  const handleStageClick = (status: LeadStatus) => {
    if (!canManage || lead.status === 'converted' || lead.status === status) return;
    updateMutation.mutate({ status });
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Breadcrumb & Navigation */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-text-secondary">
          <Link to="/leads" className="hover:text-text-primary transition-colors">
            Leads
          </Link>
          <span>/</span>
          <span className="font-semibold text-text-primary">{lead.name}</span>
        </div>
        <Link to="/leads" className="text-xs text-accent hover:underline">
          ← Back to all leads
        </Link>
      </div>

      {/* Converted Success Banner */}
      {lead.status === 'converted' && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-success-soft bg-success-soft/30 p-4">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-success text-white font-bold text-sm shrink-0">
              ✓
            </span>
            <div>
              <p className="text-sm font-semibold text-text-primary">
                This lead has been successfully converted
              </p>
              <p className="text-xs text-text-secondary">
                {lead.convertedAt
                  ? `Converted on ${new Date(lead.convertedAt).toLocaleDateString()}`
                  : 'Contact and Account created.'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {lead.convertedContactId && (
              <Link to="/contacts/$id" params={{ id: lead.convertedContactId }}>
                <Button variant="secondary" className="text-xs h-8">
                  View Contact →
                </Button>
              </Link>
            )}
            {lead.convertedAccountId && (
              <Link to="/accounts/$id" params={{ id: lead.convertedAccountId }}>
                <Button variant="secondary" className="text-xs h-8">
                  View Account →
                </Button>
              </Link>
            )}
          </div>
        </div>
      )}

      {/* Lead Header Card with Pipeline Stepper */}
      <div className="rounded-lg border border-border bg-surface p-6 shadow-subtle flex flex-col gap-5">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight text-text-primary">{lead.name}</h1>
              <Badge
                tone={
                  lead.status === 'new'
                    ? 'info'
                    : lead.status === 'contacted'
                    ? 'warning'
                    : lead.status === 'qualified'
                    ? 'success'
                    : lead.status === 'converted'
                    ? 'neutral'
                    : 'danger'
                }
              >
                {lead.status.toUpperCase()}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-text-secondary">
              {lead.title ? `${lead.title} at ` : ''}
              <span className="font-medium text-text-primary">{lead.company || 'Independent'}</span>
              {' · '}
              <span className="font-mono">{lead.email}</span>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {lead.status !== 'converted' && canManage && (
              <Button
                variant="primary"
                onClick={() => setConvertModalOpen(true)}
                className="text-xs h-9 font-medium"
              >
                <span className="mr-1.5">🚀</span> Convert Lead
              </Button>
            )}
            {canManage && (
              <Button
                variant="secondary"
                onClick={() => {
                  setReassignUserId(lead.ownerId || '');
                  setReassignModalOpen(true);
                }}
                className="text-xs h-9"
              >
                Reassign
              </Button>
            )}
            {canManage && (
              <Button
                variant="danger"
                onClick={() => setDeleteModalOpen(true)}
                className="text-xs h-9 px-3"
              >
                Delete
              </Button>
            )}
          </div>
        </div>

        {/* Pipeline Progression Stepper */}
        <div className="border-t border-border pt-4">
          <div className="flex items-center justify-between text-xs text-text-secondary mb-2">
            <span className="font-semibold uppercase tracking-wider text-[10px]">
              Lifecycle Progression
            </span>
            {lead.status !== 'unqualified' && lead.status !== 'converted' && canManage && (
              <button
                type="button"
                onClick={() => handleStageClick('unqualified')}
                className="text-[11px] text-danger hover:underline"
              >
                Mark Unqualified
              </button>
            )}
          </div>

          <div className="grid grid-cols-4 gap-1 rounded-lg bg-surface-sunken p-1">
            {STAGES.map((s, idx) => {
              const currentIdx = STAGES.findIndex((stage) => stage.status === lead.status);
              const isPastOrCurrent = currentIdx >= idx;
              const isCurrent = lead.status === s.status;

              return (
                <button
                  key={s.status}
                  type="button"
                  disabled={!canManage || lead.status === 'converted'}
                  onClick={() => handleStageClick(s.status)}
                  className={`flex flex-col items-center justify-center py-2 px-1 rounded transition-colors text-xs ${
                    isCurrent
                      ? 'bg-accent text-white font-semibold shadow-sm'
                      : isPastOrCurrent
                      ? 'bg-accent-soft text-accent font-medium'
                      : 'text-text-secondary hover:bg-surface-raised hover:text-text-primary'
                  } ${lead.status === 'converted' ? 'cursor-default' : 'cursor-pointer'}`}
                >
                  <span className="text-[10px] opacity-80">Stage {idx + 1}</span>
                  <span>{s.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main Details Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Columns: Core Info & Attribution */}
        <div className="lg:col-span-2 flex flex-col gap-6">
          {/* Core Information Card */}
          <Card title="Lead Information" description="Primary contact details and identity">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <InlineEdit
                label="Full Name"
                value={lead.name}
                readOnly={!canManage || lead.status === 'converted'}
                onSave={(val) => handleFieldSave('name', val)}
              />
              <InlineEdit
                label="Email Address"
                value={lead.email}
                readOnly={!canManage || lead.status === 'converted'}
                onSave={(val) => handleFieldSave('email', val)}
              />
              <InlineEdit
                label="Phone"
                value={lead.phone || ''}
                readOnly={!canManage || lead.status === 'converted'}
                onSave={(val) => handleFieldSave('phone', val || null)}
              />
              <InlineEdit
                label="Company"
                value={lead.company || ''}
                readOnly={!canManage || lead.status === 'converted'}
                onSave={(val) => handleFieldSave('company', val || null)}
              />
              <InlineEdit
                label="Job Title"
                value={lead.title || ''}
                readOnly={!canManage || lead.status === 'converted'}
                onSave={(val) => handleFieldSave('title', val || null)}
              />
              <div>
                <span className="text-xs font-medium text-text-secondary block mb-1">Source</span>
                <span className="rounded bg-surface-sunken px-2.5 py-1 text-xs font-semibold text-text-primary capitalize inline-block">
                  {lead.source}
                </span>
              </div>
            </div>

            <div className="mt-4 pt-4 border-t border-border">
              <InlineEdit
                label="Discovery Notes"
                value={lead.notes || ''}
                readOnly={!canManage || lead.status === 'converted'}
                onSave={(val) => handleFieldSave('notes', val || null)}
              />
            </div>
          </Card>

          {/* Custom Fields Card */}
          <Card
            title="Custom Attributes"
            description="Tenant-defined fields configured for lead entities"
          >
            <CustomFieldsRenderer
              defs={customFieldDefs.data ?? []}
              values={lead.customFields}
              computedValues={lead.computedFields}
              canManage={canManage && lead.status !== 'converted'}
              onSaveField={handleCustomFieldSave}
            />
          </Card>

          {/* Marketing Attribution Card */}
          <Card
            title="Marketing Attribution & Web Tracking"
            description="Captured UTM tags and referrer analytics from ingestion"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div className="flex flex-col gap-1 p-2.5 rounded border border-border/60 bg-surface-raised/40">
                <span className="text-text-secondary font-medium">UTM Source</span>
                <span className="font-mono text-text-primary">
                  {lead.utmSource || <span className="text-text-secondary/60 italic">direct</span>}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded border border-border/60 bg-surface-raised/40">
                <span className="text-text-secondary font-medium">UTM Medium</span>
                <span className="font-mono text-text-primary">
                  {lead.utmMedium || <span className="text-text-secondary/60 italic">none</span>}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded border border-border/60 bg-surface-raised/40">
                <span className="text-text-secondary font-medium">UTM Campaign</span>
                <span className="font-mono text-text-primary">
                  {lead.utmCampaign || <span className="text-text-secondary/60 italic">none</span>}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded border border-border/60 bg-surface-raised/40">
                <span className="text-text-secondary font-medium">UTM Term</span>
                <span className="font-mono text-text-primary">
                  {lead.utmTerm || <span className="text-text-secondary/60 italic">none</span>}
                </span>
              </div>
              <div className="flex flex-col gap-1 p-2.5 rounded border border-border/60 bg-surface-raised/40 sm:col-span-2">
                <span className="text-text-secondary font-medium">Referrer URL</span>
                <span className="font-mono text-text-primary break-all">
                  {lead.referrerUrl || <span className="text-text-secondary/60 italic">none</span>}
                </span>
              </div>
            </div>
          </Card>
        </div>

        {/* Right 1 Column: Assignment & History */}
        <div className="flex flex-col gap-6">
          {/* Owner / Rep Card */}
          <Card title="Assigned Representative" description="Responsible for qualifying this lead">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-white font-bold text-sm">
                  {lead.owner ? lead.owner.name.slice(0, 2).toUpperCase() : '?'}
                </div>
                <div>
                  <p className="text-sm font-semibold text-text-primary">
                    {lead.owner ? lead.owner.name : 'Unassigned'}
                  </p>
                  <p className="text-xs text-text-secondary">
                    {lead.owner ? 'Sales Representative' : 'Pending routing rule'}
                  </p>
                </div>
              </div>

              {canManage && lead.status !== 'converted' && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setReassignUserId(lead.ownerId || '');
                    setReassignModalOpen(true);
                  }}
                  className="text-xs h-8 px-2.5"
                >
                  Change
                </Button>
              )}
            </div>
          </Card>

          {/* Assignment History Timeline Card */}
          <Card title="Assignment History" description="Audit log of lead assignments and routing">
            {history.length === 0 ? (
              <p className="text-xs text-text-secondary italic">No reassignment history recorded.</p>
            ) : (
              <div className="relative border-l border-border pl-4 ml-2 flex flex-col gap-4">
                {history.map((item) => (
                  <div key={item.id} className="relative text-xs">
                    <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-surface bg-accent" />
                    <p className="font-medium text-text-primary">
                      Assigned to{' '}
                      <span className="font-semibold text-accent">
                        {item.assignedToUser?.name || 'Representative'}
                      </span>
                    </p>
                    {item.previousUser && (
                      <p className="text-[11px] text-text-secondary">
                        Previously: {item.previousUser.name}
                      </p>
                    )}
                    {item.reason && (
                      <p className="text-[11px] text-text-secondary mt-0.5 italic">
                        &quot;{item.reason}&quot;
                      </p>
                    )}
                    <p className="text-[10px] text-text-secondary/70 mt-1">
                      {new Date(item.createdAt).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      {/* Reassign Modal */}
      <Modal
        open={reassignModalOpen}
        onClose={() => setReassignModalOpen(false)}
        title="Reassign Lead"
        description="Select an active sales representative to take ownership of this lead."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            reassignMutation.mutate();
          }}
          className="flex flex-col gap-4 pt-2"
        >
          <Field label="Assign To *" htmlFor="reassignSelect">
            <select
              id="reassignSelect"
              required
              value={reassignUserId}
              onChange={(e) => setReassignUserId(e.target.value)}
              className="h-9 w-full rounded border border-border bg-surface px-3 text-xs text-text-primary focus:border-accent"
            >
              <option value="">-- Choose Representative --</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </select>
          </Field>

          <Field label="Reason for Reassignment" htmlFor="reassignReasonText" hint="Optional explanation logged in history">
            <Input
              id="reassignReasonText"
              value={reassignReason}
              onChange={(e) => setReassignReason(e.target.value)}
              placeholder="e.g. Vacation coverage, account alignment, workload balancing"
            />
          </Field>

          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setReassignModalOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={!reassignUserId || reassignMutation.isPending}
            >
              {reassignMutation.isPending ? 'Reassigning...' : 'Confirm Reassignment'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Convert Lead Modal */}
      {convertModalOpen && (
        <LeadConversionModal
          lead={lead}
          isOpen={convertModalOpen}
          onClose={() => setConvertModalOpen(false)}
        />
      )}

      {/* Delete Confirmation Modal */}
      <Modal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        title="Delete Lead"
        description={`Are you sure you want to permanently delete lead "${lead.name}"? This action cannot be undone.`}
      >
        <div className="flex justify-end gap-2 pt-4">
          <Button variant="secondary" onClick={() => setDeleteModalOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? 'Deleting...' : 'Delete Lead'}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
