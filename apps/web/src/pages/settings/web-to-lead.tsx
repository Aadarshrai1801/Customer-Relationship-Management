import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { api, API_URL } from '../../lib/api';
import { useAuth } from '../../lib/providers';
import type { WebToLeadSnippetResponse } from '../../lib/crm-types';
import { Button, Card, Field, Input } from '../../components/ui';
import { useToast } from '../../components/toast';

export function WebToLeadPage(): React.JSX.Element {
  const { org } = useAuth();
  const { notify } = useToast();

  const [testName, setTestName] = useState('Jane Prospect');
  const [testEmail, setTestEmail] = useState('jane@example.com');
  const [testPhone, setTestPhone] = useState('+1 (555) 234-5678');
  const [testCompany, setTestCompany] = useState('Acme Ventures');
  const [testNotes, setTestNotes] = useState('Inbound inquiry from marketing website.');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    leadId?: string;
    deduplicated?: boolean;
    error?: string;
  } | null>(null);

  // Query embed snippet from backend
  const snippetQuery = useQuery({
    queryKey: ['web-to-lead-snippet'],
    queryFn: () => api<WebToLeadSnippetResponse>('/web-to-lead/snippet'),
  });

  const tenantToken = snippetQuery.data?.slug || snippetQuery.data?.tenantToken || org?.slug || '';
  const endpointUrl =
    snippetQuery.data?.endpoint || snippetQuery.data?.endpointUrl || `${API_URL}/v1/web-to-lead`;
  const snippetHtml = snippetQuery.data?.html || snippetQuery.data?.formHtml || '';

  const copyToClipboard = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify('success', `${label} copied to clipboard!`);
    } catch {
      notify('error', 'Failed to copy to clipboard');
    }
  };

  const handleTestSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setTestResult(null);

    try {
      const response = await fetch(`${API_URL}/v1/web-to-lead`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-nexus-tenant-token': tenantToken,
        },
        body: JSON.stringify({
          token: tenantToken,
          name: testName,
          email: testEmail,
          phone: testPhone,
          company: testCompany,
          notes: testNotes,
          source: 'website',
          utmSource: 'web-settings-test',
          utmMedium: 'in-app-console',
        }),
      });

      const json = await response.json();
      if (!response.ok) {
        setTestResult({
          success: false,
          error: json.message || 'Submission failed',
        });
        notify('error', json.message || 'Failed to submit lead');
      } else {
        setTestResult({
          success: true,
          leadId: json.leadId,
          deduplicated: json.deduplicated,
        });
        notify(
          'success',
          json.deduplicated
            ? 'Test lead ingested (Deduplicated within 5m window)'
            : 'Test lead ingested successfully!',
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Network error';
      setTestResult({ success: false, error: msg });
      notify('error', msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-text-primary">
          Web-to-Lead Ingestion
        </h1>
        <p className="mt-1 text-xs text-text-secondary">
          Embed lightweight, anti-spam HTML lead capture forms on any external website or landing page.
        </p>
      </div>

      {/* Tenant Token Card */}
      <Card
        title="Public Tenant Token"
        description="Public identifier used to route inbound submissions to your organization"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded bg-surface-raised p-3 border border-border">
          <div>
            <span className="text-[11px] uppercase tracking-wider text-text-secondary font-semibold block">
              Tenant Token / Slug
            </span>
            <span className="font-mono text-sm font-semibold text-accent">{tenantToken}</span>
          </div>
          <Button
            variant="secondary"
            onClick={() => void copyToClipboard(tenantToken, 'Tenant Token')}
            className="text-xs h-8 px-3"
          >
            Copy Token
          </Button>
        </div>
      </Card>

      {/* Embed Code Snippet Card */}
      <Card
        title="Embeddable HTML Form Snippet"
        description="Copy and paste this HTML code directly into your landing page or CMS"
        actions={
          <Button
            variant="primary"
            onClick={() => void copyToClipboard(snippetHtml, 'Embed Code')}
            className="text-xs h-8 px-3"
          >
            Copy HTML Code
          </Button>
        }
      >
        <div className="flex flex-col gap-3">
          <div className="rounded-lg bg-surface-sunken p-4 font-mono text-xs overflow-x-auto border border-border/80 text-text-primary">
            <pre className="whitespace-pre">{snippetHtml || 'Loading embed snippet...'}</pre>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs text-text-secondary">
            <div className="rounded border border-border/60 bg-surface-raised/40 p-3">
              <span className="font-semibold text-text-primary block mb-1">🛡️ Anti-Spam Honeypot</span>
              <p>
                Includes a hidden <code>name=&quot;_hp&quot;</code> input. Automated bots filling all inputs
                are silently rejected without spamming your database.
              </p>
            </div>
            <div className="rounded border border-border/60 bg-surface-raised/40 p-3">
              <span className="font-semibold text-text-primary block mb-1">📊 UTM Analytics Capture</span>
              <p>
                Automatically extracts <code>utm_source</code>, <code>utm_medium</code>, and <code>utm_campaign</code> from query parameters or hidden inputs.
              </p>
            </div>
          </div>
        </div>
      </Card>

      {/* Interactive Testing Form */}
      <Card
        title="Live Ingestion Testing Console"
        description="Test web-to-lead submission directly against the active backend API"
      >
        <form onSubmit={handleTestSubmit} className="flex flex-col gap-4 max-w-xl">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Full Name" htmlFor="testName">
              <Input
                id="testName"
                value={testName}
                onChange={(e) => setTestName(e.target.value)}
                required
              />
            </Field>
            <Field label="Email" htmlFor="testEmail">
              <Input
                id="testEmail"
                type="email"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                required
              />
            </Field>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Phone" htmlFor="testPhone">
              <Input
                id="testPhone"
                value={testPhone}
                onChange={(e) => setTestPhone(e.target.value)}
              />
            </Field>
            <Field label="Company" htmlFor="testCompany">
              <Input
                id="testCompany"
                value={testCompany}
                onChange={(e) => setTestCompany(e.target.value)}
              />
            </Field>
          </div>

          <Field label="Notes / Message" htmlFor="testNotes">
            <Input
              id="testNotes"
              value={testNotes}
              onChange={(e) => setTestNotes(e.target.value)}
            />
          </Field>

          <div className="flex items-center justify-between pt-2">
            <Button type="submit" variant="primary" disabled={isSubmitting}>
              {isSubmitting ? 'Submitting...' : 'Submit Test Lead'}
            </Button>
            <span className="text-[11px] text-text-secondary">
              POST {endpointUrl}
            </span>
          </div>

          {testResult && (
            <div
              className={`rounded-lg p-3 text-xs border ${
                testResult.success
                  ? 'border-success-soft bg-success-soft/30 text-text-primary'
                  : 'border-danger-soft bg-danger-soft/20 text-danger'
              }`}
            >
              {testResult.success ? (
                <div className="flex items-center justify-between">
                  <span>
                    ✓ <strong>Success!</strong> Lead ingested.{' '}
                    {testResult.deduplicated && '(Deduplication applied: returned existing lead)'}
                  </span>
                  {testResult.leadId && (
                    <Link
                      to="/leads/$id"
                      params={{ id: testResult.leadId }}
                      className="text-accent font-semibold hover:underline ml-2"
                    >
                      View Lead →
                    </Link>
                  )}
                </div>
              ) : (
                <span>Error: {testResult.error}</span>
              )}
            </div>
          )}
        </form>
      </Card>
    </div>
  );
}
