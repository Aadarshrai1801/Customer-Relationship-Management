CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_id" uuid,
	"name" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"email" text NOT NULL,
	"phone" text,
	"company" text,
	"title" text,
	"status" text DEFAULT 'new' NOT NULL,
	"source" text DEFAULT 'website' NOT NULL,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_term" text,
	"utm_content" text,
	"referrer_url" text,
	"notes" text,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"converted_at" timestamp with time zone,
	"converted_contact_id" uuid,
	"converted_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_routing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"strategy" text DEFAULT 'round_robin' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"fallback_user_id" uuid,
	"last_assigned_index" integer DEFAULT -1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_routing_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rep_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"ooo_reason" text,
	"return_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_assignment_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"assigned_to_user_id" uuid,
	"assigned_by_user_id" uuid,
	"rule_id" uuid,
	"strategy" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_converted_contact_id_contacts_id_fk" FOREIGN KEY ("converted_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_converted_account_id_accounts_id_fk" FOREIGN KEY ("converted_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "lead_routing_rules" ADD CONSTRAINT "lead_routing_rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_routing_rules" ADD CONSTRAINT "lead_routing_rules_fallback_user_id_users_id_fk" FOREIGN KEY ("fallback_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "lead_routing_members" ADD CONSTRAINT "lead_routing_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_routing_members" ADD CONSTRAINT "lead_routing_members_rule_id_lead_routing_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."lead_routing_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_routing_members" ADD CONSTRAINT "lead_routing_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "rep_availability" ADD CONSTRAINT "rep_availability_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rep_availability" ADD CONSTRAINT "rep_availability_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "lead_assignment_logs" ADD CONSTRAINT "lead_assignment_logs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_assignment_logs" ADD CONSTRAINT "lead_assignment_logs_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_assignment_logs" ADD CONSTRAINT "lead_assignment_logs_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_assignment_logs" ADD CONSTRAINT "lead_assignment_logs_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_assignment_logs" ADD CONSTRAINT "lead_assignment_logs_rule_id_lead_routing_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."lead_routing_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "ix_leads_org_email" ON "leads" ("org_id", lower("email"));--> statement-breakpoint
CREATE INDEX "ix_leads_org_status" ON "leads" ("org_id", "status");--> statement-breakpoint
CREATE INDEX "ix_leads_org_owner" ON "leads" ("org_id", "owner_id");--> statement-breakpoint
CREATE INDEX "ix_leads_org_created" ON "leads" ("org_id", "created_at");--> statement-breakpoint
CREATE INDEX "ix_lead_routing_rules_org" ON "lead_routing_rules" ("org_id", "is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_lead_routing_member" ON "lead_routing_members" ("rule_id", "user_id");--> statement-breakpoint
CREATE INDEX "ix_lead_routing_members_rule" ON "lead_routing_members" ("rule_id", "order_index");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_rep_availability_org_user" ON "rep_availability" ("org_id", "user_id");--> statement-breakpoint
CREATE INDEX "ix_lead_assignment_logs_lead" ON "lead_assignment_logs" ("org_id", "lead_id");--> statement-breakpoint
CREATE INDEX "ix_notifications_user_read" ON "notifications" ("org_id", "user_id", "read_at");--> statement-breakpoint

ALTER TABLE "leads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "leads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "leads"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "leads" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "leads" TO nexus_auth;--> statement-breakpoint

ALTER TABLE "lead_routing_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lead_routing_rules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "lead_routing_rules"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "lead_routing_rules" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "lead_routing_rules" TO nexus_auth;--> statement-breakpoint

ALTER TABLE "lead_routing_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lead_routing_members" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "lead_routing_members"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "lead_routing_members" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "lead_routing_members" TO nexus_auth;--> statement-breakpoint

ALTER TABLE "rep_availability" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rep_availability" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "rep_availability"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "rep_availability" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "rep_availability" TO nexus_auth;--> statement-breakpoint

ALTER TABLE "lead_assignment_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lead_assignment_logs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "lead_assignment_logs"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "lead_assignment_logs" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "lead_assignment_logs" TO nexus_auth;--> statement-breakpoint

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "notifications"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "notifications" TO nexus_auth;
