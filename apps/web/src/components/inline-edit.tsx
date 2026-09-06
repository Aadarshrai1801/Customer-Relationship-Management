import { useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Button } from './ui';

export interface SelectOption {
  value: string;
  label: string;
}

export interface InlineEditProps {
  label?: string;
  value: string | number | null | undefined;
  type?: 'text' | 'number' | 'date' | 'select' | 'textarea';
  options?: SelectOption[];
  placeholder?: string;
  readOnly?: boolean;
  onSave: (val: string) => Promise<void>;
  className?: string;
  renderDisplay?: (val: string | number | null | undefined) => React.ReactNode;
}

export function InlineEdit({
  label,
  value,
  type = 'text',
  options = [],
  placeholder = 'Empty (click to edit)',
  readOnly = false,
  onSave,
  className,
  renderDisplay,
}: InlineEditProps): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value != null ? String(value) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setDraft(value != null ? String(value) : '');
  }, [value]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
    }
  }, [editing]);

  async function handleSave(): Promise<void> {
    const trimmed = draft.trim();
    if (trimmed === (value != null ? String(value).trim() : '')) {
      setEditing(false);
      setError(null);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  function handleCancel(): void {
    setDraft(value != null ? String(value) : '');
    setEditing(false);
    setError(null);
  }

  function handleKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    } else if (e.key === 'Enter' && type !== 'textarea') {
      e.preventDefault();
      void handleSave();
    }
  }

  if (readOnly) {
    return (
      <div className={clsx('flex flex-col gap-0.5', className)}>
        {label && <span className="text-xs font-medium text-text-secondary">{label}</span>}
        <div className="text-sm text-text-primary">
          {renderDisplay ? renderDisplay(value) : value != null && value !== '' ? String(value) : <span className="text-text-secondary italic">{placeholder}</span>}
        </div>
      </div>
    );
  }

  if (!editing) {
    return (
      <div className={clsx('group flex flex-col gap-0.5', className)}>
        {label && <span className="text-xs font-medium text-text-secondary">{label}</span>}
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="flex min-h-[30px] items-center justify-between gap-2 rounded px-1.5 py-1 text-left text-sm text-text-primary transition-colors hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-accent"
          title="Click to edit"
        >
          <span className="truncate">
            {renderDisplay ? renderDisplay(value) : value != null && value !== '' ? (
              type === 'select' ? (
                options.find((o) => o.value === String(value))?.label ?? String(value)
              ) : (
                String(value)
              )
            ) : (
              <span className="text-text-secondary/70 italic">{placeholder}</span>
            )}
          </span>
          <span
            aria-hidden
            className="text-xs text-text-secondary opacity-0 transition-opacity group-hover:opacity-100"
          >
            ✎
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className={clsx('flex flex-col gap-1', className)}>
      {label && <span className="text-xs font-medium text-text-secondary">{label}</span>}
      <div className="flex items-center gap-1.5">
        {type === 'select' ? (
          <select
            ref={inputRef as React.RefObject<HTMLSelectElement>}
            value={draft}
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            className="h-8 flex-1 rounded border border-accent bg-surface px-2 text-sm text-text-primary focus:outline-none"
          >
            <option value="">-- None --</option>
            {options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        ) : type === 'textarea' ? (
          <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            value={draft}
            disabled={saving}
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 rounded border border-accent bg-surface p-2 text-sm text-text-primary focus:outline-none"
          />
        ) : (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type={type}
            value={draft}
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            className="h-8 flex-1 rounded border border-accent bg-surface px-2 text-sm text-text-primary focus:outline-none"
          />
        )}
        <Button
          type="button"
          variant="primary"
          onClick={() => void handleSave()}
          disabled={saving}
          className="h-8 px-2.5 text-xs"
        >
          {saving ? '...' : 'Save'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={handleCancel}
          disabled={saving}
          className="h-8 px-2 text-xs"
        >
          ✕
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
