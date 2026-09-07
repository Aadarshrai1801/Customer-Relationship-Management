CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"requester_id" uuid,
	"decided_by_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"duration_minutes" integer DEFAULT 30 NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"contact_id" uuid,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"platform" text DEFAULT 'web' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sla_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"entity" text NOT NULL,
	"metric" text NOT NULL,
	"hours" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "territories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_id" uuid,
	"name" text NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_links" ADD CONSTRAINT "booking_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_links" ADD CONSTRAINT "booking_links_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_link_id_booking_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."booking_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "territories" ADD CONSTRAINT "territories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "territories" ADD CONSTRAINT "territories_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_approvals_org_status" ON "approvals" USING btree ("org_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_booking_links_org_slug" ON "booking_links" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "ix_bookings_link_start" ON "bookings" USING btree ("org_id","link_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_devices_org_token" ON "devices" USING btree ("org_id","token");--> statement-breakpoint
CREATE INDEX "ix_sla_org_active" ON "sla_policies" USING btree ("org_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_territories_org_name" ON "territories" USING btree ("org_id","name");--> statement-breakpoint
ALTER TABLE "approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "approvals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "approvals"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "approvals" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "approvals" TO nexus_auth;--> statement-breakpoint
ALTER TABLE "booking_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "booking_links"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "booking_links" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "booking_links" TO nexus_auth;--> statement-breakpoint
ALTER TABLE "bookings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bookings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "bookings"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "bookings" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "bookings" TO nexus_auth;--> statement-breakpoint
ALTER TABLE "territories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "territories" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "territories"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "territories" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "territories" TO nexus_auth;--> statement-breakpoint
ALTER TABLE "devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "devices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "devices"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "devices" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "devices" TO nexus_auth;--> statement-breakpoint
ALTER TABLE "sla_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sla_policies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sla_policies"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "sla_policies" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "sla_policies" TO nexus_auth;