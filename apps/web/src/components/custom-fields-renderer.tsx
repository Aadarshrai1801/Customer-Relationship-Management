import React from 'react';
import type { CustomFieldDef } from '../lib/crm-types';
import { InlineEdit } from './inline-edit';
import { Badge } from './ui';

export interface CustomFieldsRendererProps {
  defs: CustomFieldDef[];
  values: Record<string, unknown>;
  computedValues?: Record<string, unknown>;
  fieldPermissions?: Record<string, 'edit' | 'read' | 'none'>;
  canManage?: boolean;
  onSaveField?: (key: string, value: unknown) => Promise<void>;
}

export function CustomFieldsRenderer({
  defs,
  values,
  computedValues = {},
  fieldPermissions = {},
  canManage = true,
  onSaveField,
}: CustomFieldsRendererProps): React.JSX.Element {
  if (defs.length === 0) {
    return <p className="text-xs text-text-secondary italic">No custom fields defined.</p>;
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {defs.map((def) => {
        const perm = fieldPermissions[def.key] ?? 'edit';
        if (perm === 'none') return null;
        const isReadOnly = !canManage || perm === 'read' || def.type === 'formula';

        if (def.type === 'formula') {
          const computed = computedValues[def.key];
          const hasVal = computed !== undefined && computed !== null && computed !== '';
          return (
            <div key={def.key} className="flex flex-col gap-0.5 rounded border border-border/50 bg-surface-raised/40 p-2">
              <div className="flex items-center justify-between gap-1">
                <span className="text-xs font-medium text-text-secondary">{def.label}</span>
                <span className="rounded bg-accent-soft px-1.5 py-0.2 text-[10px] font-mono text-accent" title={`Formula: ${def.options['expression'] ?? ''}`}>
                  fx
                </span>
              </div>
              <div className="text-sm font-medium text-text-primary">
                {hasVal ? (
                  typeof computed === 'boolean' ? (
                    computed ? 'Yes' : 'No'
                  ) : typeof computed === 'number' ? (
                    computed.toLocaleString()
                  ) : (
                    String(computed)
                  )
                ) : (
                  <span className="text-text-secondary italic">—</span>
                )}
              </div>
            </div>
          );
        }

        const rawVal = values[def.key];

        if (def.type === 'checkbox') {
          const checked = Boolean(rawVal);
          return (
            <div key={def.key} className="flex flex-col gap-0.5 p-1">
              <span className="text-xs font-medium text-text-secondary">{def.label}</span>
              {isReadOnly ? (
                <div className="text-sm">{checked ? 'Yes' : 'No'}</div>
              ) : (
                <label className="flex items-center gap-2 text-sm text-text-primary cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      if (onSaveField) {
                        void onSaveField(def.key, e.target.checked);
                      }
                    }}
                    className="h-4 w-4 rounded border-border text-accent focus:ring-accent"
                  />
                  <span>{checked ? 'Checked' : 'Unchecked'}</span>
                </label>
              )}
            </div>
          );
        }

        if (def.type === 'multi_select') {
          const arr = Array.isArray(rawVal) ? (rawVal as string[]) : [];
          const optionsList = Array.isArray(def.options['options'])
            ? (def.options['options'] as string[])
            : [];
          return (
            <div key={def.key} className="flex flex-col gap-1 p-1">
              <span className="text-xs font-medium text-text-secondary">{def.label}</span>
              {arr.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {arr.map((item) => (
                    <Badge key={item} tone="info">
                      {item}
                    </Badge>
                  ))}
                </div>
              ) : (
                <span className="text-xs text-text-secondary italic">None selected</span>
              )}
              {!isReadOnly && onSaveField && (
                <div className="mt-1 flex flex-wrap gap-1 text-xs">
                  {optionsList.map((opt) => {
                    const isSelected = arr.includes(opt);
                    return (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => {
                          const next = isSelected ? arr.filter((x) => x !== opt) : [...arr, opt];
                          void onSaveField(def.key, next);
                        }}
                        className={`rounded border px-2 py-0.5 text-xs transition-colors ${
                          isSelected
                            ? 'border-accent bg-accent text-white'
                            : 'border-border bg-surface text-text-secondary hover:bg-surface-raised'
                        }`}
                      >
                        {isSelected ? `✓ ${opt}` : `+ ${opt}`}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        }

        if (def.type === 'currency') {
          const amount =
            rawVal != null && typeof rawVal === 'object' && 'amount' in rawVal
              ? (rawVal as { amount?: number; currency?: string }).amount
              : typeof rawVal === 'number'
                ? rawVal
                : null;
          const currencyCode =
            (typeof def.options['currency'] === 'string' && def.options['currency']) ||
            (rawVal != null &&
            typeof rawVal === 'object' &&
            'currency' in rawVal &&
            typeof (rawVal as { currency?: string }).currency === 'string'
              ? (rawVal as { currency?: string }).currency
              : 'USD');

          return (
            <div key={def.key} className="p-1">
              <InlineEdit
                label={def.label}
                type="number"
                value={amount != null ? amount : ''}
                readOnly={isReadOnly}
                renderDisplay={(v) =>
                  v != null && v !== '' ? (
                    <span className="font-mono">
                      {currencyCode} {Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  ) : null
                }
                onSave={async (draft) => {
                  if (!onSaveField) return;
                  const num = draft.trim() === '' ? null : Number(draft);
                  await onSaveField(def.key, num != null ? { amount: num, currency: currencyCode } : null);
                }}
              />
            </div>
          );
        }

        if (def.type === 'picklist') {
          const opts = Array.isArray(def.options['options'])
            ? (def.options['options'] as string[]).map((o) => ({ value: o, label: o }))
            : [];
          return (
            <div key={def.key} className="p-1">
              <InlineEdit
                label={def.label}
                type="select"
                options={opts}
                value={rawVal != null ? String(rawVal) : ''}
                readOnly={isReadOnly}
                onSave={async (draft) => {
                  if (onSaveField) {
                    await onSaveField(def.key, draft.trim() === '' ? null : draft);
                  }
                }}
              />
            </div>
          );
        }

        return (
          <div key={def.key} className="p-1">
            <InlineEdit
              label={def.label}
              type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'}
              value={rawVal != null ? String(rawVal) : ''}
              readOnly={isReadOnly}
              onSave={async (draft) => {
                if (onSaveField) {
                  const val =
                    def.type === 'number'
                      ? draft.trim() === ''
                        ? null
                        : Number(draft)
                      : draft.trim() === ''
                        ? null
                        : draft;
                  await onSaveField(def.key, val);
                }
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

export function CustomFieldsForm({
  defs,
  values,
  onChange,
}: {
  defs: CustomFieldDef[];
  values: Record<string, unknown>;
  onChange: (key: string, val: unknown) => void;
}): React.JSX.Element {
  const editableDefs = defs.filter((d) => d.type !== 'formula');
  if (editableDefs.length === 0) return <></>;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised/30 p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">Custom Fields</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {editableDefs.map((def) => {
          const val = values[def.key];
          if (def.type === 'checkbox') {
            return (
              <label key={def.key} className="flex items-center gap-2 text-sm text-text-primary pt-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(val)}
                  onChange={(e) => onChange(def.key, e.target.checked)}
                  className="h-4 w-4 rounded border-border text-accent focus:ring-accent"
                />
                <span className="font-medium">{def.label} {def.required && '*'}</span>
              </label>
            );
          }

          if (def.type === 'picklist') {
            const options = Array.isArray(def.options['options'])
              ? (def.options['options'] as string[])
              : [];
            return (
              <div key={def.key} className="flex flex-col gap-1">
                <label htmlFor={`cf-${def.key}`} className="text-xs font-medium text-text-primary">
                  {def.label} {def.required && '*'}
                </label>
                <select
                  id={`cf-${def.key}`}
                  value={val != null ? String(val) : ''}
                  onChange={(e) => onChange(def.key, e.target.value || null)}
                  className="h-9 rounded border border-border bg-surface px-3 text-sm text-text-primary focus:border-accent"
                >
                  <option value="">-- Select --</option>
                  {options.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              </div>
            );
          }

          if (def.type === 'currency') {
            const currencyCode = (def.options['currency'] as string) || 'USD';
            const num = typeof val === 'object' && val !== null && 'amount' in val
              ? (val as { amount: number }).amount
              : typeof val === 'number'
                ? val
                : '';
            return (
              <div key={def.key} className="flex flex-col gap-1">
                <label htmlFor={`cf-${def.key}`} className="text-xs font-medium text-text-primary">
                  {def.label} ({currencyCode}) {def.required && '*'}
                </label>
                <input
                  id={`cf-${def.key}`}
                  type="number"
                  step="any"
                  value={num}
                  onChange={(e) => {
                    const parsed = e.target.value === '' ? null : Number(e.target.value);
                    onChange(def.key, parsed != null ? { amount: parsed, currency: currencyCode } : null);
                  }}
                  className="h-9 rounded border border-border bg-surface px-3 text-sm text-text-primary focus:border-accent"
                />
              </div>
            );
          }

          return (
            <div key={def.key} className="flex flex-col gap-1">
              <label htmlFor={`cf-${def.key}`} className="text-xs font-medium text-text-primary">
                {def.label} {def.required && '*'}
              </label>
              <input
                id={`cf-${def.key}`}
                type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'}
                value={val != null ? String(val) : ''}
                onChange={(e) => {
                  const raw = e.target.value;
                  const res = def.type === 'number' ? (raw === '' ? null : Number(raw)) : raw === '' ? null : raw;
                  onChange(def.key, res);
                }}
                className="h-9 rounded border border-border bg-surface px-3 text-sm text-text-primary focus:border-accent"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
