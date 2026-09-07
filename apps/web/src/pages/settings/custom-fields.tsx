import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasScope } from '../../lib/api';
import { useAuth } from '../../lib/providers';
import type { CustomFieldDef, CustomFieldType } from '../../lib/crm-types';
import { Badge, Button, Card, EmptyState, Field, Input, Skeleton } from '../../components/ui';
import { Modal } from '../../components/modal';
import { useToast } from '../../components/toast';

const FIELD_TYPES: Array<{ type: CustomFieldType; label: string; desc: string }> = [
  { type: 'text', label: 'Text', desc: 'Single-line text string' },
  { type: 'number', label: 'Number', desc: 'Floating-point or integer number' },
  { type: 'date', label: 'Date', desc: 'ISO Date (YYYY-MM-DD)' },
  { type: 'picklist', label: 'Picklist', desc: 'Single selection from defined options' },
  { type: 'multi_select', label: 'Multi-Select', desc: 'Multiple selections from options' },
  { type: 'checkbox', label: 'Checkbox', desc: 'Boolean true/false flag' },
  { type: 'currency', label: 'Currency', desc: 'Monetary amount with ISO currency code' },
  { type: 'formula', label: 'Formula', desc: 'Computed expression (read-only automated field)' },
];

export function CustomFieldsAdminPage(): React.JSX.Element {
  const { user } = useAuth();
  const { notify } = useToast();
  const queryClient = useQueryClient();

  const [entityType, setEntityType] = useState<'contact' | 'account' | 'lead' | 'deal'>('contact');
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<CustomFieldDef | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CustomFieldDef | null>(null);

  // Create form state
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [type, setType] = useState<CustomFieldType>('text');
  const [required, setRequired] = useState(false);
  const [optionsInput, setOptionsInput] = useState('');
  const [formulaExpression, setFormulaExpression] = useState('');
  const [currencyCode, setCurrencyCode] = useState('USD');
  const [formError, setFormError] = useState<string | null>(null);

  // Edit form state
  const [editLabel, setEditLabel] = useState('');
  const [editRequired, setEditRequired] = useState(false);
  const [editOptionsInput, setEditOptionsInput] = useState('');
  const [editFormula, setEditFormula] = useState('');

  const canManage = hasScope(user, 'custom_fields:manage');

  const fieldsQuery = useQuery({
    queryKey: ['custom-fields-admin', entityType],
    queryFn: () => api<CustomFieldDef[]>(`/custom-fields?entityType=${entityType}`),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const options: Record<string, unknown> = {};
      if (type === 'picklist' || type === 'multi_select') {
        const list = optionsInput
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean);
        options['options'] = list;
      }
      if (type === 'formula') {
        options['expression'] = formulaExpression.trim();
      }
      if (type === 'currency') {
        options['currency'] = currencyCode.trim().toUpperCase() || 'USD';
      }

      return api('/custom-fields', {
        method: 'POST',
        body: {
          entityType,
          key: key.trim().toLowerCase(),
          label: label.trim(),
          type,
          required,
          options,
        },
      });
    },
    onSuccess: () => {
      notify('success', 'Custom field created');
      setCreateModalOpen(false);
      resetCreateForm();
      void queryClient.invalidateQueries({ queryKey: ['custom-fields-admin'] });
      void queryClient.invalidateQueries({ queryKey: ['custom-fields'] });
    },
    onError: (err) => {
      setFormError(err instanceof Error ? err.message : 'Failed to create field');
    },
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!editTarget) return;
      const options: Record<string, unknown> = { ...editTarget.options };
      if (editTarget.type === 'picklist' || editTarget.type === 'multi_select') {
        options['options'] = editOptionsInput
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean);
      }
      if (editTarget.type === 'formula') {
        options['expression'] = editFormula.trim();
      }

      return api(`/custom-fields/${editTarget.id}`, {
        method: 'PATCH',
        body: {
          label: editLabel.trim(),
          required: editRequired,
          options,
        },
      });
    },
    onSuccess: () => {
      notify('success', 'Field updated');
      setEditTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['custom-fields-admin'] });
      void queryClient.invalidateQueries({ queryKey: ['custom-fields'] });
    },
    onError: (err) => {
      notify('error', err instanceof Error ? err.message : 'Update failed');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return api(`/custom-fields/${id}`, { method: 'DELETE' });
    },
    onSuccess: () => {
      notify('success', 'Custom field removed');
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: ['custom-fields-admin'] });
      void queryClient.invalidateQueries({ queryKey: ['custom-fields'] });
    },
    onError: (err) => {
      notify('error', err instanceof Error ? err.message : 'Delete failed');
    },
  });

  function resetCreateForm() {
    setKey('');
    setLabel('');
    setType('text');
    setRequired(false);
    setOptionsInput('');
    setFormulaExpression('');
    setCurrencyCode('USD');
    setFormError(null);
  }

  function openEdit(def: CustomFieldDef) {
    setEditTarget(def);
    setEditLabel(def.label);
    setEditRequired(def.required);
    const opts = Array.isArray(def.options['options'])
      ? (def.options['options'] as string[]).join(', ')
      : '';
    setEditOptionsInput(opts);
    setEditFormula(typeof def.options['expression'] === 'string' ? def.options['expression'] : '');
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">
            Custom Fields &amp; Schema
          </h1>
          <p className="mt-0.5 text-xs text-text-secondary">
            Configure custom properties and automated formulas for contacts and accounts.
          </p>
        </div>
        {canManage && (
          <Button
            variant="primary"
            onClick={() => {
              resetCreateForm();
              setCreateModalOpen(true);
            }}
            className="text-xs"
          >
            + New Custom Field
          </Button>
        )}
      </div>

      {/* Entity Switcher */}
      <div className="flex gap-2 border-b border-border pb-2">
        <button
          type="button"
          onClick={() => setEntityType('contact')}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
            entityType === 'contact'
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:bg-surface-raised hover:text-text-primary'
          }`}
        >
          Contact Custom Fields
        </button>
        <button
          type="button"
          onClick={() => setEntityType('account')}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
            entityType === 'account'
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:bg-surface-raised hover:text-text-primary'
          }`}
        >
          Account Custom Fields
        </button>
        <button
          type="button"
          onClick={() => setEntityType('lead')}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
            entityType === 'lead'
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:bg-surface-raised hover:text-text-primary'
          }`}
        >
          Lead Custom Fields
        </button>
        <button
          type="button"
          onClick={() => setEntityType('deal')}
          className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
            entityType === 'deal'
              ? 'bg-accent text-white'
              : 'text-text-secondary hover:bg-surface-raised hover:text-text-primary'
          }`}
        >
          Deal Custom Fields
        </button>
      </div>

      {/* Fields List */}
      <Card
        title={`${entityType === 'contact' ? 'Contact' : entityType === 'account' ? 'Account' : entityType === 'lead' ? 'Lead' : 'Deal'} Field Definitions`}
        description="These fields are validated and rendered across list and detail pages."
      >
        {fieldsQuery.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : fieldsQuery.isError ? (
          <div className="rounded bg-danger-soft p-4 text-sm text-danger">
            Could not load custom fields: {fieldsQuery.error?.message}
          </div>
        ) : !fieldsQuery.data || fieldsQuery.data.length === 0 ? (
          <EmptyState
            title="No custom fields defined"
            description={`Create custom fields to capture specialized ${entityType} information.`}
            action={
              canManage ? (
                <Button variant="primary" onClick={() => setCreateModalOpen(true)}>
                  Add First Field
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border text-text-secondary">
                <tr>
                  <th className="py-2.5 font-medium">Label</th>
                  <th className="py-2.5 font-medium">Key</th>
                  <th className="py-2.5 font-medium">Type</th>
                  <th className="py-2.5 font-medium">Required</th>
                  <th className="py-2.5 font-medium">Configuration</th>
                  <th className="py-2.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {fieldsQuery.data.map((def) => {
                  let configDisplay = '—';
                  if (def.type === 'picklist' || def.type === 'multi_select') {
                    const opts = Array.isArray(def.options['options'])
                      ? (def.options['options'] as string[])
                      : [];
                    configDisplay = `${opts.length} options: [${opts.join(', ')}]`;
                  } else if (def.type === 'formula') {
                    configDisplay = `Expression: ${String(def.options['expression'] ?? '')}`;
                  } else if (def.type === 'currency') {
                    configDisplay = `Currency: ${String(def.options['currency'] ?? 'USD')}`;
                  }

                  return (
                    <tr key={def.id} className="hover:bg-surface-raised/40">
                      <td className="py-2.5 font-semibold text-text-primary">{def.label}</td>
                      <td className="py-2.5 font-mono text-text-secondary">{def.key}</td>
                      <td className="py-2.5">
                        <Badge tone={def.type === 'formula' ? 'info' : 'neutral'}>{def.type}</Badge>
                      </td>
                      <td className="py-2.5 text-text-secondary">
                        {def.required ? 'Yes (Mandatory)' : 'No'}
                      </td>
                      <td
                        className="py-2.5 text-text-secondary max-w-[250px] truncate"
                        title={configDisplay}
                      >
                        {configDisplay}
                      </td>
                      <td className="py-2.5 text-right">
                        {canManage && (
                          <div className="flex items-center justify-end gap-1.5">
                            <Button
                              variant="ghost"
                              onClick={() => openEdit(def)}
                              className="h-6 px-2 text-xs"
                            >
                              Edit
                            </Button>
                            <Button
                              variant="ghost"
                              onClick={() => setDeleteTarget(def)}
                              className="h-6 px-2 text-xs text-danger hover:bg-danger-soft"
                            >
                              Delete
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Create Modal */}
      <Modal
        open={createModalOpen}
        onOpenChange={setCreateModalOpen}
        size="lg"
        title={`New ${entityType === 'contact' ? 'Contact' : 'Account'} Custom Field`}
        description="Define a new property for records in your workspace."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setFormError(null);
            if (!key.trim() || !/^[a-z][a-z0-9_]{1,49}$/.test(key.trim())) {
              setFormError('Key must be lowercase snake_case (e.g. lead_score, region_name)');
              return;
            }
            if (!label.trim()) {
              setFormError('Label is required');
              return;
            }
            if ((type === 'picklist' || type === 'multi_select') && !optionsInput.trim()) {
              setFormError('Picklist and Multi-select require comma-separated options');
              return;
            }
            if (type === 'formula' && !formulaExpression.trim()) {
              setFormError('Formula expression is required');
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
            <Field label="Field Label *" htmlFor="cf-label" hint="Display name in the UI">
              <Input
                id="cf-label"
                required
                placeholder="e.g. Lead Score, Region"
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value);
                  if (!key) {
                    setKey(
                      e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9_]/g, '_')
                        .replace(/_{2,}/g, '_')
                        .replace(/^_|_$/g, ''),
                    );
                  }
                }}
              />
            </Field>

            <Field label="System Key *" htmlFor="cf-key" hint="Unique snake_case identifier">
              <Input
                id="cf-key"
                required
                placeholder="lead_score"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </Field>

            <Field label="Field Type *" htmlFor="cf-type">
              <select
                id="cf-type"
                value={type}
                onChange={(e) => setType(e.target.value as CustomFieldType)}
                className="h-9 rounded border border-border bg-surface px-3 text-sm text-text-primary"
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.label} — {t.desc}
                  </option>
                ))}
              </select>
            </Field>

            {type !== 'formula' && (
              <div className="flex items-center pt-6">
                <label className="flex items-center gap-2 text-sm text-text-primary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={required}
                    onChange={(e) => setRequired(e.target.checked)}
                    className="h-4 w-4 rounded border-border text-accent focus:ring-accent"
                  />
                  <span>Required field</span>
                </label>
              </div>
            )}
          </div>

          {/* Type-Specific Options */}
          {(type === 'picklist' || type === 'multi_select') && (
            <Field
              label="Options (comma-separated) *"
              htmlFor="cf-options"
              hint="e.g. Tier 1, Tier 2, Tier 3"
            >
              <Input
                id="cf-options"
                placeholder="Active, Inactive, Pending"
                value={optionsInput}
                onChange={(e) => setOptionsInput(e.target.value)}
              />
            </Field>
          )}

          {type === 'currency' && (
            <Field label="Currency Code" htmlFor="cf-currency" hint="3-letter ISO code">
              <Input
                id="cf-currency"
                placeholder="USD"
                value={currencyCode}
                onChange={(e) => setCurrencyCode(e.target.value)}
              />
            </Field>
          )}

          {type === 'formula' && (
            <div className="flex flex-col gap-2 rounded-lg border border-accent/30 bg-accent-soft/20 p-3">
              <Field
                label="Formula Expression *"
                htmlFor="cf-formula"
                hint="e.g. {score} * 1.5 or CONCAT({first_name}, ' ', {last_name}) or ROUND({amount} * 1.1, 2)"
              >
                <Input
                  id="cf-formula"
                  placeholder="CONCAT({nickname}, ' (VIP)')"
                  value={formulaExpression}
                  onChange={(e) => setFormulaExpression(e.target.value)}
                />
              </Field>
              <div className="text-[11px] text-text-secondary">
                <span className="font-semibold text-text-primary">Supported Functions:</span>{' '}
                <code>CONCAT(a, b, ...)</code>, <code>ROUND(x, dec)</code>,{' '}
                <code>IF(cond, a, b)</code>, <code>MIN(a, b)</code>, <code>MAX(a, b)</code>. Field
                references must be in braces: <code>&#123;field_key&#125;</code>.
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
            <Button type="button" variant="secondary" onClick={() => setCreateModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Creating...' : 'Save Field'}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Edit Modal */}
      <Modal
        open={Boolean(editTarget)}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
        size="md"
        title={`Edit ${editTarget?.label}`}
        description="Update custom field settings. Key and type are immutable."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            updateMutation.mutate();
          }}
          className="flex flex-col gap-4"
        >
          <Field label="Field Label" htmlFor="edit-cf-label">
            <Input
              id="edit-cf-label"
              required
              value={editLabel}
              onChange={(e) => setEditLabel(e.target.value)}
            />
          </Field>

          {editTarget?.type !== 'formula' && (
            <label className="flex items-center gap-2 text-sm text-text-primary cursor-pointer">
              <input
                type="checkbox"
                checked={editRequired}
                onChange={(e) => setEditRequired(e.target.checked)}
                className="h-4 w-4 rounded border-border text-accent focus:ring-accent"
              />
              <span>Required field</span>
            </label>
          )}

          {(editTarget?.type === 'picklist' || editTarget?.type === 'multi_select') && (
            <Field label="Options (comma-separated)" htmlFor="edit-cf-options">
              <Input
                id="edit-cf-options"
                value={editOptionsInput}
                onChange={(e) => setEditOptionsInput(e.target.value)}
              />
            </Field>
          )}

          {editTarget?.type === 'formula' && (
            <Field label="Formula Expression" htmlFor="edit-cf-formula">
              <Input
                id="edit-cf-formula"
                value={editFormula}
                onChange={(e) => setEditFormula(e.target.value)}
              />
            </Field>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
            <Button type="button" variant="secondary" onClick={() => setEditTarget(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Saving...' : 'Update Field'}
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
        title="Delete Custom Field"
        description={`Remove "${deleteTarget?.label}"?`}
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs text-text-secondary">
            Deleting this custom field definition will stop validating it on future writes. Existing
            stored data is preserved.
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
