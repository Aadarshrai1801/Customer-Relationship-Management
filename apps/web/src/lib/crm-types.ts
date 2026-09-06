export type LifecycleStage =
  | 'lead'
  | 'mql'
  | 'sql'
  | 'opportunity'
  | 'customer'
  | 'evangelist'
  | 'other';

export type CustomFieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'picklist'
  | 'multi_select'
  | 'checkbox'
  | 'currency'
  | 'formula';

export interface CustomFieldDef {
  id: string;
  entityType: 'contact' | 'account';
  key: string;
  label: string;
  type: CustomFieldType;
  required: boolean;
  options: Record<string, unknown>;
}

export interface ContactWarning {
  code: 'DUPLICATE_EMAIL' | 'POSSIBLE_DUPLICATE';
  message: string;
  contactIds: string[];
  confidence?: 'exact' | 'high' | 'medium';
}

export interface SerializedContact {
  id: string;
  accountId: string | null;
  account: { id: string; name: string } | null;
  ownerId: string | null;
  owner: { id: string; name: string } | null;
  name: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  phone: string | null;
  title: string | null;
  lifecycleStage: LifecycleStage;
  tags: string[];
  customFields: Record<string, unknown>;
  computedFields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface SerializedAccount {
  id: string;
  name: string;
  website: string | null;
  domains: string[];
  phone: string | null;
  industry: string | null;
  parentId: string | null;
  parent: { id: string; name: string } | null;
  children: Array<{ id: string; name: string }>;
  contactCount: number;
  ownerId: string | null;
  owner: { id: string; name: string } | null;
  tags: string[];
  customFields: Record<string, unknown>;
  computedFields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface ContactNote {
  id: string;
  contactId: string;
  author: { id: string; name: string } | null;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineItem {
  id: string;
  type: 'contact_created' | 'contact_updated' | 'contact_deleted' | 'contact_merged' | 'note_added';
  occurredAt: string;
  actor: { id: string | null; email: string | null };
  summary: string;
  data: Record<string, unknown>;
}

export interface MergeFieldComparison {
  field: string;
  winner: unknown;
  loser: unknown;
  conflict: boolean;
}

export interface MergePreview {
  winnerId: string;
  loserId: string;
  fields: MergeFieldComparison[];
  tags: { winner: string[]; loser: string[]; merged: string[] };
  notesMoved?: number;
  contactsMoved?: number;
  childrenMoved?: number;
  domains?: { winner: string[]; loser: string[]; merged: string[] };
}

export interface CandidateRecord {
  id: string;
  name: string;
  email: string | null;
  ownerId: string | null;
}

export interface DuplicateCandidate {
  id: string;
  entityType: 'contact' | 'account';
  confidence: 'exact' | 'high' | 'medium';
  signals: Record<string, unknown>;
  status: 'pending' | 'dismissed' | 'merged';
  createdAt: string;
  records: [CandidateRecord, CandidateRecord];
}

export interface ImportJobStats {
  totalRows: number | null;
  valid: number | null;
  invalid: number | null;
  created: number | null;
  skipped: number | null;
  failed: number | null;
  processed: number | null;
  accountsCreated: number | null;
  sampleErrors: Array<{ row: number; error: string }>;
}

export interface ImportJobDetail {
  id: string;
  entityType: 'contact' | 'account';
  status: 'pending' | 'validating' | 'validated' | 'validation_failed' | 'importing' | 'completed' | 'failed';
  mapping: Record<string, string>;
  stats: ImportJobStats;
  error?: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface UploadResponse {
  id: string;
  entityType: 'contact' | 'account';
  status: string;
  headers: string[];
  totalRows: number;
  sampleRows: Array<Record<string, string>>;
  suggestedMapping: Record<string, string>;
}
