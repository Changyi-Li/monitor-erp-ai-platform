-- 角色是 cluster 级（跨库共享）：测试库/开发库/重试时可能已存在，幂等创建
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_tenant_user') THEN
    CREATE ROLE "app_tenant_user";
  END IF;
END
$$;--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"industry" text,
	"region" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_tenants_user_customer_unique" UNIQUE("user_id","customer_id")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_tenant_id_customers_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tenants" ADD CONSTRAINT "user_tenants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tenants" ADD CONSTRAINT "user_tenants_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projects_tenant_idx" ON "projects" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "user_tenants_user_idx" ON "user_tenants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_tenants_customer_idx" ON "user_tenants" USING btree ("customer_id");--> statement-breakpoint
CREATE POLICY "customers_tenant_self" ON "customers" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING ("customers"."id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("customers"."id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "customers_internal_bypass" ON "customers" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING (current_setting('app.is_internal', true) = 'true') WITH CHECK (current_setting('app.is_internal', true) = 'true');--> statement-breakpoint
CREATE POLICY "projects_tenant_isolation" ON "projects" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING ("projects"."tenant_id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("projects"."tenant_id" = current_setting('app.tenant_id', true)::uuid);--> statement-breakpoint
CREATE POLICY "projects_internal_bypass" ON "projects" AS PERMISSIVE FOR ALL TO "app_tenant_user" USING (current_setting('app.is_internal', true) = 'true') WITH CHECK (current_setting('app.is_internal', true) = 'true');
--> statement-breakpoint
-- ===== 手写追加：受限角色授权（drizzle-kit 不生成 GRANT）=====
-- 应用连接以 app_tenant_user 身份运行：非表 owner、无 BYPASSRLS，RLS 兜底生效。
-- 不给 REFERENCES/TRUNCATE/CONNECT：FK 检查以表 owner 身份执行绕过 RLS；
-- TRUNCATE 仅 owner 管理操作；CONNECT 默认对 PUBLIC 开放。
GRANT USAGE ON SCHEMA public TO "app_tenant_user";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "app_tenant_user";
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "app_tenant_user";