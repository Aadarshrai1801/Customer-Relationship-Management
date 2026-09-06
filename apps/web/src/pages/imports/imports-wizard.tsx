import { useEffect, useRef, useState } from 'react';
import { Link, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, API_URL } from '../../lib/api';
import type {
  CustomFieldDef,
  ImportJobDetail,
  UploadResponse,
} from '../../lib/crm-types';
import { Badge, Button, Card, EmptyState, Skeleton } from '../../components/ui';
import { useToast } from '../../components/toast';

const STANDARD_CONTACT_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'name', label: 'Full Name *' },
  { key: 'firstName', label: 'First Name' },
  { key: 'lastName', label: 'Last Name' },
  { key: 'email', label: 'Email Address *' },
  { key: 'phone', label: 'Phone Number' },
  { key: 'title', label: 'Job Title' },
  { key: 'lifecycleStage', label: 'Lifecycle Stage' },
  { key: 'tags', label: 'Tags' },
  { key: 'accountName', label: 'Company / Account Name' },
  { key: 'ownerEmail', label: 'Owner Email' },
];

const STANDARD_ACCOUNT_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'name', label: 'Company Name *' },
  { key: 'website', label: 'Website' },
  { key: 'phone', label: 'Phone Number' },
  { key: 'industry', label: 'Industry' },
  { key: 'tags', label: 'Tags' },
  { key: 'domains', label: 'Domains' },
  { key: 'ownerEmail', label: 'Owner Email' },
];

export function ImportsWizardPage(): React.JSX.Element {
  const searchParams = useSearch({ strict: false }) as { entityType?: 'contact' | 'account' };
  const { notify } = useToast();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [entityType, setEntityType] = useState<'contact' | 'account'>(
    searchParams.entityType === 'account' ? 'account' : 'contact',
  );

  const [uploadedJob, setUploadedJob] = useState<UploadResponse | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [uploadError, setUploadError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Load custom fields for entity type to include in mapping options
  const customFieldDefs = useQuery({
    queryKey: ['custom-fields', entityType],
    queryFn: () => api<CustomFieldDef[]>(`/custom-fields?entityType=${entityType}`),
  });

  // Query active job details when in step 3 or 4
  const activeJobQuery = useQuery({
    queryKey: ['import-job', jobId],
    queryFn: () => api<ImportJobDetail>(`/imports/${jobId}`),
    enabled: Boolean(jobId) && (step === 3 || step === 4),
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      if (s === 'validating' || s === 'importing') {
        return 1500; // Poll every 1.5s while async worker is running
      }
      return false;
    },
  });

  // Past jobs list
  const pastJobsQuery = useQuery({
    queryKey: ['import-jobs-list'],
    queryFn: () => api<ImportJobDetail[]>('/imports'),
  });

  // Automatically advance to validated state when validating finishes
  useEffect(() => {
    if (step === 3 && activeJobQuery.data) {
      if (activeJobQuery.data.status === 'validated' || activeJobQuery.data.status === 'validation_failed') {
        // Validation completed
      }
    }
    if (step === 4 && activeJobQuery.data) {
      if (activeJobQuery.data.status === 'completed') {
        notify('success', 'Import completed successfully!');
        void queryClient.invalidateQueries({ queryKey: ['import-jobs-list'] });
      }
    }
  }, [activeJobQuery.data, step]);

  // Upload mutation
  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      setUploadError(null);
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch(`${API_URL}/v1/imports/upload?entityType=${entityType}`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string };
        throw new Error(data?.message ?? 'Upload failed');
      }

      return res.json() as Promise<UploadResponse>;
    },
    onSuccess: (data) => {
      setUploadedJob(data);
      setJobId(data.id);
      setMapping(data.suggestedMapping || {});
      setStep(2);
      notify('success', `File uploaded: ${data.totalRows.toLocaleString()} rows found.`);
    },
    onError: (err) => {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    },
  });

  // Save mapping & request validation mutation
  const validateMutation = useMutation({
    mutationFn: async () => {
      if (!jobId) return;
      // 1. Save mapping
      await api(`/imports/${jobId}/mapping`, {
        method: 'POST',
        body: { mapping },
      });
      // 2. Trigger validation
      await api(`/imports/${jobId}/validate`, {
        method: 'POST',
      });
    },
    onSuccess: () => {
      setStep(3);
      void queryClient.invalidateQueries({ queryKey: ['import-job', jobId] });
    },
    onError: (err) => {
      notify('error', err instanceof Error ? err.message : 'Validation request failed');
    },
  });

  // Commit mutation
  const commitMutation = useMutation({
    mutationFn: async () => {
      if (!jobId) return;
      return api(`/imports/${jobId}/commit`, { method: 'POST' });
    },
    onSuccess: () => {
      setStep(4);
      void queryClient.invalidateQueries({ queryKey: ['import-job', jobId] });
    },
    onError: (err) => {
      notify('error', err instanceof Error ? err.message : 'Commit failed');
    },
  });

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      uploadMutation.mutate(file);
    }
  }

  const standardFields =
    entityType === 'contact' ? STANDARD_CONTACT_FIELDS : STANDARD_ACCOUNT_FIELDS;
  const customFields = customFieldDefs.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-text-primary">
          Import &amp; Export Data
        </h1>
        <p className="mt-0.5 text-xs text-text-secondary">
          Upload CSV or vCard (.vcf) files with field mapping and dry-run validation.
        </p>
      </div>

      {/* Stepper indicator */}
      <div className="flex items-center justify-between rounded-xl border border-border bg-surface p-4 shadow-subtle">
        {[
          { num: 1, label: 'Upload File' },
          { num: 2, label: 'Map Fields' },
          { num: 3, label: 'Preview & Validate' },
          { num: 4, label: 'Import Progress' },
        ].map((s, idx) => {
          const isCurrent = step === s.num;
          const isPassed = step > s.num;
          return (
            <div key={s.num} className="flex items-center gap-2">
              <div
                className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
                  isPassed
                    ? 'bg-success text-white'
                    : isCurrent
                      ? 'bg-accent text-white'
                      : 'bg-surface-raised text-text-secondary border border-border'
                }`}
              >
                {isPassed ? '✓' : s.num}
              </div>
              <span
                className={`text-xs font-medium ${
                  isCurrent ? 'text-text-primary' : 'text-text-secondary'
                }`}
              >
                {s.label}
              </span>
              {idx < 3 && <div className="hidden h-[1px] w-8 bg-border sm:block md:w-16" />}
            </div>
          );
        })}
      </div>

      {/* Step 1: Upload File */}
      {step === 1 && (
        <Card title="Step 1: Upload Your Data File" description="Supported formats: .csv, .vcf (vCard).">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-4">
              <label className="text-xs font-medium text-text-secondary">Import Destination:</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setEntityType('contact')}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                    entityType === 'contact'
                      ? 'border-accent bg-accent text-white'
                      : 'border-border bg-surface text-text-secondary hover:bg-surface-raised'
                  }`}
                >
                  Contacts
                </button>
                <button
                  type="button"
                  onClick={() => setEntityType('account')}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                    entityType === 'account'
                      ? 'border-accent bg-accent text-white'
                      : 'border-border bg-surface text-text-secondary hover:bg-surface-raised'
                  }`}
                >
                  Accounts (Companies)
                </button>
              </div>
            </div>

            {/* Dropzone */}
            <div
              onClick={() => fileInputRef.current?.click()}
              className="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border-strong bg-surface-raised/40 p-8 text-center cursor-pointer transition-colors hover:border-accent hover:bg-accent-soft/10"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.vcf"
                onChange={handleFileChange}
                className="hidden"
              />
              <span className="text-2xl">📄</span>
              <p className="text-sm font-semibold text-text-primary">
                Click to browse or drop your CSV or VCF file here
              </p>
              <p className="text-xs text-text-secondary">
                Max file size 50MB · Up to 100,000 rows processed asynchronously
              </p>
              {uploadMutation.isPending && (
                <div className="mt-2 text-xs font-medium text-accent animate-pulse">
                  Uploading and inspecting headers...
                </div>
              )}
            </div>

            {uploadError && (
              <div role="alert" className="rounded bg-danger-soft p-3 text-xs text-danger">
                {uploadError}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Step 2: Map Fields */}
      {step === 2 && uploadedJob && (
        <Card
          title="Step 2: Map Columns to CRM Fields"
          description={`Review auto-suggested mappings for ${uploadedJob.headers.length} columns from your file.`}
        >
          <div className="flex flex-col gap-4">
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-border bg-surface-raised text-text-secondary">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Source Column Header</th>
                    <th className="px-4 py-2.5 font-medium">Sample Values</th>
                    <th className="px-4 py-2.5 font-medium">Target CRM Field</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {uploadedJob.headers.map((header) => {
                    const sample = uploadedJob.sampleRows
                      .map((r) => r[header])
                      .filter(Boolean)
                      .slice(0, 2)
                      .join(', ');

                    return (
                      <tr key={header} className="hover:bg-surface-raised/40">
                        <td className="px-4 py-2.5 font-semibold text-text-primary">{header}</td>
                        <td className="px-4 py-2.5 font-mono text-[11px] text-text-secondary truncate max-w-[200px]">
                          {sample || '—'}
                        </td>
                        <td className="px-4 py-2.5">
                          <select
                            value={mapping[header] ?? ''}
                            onChange={(e) => {
                              const val = e.target.value;
                              setMapping((prev) => {
                                const next = { ...prev };
                                if (val) next[header] = val;
                                else delete next[header];
                                return next;
                              });
                            }}
                            className="h-8 rounded border border-border bg-surface px-2 text-xs text-text-primary focus:border-accent"
                          >
                            <option value="">-- Skip (Do not import) --</option>
                            <optgroup label="Standard Fields">
                              {standardFields.map((f) => (
                                <option key={f.key} value={f.key}>
                                  {f.label}
                                </option>
                              ))}
                            </optgroup>
                            {customFields.length > 0 && (
                              <optgroup label="Custom Fields">
                                {customFields.map((cf) => (
                                  <option key={cf.key} value={cf.key}>
                                    {cf.label} ({cf.key})
                                  </option>
                                ))}
                              </optgroup>
                            )}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between border-t border-border pt-4">
              <Button type="button" variant="secondary" onClick={() => setStep(1)}>
                ← Back
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={() => validateMutation.mutate()}
                disabled={validateMutation.isPending}
              >
                {validateMutation.isPending ? 'Validating...' : 'Validate & Preview →'}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Step 3: Dry-Run Validation & Preview */}
      {step === 3 && (
        <Card
          title="Step 3: Dry-Run Validation Results"
          description="Nexus pre-validates each row against schema and custom field rules before writing to the database."
        >
          {activeJobQuery.isLoading || activeJobQuery.data?.status === 'validating' ? (
            <div className="flex flex-col items-center gap-3 py-10">
              <Skeleton className="h-6 w-48" />
              <p className="text-xs text-text-secondary animate-pulse">
                Dry-run validator is analyzing rows in background queue...
              </p>
            </div>
          ) : activeJobQuery.data ? (
            <div className="flex flex-col gap-4">
              {/* Stats Summary */}
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-border bg-surface-raised p-4 text-center">
                  <span className="text-2xl font-bold text-text-primary">
                    {activeJobQuery.data.stats.totalRows?.toLocaleString() ?? '—'}
                  </span>
                  <p className="text-xs text-text-secondary mt-0.5">Total Rows Analyzed</p>
                </div>

                <div className="rounded-lg border border-success/30 bg-success-soft/30 p-4 text-center">
                  <span className="text-2xl font-bold text-success">
                    {activeJobQuery.data.stats.valid?.toLocaleString() ?? 0}
                  </span>
                  <p className="text-xs text-text-secondary mt-0.5">Valid &amp; Ready to Import</p>
                </div>

                <div className="rounded-lg border border-danger/30 bg-danger-soft/30 p-4 text-center">
                  <span className="text-2xl font-bold text-danger">
                    {activeJobQuery.data.stats.invalid?.toLocaleString() ?? 0}
                  </span>
                  <p className="text-xs text-text-secondary mt-0.5">Invalid Rows (Will be skipped)</p>
                </div>
              </div>

              {/* Sample Errors Table */}
              {(activeJobQuery.data.stats.sampleErrors?.length ?? 0) > 0 && (
                <div className="rounded-lg border border-danger/30 bg-danger-soft/10 p-3">
                  <h4 className="text-xs font-semibold text-danger mb-2">
                    Validation Error Samples ({activeJobQuery.data.stats.sampleErrors.length})
                  </h4>
                  <ul className="flex flex-col gap-1 max-h-48 overflow-y-auto text-xs font-mono">
                    {activeJobQuery.data.stats.sampleErrors.map((err, idx) => (
                      <li key={idx} className="rounded bg-surface p-2 border border-border">
                        <span className="font-semibold text-text-primary">Row {err.row}:</span>{' '}
                        <span className="text-danger">{err.error}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="flex items-center justify-between border-t border-border pt-4">
                <Button type="button" variant="secondary" onClick={() => setStep(2)}>
                  ← Adjust Mapping
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => commitMutation.mutate()}
                  disabled={commitMutation.isPending || (activeJobQuery.data.stats.valid ?? 0) === 0}
                >
                  {commitMutation.isPending ? 'Submitting...' : 'Commit Import →'}
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      )}

      {/* Step 4: Import Progress & Completion */}
      {step === 4 && (
        <Card title="Step 4: Import Job Execution" description="Asynchronous import worker status.">
          {activeJobQuery.data?.status === 'importing' ? (
            <div className="flex flex-col items-center gap-4 py-10">
              <div className="h-3 w-full max-w-md rounded-full bg-surface-raised overflow-hidden border border-border">
                <div
                  className="h-full bg-accent transition-all duration-300"
                  style={{
                    width: `${Math.min(
                      Math.round(
                        ((activeJobQuery.data.stats.processed ?? 0) /
                          (activeJobQuery.data.stats.totalRows || 1)) *
                          100,
                      ),
                      100,
                    )}%`,
                  }}
                />
              </div>
              <p className="text-sm font-medium text-text-primary">
                Importing... {activeJobQuery.data.stats.processed?.toLocaleString() ?? 0} of{' '}
                {activeJobQuery.data.stats.totalRows?.toLocaleString() ?? 0} rows processed
              </p>
              <p className="text-xs text-text-secondary">
                You can safely navigate away; a notification will be sent upon completion.
              </p>
            </div>
          ) : activeJobQuery.data?.status === 'completed' ? (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success-soft text-success text-2xl">
                ✓
              </div>
              <h3 className="text-lg font-bold text-text-primary">Import Completed Successfully!</h3>
              <p className="text-xs text-text-secondary max-w-md">
                Successfully created{' '}
                <strong className="text-text-primary font-bold">
                  {activeJobQuery.data.stats.created?.toLocaleString() ?? 0}
                </strong>{' '}
                records in Nexus CRM.
                {activeJobQuery.data.stats.accountsCreated
                  ? ` Automatically created ${activeJobQuery.data.stats.accountsCreated} associated accounts.`
                  : ''}
                {activeJobQuery.data.stats.skipped
                  ? ` Skipped ${activeJobQuery.data.stats.skipped} invalid rows.`
                  : ''}
              </p>
              <div className="mt-4 flex gap-2">
                <Link to={entityType === 'contact' ? '/contacts' : '/accounts'}>
                  <Button variant="primary">
                    View {entityType === 'contact' ? 'Contacts' : 'Accounts'}
                  </Button>
                </Link>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setStep(1);
                    setJobId(null);
                    setUploadedJob(null);
                  }}
                >
                  Import Another File
                </Button>
              </div>
            </div>
          ) : (
            <div className="p-4 text-center text-xs text-danger">
              Import failed: {activeJobQuery.data?.error || 'Unknown error occurred.'}
            </div>
          )}
        </Card>
      )}

      {/* Past Import Jobs Table */}
      <Card
        title="Recent Import Jobs"
        description="History of CSV and VCF imports for this organization."
      >
        {pastJobsQuery.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : !pastJobsQuery.data || pastJobsQuery.data.length === 0 ? (
          <EmptyState title="No prior imports" description="Imported files will appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border text-text-secondary">
                <tr>
                  <th className="py-2.5 font-medium">Job ID</th>
                  <th className="py-2.5 font-medium">Type</th>
                  <th className="py-2.5 font-medium">Status</th>
                  <th className="py-2.5 font-medium">Rows</th>
                  <th className="py-2.5 font-medium">Created</th>
                  <th className="py-2.5 font-medium">Completed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {pastJobsQuery.data.map((job) => (
                  <tr key={job.id} className="hover:bg-surface-raised/40">
                    <td className="py-2.5 font-mono font-medium text-text-primary">
                      {job.id.slice(0, 8)}…
                    </td>
                    <td className="py-2.5 capitalize">{job.entityType}</td>
                    <td className="py-2.5">
                      <Badge
                        tone={
                          job.status === 'completed'
                            ? 'success'
                            : job.status === 'failed' || job.status === 'validation_failed'
                              ? 'danger'
                              : 'warning'
                        }
                      >
                        {job.status}
                      </Badge>
                    </td>
                    <td className="py-2.5 text-text-secondary">
                      {job.stats.created !== null
                        ? `${job.stats.created} imported`
                        : `${job.stats.totalRows ?? '—'} total`}
                    </td>
                    <td className="py-2.5 text-text-secondary">
                      {new Date(job.createdAt).toLocaleDateString()}
                    </td>
                    <td className="py-2.5 text-text-secondary">
                      {job.completedAt ? new Date(job.completedAt).toLocaleTimeString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
