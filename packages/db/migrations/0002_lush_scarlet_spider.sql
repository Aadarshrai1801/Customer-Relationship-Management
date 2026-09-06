CREATE TABLE "two_factor" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"secret" text NOT NULL,
	"enabled_at" timestamp with time zone,
	"backup_codes" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "roles" ALTER COLUMN "permissions" SET DEFAULT '{"version":1,"scopes":[],"recordAccess":{},"fields":{}}'::jsonb;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "two_factor" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "two_factor"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "two_factor" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "two_factor" TO nexus_auth;