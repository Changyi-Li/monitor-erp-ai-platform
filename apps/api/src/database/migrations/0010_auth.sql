CREATE TABLE "issue_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_links_issue_target_unique" UNIQUE("issue_id","target_type","target_id"),
	CONSTRAINT "issue_links_target_type_check" CHECK ("issue_links"."target_type" in ('blueprint','minute','kb_document'))
);
--> statement-breakpoint
ALTER TABLE "issue_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "issue_links" ADD CONSTRAINT "issue_links_tenant_id_customers_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_links" ADD CONSTRAINT "issue_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_links" ADD CONSTRAINT "issue_links_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_links_issue_idx" ON "issue_links" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "issue_links_tenant_idx" ON "issue_links" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "issue_links_tenant_isolation" ON "issue_links" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING ("issue_links"."tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("issue_links"."tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "issue_links_internal_bypass" ON "issue_links" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING (current_setting('app.is_internal', true) = 'true') WITH CHECK (current_setting('app.is_internal', true) = 'true');