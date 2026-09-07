export type LifecycleStage =
  'lead' | 'mql' | 'sql' | 'opportunity' | 'customer' | 'evangelist' | 'other';

export type CustomFieldType =
  'text' | 'number' | 'date' | 'picklist' | 'multi_select' | 'checkbox' | 'currency' | 'formula';

export interface CustomFieldDef {
  id: string;
  entityType: 'contact' | 'account' | 'lead';
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
  type:
    | 'contact_created'
    | 'contact_updated'
    | 'contact_deleted'
    | 'contact_merged'
    | 'note_added'
    | 'activity_logged'
    | 'comment_added';
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
  status:
    | 'pending'
    | 'validating'
    | 'validated'
    | 'validation_failed'
    | 'importing'
    | 'completed'
    | 'failed';
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

export type DealStatus = 'open' | 'won' | 'lost';

export interface DealStageRef {
  id: string;
  key: string;
  name: string;
  position: number;
  probability: number;
  isClosedWon: boolean;
  isClosedLost: boolean;
}

export interface SerializedDeal {
  id: string;
  pipeline: { id: string; name: string; slug: string };
  stage: DealStageRef;
  account: { id: string; name: string } | null;
  contact: { id: string; name: string; email: string } | null;
  owner: { id: string; name: string } | null;
  ownerId: string | null;
  name: string;
  amount: number;
  currency: string;
  baseCurrency: string;
  baseAmount: number;
  exchangeRate: number;
  exchangeRateDate: string;
  probability: number | null;
  effectiveProbability: number;
  weightedValue: number;
  expectedCloseDate: string | null;
  closeDateStatus: 'overdue' | 'due-soon' | 'on-track' | null;
  status: DealStatus;
  lossReason: string | null;
  closedAt: string | null;
  forecastCategory: 'pipeline' | 'best_case' | 'commit';
  competitor: { id: string; name: string } | null;
  customFields: Record<string, unknown>;
  computedFields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface PipelineWithStages {
  pipeline: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    isDefault: boolean;
  };
  stages: DealStageRef[];
}

export interface ForecastStage {
  stage: { id: string; key: string; name: string; position: number; probability: number };
  dealCount: number;
  totalBaseAmount: number;
  weightedValue: number;
  overdueCount: number;
  overdueBaseAmount: number;
}

export interface ForecastResponse {
  pipeline: { id: string; name: string; slug: string };
  baseCurrency: string;
  stages: ForecastStage[];
  totals: { dealCount: number; totalBaseAmount: number; weightedValue: number };
}

export interface DealLineItem {
  id: string;
  name: string;
  productId: string | null;
  quantity: string;
  unitPrice: string;
  discountRate: string;
  taxRate: string;
  lineTotal: string;
  currency: string;
}

export interface CatalogProduct {
  id: string;
  name: string;
  sku: string | null;
  unitPrice: string;
  currency: string;
  taxRate: string;
  isActive: boolean;
}

export interface SerializedTask {
  id: string;
  owner: { id: string; name: string } | null;
  ownerId: string | null;
  contact: { id: string; name: string } | null;
  account: { id: string; name: string } | null;
  deal: { id: string; name: string } | null;
  title: string;
  description: string | null;
  status: 'open' | 'completed' | 'cancelled';
  priority: 'low' | 'normal' | 'high';
  dueAt: string | null;
  remindAt: string | null;
  reminderSentAt: string | null;
  completedAt: string | null;
  recurrence: { frequency: string; interval: number } | null;
  overdue: boolean;
  reminderDue: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SerializedActivity {
  id: string;
  owner: { id: string; name: string } | null;
  ownerId: string | null;
  contact: { id: string; name: string } | null;
  account: { id: string; name: string } | null;
  deal: { id: string; name: string } | null;
  taskId: string | null;
  type: 'call' | 'meeting' | 'email' | 'task';
  subject: string | null;
  body: string | null;
  occurredAt: string;
  provider: string | null;
  externalId: string | null;
  syncStatus: string;
  conflictFlag: boolean;
  direction: string;
  senderEmail: string | null;
  recipientEmails: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SerializedEmailActivity {
  id: string;
  owner: { id: string; name: string } | null;
  ownerId: string | null;
  contact: { id: string; name: string } | null;
  account: { id: string; name: string } | null;
  deal: { id: string; name: string } | null;
  subject: string | null;
  body: string | null;
  occurredAt: string;
  direction: string;
  senderEmail: string | null;
  recipientEmails: string[];
  provider: string | null;
  externalId: string | null;
  syncStatus: string;
  createdAt: string;
  updatedAt: string;
}

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export type CommentEntityType = 'contact' | 'deal' | 'task';

export interface SerializedComment {
  id: string;
  author: { id: string; name: string } | null;
  authorId: string | null;
  entityType: CommentEntityType;
  entityId: string;
  body: string;
  mentionedUsers: Array<{ id: string; name: string; email: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface SerializedAttachment {
  id: string;
  owner: { id: string; name: string } | null;
  ownerId: string | null;
  entityType: CommentEntityType;
  entityId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
}

export type LeadStatus = 'new' | 'contacted' | 'qualified' | 'unqualified' | 'converted';
export type LeadSource = 'website' | 'referral' | 'event' | 'outbound' | 'campaign' | 'other';

export interface SerializedLead {
  id: string;
  ownerId: string | null;
  owner: { id: string; name: string } | null;
  name: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  phone: string | null;
  company: string | null;
  title: string | null;
  status: LeadStatus;
  source: LeadSource;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  referrerUrl: string | null;
  notes: string | null;
  customFields: Record<string, unknown>;
  computedFields: Record<string, unknown>;
  convertedAt: string | null;
  convertedContactId: string | null;
  convertedAccountId: string | null;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface LeadAssignmentLog {
  id: string;
  leadId: string;
  ruleId: string | null;
  assignedToUserId: string;
  assignedToUser?: { id: string; name: string; email: string } | null;
  previousUserId: string | null;
  previousUser?: { id: string; name: string; email: string } | null;
  reason: string | null;
  createdAt: string;
}

export interface RoutingMember {
  id: string;
  userId: string;
  user: { id: string; name: string; email: string } | null;
  orderIndex: number;
  isActive: boolean;
}

export interface RoutingRule {
  id: string;
  name: string;
  strategy: 'round_robin' | 'manual';
  isActive: boolean;
  fallbackUserId: string | null;
  fallbackUser: { id: string; name: string; email: string } | null;
  lastAssignedIndex: number;
  members: RoutingMember[];
  createdAt: string;
  updatedAt: string;
}

export interface RepAvailability {
  userId: string;
  isAvailable: boolean;
  oooReason: string | null;
  returnAt: string | null;
}

export interface AppNotification {
  id: string;
  orgId: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface WebToLeadSnippetResponse {
  orgId?: string;
  slug?: string;
  endpoint?: string;
  html?: string;
  tenantToken?: string;
  formHtml?: string;
  endpointUrl?: string;
  fields?: string[];
}
