-- Backfill default escalation keywords for existing tenants that have none.
-- Only updates rows where escalation_keywords IS NULL (never set).
-- Rows with an empty array OR existing keywords are left untouched.
UPDATE public.ai_settings
SET escalation_keywords = ARRAY[
  'quiero ayuda',
  'necesito ayuda',
  'necesito que me ayuden',
  'quiero hablar con alguien',
  'quiero hablar con un humano',
  'hablar con humano',
  'persona real',
  'asesor',
  'asesora',
  'atención humana',
  'me pueden llamar',
  'llamame',
  'llámenme'
]
WHERE escalation_keywords IS NULL;
