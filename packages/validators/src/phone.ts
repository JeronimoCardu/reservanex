/**
 * Normalizes an Argentine phone number to canonical WhatsApp format:
 * 549 + area code + subscriber number = 13 digits (e.g. 5492325471890)
 *
 * Handled variants:
 *   +54 9 2325 471890  → 5492325471890
 *   5492325471890      → 5492325471890  (already canonical)
 *   542325471890       → 5492325471890  (missing mobile 9)
 *   02325 15 471890    → 5492325471890  (trunk prefix + old 15 mobile)
 *   2325 471890        → 5492325471890  (bare national)
 *   2325471890         → 5492325471890  (bare national, no spaces)
 */
export function normalizePhoneForWhatsApp(input: string): string {
  if (!input || /[a-zA-Z]/.test(input)) return input

  const digits = input.replace(/\D/g, '')
  if (!digits) return input

  if (digits.startsWith('549')) {
    return digits
  }

  if (digits.startsWith('54')) {
    // Has country code but missing the mobile 9
    // 542325471890 → 5492325471890
    return '549' + digits.slice(2)
  }

  if (digits.startsWith('0')) {
    // Trunk prefix (local dialing with 0)
    let national = digits.slice(1)

    // Detect and remove old '15' mobile prefix: CC(2-4 digits) + 15 + XXXXXXXX
    for (const ccLen of [2, 3, 4] as const) {
      if (national.length > ccLen + 2 && national.slice(ccLen, ccLen + 2) === '15') {
        national = national.slice(0, ccLen) + national.slice(ccLen + 2)
        break
      }
    }

    return '549' + national
  }

  // Bare 10-digit national number (no country or trunk prefix)
  return '549' + digits
}

/** Returns true if phone is a valid Argentine WhatsApp mobile: 549 + 10 digits */
export function isValidARWhatsAppPhone(phone: string): boolean {
  return /^549\d{10}$/.test(phone)
}

/**
 * Normalizes an email address: trim + lowercase.
 * Returns undefined for empty/null/undefined input (no email provided).
 */
export function normalizeEmail(input: string | null | undefined): string | undefined {
  if (input == null) return undefined
  const trimmed = input.trim().toLowerCase()
  return trimmed === '' ? undefined : trimmed
}
