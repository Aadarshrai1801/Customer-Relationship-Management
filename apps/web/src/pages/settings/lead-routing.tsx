import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasScope } from '../../lib/api';
import { useAuth } from '../../lib/providers';
import type { RepAvailability, RoutingRule } from '../../lib/crm-types';
import { Badge, Button, Card, Field, Input } from '../../components/ui';
import { Modal } from '../../components/modal';
import { useToast } from '../../components/toast';

interface UserSummary {
  id: string;
  name: string;
  email: string;
}

export function LeadRoutingPage(): React.JSX.Element {
  const { user } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();

  const canManage = hasScope(user, 'lead_routing:manage');

  // Query my availability
  const availabilityQuery = useQuery({
    queryKey: ['my-availability'],
    queryFn: () => api<RepAvailability>('/lead-routing/availability'),
  });

  // Query routing rules
  const rulesQuery = useQuery({
    queryKey: ['routing-rules'],
    queryFn: () => api<RoutingRule[]>('/lead-routing/rules'),
    enabled: canManage,
  });

  // Query users for rule member selection
  const usersQuery = useQuery({
    queryKey: ['users-list'],
    queryFn: () => api<UserSummary[]>('/users'),
  });

  // Availability form state
  const [isAvailable, setIsAvailable] = useState<boolean>(true);
  const [oooReason, setOooReason] = useState<string>('');
  const [returnAt, setReturnAt] = useState<string>('');
  const [availabilityInit, setAvailabilityInit] = useState(false);

  // Sync loaded availability once
  if (availabilityQuery.data && !availabilityInit) {
    setIsAvailable(availabilityQuery.data.isAvailable);
    setOooReason(availabilityQuery.data.oooReason || '');
    setReturnAt(
      availabilityQuery.data.returnAt
        ? new Date(availabilityQuery.data.returnAt).toISOString().split('T')[0]!
        : '',
    );
    setAvailabilityInit(true);
  }

  // Update availability mutation
  const updateAvailabilityMutation = useMutation({
    mutationFn: (body: { isAvailable: boolean; oooReason?: string | null; returnAt?: string | null }) =>
      api('/lead-routing/availability', { method: 'PATCH', body }),
    onSuccess: () => {
      notify('success', 'Your availability status has been updated');
      void queryClient.invalidateQueries({ queryKey: ['my-availability'] });
    },
    onError: (err: Error) => {
      notify('error', err.message || 'Failed to update availability');
    },
  });

  // Rule modal state
  const [ruleModalOpen, setRuleModalOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<RoutingRule | null>(null);
  const [ruleName, setRuleName] = useState('');
  const [ruleStrategy, setRuleStrategy] = useState<'round_robin' | 'manual'>('round_robin');
  const [ruleIsActive, setRuleIsActive] = useState(true);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [fallbackUserId, setFallbackUserId] = useState<string>('');
  const [ruleError, setRuleError] = useState<string | null>(null);

  // Delete rule modal state
  const [deleteRuleTarget, setDeleteRuleTarget] = useState<RoutingRule | null>(null);

  // Create / Update Rule Mutation
  const saveRuleMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: ruleName.trim(),
        strategy: ruleStrategy,
        isActive: ruleIsActive,
        memberUserIds: selectedMemberIds,
        fallbackUserId: fallbackUserId || undefined,
      };

      if (editingRule) {
        return api(`/lead-routing/rules/${editingRule.id}`, {
          method: 'PATCH',
          body: payload,
        });
      }
      return api('/lead-routing/rules', {
        method: 'POST',
        body: payload,
      });
    },
    onSuccess: () => {
      notify('success', editingRule ? 'Routing rule updated' : 'Routing rule created');
      void queryClient.invalidateQueries({ queryKey: ['routing-rules'] });
      setRuleModalOpen(false);
    },
    onError: (err: Error) => {
      setRuleError(err.message || 'Failed to save routing rule');
    },
  });

  // Delete Rule Mutation
  const deleteRuleMutation = useMutation({
    mutationFn: (id: string) => api(`/lead-routing/rules/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      notify('success', 'Routing rule deleted');
      void queryClient.invalidateQueries({ queryKey: ['routing-rules'] });
      setDeleteRuleTarget(null);
    },
    onError: (err: Error) => {
      notify('error', err.message || 'Failed to delete rule');
    },
  });

  const openCreateRuleModal = () => {
    setEditingRule(null);
    setRuleName('');
    setRuleStrategy('round_robin');
    setRuleIsActive(true);
    setSelectedMemberIds([]);
    setFallbackUserId('');
    setRuleError(null);
    setRuleModalOpen(true);
  };

  const openEditRuleModal = (rule: RoutingRule) => {
    setEditingRule(rule);
    setRuleName(rule.name);
    setRuleStrategy(rule.strategy);
    setRuleIsActive(rule.isActive);
    setSelectedMemberIds(rule.members.map((m) => m.userId));
    setFallbackUserId(rule.fallbackUserId || '');
    setRuleError(null);
    setRuleModalOpen(true);
  };

  const moveMember = (index: number, direction: 'up' | 'down') => {
    const next = [...selectedMemberIds];
    const targetIdx = direction === 'up' ? index - 1 : index + 1;
    if (targetIdx < 0 || targetIdx >= next.length) return;
    const temp = next[index]!;
    next[index] = next[targetIdx]!;
    next[targetIdx] = temp;
    setSelectedMemberIds(next);
  };

  const toggleMemberSelection = (userId: string) => {
    if (selectedMemberIds.includes(userId)) {
      setSelectedMemberIds(selectedMemberIds.filter((id) => id !== userId));
    } else {
      setSelectedMemberIds([...selectedMemberIds, userId]);
    }
  };

  const users: UserSummary[] = (Array.isArray(usersQuery.data) ? usersQuery.data : (usersQuery.data as any)?.users) ?? [];
  const rules = rulesQuery.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-text-primary">
          Lead Routing & Rep Availability
        </h1>
        <p className="mt-1 text-xs text-text-secondary">
          Manage automated round-robin lead assignment, out-of-office exclusions, and fallback queues.
        </p>
      </div>

      {/* Rep Availability Section */}
      <Card
        title="My Working Availability"
        description="Set your availability for incoming leads. Leads will skip you when Out of Office is active."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            updateAvailabilityMutation.mutate({
              isAvailable,
              oooReason: isAvailable ? null : oooReason || null,
              returnAt: isAvailable ? null : returnAt ? new Date(returnAt).toISOString() : null,
            });
          }}
          className="flex flex-col gap-4 max-w-lg"
        >
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="isAvailableToggle"
              checked={isAvailable}
              onChange={(e) => setIsAvailable(e.target.checked)}
              className="h-4 w-4 rounded border-border text-accent focus:ring-accent"
            />
            <label htmlFor="isAvailableToggle" className="text-xs font-semibold text-text-primary cursor-pointer">
              {isAvailable ? '🟢 Available for new lead assignments' : '🔴 Out of Office / Unavailable'}
            </label>
          </div>

          {!isAvailable && (
            <div className="flex flex-col gap-3 rounded border border-border/80 bg-surface-raised/50 p-3 text-xs">
              <Field label="Out of Office Reason" htmlFor="oooReason">
                <Input
                  id="oooReason"
                  value={oooReason}
                  onChange={(e) => setOooReason(e.target.value)}
                  placeholder="e.g. Annual leave, conference, PTO"
                />
              </Field>
              <Field label="Expected Return Date" htmlFor="returnAt">
                <Input
                  id="returnAt"
                  type="date"
                  value={returnAt}
                  onChange={(e) => setReturnAt(e.target.value)}
                />
              </Field>
            </div>
          )}

          <div>
            <Button
              type="submit"
              variant="primary"
              disabled={updateAvailabilityMutation.isPending}
              className="text-xs h-8 px-3"
            >
              {updateAvailabilityMutation.isPending ? 'Saving...' : 'Save Availability'}
            </Button>
          </div>
        </form>
      </Card>

      {/* Round-Robin Routing Rules Section */}
      {canManage && (
        <Card
          title="Round-Robin Routing Rules"
          description="Rules dictate how inbound website leads are rotated across sales representatives."
          actions={
            <Button variant="primary" onClick={openCreateRuleModal} className="text-xs h-8 px-3">
              + Add Rule
            </Button>
          }
        >
          {rulesQuery.isLoading ? (
            <p className="text-xs text-text-secondary">Loading routing rules...</p>
          ) : rules.length === 0 ? (
            <div className="rounded border border-dashed border-border-strong p-6 text-center text-xs text-text-secondary">
              <p className="font-medium text-text-primary mb-1">No routing rules configured</p>
              <p className="mb-3">
                Create a round-robin rule to distribute incoming leads fairly among reps.
              </p>
              <Button variant="secondary" onClick={openCreateRuleModal} className="text-xs">
                Create Rule
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  className="rounded-lg border border-border bg-surface-raised/40 p-4 flex flex-col gap-3"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-text-primary">{rule.name}</span>
                      <Badge tone={rule.isActive ? 'success' : 'neutral'}>
                        {rule.isActive ? 'ACTIVE' : 'INACTIVE'}
                      </Badge>
                      <span className="text-[11px] font-mono text-text-secondary">
                        Strategy: {rule.strategy}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        onClick={() => openEditRuleModal(rule)}
                        className="text-xs h-7 px-2.5"
                      >
                        Edit
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => setDeleteRuleTarget(rule)}
                        className="text-xs h-7 px-2.5"
                      >
                        Delete
                      </Button>
                    </div>
                  </div>

                  {/* Members list */}
                  <div>
                    <span className="text-[11px] uppercase tracking-wider text-text-secondary font-semibold block mb-1.5">
                      Rotation Members ({rule.members.length})
                    </span>
                    {rule.members.length === 0 ? (
                      <p className="text-xs text-text-secondary italic">No members assigned to rotation.</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {rule.members.map((m, idx) => (
                          <span
                            key={m.id}
                            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-text-primary"
                          >
                            <span className="font-mono text-[10px] text-text-secondary">
                              #{idx + 1}
                            </span>
                            <span className="font-medium">{m.user?.name || 'Rep'}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Fallback user */}
                  <div className="text-xs text-text-secondary pt-2 border-t border-border/60 flex items-center justify-between">
                    <span>
                      Fallback Representative:{' '}
                      <strong className="text-text-primary">
                        {rule.fallbackUser ? rule.fallbackUser.name : 'None (Unassigned)'}
                      </strong>
                    </span>
                    <span className="text-[11px]">
                      Last assigned index: #{rule.lastAssignedIndex}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Create / Edit Rule Modal */}
      <Modal
        open={ruleModalOpen}
        onClose={() => setRuleModalOpen(false)}
        title={editingRule ? 'Edit Routing Rule' : 'Create Routing Rule'}
        description="Configure round-robin assignment rotation and fallback handler."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setRuleError(null);
            saveRuleMutation.mutate();
          }}
          className="flex flex-col gap-4 pt-2 max-h-[75vh] overflow-y-auto px-1"
        >
          {ruleError && (
            <div role="alert" className="rounded bg-danger-soft p-3 text-xs text-danger">
              {ruleError}
            </div>
          )}

          <Field label="Rule Name *" htmlFor="ruleName">
            <Input
              id="ruleName"
              value={ruleName}
              onChange={(e) => setRuleName(e.target.value)}
              placeholder="e.g. Website Inbound Round-Robin"
              required
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Strategy" htmlFor="ruleStrategy">
              <select
                id="ruleStrategy"
                value={ruleStrategy}
                onChange={(e) => setRuleStrategy(e.target.value as 'round_robin' | 'manual')}
                className="h-9 w-full rounded border border-border bg-surface px-3 text-xs text-text-primary"
              >
                <option value="round_robin">Round-Robin</option>
                <option value="manual">Manual Assignment</option>
              </select>
            </Field>

            <Field label="Fallback Representative" htmlFor="fallbackUser">
              <select
                id="fallbackUser"
                value={fallbackUserId}
                onChange={(e) => setFallbackUserId(e.target.value)}
                className="h-9 w-full rounded border border-border bg-surface px-3 text-xs text-text-primary"
              >
                <option value="">-- No Fallback Rep --</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="ruleActive"
              checked={ruleIsActive}
              onChange={(e) => setRuleIsActive(e.target.checked)}
              className="h-4 w-4 rounded border-border text-accent focus:ring-accent"
            />
            <label htmlFor="ruleActive" className="text-xs font-medium text-text-primary cursor-pointer">
              Rule is active for incoming leads
            </label>
          </div>

          {/* Member Selection & Ordering */}
          <div className="border-t border-border pt-3">
            <label className="text-xs font-semibold text-text-primary block mb-2">
              Rotation Members (Selected in Round-Robin Order)
            </label>

            {/* Selected members in order */}
            {selectedMemberIds.length > 0 && (
              <div className="flex flex-col gap-1.5 mb-3 rounded border border-border bg-surface-raised/40 p-2">
                {selectedMemberIds.map((userId, idx) => {
                  const u = users.find((user) => user.id === userId);
                  return (
                    <div
                      key={userId}
                      className="flex items-center justify-between rounded bg-surface p-1.5 px-2 text-xs border border-border/70"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[10px] text-accent font-bold">
                          #{idx + 1}
                        </span>
                        <span className="font-medium text-text-primary">{u?.name || userId}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => moveMember(idx, 'up')}
                          className="px-1.5 py-0.5 rounded text-[10px] bg-surface-raised hover:bg-surface-sunken disabled:opacity-30"
                          title="Move Up"
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          disabled={idx === selectedMemberIds.length - 1}
                          onClick={() => moveMember(idx, 'down')}
                          className="px-1.5 py-0.5 rounded text-[10px] bg-surface-raised hover:bg-surface-sunken disabled:opacity-30"
                          title="Move Down"
                        >
                          ▼
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleMemberSelection(userId)}
                          className="px-1.5 py-0.5 rounded text-[10px] text-danger hover:bg-danger-soft ml-1"
                          title="Remove"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* User checkboxes to toggle inclusion */}
            <div className="max-h-40 overflow-y-auto divide-y divide-border/60 rounded border border-border bg-surface p-2 text-xs">
              <span className="text-[10px] text-text-secondary uppercase tracking-wider font-semibold block px-1 py-0.5 mb-1">
                Available Reps
              </span>
              {users.map((u) => {
                const isSelected = selectedMemberIds.includes(u.id);
                return (
                  <label
                    key={u.id}
                    className="flex items-center justify-between p-1.5 hover:bg-surface-raised/60 cursor-pointer rounded"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleMemberSelection(u.id)}
                        className="h-3.5 w-3.5 rounded border-border text-accent"
                      />
                      <span className="font-medium text-text-primary">{u.name}</span>
                    </div>
                    <span className="font-mono text-[10px] text-text-secondary">{u.email}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <Button type="button" variant="secondary" onClick={() => setRuleModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={saveRuleMutation.isPending}>
              {saveRuleMutation.isPending ? 'Saving...' : 'Save Rule'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Delete Rule Confirmation Modal */}
      {deleteRuleTarget && (
        <Modal
          open={!!deleteRuleTarget}
          onClose={() => setDeleteRuleTarget(null)}
          title="Delete Routing Rule"
          description={`Are you sure you want to delete "${deleteRuleTarget.name}"? Inbound leads will not be routed with this rule.`}
        >
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="secondary" onClick={() => setDeleteRuleTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => deleteRuleMutation.mutate(deleteRuleTarget.id)}
              disabled={deleteRuleMutation.isPending}
            >
              {deleteRuleMutation.isPending ? 'Deleting...' : 'Delete Rule'}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
