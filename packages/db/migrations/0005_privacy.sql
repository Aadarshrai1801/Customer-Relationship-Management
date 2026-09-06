CREATE TABLE "gdpr_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"storage_key" text,
	"file_size" text,
	"checksum" text,
	"error" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "gdpr_exports" ADD CONSTRAINT "gdpr_exports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gdpr_exports" ADD CONSTRAINT "gdpr_exports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gdpr_exports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gdpr_exports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gdpr_exports"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "gdpr_exports" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "gdpr_exports" TO nexus_auth;--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS boss;--> statement-breakpoint
GRANT USAGE ON SCHEMA boss TO nexus_app;--> statement-breakpoint
GRANT USAGE ON SCHEMA boss TO nexus_auth;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA boss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nexus_app, nexus_auth;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA boss GRANT USAGE, SELECT ON SEQUENCES TO nexus_app, nexus_auth;