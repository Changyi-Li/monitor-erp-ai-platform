CREATE TABLE "kb_document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version_number" integer,
	"is_published" boolean DEFAULT false NOT NULL,
	"body" text,
	"file_name" text,
	"content_type" text,
	"size" integer,
	"storage_key" text,
	"published_by_id" uuid,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kb_document_versions_doc_version_unique" UNIQUE("document_id","version_number")
);
--> statement-breakpoint
ALTER TABLE "kb_document_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "kb_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"doc_type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kb_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kb_document_versions" ADD CONSTRAINT "kb_document_versions_document_id_kb_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."kb_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_document_versions" ADD CONSTRAINT "kb_document_versions_published_by_id_users_id_fk" FOREIGN KEY ("published_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kb_document_versions_doc_idx" ON "kb_document_versions" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "kb_documents_category_status_idx" ON "kb_documents" USING btree ("category","status");--> statement-breakpoint
CREATE POLICY "kb_document_versions_internal_manage" ON "kb_document_versions" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING (current_setting('app.is_internal', true) = 'true') WITH CHECK (current_setting('app.is_internal', true) = 'true');--> statement-breakpoint
CREATE POLICY "kb_document_versions_read_published" ON "kb_document_versions" AS PERMISSIVE FOR SELECT TO "app_tenant_user" USING (exists(select 1 from kb_documents d where d.id = "kb_document_versions"."document_id" and d.status = 'published'));--> statement-breakpoint
CREATE POLICY "kb_documents_internal_manage" ON "kb_documents" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING (current_setting('app.is_internal', true) = 'true') WITH CHECK (current_setting('app.is_internal', true) = 'true');--> statement-breakpoint
CREATE POLICY "kb_documents_read_published" ON "kb_documents" AS PERMISSIVE FOR SELECT TO "app_tenant_user" USING ("kb_documents"."status" = 'published');