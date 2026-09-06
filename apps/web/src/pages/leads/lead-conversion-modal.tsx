import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { SerializedAccount, SerializedContact, SerializedLead } from '../../lib/crm-types';
import { Modal } from '../../components/modal';
import { Button, Field, Input } from '../../components/ui';
import { useToast } from '../../components/toast';

interface ConvertResponse {
  lead: SerializedLead;
  contact: SerializedContact;
  account: SerializedAccount | null;
}

interface LeadConversionModalProps {
  lead: SerializedLead;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (res: ConvertResponse) => void;
}

export function LeadConversionModal({
  lead,
  isOpen,
  onClose,
  onSuccess,
}: LeadConversionModalProps): React.JSX.Element {
  const { notify } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [accountMode, setAccountMode] = useState<'create' | 'existing'>(
    lead.company ? 'create' : 'existing',
  );
  const [newAccountName, setNewAccountName] = useState(lead.company || lead.name || '');
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Query accounts list for linking
  const accountsQuery = useQuery({
    queryKey: ['accounts-select-convert'],
    queryFn: () => api<{ accounts: SerializedAccount[] }>('/accounts?limit=100'),
    enabled: isOpen,
  });

  const convertMutation = useMutation({
    mutationFn: async () => {
      const payload: { accountId?: string; accountName?: string; contactId?: string } = {};
      if (accountMode === 'create' && newAccountName.trim()) {
        payload.accountName = newAccountName.trim();
      } else if (accountMode === 'existing' && selectedAccountId) {
        payload.accountId = selectedAccountId;
      }
      return api<ConvertResponse>(`/leads/${lead.id}/convert`, {
        method: 'POST',
        body: payload,
      });
    },
    onSuccess: (data) => {
      notify('success', `Lead converted! Contact "${data.contact.name}" created.`);
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      void queryClient.invalidateQueries({ queryKey: ['lead', lead.id] });
      void queryClient.invalidateQueries({ queryKey: ['contacts'] });
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      onClose();
      if (onSuccess) {
        onSuccess(data);
      } else {
        void navigate({ to: `/contacts/${data.contact.id}` });
      }
    },
    onError: (err: Error) => {
      setError(err.message || 'Failed to convert lead');
    },
  });

  const handleConvert = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    convertMutation.mutate();
  };

  const accounts = accountsQuery.data?.accounts ?? [];

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Convert Lead"
      description="Convert this qualified lead into a Contact and Account record."
    >
      <form onSubmit={handleConvert} className="flex flex-col gap-5 pt-2">
        {error && (
          <div role="alert" className="rounded bg-danger-soft p-3 text-xs text-danger">
            {error}
          </div>
        )}

        {/* Lead summary */}
        <div className="rounded border border-border bg-surface-raised p-3 text-xs flex flex-col gap-1.5">
          <div className="flex justify-between">
            <span className="text-text-secondary">Lead Name:</span>
            <span className="font-medium text-text-primary">{lead.name}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-secondary">Email:</span>
            <span className="font-mono text-text-primary">{lead.email}</span>
          </div>
          {lead.company && (
            <div className="flex justify-between">
              <span className="text-text-secondary">Company:</span>
              <span className="font-medium text-text-primary">{lead.company}</span>
            </div>
          )}
        </div>

        {/* Contact Creation Notice */}
        <div className="flex items-center gap-2 rounded border border-success-soft bg-success-soft/30 p-2.5 text-xs text-text-primary">
          <svg className="h-4 w-4 text-success shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span>
            A new Contact <strong>{lead.name}</strong> ({lead.email}) will be created and linked.
          </span>
        </div>

        {/* Account Options */}
        <div className="flex flex-col gap-2">
          <label className="text-xs font-semibold text-text-primary uppercase tracking-wider">
            Account Details
          </label>
          <div className="flex gap-4 text-xs">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="accountMode"
                checked={accountMode === 'create'}
                onChange={() => setAccountMode('create')}
                className="text-accent"
              />
              <span>Create New Account</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="accountMode"
                checked={accountMode === 'existing'}
                onChange={() => setAccountMode('existing')}
                className="text-accent"
              />
              <span>Link to Existing Account</span>
            </label>
          </div>

          {accountMode === 'create' ? (
            <Field label="New Account Name" htmlFor="convertAccountName">
              <Input
                id="convertAccountName"
                value={newAccountName}
                onChange={(e) => setNewAccountName(e.target.value)}
                placeholder="e.g. Acme Corporation"
              />
            </Field>
          ) : (
            <Field label="Select Existing Account" htmlFor="convertExistingAccount">
              <select
                id="convertExistingAccount"
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                className="h-9 w-full rounded border border-border bg-surface px-3 text-xs text-text-primary focus:border-accent"
              >
                <option value="">-- Choose Account --</option>
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>

        <p className="text-xs text-text-secondary">
          Notes and matching custom fields will be copied to the new Contact and Account. The lead
          status will be locked as Converted.
        </p>

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={convertMutation.isPending}>
            {convertMutation.isPending ? 'Converting...' : 'Convert Lead'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
