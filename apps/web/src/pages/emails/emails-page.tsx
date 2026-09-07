import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, hasScope } from '../../lib/api';
import { useAuth } from '../../lib/providers';
import type { EmailTemplate, SerializedEmailActivity } from '../../lib/crm-types';
import { Badge, Button, Card, EmptyState, Field, Input, Skeleton } from '../../components/ui';
import { Modal } from '../../components/modal';
import { useToast } from '../../components/toast';

interface SuggestionsResponse {
  suggestions: SerializedEmailActivity[];
  nextCursor: string | null;
}

interface EmailLogResponse {
  activities: SerializedEmailActivity[];
  nextCursor: string | null;
}

interface InboxResponse {
  messages: SerializedEmailActivity[];
  nextCursor: string | null;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Best-effort open/click signals (Apple MPP undercounts — see API docs). */
function TrackingCounts({ activityId }: { activityId: string }): React.JSX.Element {
  const trackingQuery = useQuery({
    queryKey: ['email-tracking', activityId],
    queryFn: () => api<{ opens: number; clicks: number }>(`/emails/${activityId}/tracking`),
    staleTime: 60_000,
  });
  if (trackingQuery.isLoading) return <span>tracking…</span>;
  if (trackingQuery.isError || !trackingQuery.data) return <span>tracking n/a</span>;
  return (
    <span>
      {trackingQuery.data.opens} opens · {trackingQuery.data.clicks} clicks
    </span>
  );
}

export function EmailsPage(): React.JSX.Element {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [direction, setDirection] = useState<'all' | 'inbound' | 'outbound'>('all');
  const [composeOpen, setComposeOpen] = useState(false);

  const canManage = hasScope(user, 'activities:manage');

  const logParams = new URLSearchParams({ type: 'email', limit: '50' });
  if (direction !== 'all') logParams.set('direction', direction);

  const logQuery = useQuery({
    queryKey: ['email-log', direction],
    queryFn: () => api<EmailLogResponse>(`/activities?${logParams.toString()}`),
  });

  const templatesQuery = useQuery({
    queryKey: ['email-templates'],
    queryFn: () => api<EmailTemplate[]>('/email-templates'),
  });

  const suggestionsQuery = useQuery({
    queryKey: ['email-suggestions'],
    queryFn: () => api<SuggestionsResponse>('/emails/suggestions?limit=50'),
  });

  const inboxQuery = useQuery({
    queryKey: ['email-inbox'],
    queryFn: () => api<InboxResponse>('/emails/inbox/list?limit=50'),
  });

  function refresh(): void {
    void queryClient.invalidateQueries({ queryKey: ['email-log'] });
    void queryClient.invalidateQueries({ queryKey: ['email-templates'] });
    void queryClient.invalidateQueries({ queryKey: ['email-suggestions'] });
    void queryClient.invalidateQueries({ queryKey: ['email-inbox'] });
  }

  const log = logQuery.data?.activities ?? [];
  const templates = templatesQuery.data ?? [];
  const suggestions = suggestionsQuery.data?.suggestions ?? [];
  const inbox = inboxQuery.data?.messages ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-text-primary">Emails</h1>
          <p className="mt-1 text-xs text-text-secondary" aria-live="polite">
            {log.length} email{log.length === 1 ? '' : 's'} in view
            {suggestions.length > 0 && (
              <span className="ml-2 font-semibold text-warning">
                {suggestions.length} unmatched sender{suggestions.length === 1 ? '' : 's'}
              </span>
            )}
          </p>
        </div>
        {canManage && (
          <Button variant="primary" onClick={() => setComposeOpen(true)} className="h-9 text-xs">
            + Compose
          </Button>
        )}
      </div>

      <div className="flex gap-2" role="group" aria-label="Email direction">
        {(
          [
            { key: 'all', label: 'All' },
            { key: 'inbound', label: 'Inbound' },
            { key: 'outbound', label: 'Outbound' },
          ] as const
        ).map((d) => (
          <button
            key={d.key}
            type="button"
            onClick={() => setDirection(d.key)}
            aria-pressed={direction === d.key}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
              direction === d.key
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:bg-surface-raised hover:text-text-primary'
            }`}
          >
            {d.label}
          </button>
        ))}
      </div>

      <Card
        title="Email log"
        description="Inbound mail auto-matches contacts; outbound is logged on send."
      >
        {logQuery.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : logQuery.isError ? (
          <div className="rounded bg-danger-soft p-4 text-sm text-danger">
            Could not load emails: {logQuery.error?.message}
          </div>
        ) : log.length === 0 ? (
          <EmptyState title="No emails here" description="Sync inbound mail or compose an email." />
        ) : (
          <ul className="flex flex-col gap-2 text-xs">
            {log.map((mail) => (
              <li
                key={mail.id}
                aria-label={`Email ${mail.subject ?? '(no subject)'}`}
                className="flex flex-col gap-1 rounded-lg border border-border px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={mail.direction === 'outbound' ? 'success' : 'info'}>
                    {mail.direction}
                  </Badge>
                  <span className="text-sm font-medium text-text-primary">
                    {mail.subject ?? '(no subject)'}
                  </span>
                  {mail.contact && (
                    <span className="text-text-secondary">· {mail.contact.name}</span>
                  )}
                  {!mail.contact && mail.direction === 'inbound' && (
                    <span className="font-semibold text-warning">· unmatched</span>
                  )}
                </div>
                <p className="text-text-secondary">
                  {mail.direction === 'outbound' ? 'To ' : 'From '}
                  {mail.direction === 'outbound'
                    ? (mail.recipientEmails[0] ?? '—')
                    : (mail.senderEmail ?? '—')}
                  {' · '}
                  {formatDate(mail.occurredAt)}
                  {mail.direction === 'outbound' && (
                    <>
                      {' · '}
                      <TrackingCounts activityId={mail.id} />
                    </>
                  )}
                </p>
                {mail.body && (
                  <p className="whitespace-pre-wrap text-text-primary">{mail.body.slice(0, 300)}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {suggestions.length > 0 && (
        <Card
          title="Unmatched senders"
          description="Inbound mail from unknown addresses — convert to a contact instead of dropping it."
        >
          <ul className="flex flex-col gap-2 text-xs">
            {suggestions.map((s) => (
              <ConvertRow key={s.id} suggestion={s} onConverted={refresh} />
            ))}
          </ul>
        </Card>
      )}

      <Card
        title="Team inbox"
        description="Every inbound email in one triage queue — claim one to take ownership."
      >
        {inboxQuery.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : inboxQuery.isError ? (
          <div className="rounded bg-danger-soft p-4 text-sm text-danger">
            Could not load inbox: {inboxQuery.error?.message}
          </div>
        ) : inbox.length === 0 ? (
          <p className="text-xs italic text-text-secondary">Inbox zero. Nice.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-xs">
            {inbox.map((m) => (
              <InboxRow key={m.id} message={m} onClaimed={refresh} canManage={canManage} />
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Templates"
        description="Reusable subjects and bodies with {{variable}} placeholders."
      >
        {templatesQuery.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : templates.length === 0 ? (
          <p className="text-xs italic text-text-secondary">No templates yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-xs">
            {templates.map((t) => (
              <TemplateRow key={t.id} template={t} onChanged={refresh} canManage={canManage} />
            ))}
          </ul>
        )}
        {canManage && <TemplateForm onCreated={refresh} />}
      </Card>

      {canManage && <InboundTestConsole onSynced={refresh} />}

      <ComposeModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        templates={templates}
        onSent={refresh}
      />
    </div>
  );
}

function InboxRow({
  message,
  onClaimed,
  canManage,
}: {
  message: SerializedEmailActivity;
  onClaimed: () => void;
  canManage: boolean;
}): React.JSX.Element {
  const { notify } = useToast();
  const claimMutation = useMutation({
    mutationFn: () => api(`/emails/inbox/${message.id}/claim`, { method: 'POST', body: {} }),
    onSuccess: () => {
      onClaimed();
      notify('success', 'Message claimed');
    },
    onError: (err: Error) => notify('error', err.message || 'Claim failed'),
  });
  return (
    <li
      aria-label={`Inbox message ${message.subject ?? '(no subject)'}`}
      className="flex flex-col gap-1 rounded-lg border border-border px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-text-primary">
          {message.subject ?? '(no subject)'}
        </span>
        {message.owner ? (
          <span className="text-text-secondary">· {message.owner.name}</span>
        ) : (
          <Badge tone="warning">unclaimed</Badge>
        )}
        {canManage && (
          <Button
            variant="ghost"
            onClick={() => claimMutation.mutate()}
            className="ml-auto h-7 text-xs"
          >
            Claim
          </Button>
        )}
      </div>
      <p className="text-text-secondary">
        From {message.senderEmail ?? '—'} · {formatDate(message.occurredAt)}
      </p>
    </li>
  );
}

function ConvertRow({
  suggestion,
  onConverted,
}: {
  suggestion: SerializedEmailActivity;
  onConverted: () => void;
}): React.JSX.Element {
  const { notify } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const convertMutation = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error('Name is required');
      return api(`/emails/suggestions/${suggestion.id}/convert`, {
        method: 'POST',
        body: { name: name.trim() },
      });
    },
    onSuccess: () => {
      setExpanded(false);
      setName('');
      setError(null);
      onConverted();
      notify('success', 'Contact created from email');
    },
    onError: (err: Error) => setError(err.message || 'Conversion failed'),
  });

  return (
    <li className="flex flex-col gap-2 rounded border border-border px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span>
          <span className="font-medium">{suggestion.senderEmail ?? '(unknown sender)'}</span>{' '}
          <span className="text-text-secondary">— {suggestion.subject ?? '(no subject)'}</span>
        </span>
        <Button variant="secondary" onClick={() => setExpanded((v) => !v)} className="h-7 text-xs">
          {expanded ? 'Cancel' : 'Log as new contact'}
        </Button>
      </div>
      {expanded && (
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            convertMutation.mutate();
          }}
        >
          <Field label="Contact name" htmlFor={`convert-name-${suggestion.id}`}>
            <Input
              id={`convert-name-${suggestion.id}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Sam Stranger"
            />
          </Field>
          <Button
            type="submit"
            variant="primary"
            disabled={convertMutation.isPending}
            className="h-9 text-xs"
          >
            {convertMutation.isPending ? 'Creating…' : 'Create contact'}
          </Button>
        </form>
      )}
      {error && (
        <div role="alert" className="rounded bg-danger-soft p-2 text-xs text-danger">
          {error}
        </div>
      )}
    </li>
  );
}

function TemplateRow({
  template,
  onChanged,
  canManage,
}: {
  template: EmailTemplate;
  onChanged: () => void;
  canManage: boolean;
}): React.JSX.Element {
  const { notify } = useToast();
  const deleteMutation = useMutation({
    mutationFn: () => api(`/email-templates/${template.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      onChanged();
      notify('success', 'Template deleted');
    },
    onError: (err: Error) => notify('error', err.message || 'Failed to delete template'),
  });

  return (
    <li className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2">
      <span>
        <span className="font-medium">{template.name}</span>{' '}
        <span className="text-text-secondary">— {template.subject}</span>
      </span>
      {canManage && (
        <button
          type="button"
          onClick={() => deleteMutation.mutate()}
          className="rounded px-1.5 py-0.5 text-danger hover:bg-danger-soft"
          aria-label={`Delete template ${template.name}`}
        >
          Remove
        </button>
      )}
    </li>
  );
}

function TemplateForm({ onCreated }: { onCreated: () => void }): React.JSX.Element {
  const { notify } = useToast();
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!name.trim() || !subject.trim() || !body.trim()) {
        throw new Error('Name, subject, and body are required');
      }
      return api('/email-templates', {
        method: 'POST',
        body: { name: name.trim(), subject: subject.trim(), body: body.trim() },
      });
    },
    onSuccess: () => {
      setName('');
      setSubject('');
      setBody('');
      setError(null);
      onCreated();
      notify('success', 'Template created');
    },
    onError: (err: Error) => setError(err.message || 'Failed to create template'),
  });

  return (
    <form
      className="mt-3 flex flex-col gap-2 rounded border border-dashed border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        createMutation.mutate();
      }}
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="Template name" htmlFor="new-template-name">
          <Input
            id="new-template-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Intro"
          />
        </Field>
        <Field label="Subject" htmlFor="new-template-subject">
          <Input
            id="new-template-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Hi {{contactName}}"
          />
        </Field>
      </div>
      <Field label="Body" htmlFor="new-template-body">
        <textarea
          id="new-template-body"
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={'Hi {{contactName}}, this is {{ownerName}} at {{orgName}}.'}
          className="w-full rounded border border-border bg-surface p-2.5 text-xs text-text-primary focus:border-accent focus:outline-none"
        />
      </Field>
      {error && (
        <div role="alert" className="rounded bg-danger-soft p-2 text-xs text-danger">
          {error}
        </div>
      )}
      <div className="flex justify-end">
        <Button
          type="submit"
          variant="secondary"
          disabled={createMutation.isPending}
          className="h-8 text-xs"
        >
          {createMutation.isPending ? 'Creating…' : 'Create template'}
        </Button>
      </div>
    </form>
  );
}

function ComposeModal({
  open,
  onClose,
  templates,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  templates: EmailTemplate[];
  onSent: () => void;
}): React.JSX.Element {
  const { notify } = useToast();
  const [to, setTo] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (!to.trim()) throw new Error('Recipient is required');
      const payload: Record<string, unknown> = { to: to.trim() };
      if (templateId) payload['templateId'] = templateId;
      else {
        if (!subject.trim() || !body.trim()) throw new Error('Subject and body are required');
        payload['subject'] = subject.trim();
        payload['body'] = body.trim();
      }
      return api<{ messageId: string }>('/emails/send', { method: 'POST', body: payload });
    },
    onSuccess: () => {
      setTo('');
      setTemplateId('');
      setSubject('');
      setBody('');
      setError(null);
      onClose();
      onSent();
      notify('success', 'Email sent and logged');
    },
    onError: (err: Error) => setError(err.message || 'Failed to send email'),
  });

  function applyTemplate(id: string): void {
    setTemplateId(id);
    const template = templates.find((t) => t.id === id);
    if (template) {
      setSubject(template.subject);
      setBody(template.body);
    } else {
      setSubject('');
      setBody('');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Compose email"
      description="Sent mail is logged automatically."
    >
      <form
        className="flex flex-col gap-3 pt-2"
        onSubmit={(e) => {
          e.preventDefault();
          sendMutation.mutate();
        }}
      >
        {error && (
          <div role="alert" className="rounded bg-danger-soft p-3 text-xs text-danger">
            {error}
          </div>
        )}
        <Field label="To" htmlFor="compose-to">
          <Input
            id="compose-to"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="buyer@acme.test"
          />
        </Field>
        <Field label="Template (optional)" htmlFor="compose-template">
          <select
            id="compose-template"
            value={templateId}
            onChange={(e) => applyTemplate(e.target.value)}
            className="h-9 rounded border border-border bg-surface px-2 text-xs"
          >
            <option value="">No template — write free-form</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Subject" htmlFor="compose-subject">
          <Input
            id="compose-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Quick intro"
          />
        </Field>
        <Field label="Body" htmlFor="compose-body">
          <textarea
            id="compose-body"
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Hi there…"
            className="w-full rounded border border-border bg-surface p-2.5 text-xs text-text-primary focus:border-accent focus:outline-none"
          />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={sendMutation.isPending}>
            {sendMutation.isPending ? 'Sending…' : 'Send email'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function InboundTestConsole({ onSynced }: { onSynced: () => void }): React.JSX.Element {
  const { notify } = useToast();
  const [from, setFrom] = useState('');
  const [subject, setSubject] = useState('');
  const [error, setError] = useState<string | null>(null);

  const syncMutation = useMutation({
    mutationFn: async () => {
      if (!from.trim()) throw new Error('Sender is required');
      return api('/emails/sync', {
        method: 'POST',
        body: {
          provider: 'gmail',
          externalId: `console-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          from: from.trim(),
          to: [],
          subject: subject.trim() || undefined,
        },
      });
    },
    onSuccess: (result: unknown) => {
      setFrom('');
      setSubject('');
      setError(null);
      onSynced();
      const created = (result as { created?: boolean })?.created;
      notify('success', created ? 'Inbound email synced' : 'Duplicate ignored');
    },
    onError: (err: Error) => setError(err.message || 'Sync failed'),
  });

  return (
    <Card
      title="Inbound test console"
      description="Simulates a provider webhook (same pattern as the web-to-lead console)."
    >
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          syncMutation.mutate();
        }}
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="Sender email" htmlFor="console-from">
            <Input
              id="console-from"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              placeholder="prospect@example.test"
            />
          </Field>
          <Field label="Subject" htmlFor="console-subject">
            <Input
              id="console-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Hello from the field"
            />
          </Field>
        </div>
        {error && (
          <div role="alert" className="rounded bg-danger-soft p-2 text-xs text-danger">
            {error}
          </div>
        )}
        <div className="flex justify-end">
          <Button
            type="submit"
            variant="secondary"
            disabled={syncMutation.isPending}
            className="h-8 text-xs"
          >
            {syncMutation.isPending ? 'Syncing…' : 'Sync test email'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
