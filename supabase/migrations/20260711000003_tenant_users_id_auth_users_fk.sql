-- Formaliza el modelo actual:
-- public.tenant_users.id debe ser el mismo UUID que auth.users.id

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.tenant_users tu
    LEFT JOIN auth.users au ON au.id = tu.id
    WHERE au.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot add FK: some tenant_users.id do not exist in auth.users.id';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tenant_users_id_auth_users_id_fkey'
      AND conrelid = 'public.tenant_users'::regclass
  ) THEN
    ALTER TABLE public.tenant_users
      ADD CONSTRAINT tenant_users_id_auth_users_id_fkey
      FOREIGN KEY (id)
      REFERENCES auth.users(id)
      ON DELETE RESTRICT;
  END IF;
END $$;