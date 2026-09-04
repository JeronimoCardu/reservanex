-- Add human-readable phone number field to whatsapp_accounts.
-- phone_number stores the Meta Phone Number ID (numeric); display_phone_number stores the
-- E.164 or formatted number shown to users (e.g. "+54 9 11 1234-5678").
alter table public.whatsapp_accounts
  add column if not exists display_phone_number text;
