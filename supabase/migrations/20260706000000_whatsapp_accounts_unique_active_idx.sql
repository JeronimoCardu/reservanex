-- Prevent duplicate active WhatsApp accounts for the same (tenant, WABA, phone).
--
-- Before applying, verify no current violations:
--   SELECT business_account_id, phone_number, COUNT(*) AS active_rows
--   FROM public.whatsapp_accounts
--   WHERE active = true
--   GROUP BY business_account_id, phone_number
--   HAVING COUNT(*) > 1;
--
-- If rows are returned, deactivate duplicates first:
--   UPDATE public.whatsapp_accounts
--   SET active = false
--   WHERE id NOT IN (
--     SELECT DISTINCT ON (tenant_id, business_account_id, phone_number) id
--     FROM public.whatsapp_accounts
--     WHERE active = true
--     ORDER BY tenant_id, business_account_id, phone_number, last_verified_at DESC NULLS LAST
--   )
--   AND active = true;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_accounts_one_active_per_waba_phone_idx
ON public.whatsapp_accounts (business_account_id, phone_number)
WHERE active = true;
