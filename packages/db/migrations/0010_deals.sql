CREATE TABLE "deal_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"deal_id" uuid NOT NULL,
	"product_id" uuid,
	"name" text NOT NULL,
	"quantity" numeric(12, 2) NOT NULL,
	"unit_price" numeric(19, 2) NOT NULL,
	"discount_rate" numeric(7, 4) DEFAULT '0' NOT NULL,
	"tax_rate" numeric(7, 4) DEFAULT '0' NOT NULL,
	"line_total" numeric(19, 2) NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deal_stage_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"deal_id" uuid NOT NULL,
	"from_stage_id" uuid,
	"to_stage_id" uuid,
	"from_stage_name" text,
	"to_stage_name" text NOT NULL,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"exited_at" timestamp with time zone,
	"duration_seconds" integer,
	"actor_user_id" uuid
);
--> statement-breakpoint
CREATE TABLE "deals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"account_id" uuid,
	"contact_id" uuid,
	"owner_id" uuid,
	"name" text NOT NULL,
	"amount" numeric(19, 2) NOT NULL,
	"currency" text NOT NULL,
	"base_currency" text NOT NULL,
	"base_amount" numeric(19, 2) NOT NULL,
	"exchange_rate" numeric(19, 6) NOT NULL,
	"exchange_rate_date" date NOT NULL,
	"probability" integer,
	"expected_close_date" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"loss_reason" text,
	"closed_at" timestamp with time zone,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"rate_date" date NOT NULL,
	"base_currency" text NOT NULL,
	"rates" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"probability" integer NOT NULL,
	"is_closed_won" boolean DEFAULT false NOT NULL,
	"is_closed_lost" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sku" text,
	"unit_price" numeric(19, 2) NOT NULL,
	"currency" text NOT NULL,
	"tax_rate" numeric(7, 4) DEFAULT '0' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "settings" SET DEFAULT '{"timezone":"UTC","locale":"en-US","dateFormat":"YYYY-MM-DD","baseCurrency":"USD"}'::jsonb;--> statement-breakpoint
ALTER TABLE "deal_line_items" ADD CONSTRAINT "deal_line_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_line_items" ADD CONSTRAINT "deal_line_items_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_line_items" ADD CONSTRAINT "deal_line_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_from_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("from_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_to_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("to_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deal_stage_history" ADD CONSTRAINT "deal_stage_history_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_deal_line_items_deal" ON "deal_line_items" USING btree ("org_id","deal_id");--> statement-breakpoint
CREATE INDEX "ix_deal_stage_history_deal" ON "deal_stage_history" USING btree ("org_id","deal_id","entered_at");--> statement-breakpoint
CREATE INDEX "ix_deals_org_pipeline_stage" ON "deals" USING btree ("org_id","pipeline_id","stage_id");--> statement-breakpoint
CREATE INDEX "ix_deals_org_owner" ON "deals" USING btree ("org_id","owner_id");--> statement-breakpoint
CREATE INDEX "ix_deals_org_account" ON "deals" USING btree ("org_id","account_id");--> statement-breakpoint
CREATE INDEX "ix_deals_org_close" ON "deals" USING btree ("org_id","expected_close_date");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_exchange_rates_org_date_base" ON "exchange_rates" USING btree ("org_id","rate_date","base_currency");--> statement-breakpoint
CREATE INDEX "ix_exchange_rates_org_base_date" ON "exchange_rates" USING btree ("org_id","base_currency","rate_date");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pipeline_stages_pipeline_key" ON "pipeline_stages" USING btree ("pipeline_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pipeline_stages_pipeline_position" ON "pipeline_stages" USING btree ("pipeline_id","position");--> statement-breakpoint
CREATE INDEX "ix_pipeline_stages_pipeline_position" ON "pipeline_stages" USING btree ("pipeline_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_pipelines_org_slug" ON "pipelines" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "ix_products_org_active" ON "products" USING btree ("org_id","is_active");--> statement-breakpoint
ALTER TABLE "deal_line_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deal_line_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "deal_line_items"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "deal_line_items" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "deal_line_items" TO nexus_auth;--> statement-breakpoint
ALTER TABLE "deal_stage_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deal_stage_history" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "deal_stage_history"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "deal_stage_history" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "deal_stage_history" TO nexus_auth;--> statement-breakpoint
ALTER TABLE "deals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "deals"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "deals" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "deals" TO nexus_auth;--> statement-breakpoint
ALTER TABLE "exchange_rates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "exchange_rates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "exchange_rates"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "exchange_rates" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "exchange_rates" TO nexus_auth;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pipeline_stages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "pipeline_stages"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "pipeline_stages" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "pipeline_stages" TO nexus_auth;--> statement-breakpoint
ALTER TABLE "pipelines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pipelines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "pipelines"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "pipelines" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "pipelines" TO nexus_auth;--> statement-breakpoint
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "products"
  USING ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("org_id" = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "products" TO nexus_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "products" TO nexus_auth;
