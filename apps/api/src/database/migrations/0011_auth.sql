CREATE TABLE "document_syncs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"version_number" integer NOT NULL,
	"action" text NOT NULL,
	"scope" text NOT NULL,
	"tenant_id" uuid,
	"title" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_syncs_key_unique" UNIQUE("document_id","document_type","version_number","action"),
	CONSTRAINT "document_syncs_type_check" CHECK ("document_syncs"."document_type" in ('kb_document','blueprint')),
	CONSTRAINT "document_syncs_action_check" CHECK ("document_syncs"."action" in ('upsert','delete')),
	CONSTRAINT "document_syncs_scope_check" CHECK ("document_syncs"."scope" in ('internal','customer')),
	CONSTRAINT "document_syncs_status_check" CHECK ("document_syncs"."status" in ('queued','processing','succeeded','failed'))
);
--> statement-breakpoint
ALTER TABLE "document_syncs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_syncs" ADD CONSTRAINT "document_syncs_tenant_id_customers_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_syncs_status_idx" ON "document_syncs" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE POLICY "document_syncs_tenant_isolation" ON "document_syncs" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING ("document_syncs"."tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("document_syncs"."tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "document_syncs_internal_bypass" ON "document_syncs" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING (current_setting('app.is_internal', true) = 'true') WITH CHECK (current_setting('app.is_internal', true) = 'true');