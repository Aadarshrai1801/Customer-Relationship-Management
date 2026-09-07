CREATE TABLE "dashboards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_id" uuid,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"layout" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "forecast_category" text DEFAULT 'pipeline' NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboards" ADD CONSTRAINT "dashboards_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_dashboards_org_owner" ON "dashboards" USING btree ("org_id","owner_id");--> statement-breakpoint
ALTER TABLE "dashboards" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dashboards" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "dashboards"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "dashboards" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "dashboards" TO nexus_auth;