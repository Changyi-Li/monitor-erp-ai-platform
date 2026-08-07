CREATE TABLE "import_staged_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_key" text NOT NULL,
	"action" text NOT NULL,
	"fingerprint" text NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"doc_type" text NOT NULL,
	"body" text,
	"file_name" text,
	"content_type" text,
	"base64" text,
	"metadata" jsonb,
	"document_id" uuid,
	"created_by_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"last_error" text,
	"duplicate_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_staged_key_unique" UNIQUE("source","source_key","action"),
	CONSTRAINT "import_staged_source_check" CHECK ("import_staged_documents"."source" in ('api','fetch')),
	CONSTRAINT "import_staged_action_check" CHECK ("import_staged_documents"."action" in ('upsert','delete')),
	CONSTRAINT "import_staged_category_check" CHECK ("import_staged_documents"."category" in ('manual','faq','best_practice')),
	CONSTRAINT "import_staged_doc_type_check" CHECK ("import_staged_documents"."doc_type" in ('markdown','file')),
	CONSTRAINT "import_staged_status_check" CHECK ("import_staged_documents"."status" in ('pending','processing','processed','failed'))
);
--> statement-breakpoint
ALTER TABLE "import_staged_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN "external_key" text;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN "fingerprint" text;--> statement-breakpoint
ALTER TABLE "import_staged_documents" ADD CONSTRAINT "import_staged_documents_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_staged_status_idx" ON "import_staged_documents" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE INDEX "import_staged_source_key_idx" ON "import_staged_documents" USING btree ("source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "kb_documents_external_key_unique" ON "kb_documents" USING btree ("source","external_key") WHERE "kb_documents"."source" = 'online_help' and "kb_documents"."external_key" is not null;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_source_check" CHECK ("kb_documents"."source" in ('manual','online_help'));--> statement-breakpoint
CREATE POLICY "import_staged_internal_bypass" ON "import_staged_documents" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING (current_setting('app.is_internal', true) = 'true') WITH CHECK (current_setting('app.is_internal', true) = 'true');