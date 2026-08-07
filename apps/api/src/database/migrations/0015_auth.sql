CREATE TABLE "manual_chapters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"generation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"title" text NOT NULL,
	"outline" text,
	"content_md" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"ai_generated_at" timestamp with time zone,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manual_chapters_generation_seq_unique" UNIQUE("generation_id","seq"),
	CONSTRAINT "manual_chapters_status_check" CHECK ("manual_chapters"."status" in ('pending','ready','edited'))
);
--> statement-breakpoint
ALTER TABLE "manual_chapters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "manual_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"blueprint_id" uuid NOT NULL,
	"blueprint_version" integer NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"kb_document_id" uuid,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "manual_generations_status_check" CHECK ("manual_generations"."status" in ('in_progress','published'))
);
--> statement-breakpoint
ALTER TABLE "manual_generations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "manual_chapters" ADD CONSTRAINT "manual_chapters_tenant_id_customers_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_chapters" ADD CONSTRAINT "manual_chapters_generation_id_manual_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."manual_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_generations" ADD CONSTRAINT "manual_generations_tenant_id_customers_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_generations" ADD CONSTRAINT "manual_generations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_generations" ADD CONSTRAINT "manual_generations_blueprint_id_blueprints_id_fk" FOREIGN KEY ("blueprint_id") REFERENCES "public"."blueprints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_generations" ADD CONSTRAINT "manual_generations_kb_document_id_kb_documents_id_fk" FOREIGN KEY ("kb_document_id") REFERENCES "public"."kb_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "manual_generations" ADD CONSTRAINT "manual_generations_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "manual_chapters_generation_idx" ON "manual_chapters" USING btree ("generation_id");--> statement-breakpoint
CREATE INDEX "manual_chapters_tenant_idx" ON "manual_chapters" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "manual_generations_tenant_idx" ON "manual_generations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "manual_generations_project_idx" ON "manual_generations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "manual_generations_blueprint_idx" ON "manual_generations" USING btree ("blueprint_id");--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_tenant_id_customers_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_documents_tenant_idx" ON "kb_documents" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "kb_documents_project_idx" ON "kb_documents" USING btree ("project_id");--> statement-breakpoint
CREATE POLICY "manual_chapters_tenant_isolation" ON "manual_chapters" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING ("manual_chapters"."tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("manual_chapters"."tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "manual_chapters_internal_bypass" ON "manual_chapters" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING (current_setting('app.is_internal', true) = 'true') WITH CHECK (current_setting('app.is_internal', true) = 'true');--> statement-breakpoint
CREATE POLICY "manual_generations_tenant_isolation" ON "manual_generations" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING ("manual_generations"."tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("manual_generations"."tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "manual_generations_internal_bypass" ON "manual_generations" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING (current_setting('app.is_internal', true) = 'true') WITH CHECK (current_setting('app.is_internal', true) = 'true');--> statement-breakpoint
ALTER POLICY "kb_documents_read_published" ON "kb_documents" TO app_tenant_user USING ("kb_documents"."status" = 'published' and ("kb_documents"."tenant_id" is null or "kb_documents"."tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid));