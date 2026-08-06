CREATE TABLE "ai_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text DEFAULT '新会话' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ai_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"citations" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_messages_role_check" CHECK ("ai_messages"."role" in ('user','assistant'))
);
--> statement-breakpoint
ALTER TABLE "ai_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "langgraph_checkpoint_writes" (
	"thread_id" text NOT NULL,
	"checkpoint_id" text NOT NULL,
	"task_id" text NOT NULL,
	"idx" integer NOT NULL,
	"write" jsonb NOT NULL,
	CONSTRAINT "langgraph_checkpoint_writes_thread_id_checkpoint_id_task_id_idx_pk" PRIMARY KEY("thread_id","checkpoint_id","task_id","idx")
);
--> statement-breakpoint
ALTER TABLE "langgraph_checkpoint_writes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "langgraph_checkpoints" (
	"thread_id" text NOT NULL,
	"checkpoint_id" text NOT NULL,
	"parent_checkpoint_id" text,
	"checkpoint" jsonb NOT NULL,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "langgraph_checkpoints_thread_id_checkpoint_id_pk" PRIMARY KEY("thread_id","checkpoint_id")
);
--> statement-breakpoint
ALTER TABLE "langgraph_checkpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_conversations_user_idx" ON "ai_conversations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ai_messages_conversation_idx" ON "ai_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "langgraph_checkpoints_parent_idx" ON "langgraph_checkpoints" USING btree ("thread_id","parent_checkpoint_id");--> statement-breakpoint
CREATE POLICY "ai_conversations_internal_bypass" ON "ai_conversations" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING (current_setting('app.is_internal', true) = 'true') WITH CHECK (current_setting('app.is_internal', true) = 'true');--> statement-breakpoint
CREATE POLICY "ai_messages_internal_bypass" ON "ai_messages" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING (current_setting('app.is_internal', true) = 'true') WITH CHECK (current_setting('app.is_internal', true) = 'true');--> statement-breakpoint
CREATE POLICY "langgraph_checkpoint_writes_internal_bypass" ON "langgraph_checkpoint_writes" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING (current_setting('app.is_internal', true) = 'true') WITH CHECK (current_setting('app.is_internal', true) = 'true');--> statement-breakpoint
CREATE POLICY "langgraph_checkpoints_internal_bypass" ON "langgraph_checkpoints" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING (current_setting('app.is_internal', true) = 'true') WITH CHECK (current_setting('app.is_internal', true) = 'true');