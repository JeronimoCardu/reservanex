-- ─────────────────────────────────────────────────────────────────
-- Migration 000008: Normalize existing contacts phone + email
-- ─────────────────────────────────────────────────────────────────
-- Replicates the JS normalizePhoneForWhatsApp() logic in SQL so we
-- can backfill existing rows consistently.
--
-- Rules (Argentina / WhatsApp canonical format = 549 + 10 digits):
--   549...  → keep as-is
--   54...   → insert 9 after 54
--   0...    → remove trunk 0; detect and strip legacy 15 mobile prefix
--   else    → prepend 549 (bare national number)
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.normalize_contact_phone_ar(phone text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  digits   text;
  national text;
  cc_len   int;
BEGIN
  IF phone IS NULL THEN
    RETURN phone;
  END IF;

  -- Strip all non-digit characters (spaces, dashes, parens, +)
  digits := regexp_replace(phone, '[^0-9]', '', 'g');

  IF digits = '' THEN
    RETURN phone;
  END IF;

  -- Already canonical
  IF digits LIKE '549%' THEN
    RETURN digits;
  END IF;

  -- Has country code but missing mobile 9 (e.g. 542325471890)
  IF digits LIKE '54%' THEN
    RETURN '549' || substring(digits FROM 3);
  END IF;

  -- Trunk prefix (local 0 dialing)
  IF digits LIKE '0%' THEN
    national := substring(digits FROM 2);

    -- Remove legacy 15 mobile prefix at area-code boundary (2, 3, or 4 digits)
    FOREACH cc_len IN ARRAY ARRAY[2, 3, 4] LOOP
      IF length(national) > cc_len + 2
         AND substring(national FROM cc_len + 1 FOR 2) = '15' THEN
        national := substring(national FROM 1 FOR cc_len)
                 || substring(national FROM cc_len + 3);
        EXIT;
      END IF;
    END LOOP;

    RETURN '549' || national;
  END IF;

  -- Bare national number (no prefix)
  RETURN '549' || digits;
END;
$$;

-- ─────────────────────────────────────────────────────────────────
-- Safety check: abort if normalization would produce duplicates.
-- Resolve manually before re-running.
-- ─────────────────────────────────────────────────────────────────
DO $$
DECLARE
  dup_count integer;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT
      tenant_id,
      public.normalize_contact_phone_ar(phone) AS norm_phone,
      COUNT(*) AS n
    FROM public.contacts
    WHERE phone IS NOT NULL
      AND deleted_at IS NULL
    GROUP BY tenant_id, public.normalize_contact_phone_ar(phone)
    HAVING COUNT(*) > 1
  ) dups;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      E'Phone normalization would create % duplicate group(s).\n'
      'Find them with:\n'
      '  SELECT tenant_id, public.normalize_contact_phone_ar(phone) AS norm_phone,\n'
      '         array_agg(id) AS ids, array_agg(phone) AS phones\n'
      '  FROM public.contacts\n'
      '  WHERE phone IS NOT NULL AND deleted_at IS NULL\n'
      '  GROUP BY tenant_id, public.normalize_contact_phone_ar(phone)\n'
      '  HAVING COUNT(*) > 1;\n'
      'Archive duplicates manually, then re-run this migration.',
      dup_count;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- Backfill: update phones that differ from their normalized form
-- ─────────────────────────────────────────────────────────────────
UPDATE public.contacts
SET   phone = public.normalize_contact_phone_ar(phone)
WHERE phone IS NOT NULL
  AND phone IS DISTINCT FROM public.normalize_contact_phone_ar(phone);

-- ─────────────────────────────────────────────────────────────────
-- Backfill: normalize email (trim + lowercase)
-- ─────────────────────────────────────────────────────────────────
UPDATE public.contacts
SET   email = lower(trim(email))
WHERE email IS NOT NULL
  AND email IS DISTINCT FROM lower(trim(email));
