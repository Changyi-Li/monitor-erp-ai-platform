-- 平台角色拆分（T1）：'customer' → customer_pm / customer_key_user / customer_user
-- 顺序关键：先映射存量数据，再加 CHECK 约束（否则存量 'customer' 行违反约束导致 ADD CONSTRAINT 失败）。
--
-- 存量映射按项目成员角色取最高档：任一项目 project_manager → customer_pm；
-- 否则任一项目 key_user → customer_key_user；否则（仅 regular_user 或无成员关系）→ customer_user。
-- 幂等：UPDATE 只作用于 role='customer' 的行；重跑时无此值，零操作。
UPDATE "users" SET "role" = m.role
FROM (
  SELECT pm."user_id",
         CASE
           WHEN bool_or(pm."role" = 'project_manager') THEN 'customer_pm'
           WHEN bool_or(pm."role" = 'key_user') THEN 'customer_key_user'
           ELSE 'customer_user'
         END AS role
  FROM "project_members" pm
  GROUP BY pm."user_id"
) m
WHERE "users"."id" = m."user_id" AND "users"."role" = 'customer';

-- 无任何项目成员关系的存量 customer → 普通用户
UPDATE "users" SET "role" = 'customer_user' WHERE "role" = 'customer';

ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("users"."role" in ('super_admin','internal','customer_pm','customer_key_user','customer_user'));
