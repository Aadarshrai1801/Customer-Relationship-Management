CREATE TABLE "sso_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"domains" text[] DEFAULT '{}' NOT NULL,
	"config" text NOT NULL,
	"default_role_key" text DEFAULT 'rep' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_login_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"state_hash" text NOT NULL,
	"code_verifier" text,
	"nonce" text,
	"saml_request_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sso_subject" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sso_provider" text;--> statement-breakpoint
ALTER TABLE "sso_configs" ADD CONSTRAINT "sso_configs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_login_states" ADD CONSTRAINT "sso_login_states_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sso_configs_org_provider" ON "sso_configs" USING btree ("org_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sso_login_states_state_hash" ON "sso_login_states" USING btree ("state_hash");
--> statement-breakpoint
ALTER TABLE "sso_configs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sso_configs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sso_configs"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "sso_login_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sso_login_states" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sso_login_states"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "sso_configs" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "sso_login_states" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "sso_configs" TO nexus_auth;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "sso_login_states" TO nexus_auth;