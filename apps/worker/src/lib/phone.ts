// Mirrors packages/validators/src/phone.ts — keep in sync.
// Worker does not depend on @orderflow/validators, so this is a standalone copy.

export function normalizePhoneForWhatsApp(input: string): string {
  if (!input || /[a-zA-Z]/.test(input)) return input

  const digits = input.replace(/\D/g, '')
  if (!digits) return input

  if (digits.startsWith('549')) {
    return digits
  }

  if (digits.startsWith('54')) {
    return '549' + digits.slice(2)
  }

  if (digits.startsWith('0')) {
    let national = digits.slice(1)

    for (const ccLen of [2, 3, 4] as const) {
      if (national.length > ccLen + 2 && national.slice(ccLen, ccLen + 2) === '15') {
        national = national.slice(0, ccLen) + national.slice(ccLen + 2)
        break
      }
    }

    return '549' + national
  }

  return '549' + digits
}

/** Returns true if phone is a valid Argentine WhatsApp mobile: 549 + 10 digits */
export function isValidARWhatsAppPhone(phone: string): boolean {
  return /^549\d{10}$/.test(phone)
}
