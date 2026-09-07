import { useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, API_URL, hasScope } from '../../lib/api';
import { useAuth } from '../../lib/providers';
import type {
  ContactNote,
  CustomFieldDef,
  SerializedAccount,
  SerializedContact,
  TimelineItem,
} from '../../lib/crm-types';
import { Badge, Button, Card, EmptyState, Skeleton } from '../../components/ui';
import { Breadcrumbs } from '../../components/breadcrumbs';
import { InlineEdit } from '../../components/inline-edit';
import { CustomFieldsRenderer } from '../../components/custom-fields-renderer';
import { MergePickerModal } from '../../components/merge-picker-modal';
import { Modal } from '../../components/modal';
import { CommentsThread } from '../../components/comments-thread';
import { AttachmentsCard } from '../../components/attachments-card';
import { useToast } from '../../components/toast';

const STAGE_OPTIONS = [
  { value: 'lead', label: 'Lead' },
  { value: 'mql', label: 'MQL' },
  { value: 'sql', label: 'SQL' },
  { value: 'opportunity', label: 'Opportunity' },
  { value: 'customer', label: 'Customer' },
  { value: 'evangelist', label: 'Evangelist' },
  { value: 'other', label: 'Other' },
];

export function ContactDetailPage(): React.JSX.Element {
  const { id } = useParams({ strict: false }) as { id: string };
  const { user } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<'timeline' | 'notes'>('timeline');
  const [newNoteBody, setNewNoteBody] = useState('');
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteDraft, setEditingNoteDraft] = useState('');

  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [mergePickerOpen, setMergePickerOpen] = useState(false);
  const [mergeTargetContactId, setMergeTargetContactId] = useState('');
  const [candidateSelectOpen, setCandidateSelectOpen] = useState(false);

  const canManage = hasScope(user, 'contacts:manage');
  const userFieldRules =
    (user?.role.permissions?.fields as Record<string, 'edit' | 'read' | 'none'>) ?? {};

  // Fetch contact record
  const contactQuery = useQuery({
    queryKey: ['contact', id],
    queryFn: () => api<SerializedContact>(`/contacts/${id}`),
    enabled: Boolean(id),
  });

  // Fetch custom field definitions for contact
  const customFieldDefs = useQuery({
    queryKey: ['custom-fields', 'contact'],
    queryFn: () => api<CustomFieldDef[]>('/custom-fields?entityType=contact'),
  });

  // Fetch accounts for account picker
  const accountsQuery = useQuery({
    queryKey: ['accounts-select'],
    queryFn: () => api<{ accounts: SerializedAccount[] }>('/accounts?limit=100'),
  });

  // Fetch contact timeline
  const timelineQuery = useQuery({
    queryKey: ['contact-timeline', id],
    queryFn: () =>
      api<{ items: TimelineItem[]; nextCursor: string | null }>(
        `/contacts/${id}/timeline?limit=50`,
      ),
    enabled: Boolean(id),
  });

  // Fetch notes
  const notesQuery = useQuery({
    queryKey: ['contact-notes', id],
    queryFn: () => api<ContactNote[]>(`/contacts/${id}/notes`),
    enabled: Boolean(id),
  });

  // Contacts for merge target selection
  const contactsForMergeQuery = useQuery({
    queryKey: ['contacts-for-merge', id],
    queryFn: () => api<{ contacts: SerializedContact[] }>(`/contacts?limit=50`),
    enabled: candidateSelectOpen,
  });

  // Update contact field mutation
  const updateFieldMutation = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => {
      return api<SerializedContact>(`/contacts/${id}`, {
        method: 'PATCH',
        body: patch,
      });
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(['contact', id], updated);
      notify('success', 'Updated');
      void queryClient.invalidateQueries({ queryKey: ['contact-timeline', id] });
    },
    onError: (err) => {
      notify('error', err instanceof Error ? err.message : 'Update failed');
      throw err;
    },
  });

  // Add note mutation
  const addNoteMutation = useMutation({
    mutationFn: async () => {
      return api<ContactNote>(`/contacts/${id}/notes`, {
        method: 'POST',
        body: { body: newNoteBody },
      });
    },
    onSuccess: () => {
      setNewNoteBody('');
      notify('success', 'Note added');
      void queryClient.invalidateQueries({ queryKey: ['contact-notes', id] });
      void queryClient.invalidateQueries({ queryKey: ['contact-timeline', id] });
    },
    onError: (err) => {
      notify('error', err instanceof Error ? err.message : 'Failed to add note');
    },
  });

  // Update note mutation
  const updateNoteMutation = useMutation({
    mutationFn: async ({ noteId, body }: { noteId: string; body: string }) => {
      return api<ContactNote>(`/contacts/${id}/notes/${noteId}`, {
        method: 'PATCH',
        body: { body },
      });
    },
    onSuccess: () => {
      setEditingNoteId(null);
      notify('success', 'Note updated');
      void queryClient.invalidateQueries({ queryKey: ['contact-notes', id] });
      void queryClient.invalidateQueries({ queryKey: ['contact-timeline', id] });
    },
    onError: (err) => {
      notify('error', err instanceof Error ? err.message : 'Failed to update note');
    },
  });

  // Delete note mutation
  const deleteNoteMutation = useMutation({
    mutationFn: async (noteId: string) => {
      return api(`/contacts/${id}/notes/${noteId}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      notify('success', 'Note deleted');
      void queryClient.invalidateQueries({ queryKey: ['contact-notes', id] });
      void queryClient.invalidateQueries({ queryKey: ['contact-timeline', id] });
    },
    onError: (err) => {
      notify('error', err instanceof Error ? err.message : 'Failed to delete note');
    },
  });

  // Delete contact mutation
  const deleteContactMutation = useMutation({
    mutationFn: async () => {
      return api(`/contacts/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      notify('success', 'Contact deleted');
      void navigate({ to: '/contacts' });
    },
    onError: (err) => {
      notify('error', err instanceof Error ? err.message : 'Failed to delete contact');
    },
  });

  // Data enrichment mutation (links account from email domain + tags)
  const enrichMutation = useMutation({
    mutationFn: async () => {
      return api<{ contact: SerializedContact; applied: Record<string, string> }>(
        `/contacts/${id}/enrich`,
        { method: 'POST', body: {} },
      );
    },
    onSuccess: (result) => {
      queryClient.setQueryData(['contact', id], result.contact);
      const keys = Object.keys(result.applied);
      notify(
        'success',
        keys.length > 0 ? `Enriched: ${keys.join(', ')}` : 'Already enriched — nothing to apply',
      );
      void queryClient.invalidateQueries({ queryKey: ['contact-timeline', id] });
    },
    onError: (err) => {
      notify('error', err instanceof Error ? err.message : 'Enrichment failed');
    },
  });

  if (contactQuery.isLoading) {
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

  if (contactQuery.isError || !contactQuery.data) {
    return (
      <div className="flex flex-col gap-4">
        <Breadcrumbs items={[{ label: 'Contacts', to: '/contacts' }, { label: 'Not Found' }]} />
        <EmptyState
          title="Contact not found"
          description="The contact may have been deleted or you don't have permission to access it."
          action={
            <Link to="/contacts">
              <Button variant="primary">Return to Contacts</Button>
            </Link>
          }
        />
      </div>
    );
  }

  const contact = contactQuery.data;
  const accountOptions = (accountsQuery.data?.accounts ?? []).map((acc) => ({
    value: acc.id,
    label: acc.name,
  }));

  async function handleSaveField(fieldName: string, value: unknown): Promise<void> {
    await updateFieldMutation.mutateAsync({ [fieldName]: value });
  }

  async function handleSaveCustomField(key: string, val: unknown): Promise<void> {
    const nextCustom = { ...contact.customFields, [key]: val };
    await updateFieldMutation.mutateAsync({ customFields: nextCustom });
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Breadcrumbs */}
      <Breadcrumbs items={[{ label: 'Contacts', to: '/contacts' }, { label: contact.name }]} />

      {/* Header Banner */}
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-border bg-surface p-6 shadow-subtle">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-text-primary">{contact.name}</h1>
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
          </div>
          <p className="text-sm text-text-secondary">
            {contact.title ? `${contact.title} · ` : ''}
            {contact.account ? (
              <Link
                to="/accounts/$id"
                params={{ id: contact.account.id }}
                className="font-medium text-accent hover:underline"
              >
                {contact.account.name}
              </Link>
            ) : (
              'No Company'
            )}
            {' · '}
            Owner: {contact.owner?.name ?? 'Unassigned'}
          </p>
        </div>

        {/* Header Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`${API_URL}/v1/contacts/${contact.id}/vcf`}
            download
            className="inline-flex h-9 items-center justify-center gap-2 rounded border border-border bg-surface px-3 text-xs font-medium text-text-primary hover:bg-surface-raised"
          >
            Export vCard
          </a>
          {canManage && (
            <>
              <Button
                variant="secondary"
                onClick={() => enrichMutation.mutate()}
                className="text-xs"
              >
                Enrich
              </Button>
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

      {/* Main 2-Column Grid */}
      <div className="grid gap-6 lg:grid-cols-12">
        {/* Left Column: Record Details & Custom Fields */}
        <div className="flex flex-col gap-6 lg:col-span-7">
          {/* Standard Fields Card */}
          <Card title="Contact Information" description="Click on any field to edit directly.">
            <div className="grid gap-3 sm:grid-cols-2">
              <InlineEdit
                label="Full Name"
                value={contact.name}
                readOnly={!canManage || userFieldRules['name'] === 'read'}
                onSave={(val) => handleSaveField('name', val)}
              />

              <InlineEdit
                label="Email"
                value={contact.email}
                readOnly={!canManage || userFieldRules['email'] === 'read'}
                onSave={(val) => handleSaveField('email', val)}
              />

              <InlineEdit
                label="First Name"
                value={contact.firstName}
                readOnly={!canManage || userFieldRules['firstName'] === 'read'}
                onSave={(val) => handleSaveField('firstName', val || null)}
              />

              <InlineEdit
                label="Last Name"
                value={contact.lastName}
                readOnly={!canManage || userFieldRules['lastName'] === 'read'}
                onSave={(val) => handleSaveField('lastName', val || null)}
              />

              <InlineEdit
                label="Job Title"
                value={contact.title}
                readOnly={!canManage || userFieldRules['title'] === 'read'}
                onSave={(val) => handleSaveField('title', val || null)}
              />

              <InlineEdit
                label="Phone"
                value={contact.phone}
                readOnly={!canManage || userFieldRules['phone'] === 'read'}
                onSave={(val) => handleSaveField('phone', val || null)}
                renderDisplay={(val) =>
                  val ? (
                    <a
                      href={`tel:${String(val).replace(/\s+/g, '')}`}
                      className="text-accent hover:underline"
                    >
                      {String(val)}
                    </a>
                  ) : null
                }
              />

              <InlineEdit
                label="Company / Account"
                type="select"
                options={accountOptions}
                value={contact.accountId}
                readOnly={!canManage || userFieldRules['accountId'] === 'read'}
                renderDisplay={() =>
                  contact.account ? (
                    <Link
                      to="/accounts/$id"
                      params={{ id: contact.account.id }}
                      className="text-accent hover:underline"
                    >
                      {contact.account.name}
                    </Link>
                  ) : null
                }
                onSave={(val) => handleSaveField('accountId', val || null)}
              />

              <InlineEdit
                label="Lifecycle Stage"
                type="select"
                options={STAGE_OPTIONS}
                value={contact.lifecycleStage}
                readOnly={!canManage || userFieldRules['lifecycleStage'] === 'read'}
                onSave={(val) => handleSaveField('lifecycleStage', val)}
              />

              <div className="sm:col-span-2">
                <InlineEdit
                  label="Tags"
                  placeholder="No tags (click to add, comma-separated)"
                  value={contact.tags.join(', ')}
                  readOnly={!canManage || userFieldRules['tags'] === 'read'}
                  renderDisplay={(_val) =>
                    contact.tags.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {contact.tags.map((t) => (
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

          {/* Custom & Formula Fields Card */}
          <Card
            title="Custom & Computed Fields"
            description="Dynamic properties including automated formula outputs."
          >
            <CustomFieldsRenderer
              defs={customFieldDefs.data ?? []}
              values={contact.customFields ?? {}}
              computedValues={contact.computedFields ?? {}}
              fieldPermissions={userFieldRules}
              canManage={canManage}
              onSaveField={handleSaveCustomField}
            />
          </Card>
        </div>

        {/* Right Column: Timeline & Notes */}
        <div className="flex flex-col gap-4 lg:col-span-5">
          <div className="flex items-center gap-1 border-b border-border">
            <button
              type="button"
              onClick={() => setActiveTab('timeline')}
              className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === 'timeline'
                  ? 'border-accent text-accent font-semibold'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              Activity Timeline
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('notes')}
              className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === 'notes'
                  ? 'border-accent text-accent font-semibold'
                  : 'border-transparent text-text-secondary hover:text-text-primary'
              }`}
            >
              Notes ({notesQuery.data?.length ?? 0})
            </button>
          </div>

          {/* Notes Composer (visible on both tabs or prominent) */}
          <div className="rounded-xl border border-border bg-surface p-4 shadow-subtle">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-secondary">
              Add Note
            </h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (newNoteBody.trim()) {
                  addNoteMutation.mutate();
                }
              }}
              className="flex flex-col gap-2"
            >
              <textarea
                rows={2}
                placeholder="Write a note about this contact..."
                value={newNoteBody}
                onChange={(e) => setNewNoteBody(e.target.value)}
                className="w-full rounded border border-border bg-surface p-2.5 text-xs text-text-primary focus:border-accent focus:outline-none"
              />
              <div className="flex justify-end">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={!newNoteBody.trim() || addNoteMutation.isPending}
                  className="h-7 text-xs"
                >
                  {addNoteMutation.isPending ? 'Adding...' : 'Post Note'}
                </Button>
              </div>
            </form>
          </div>

          {/* Tab Content: Timeline */}
          {activeTab === 'timeline' && (
            <div className="flex flex-col gap-3">
              {timelineQuery.isLoading ? (
                <Skeleton className="h-48 w-full" />
              ) : !timelineQuery.data || timelineQuery.data.items.length === 0 ? (
                <EmptyState
                  title="No timeline events"
                  description="Activity like notes, edits, and merges will show up here."
                />
              ) : (
                <ul className="flex flex-col gap-2">
                  {timelineQuery.data.items.map((item) => (
                    <li
                      key={item.id}
                      className="rounded-lg border border-border bg-surface p-3 text-xs shadow-subtle"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <Badge
                            tone={
                              item.type === 'note_added'
                                ? 'info'
                                : item.type === 'contact_merged'
                                  ? 'warning'
                                  : 'neutral'
                            }
                          >
                            {item.type.replace('_', ' ')}
                          </Badge>
                          <span className="font-semibold text-text-primary">{item.summary}</span>
                        </div>
                        <span className="text-[10px] text-text-secondary">
                          {new Date(item.occurredAt).toLocaleString()}
                        </span>
                      </div>
                      {item.actor.email && (
                        <p className="mt-1 text-[11px] text-text-secondary">
                          By: {item.actor.email}
                        </p>
                      )}
                      {item.data && Object.keys(item.data).length > 0 && (
                        <div className="mt-1.5 rounded bg-surface-raised/60 p-2 text-[11px] font-mono text-text-secondary">
                          {item.type === 'note_added' &&
                          typeof item.data['preview'] === 'string' ? (
                            <p className="font-sans text-text-primary">{item.data['preview']}</p>
                          ) : (
                            <pre className="overflow-x-auto whitespace-pre-wrap">
                              {JSON.stringify(item.data, null, 2)}
                            </pre>
                          )}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Tab Content: Notes */}
          {activeTab === 'notes' && (
            <div className="flex flex-col gap-3">
              {notesQuery.isLoading ? (
                <Skeleton className="h-48 w-full" />
              ) : !notesQuery.data || notesQuery.data.length === 0 ? (
                <EmptyState
                  title="No notes yet"
                  description="Add meeting notes, call summaries, or context using the box above."
                />
              ) : (
                <ul className="flex flex-col gap-3">
                  {notesQuery.data.map((note) => {
                    const isEditing = editingNoteId === note.id;
                    const canEditNote =
                      canManage && (note.author?.id === user?.id || hasScope(user, 'users:manage'));

                    return (
                      <li
                        key={note.id}
                        className="rounded-lg border border-border bg-surface p-4 text-xs shadow-subtle"
                      >
                        <div className="flex items-center justify-between border-b border-border/50 pb-2">
                          <span className="font-medium text-text-primary">
                            {note.author?.name ?? 'Unknown Author'}
                          </span>
                          <span className="text-[10px] text-text-secondary">
                            {new Date(note.createdAt).toLocaleString()}
                          </span>
                        </div>

                        {isEditing ? (
                          <div className="mt-2 flex flex-col gap-2">
                            <textarea
                              rows={3}
                              value={editingNoteDraft}
                              onChange={(e) => setEditingNoteDraft(e.target.value)}
                              className="w-full rounded border border-accent bg-surface p-2 text-xs text-text-primary focus:outline-none"
                            />
                            <div className="flex justify-end gap-1.5">
                              <Button
                                type="button"
                                variant="secondary"
                                onClick={() => setEditingNoteId(null)}
                                className="h-6 text-[11px]"
                              >
                                Cancel
                              </Button>
                              <Button
                                type="button"
                                variant="primary"
                                onClick={() =>
                                  updateNoteMutation.mutate({
                                    noteId: note.id,
                                    body: editingNoteDraft,
                                  })
                                }
                                disabled={updateNoteMutation.isPending}
                                className="h-6 text-[11px]"
                              >
                                Save Note
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <p className="mt-2 whitespace-pre-wrap text-text-primary">{note.body}</p>
                        )}

                        {canEditNote && !isEditing && (
                          <div className="mt-3 flex items-center justify-end gap-2 border-t border-border/40 pt-2 text-[11px]">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingNoteId(note.id);
                                setEditingNoteDraft(note.body);
                              }}
                              className="text-text-secondary hover:text-text-primary"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                if (window.confirm('Delete this note?')) {
                                  deleteNoteMutation.mutate(note.id);
                                }
                              }}
                              className="text-danger hover:underline"
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <CommentsThread entityType="contact" entityId={contact.id} />
        <AttachmentsCard entityType="contact" entityId={contact.id} />
      </div>

      {/* Select Merge Candidate Modal */}
      <Modal
        open={candidateSelectOpen}
        onOpenChange={setCandidateSelectOpen}
        size="md"
        title="Select Contact to Merge"
        description="Choose another contact to merge with this record."
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs text-text-secondary">
            Select the contact you would like to compare and merge into{' '}
            <strong className="text-text-primary">{contact.name}</strong>.
          </p>

          <select
            value={mergeTargetContactId}
            onChange={(e) => setMergeTargetContactId(e.target.value)}
            className="h-9 rounded border border-border bg-surface px-3 text-xs text-text-primary"
          >
            <option value="">-- Choose contact --</option>
            {contactsForMergeQuery.data?.contacts
              .filter((c) => c.id !== contact.id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.email})
                </option>
              ))}
          </select>

          <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
            <Button type="button" variant="secondary" onClick={() => setCandidateSelectOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={!mergeTargetContactId}
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
      {mergePickerOpen && mergeTargetContactId && (
        <MergePickerModal
          open={mergePickerOpen}
          onOpenChange={setMergePickerOpen}
          entityType="contact"
          primaryId={contact.id}
          secondaryId={mergeTargetContactId}
          primaryName={contact.name}
          secondaryName={
            contactsForMergeQuery.data?.contacts.find((c) => c.id === mergeTargetContactId)?.name
          }
          onSuccess={(winnerId) => {
            if (winnerId === contact.id) {
              void queryClient.invalidateQueries({ queryKey: ['contact', id] });
              void queryClient.invalidateQueries({ queryKey: ['contact-timeline', id] });
            } else {
              void navigate({ to: '/contacts/$id', params: { id: winnerId } });
            }
          }}
        />
      )}

      {/* Delete Contact Confirmation */}
      <Modal
        open={deleteModalOpen}
        onOpenChange={setDeleteModalOpen}
        size="sm"
        title="Delete Contact"
        description={`Are you sure you want to delete ${contact.name}?`}
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs text-text-secondary">
            This will soft-delete the contact. Timeline activity and notes will be preserved in
            audit logs.
          </p>
          <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setDeleteModalOpen(false)}
              disabled={deleteContactMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => deleteContactMutation.mutate()}
              disabled={deleteContactMutation.isPending}
            >
              {deleteContactMutation.isPending ? 'Deleting...' : 'Confirm Delete'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
