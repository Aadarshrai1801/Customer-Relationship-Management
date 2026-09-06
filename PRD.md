# Product Requirements Document: Nexus CRM

**Document Owner:** Product Management
**Status:** Draft for Engineering / Design / QA Review
**Version:** 1.0

---

## 1. Executive Summary

### 1.1 Product Vision & Mission

**Vision:** To become the CRM that revenue teams actually want to use — one that adapts to how sales, marketing, and success teams already work instead of forcing them into rigid, configuration-heavy workflows.

**Mission Statement:** Nexus CRM eliminates the trade-off between "powerful" and "usable" in the CRM market. We give growing B2B companies (50–2,000 employees) enterprise-grade pipeline, automation, and reporting capabilities, wrapped in an interface fast enough and clean enough that reps update it without being told to.

### 1.2 Target Market & ICP

| Attribute | Definition |
| --- | --- |
| Company size | 50–2,000 employees (SMB to lower mid-market) |
| Industry | B2B SaaS, professional services, agencies, tech-enabled services |
| Buying team | VP Sales / RevOps Lead (economic buyer), Sales Managers (champions), Sales Ops/IT (technical evaluator) |
| Current tooling | Migrating from spreadsheets, HubSpot Starter/Pro, Pipedrive, or a mis-configured Salesforce org |
| Sales motion | Inside sales / inbound-led, deal cycles of 2 weeks–6 months, ACV $5K–$150K |
| Pain signals | "Our reps don't log activity," "Salesforce is too expensive/complex for our team," "We've outgrown spreadsheets/Pipedrive" |

**Secondary market:** Mid-market companies (500–2,000 employees) that have outgrown Pipedrive/HubSpot but find Salesforce too costly or slow to implement.

### 1.3 Key Differentiators vs. Competitors

| Dimension | Salesforce | HubSpot | Zoho | Pipedrive | **Nexus CRM** |
| --- | --- | --- | --- | --- | --- |
| Time to first value | Weeks–months (heavy config/consultants) | Days–weeks | Days–weeks | Days | **Under 1 day** — guided setup, smart defaults, pre-built pipelines |
| UI/UX modernity | Dated, cluttered (Lightning) | Good, but bloated with marketing upsells | Inconsistent across modules | Clean, but limited depth | **Best-in-class**: command palette, inline editing, no modal fatigue |
| Pricing transparency | Opaque, requires sales call | Tiered, marketing-hub upsell heavy | Cheap but fragmented | Simple, but caps at low feature ceiling | **Transparent, usage-based seats**, no "contact tier" tax |
| AI depth | Add-on (Einstein, extra cost) | Add-on (Breeze) | Basic | Minimal | **Native, included in core tiers**: next-best-action, AI summaries, natural-language query |
| Customization | Extremely deep, requires admin/dev | Moderate | Deep but clunky | Shallow | **Deep but no-code-first**: custom objects without Apex/dev resources |
| Admin overhead | Requires dedicated Salesforce admin | Moderate | Moderate | Low | **Low** — self-serve config, guided migrations |

**Core differentiators:**

1. **Speed of adoption** — reps are productive on day one, not after a 6-week rollout.
2. **Native AI woven into daily workflow**, not bolted on as a paid add-on.
3. **No-code customization** that doesn't require a certified admin or developer.
4. **Transparent, predictable pricing** with no per-feature upsell maze.

### 1.4 Success Metrics

**North Star Metric:** *Weekly Active Pipeline Updates per Seat* — the number of meaningful deal/contact updates (stage change, note, logged activity) per licensed seat per week. This proxies genuine adoption over vanity login metrics.

**Supporting KPIs:**

- Activation rate: % of new orgs that complete first pipeline + first deal within 3 days of signup
- Time-to-first-value (TTFV): median hours from signup to first deal created
- 90-day logo retention rate
- Net Revenue Retention (NRR)
- Feature adoption rate (automation, email sync, reporting) within 30 days
- NPS (target ≥ 40 by end of Year 1)

---

## 2. Goals & Non-Goals

### 2.1 Phased Scope

| Phase | Scope Summary | Target Timeframe |
| --- | --- | --- |
| **V1 (MVP)** | Core CRM: contacts/accounts, pipeline/deals, tasks/activities, basic email sync, basic reporting, RBAC | Months 0–4 |
| **V2** | Marketing features, automation/workflow builder, advanced reporting, integrations marketplace, mobile apps | Months 5–9 |
| **V3** | AI/intelligent features, conversation intelligence, predictive scoring, advanced customization (custom objects), post-sale/support module | Months 10–15 |

### 2.2 Explicit Non-Goals (V1–V2)

- **Not building a full marketing automation suite** to rival HubSpot Marketing Hub or Marketo (only lightweight campaign/segmentation tools ship in V2).
- **Not building a full helpdesk/ticketing system** — post-sale module (V3) covers health scoring and renewals, not a Zendesk replacement.
- **Not supporting on-premise deployment** — Nexus is cloud-only (multi-tenant SaaS).
- **Not building native accounting/invoicing** — we integrate with Stripe/QuickBooks rather than replacing them.
- **Not targeting enterprise (5,000+ employee) complex multi-org/multi-currency conglomerates** in V1–V2; that requires a dedicated enterprise architecture workstream, deferred to a future roadmap decision.

### 2.3 Business Objectives per Goal

| Goal | Business Objective |
| --- | --- |
| Ship V1 core CRM in 4 months | Enable early design-partner revenue and product-market-fit validation before Series A metrics review |
| Achieve <1 day TTFV | Reduce sales-assisted onboarding cost, enable PLG (product-led growth) self-serve signups |
| Native AI in V3 | Justify premium tier pricing and defensibility against low-cost competitors (Pipedrive, Zoho) |
| Marketplace/integrations in V2 | Reduce churn from "missing integration" as a stated cancellation reason |

---

## 3. User Personas

### 3.1 Sales Rep (Individual Contributor) — "Maya"

- **Goals:** Hit quota with minimum admin overhead; know exactly what to do next each day.
- **Pain points:** Manually logging emails/calls; switching between 4 tabs to find contact history; being asked by managers for pipeline updates via Slack.
- **JTBD:** "When I start my day, I want to see my prioritized task list and hot deals, so I can focus on selling instead of searching for information."

### 3.2 Sales Manager / Team Lead — "David"

- **Goals:** Accurate forecasting, visibility into rep activity, coaching underperformers early.
- **Pain points:** Forecast calls based on "gut feel" from reps because CRM data is stale; no early warning on stalled deals; manual spreadsheet roll-ups for QBRs.
- **JTBD:** "When I prepare for my Monday pipeline review, I want an accurate, real-time view of deal health and rep activity, so I can coach my team before deals slip."

### 3.3 Marketing Manager — "Priya"

- **Goals:** Prove marketing's contribution to pipeline; run targeted campaigns to the right segments.
- **Pain points:** Lead data is siloed from marketing platform; poor attribution from campaign to closed revenue; manual list exports/imports.
- **JTBD:** "When I launch a campaign, I want to see which leads convert to pipeline and revenue, so I can prove ROI and double down on what works."

### 3.4 Customer Success Manager — "Elena"

- **Goals:** Prevent churn, identify upsell opportunities, manage renewals proactively.
- **Pain points:** No visibility into original deal context/promises made by sales; renewal dates tracked in a separate spreadsheet; reactive instead of proactive on health.
- **JTBD:** "When a customer's usage drops, I want to be alerted automatically with full account context, so I can intervene before they churn."

### 3.5 System Administrator / RevOps — "Tom"

- **Goals:** Keep data clean, enforce process compliance, minimize support tickets, ensure security/compliance.
- **Pain points:** Duplicate records pile up; reps bypass required fields; no audit trail when data changes unexpectedly; complex permission requests take hours to configure.
- **JTBD:** "When leadership asks for a new reporting field or process change, I want to configure it myself without engineering or a support ticket, so I can respond same-day."

---

## 4. Core Feature Set

Priority legend: **P0** = MVP-blocking, **P1** = Phase 2, **P2** = Phase 3 / stretch.

### 4.1 Contact & Account Management

| Feature | Priority |
| --- | --- |
| Contact records w/ custom fields, tags, lifecycle stages | P0 |
| Company/account hierarchy (parent-child) | P1 |
| Duplicate detection & merging | P0 |
| Contact enrichment (auto-fill from email/public data) | P1 |
| Relationship mapping (org charts) | P2 |
| Unified activity timeline per contact | P0 |
| Contact scoring/health score | P1 |
| Import/export (CSV, VCF, bulk ops) | P0 |
| Data validation rules | P0 |

**User Story (Contact Records):** As a Sales Rep, I want to create and view a contact record with custom fields so that I can capture role-specific information relevant to my sales process.

**Acceptance Criteria:**

- [ ] User can create a contact with required fields (name, email) and any org-defined custom fields
- [ ] Duplicate email addresses trigger a warning before save, not a hard block
- [ ] Contact record displays a merged, reverse-chronological timeline of emails, calls, notes, tasks, and deal stage changes
- [ ] Custom fields support types: text, number, date, picklist, multi-select, checkbox, currency, formula
- [ ] Bulk CSV import supports field mapping, preview, and dry-run validation before commit

**Edge Cases:**

- Importing a CSV with 50,000+ rows must not block the UI (async job with progress + email notification on completion)
- Merging two contacts with conflicting field values must let the user choose which value wins per field, not just take the "primary" record blindly
- Deleting a contact with an open deal must warn the user and require confirmation

**Duplicate Detection & Merging — User Story:** As a RevOps admin, I want the system to flag likely duplicate contacts/accounts (fuzzy match on name, email domain, phone) so that reps don't create fragmented records.

**Acceptance Criteria:**

- [ ] Matching runs on create and via a nightly batch job across existing records
- [ ] Match confidence score (exact/high/medium) is shown to the user
- [ ] Merge preserves all activity history from both records
- [ ] Merge action is logged in the audit trail with before/after snapshot

### 4.2 Lead Management

| Feature | Priority |
| --- | --- |
| Lead capture (forms, web-to-lead, API, chatbot, email parsing) | P0 (forms/API) / P1 (chatbot/email parsing) |
| Lead scoring (rule-based) | P1 |
| Lead scoring (predictive/AI) | P2 |
| Lead assignment (round robin, territory, weighted, manual) | P0 (manual, round robin) / P1 (territory, weighted) |
| Lead qualification workflow (MQL → SQL) | P1 |
| Lead source tracking & attribution | P0 |
| Duplicate lead prevention | P0 |

**User Story:** As a Sales Manager, I want inbound leads automatically assigned via round robin so my team gets an even distribution without manual triage.

**Acceptance Criteria:**

- [ ] Round robin respects rep availability (PTO/out-of-office status excludes a rep from rotation)
- [ ] Assignment triggers a notification (in-app + email) to the assigned rep within 60 seconds of lead creation
- [ ] Admins can view and manually override assignment history
- [ ] Territory-based assignment matches on configurable rules (geography, company size, industry)

**Edge Cases:**

- A lead submitted twice within 5 minutes from the same email should not create duplicate lead records or double-notify reps
- If all reps in a rotation are marked unavailable, lead routes to a fallback queue and alerts the manager

### 4.3 Sales Pipeline & Deal Management

| Feature | Priority |
| --- | --- |
| Multiple customizable pipelines | P0 |
| Kanban drag-and-drop stages | P0 |
| Deal probability & forecasting | P0 |
| Weighted pipeline value | P0 |
| Deal rot/stagnation alerts | P1 |
| Multi-currency support | P1 |
| Products/line items (qty, discount, tax) | P0 |
| Quote generation & e-signature integration | P1 |
| Win/loss reason tracking | P0 |
| Competitor tracking on deals | P1 |

**User Story:** As a Sales Rep, I want to drag a deal card between pipeline stages so I can update deal status without opening a form.

**Acceptance Criteria:**

- [ ] Drag-and-drop update persists optimistically (UI updates instantly, syncs in background, rolls back with a toast on failure)
- [ ] Moving a deal to "Closed Won" prompts for products/line items if none exist, but does not hard-block the stage change
- [ ] Moving a deal to "Closed Lost" requires a loss reason (configurable required field)
- [ ] Pipeline view shows sum of deal values and weighted value per stage in the column header

**Deal Rot/Stagnation — Acceptance Criteria:**

- [ ] Deals with no activity logged for a configurable threshold (default 14 days) are visually flagged (e.g., amber border) on the Kanban board
- [ ] Manager dashboard surfaces a "stalled deals" widget, sortable by days inactive

**Edge Cases:**

- Changing a pipeline's stage configuration after deals already exist in the "removed" stage must migrate those deals to a mapped stage, not silently orphan them
- Multi-currency deals must store both the transaction currency and a converted value in the org's base currency for consistent reporting (using a daily exchange rate snapshot, not live rates, to avoid retroactive report drift)

### 4.4 Task & Activity Management

| Feature | Priority |
| --- | --- |
| Tasks, calls, meetings, notes, emails as activity types | P0 |
| Recurring tasks | P1 |
| Task reminders & overdue notifications | P0 |
| Calendar sync (Google/Outlook, 2-way) | P0 |
| Meeting scheduler (booking links) | P1 |
| Call logging w/ click-to-dial & recording | P1 |
| Activity SLA tracking | P2 |

**User Story:** As a Sales Rep, I want my Google Calendar to sync two-way with Nexus so that meetings booked externally show up on the contact's timeline automatically.

**Acceptance Criteria:**

- [ ] Calendar events with an attendee email matching a CRM contact auto-log as an activity on that contact/deal
- [ ] Deleting an event in Google Calendar reflects as cancelled (not deleted) in Nexus, preserving the activity record
- [ ] Sync conflicts (edited in both systems simultaneously) favor the most recently modified version and flag the conflict to the user

**Edge Cases:**

- Recurring task series edits must ask "this event only / all future events" like standard calendar UX
- Overdue task notifications must not spam — batch into a daily digest after the first same-day alert

### 4.5 Email Integration

| Feature | Priority |
| --- | --- |
| Two-way email sync (Gmail/Outlook) | P0 |
| Email templates & snippets | P0 |
| Email tracking (opens, clicks, reply detection) | P1 |
| Sequences/cadences | P1 |
| Shared team inbox | P2 |
| Email-to-CRM auto-logging | P0 |

**User Story:** As a Sales Rep, I want emails I send to a known contact automatically logged to their timeline so I don't have to BCC or manually attach them.

**Acceptance Criteria:**

- [ ] Auto-logging matches on recipient email address against existing contacts
- [ ] Emails to/from unrecognized addresses prompt "log as new contact?" rather than being silently dropped
- [ ] Email tracking pixel respects recipient privacy settings and complies with Apple Mail Privacy Protection limitations (documented as a known accuracy caveat, not silently misreported)

**Edge Cases:**

- BCC-based logging (fallback for orgs that don't want full mailbox sync) must de-duplicate against native-synced emails to avoid double-logging
- Sequence steps must auto-pause if a reply is detected mid-sequence

### 4.6 Marketing Features (V2)

| Feature | Priority |
| --- | --- |
| Campaign management | P1 |
| Landing page / form builder | P1 |
| Marketing automation (drip, triggers) | P1 |
| Segmentation & dynamic lists | P1 |
| A/B testing | P2 |
| UTM tracking & attribution reporting | P1 |

**Acceptance Criteria (Segmentation):**

- [ ] Dynamic lists auto-update membership as records change (e.g., "all contacts in Trial status" removes a contact automatically upon conversion)
- [ ] Segment builder supports AND/OR nested logic groups, not just a flat filter list

### 4.7 Customer Support / Post-Sale (V3)

| Feature | Priority |
| --- | --- |
| Ticket/case management basics | P2 |
| Customer health scoring | P1 |
| Renewal & upsell tracking | P1 |
| NPS/CSAT surveys | P2 |

**Acceptance Criteria (Health Scoring):**

- [ ] Health score is a configurable weighted formula (e.g., usage frequency, support ticket volume, NPS response, renewal proximity)
- [ ] Score changes trigger configurable alerts to the assigned CSM
- [ ] Score history is graphed over time on the account record, not just shown as a current snapshot

### 4.8 Reporting & Analytics

| Feature | Priority |
| --- | --- |
| Customizable dashboards | P0 |
| Standard reports (pipeline, forecast, activity, conversion) | P0 |
| Custom report builder | P1 |
| Goal tracking (quotas) | P1 |
| Cohort & trend analysis | P2 |
| Export to PDF/Excel, scheduled emails | P1 |

**User Story:** As a Sales Manager, I want a real-time forecast report broken down by rep and stage so I can identify who is behind pace before the end of the quarter.

**Acceptance Criteria:**

- [ ] Forecast report supports "commit / best case / pipeline" categorization per deal, editable by the rep or manager
- [ ] Dashboard widgets refresh on a configurable interval (default: real-time on view, cached for 5 min under high load)
- [ ] Report export to PDF preserves chart formatting, not just raw data tables

### 4.9 Automation & Workflows

| Feature | Priority |
| --- | --- |
| Visual workflow builder (trigger → condition → action) | P1 |
| Approval processes | P1 |
| Auto-assignment rules | P0 (basic) / P1 (advanced) |
| Data enrichment automations | P2 |
| Webhooks & API triggers | P1 |

**Acceptance Criteria (Workflow Builder):**

- [ ] Supports triggers: record created, field changed, stage changed, time-based (e.g., "3 days after created")
- [ ] Supports actions: update field, send email, create task, send Slack notification, call webhook
- [ ] Workflow execution log is visible per workflow, showing success/failure per run for debugging
- [ ] Infinite loop protection: a workflow cannot trigger itself more than N times (configurable, default 5) in a single cascade

### 4.10 AI/Intelligent Features (V3)

| Feature | Priority |
| --- | --- |
| AI-generated deal summaries & next-best-action | P2 |
| Conversation intelligence (call transcription/sentiment) | P2 |
| Predictive lead/deal scoring | P2 |
| Auto-drafted email replies | P2 |
| Natural language search/query | P2 |

**User Story:** As a Sales Rep, I want an AI-generated summary of a deal's history when I open it after time away so I can quickly re-orient without reading every note.

**Acceptance Criteria:**

- [ ] Summary regenerates when new significant activity is logged (not on every page view, to control cost)
- [ ] Summary clearly labeled as AI-generated with a "view source activities" link for verification
- [ ] Natural language query ("deals closing this month over $10k") maps to the structured filter UI and shows the equivalent filter so users can learn the underlying query model

**Edge Cases:**

- AI features must degrade gracefully (clear error state, not a blank screen) if the underlying model API is unavailable
- Sentiment analysis on calls must flag low-confidence transcriptions rather than presenting a guess as fact

### 4.11 Customization & Configuration

| Feature | Priority |
| --- | --- |
| Custom fields, objects, layouts | P0 (fields/layouts) / P2 (custom objects) |
| No-code object builder | P2 |
| Page layout editor per role/profile | P1 |
| Custom picklists, formulas, validation rules | P1 |

**Acceptance Criteria:**

- [ ] Custom field changes (type change, deletion) show impact analysis before applying (e.g., "12 records will lose data if you change this field type")
- [ ] Formula fields support cross-object references within a documented complexity limit to avoid runaway compute cost

### 4.12 Permissions, Roles & Security

| Feature | Priority |
| --- | --- |
| Role-based access control | P0 |
| Field-level and record-level permissions | P0 |
| Territory management | P1 |
| SSO (SAML/OAuth), 2FA | P0 |
| Audit logs | P0 |
| Data encryption, GDPR/CCPA tooling | P0 |

**Acceptance Criteria:**

- [ ] SSO supports SAML 2.0 and OAuth 2.0 (Okta, Azure AD, Google Workspace as launch IdPs)
- [ ] Audit log captures: who, what changed, old value, new value, timestamp, IP address — retained minimum 12 months
- [ ] GDPR data export request completes and delivers a downloadable package within 72 hours (self-serve, not requiring a support ticket)
- [ ] Field-level permissions are enforced consistently across UI, API, and reporting layer — no back-door exposure via reports

### 4.13 Collaboration

| Feature | Priority |
| --- | --- |
| @mentions and internal comments | P0 |
| Shared notes | P0 |
| Team feed/activity stream | P1 |
| File attachments & document storage | P0 |

**Acceptance Criteria:**

- [ ] @mention triggers an in-app + email notification to the mentioned user
- [ ] File attachments support drag-and-drop, with a configurable per-org storage cap and per-file size limit (default 25MB)

### 4.14 Integrations & Ecosystem

| Feature | Priority |
| --- | --- |
| Native integrations (Slack, Zoom, Gmail, Outlook, Stripe, Zapier, DocuSign) | P1 |
| Public REST API + webhooks | P0 |
| Marketplace for third-party apps | P2 |
| Mobile apps (iOS/Android) w/ offline mode | P1 |

**Acceptance Criteria:**

- [ ] Public API is versioned (e.g., `/v1/`) with documented deprecation policy (minimum 6 months notice before sunset)
- [ ] API rate limits are clearly communicated in response headers (`X-RateLimit-Remaining`, etc.)
- [ ] Mobile offline mode queues writes locally and syncs on reconnect, with conflict resolution surfaced to the user, not silently overwritten

### 4.15 Onboarding & Admin

| Feature | Priority |
| --- | --- |
| Guided setup wizard | P0 |
| Data migration tools (import from other CRMs) | P0 |
| In-app product tours/tooltips | P1 |
| Admin panel for org-wide settings | P0 |
| Billing & subscription management | P0 |

**Acceptance Criteria:**

- [ ] Setup wizard gets a new org from signup to first configured pipeline in under 10 minutes
- [ ] Migration tool provides field-mapping templates for common source systems (HubSpot, Pipedrive, Salesforce CSV export)
- [ ] Self-serve billing supports seat add/remove with prorated billing, visible before confirmation (no surprise charges)

### 4.16 Notifications

| Feature | Priority |
| --- | --- |
| In-app, email, push, Slack notifications | P0 (in-app/email) / P1 (push/Slack) |
| Notification preference center | P1 |
| Digest emails (daily/weekly) | P1 |

**Acceptance Criteria:**

- [ ] Users can configure per-notification-type channel preference (e.g., "task overdue" → email only, "@mention" → push + in-app)
- [ ] Digest email is skipped entirely if there is no relevant activity, rather than sending an empty digest

---

## 5. UI/UX Requirements

### 5.1 Design Principles

Clean, minimal, data-dense without clutter. Information hierarchy prioritizes the next action over decorative elements. Every screen should answer "what do I do next?" within 3 seconds of load.

### 5.2 Navigation

- Persistent left sidebar (collapsible) with primary objects: Home, Contacts, Accounts, Deals, Tasks, Reports, Marketing (V2)
- Global command palette (Cmd+K / Ctrl+K) for navigation, record search, and quick actions ("create deal," "log call")
- Breadcrumbs on all nested detail views

### 5.3 Visual & Interaction Standards

- **Dark mode**: full parity with light mode, not an afterthought theme
- **Responsive**: desktop-first, with adaptive tablet layout and a simplified mobile web view (full functionality reserved for native apps)
- **Inline editing**: click-to-edit on record fields; no modal required for single-field updates
- **Empty states**: every list/dashboard view has a designed empty state with a clear CTA, not a blank white screen
- **Optimistic UI**: state-changing actions (drag-drop, field edits) reflect instantly, with rollback + toast on server rejection
- **Skeleton loading states** for all async content loads over 300ms

### 5.4 Design System Tokens

| Token Category | Specification |
| --- | --- |
| Spacing scale | 4px base unit: 4, 8, 12, 16, 24, 32, 48, 64px |
| Typography scale | 12/14/16/20/24/32/40px, single type family (variable font for weight range) |
| Color — semantic naming | `--color-surface`, `--color-surface-raised`, `--color-border`, `--color-text-primary`, `--color-text-secondary`, `--color-accent`, `--color-success`, `--color-warning`, `--color-danger` |
| Border radius | 4px (inputs/buttons), 8px (cards), 12px (modals) |
| Elevation | 3-tier shadow system (subtle, medium, prominent) |

### 5.5 Accessibility

WCAG 2.1 AA compliance across all core flows: keyboard navigability, screen-reader labels on icon-only buttons, minimum 4.5:1 contrast ratio for body text, focus-visible states on all interactive elements.

### 5.6 Onboarding

Progress-tracked onboarding checklist widget (dismissible, re-openable) covering: invite team, connect email, create first pipeline, import contacts, create first deal.

---

## 6. Non-Functional Requirements

| Requirement | Target |
| --- | --- |
| Page load time | < 2s (p75) for core views |
| Search latency | < 500ms (p95) |
| Uptime SLA | 99.9% (≈8.7 hrs downtime/year budget) |
| Architecture | Multi-tenant, horizontally scalable application tier; tenant data logically isolated at the database layer |
| Data residency | US and EU region options at launch; APAC evaluated post-V2 based on demand |
| Backup & DR | Automated daily backups, point-in-time recovery (35-day window), documented RTO ≤ 4 hrs / RPO ≤ 1 hr |

---

## 7. Technical Considerations

### 7.1 Architecture Notes (Non-Prescriptive)

- **API-first design**: all UI functionality routes through the same public API surface used by external integrators — no internal-only shadow endpoints. This forces API completeness and simplifies the mobile/offline sync story.
- **Multi-tenancy**: logical isolation via tenant ID scoping on all queries, with row-level security enforced at the database layer as a defense-in-depth measure (not solely application-layer enforcement).
- **Async job processing**: bulk imports, AI summarization, and email sync should run through a queue-based worker system rather than blocking request/response cycles.
- **Search**: dedicated search index (e.g., Elasticsearch/OpenSearch-class technology) for cross-object global search and natural-language query features, separate from the primary transactional datastore.

### 7.2 Core Data Model (Entities & Relationships)

```
Organization (tenant)
 ├── User (role, permissions)
 ├── Contact ──< Account (many-to-one, with optional hierarchy on Account)
 ├── Deal ──< Pipeline/Stage
 │     ├── LineItem ──< Product
 │     └── Activity (call, email, task, note, meeting)
 ├── Lead (pre-conversion; converts to Contact + Account + Deal)
 ├── Campaign (V2) ──< Contact (many-to-many via CampaignMembership)
 ├── CustomField (polymorphic; attaches to Contact/Account/Deal)
 └── AuditLogEntry (polymorphic; attaches to any record type)
```

### 7.3 Suggested Stack Rationale

A typed backend language (e.g., Go, Kotlin, or TypeScript/Node) suits the API-first, high-concurrency nature of a multi-tenant CRM. A relational database (Postgres-class) fits the core transactional data given the strong relational structure (contacts/accounts/deals), supplemented by a document or search-optimized store for activity feeds and full-text search. Frontend should use a component-based framework with strong state-management conventions given the data-density and real-time update requirements described in Section 5.

---

## 8. Success Metrics & KPIs

| Metric | Definition | Target (Year 1) |
| --- | --- | --- |
| Activation rate | % of orgs completing first pipeline + first deal within 3 days | ≥ 60% |
| Time-to-first-value | Median hours from signup to first deal created | < 4 hours |
| Feature adoption (automation) | % of orgs with ≥1 active workflow within 30 days | ≥ 35% |
| Feature adoption (email sync) | % of seats with email connected within 7 days | ≥ 70% |
| 90-day logo retention | % of orgs still active 90 days post-signup | ≥ 85% |
| NRR | Net revenue retention | ≥ 105% |
| NPS | Net Promoter Score | ≥ 40 |

---

## 9. Release Plan / Phasing

| Phase | Contents | Est. Timeline |
| --- | --- | --- |
| **MVP (V1)** | Contacts/Accounts, Deals/Pipeline, Tasks/Activities, Email sync (core), Basic reporting/dashboards, RBAC, SSO/2FA, Audit logs, Onboarding wizard, Public API (core) | Months 0–4 |
| **Phase 2 (V2)** | Marketing (campaigns, forms, segmentation), Workflow automation builder, Advanced reporting/custom builder, Native integrations, Mobile apps, Meeting scheduler, Sequences | Months 5–9 |
| **Phase 3 (V3)** | AI features (summaries, predictive scoring, conversation intelligence, NL query), Post-sale/support module, Custom objects/no-code builder, Marketplace | Months 10–15 |

*Timelines assume a core team of ~8–10 engineers, 2 designers, 1 PM, scaling to ~16–18 engineers by Phase 3. Estimates should be revisited after MVP retro.*

---

## 10. Risks & Open Questions

### 10.1 Technical Risks

- **Email sync reliability at scale**: two-way sync with Gmail/Outlook APIs has historically been a support-ticket-heavy surface area for competitors; requires dedicated reliability investment and monitoring from day one.
- **Multi-tenant performance isolation**: a single noisy tenant (e.g., massive bulk import) must not degrade performance for other tenants; requires careful queue/resource isolation design before scale.
- **AI cost management (V3)**: real-time AI summaries and scoring at scale carry meaningful inference cost; needs a caching/regeneration-trigger strategy (see Section 4.10) validated against unit economics before general availability.

### 10.2 Market Risks

- **Category fatigue**: "another CRM" skepticism is high; the differentiation narrative (speed of adoption, native AI, transparent pricing) must be validated with design partners before broad launch spend.
- **Incumbent lock-in and switching cost**: migration tooling (Section 4.15) is a critical dependency for the entire market strategy — if migration is painful, the core wedge (displacing HubSpot/Pipedrive) fails regardless of product quality.
- **Pricing model risk**: usage-based seat pricing must be stress-tested against competitor list prices before GA; there is risk of being perceived as "cheap" rather than "value-focused" if positioned incorrectly.

### 10.3 Unresolved Product Decisions

- Should custom objects (no-code object builder) move up from P2 to P1 given RevOps persona feedback loops? Needs validation with 3–5 design partners.
- What is the minimum viable conversation intelligence experience — is call recording/transcription a build, or a launch-time integration (e.g., Gong/Chorus partnership) with native build deferred to later?
- Final decision on APAC data residency timing — dependent on early sales pipeline geography, to be revisited at V2 planning.
- Should the marketplace (Section 4.14) be a first-party curated set of apps at launch, or open to third-party developer submissions from day one? Has security review implications that need to be scoped before V3 commitment.

---

*End of document. Open questions in Section 10.3 should be resolved in the next cross-functional planning session prior to Phase 3 kickoff.*
