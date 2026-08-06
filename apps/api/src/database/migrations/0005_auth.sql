CREATE TABLE "blueprint_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"blueprint_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"business_requirements" text,
	"module_scope" text,
	"config_notes" text,
	"process_description" text,
	"drawio_key" text NOT NULL,
	"drawio_name" text NOT NULL,
	"drawio_content_type" text NOT NULL,
	"drawio_size" integer NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blueprint_versions_blueprint_version_unique" UNIQUE("blueprint_id","version")
);
--> statement-breakpoint
ALTER TABLE "blueprint_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "blueprints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"business_requirements" text,
	"module_scope" text,
	"config_notes" text,
	"process_description" text,
	"drawio_key" text NOT NULL,
	"drawio_name" text NOT NULL,
	"drawio_content_type" text NOT NULL,
	"drawio_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blueprints_project_unique" UNIQUE("project_id")
);
--> statement-breakpoint
ALTER TABLE "blueprints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "blueprint_versions" ADD CONSTRAINT "blueprint_versions_tenant_id_customers_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_versions" ADD CONSTRAINT "blueprint_versions_blueprint_id_blueprints_id_fk" FOREIGN KEY ("blueprint_id") REFERENCES "public"."blueprints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprint_versions" ADD CONSTRAINT "blueprint_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprints" ADD CONSTRAINT "blueprints_tenant_id_customers_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blueprints" ADD CONSTRAINT "blueprints_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blueprint_versions_blueprint_idx" ON "blueprint_versions" USING btree ("blueprint_id");--> statement-breakpoint
CREATE INDEX "blueprint_versions_tenant_idx" ON "blueprint_versions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "blueprints_tenant_idx" ON "blueprints" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "blueprint_versions_tenant_isolation" ON "blueprint_versions" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING ("blueprint_versions"."tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("blueprint_versions"."tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "blueprint_versions_internal_bypass" ON "blueprint_versions" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING (current_setting('app.is_internal', true) = 'true') WITH CHECK (current_setting('app.is_internal', true) = 'true');--> statement-breakpoint
CREATE POLICY "blueprints_tenant_isolation" ON "blueprints" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING ("blueprints"."tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("blueprints"."tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "blueprints_internal_bypass" ON "blueprints" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING (current_setting('app.is_internal', true) = 'true') WITH CHECK (current_setting('app.is_internal', true) = 'true');