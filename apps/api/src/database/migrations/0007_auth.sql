CREATE TABLE "meeting_minutes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"meeting_date" date NOT NULL,
	"participants" text,
	"body" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "meeting_minutes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "minute_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"minute_id" uuid NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "minute_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "meeting_minutes" ADD CONSTRAINT "meeting_minutes_tenant_id_customers_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_minutes" ADD CONSTRAINT "meeting_minutes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_minutes" ADD CONSTRAINT "meeting_minutes_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "minute_attachments" ADD CONSTRAINT "minute_attachments_tenant_id_customers_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "minute_attachments" ADD CONSTRAINT "minute_attachments_minute_id_meeting_minutes_id_fk" FOREIGN KEY ("minute_id") REFERENCES "public"."meeting_minutes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_minutes_tenant_idx" ON "meeting_minutes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "meeting_minutes_project_idx" ON "meeting_minutes" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "minute_attachments_minute_idx" ON "minute_attachments" USING btree ("minute_id");--> statement-breakpoint
CREATE INDEX "minute_attachments_tenant_idx" ON "minute_attachments" USING btree ("tenant_id");--> statement-breakpoint
CREATE POLICY "meeting_minutes_tenant_isolation" ON "meeting_minutes" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING ("meeting_minutes"."tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("meeting_minutes"."tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "meeting_minutes_internal_bypass" ON "meeting_minutes" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING (current_setting('app.is_internal', true) = 'true') WITH CHECK (current_setting('app.is_internal', true) = 'true');--> statement-breakpoint
CREATE POLICY "minute_attachments_tenant_isolation" ON "minute_attachments" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING ("minute_attachments"."tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK ("minute_attachments"."tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "minute_attachments_internal_bypass" ON "minute_attachments" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING (current_setting('app.is_internal', true) = 'true') WITH CHECK (current_setting('app.is_internal', true) = 'true');