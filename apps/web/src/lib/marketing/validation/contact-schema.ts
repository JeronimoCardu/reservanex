import { z } from 'zod'

/**
 * Shared between the client form (react-hook-form) and the /api/contact
 * route handler, so validation rules can never drift between the two.
 * Error messages are looked up client-side via message keys, not these
 * literal strings, so the UI can localize them; the API route falls back to
 * these defaults since it has no locale/message context.
 */
export const contactSchema = z.object({
  name: z.string().trim().min(2).max(120),
  company: z.string().trim().min(2).max(160),
  country: z.string().trim().min(2).max(80),
  whatsapp: z
    .string()
    .trim()
    .min(6)
    .max(30)
    .regex(/^[+\d][\d\s()-]{4,}$/, 'invalid phone'),
  email: z.string().trim().email(),
  propertiesCount: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => (value === undefined || value === '' ? undefined : Number(value)))
    .refine((value) => value === undefined || (Number.isFinite(value) && value >= 0), {
      message: 'invalid number',
    }),
  message: z.string().trim().min(10).max(2000),
  // z.boolean() (not z.literal(true)) keeps the input/output types identical
  // (boolean), which is what lets useForm<z.input<...>, unknown, z.output<...>>
  // accept `false` as a valid default value for the checkbox.
  acceptsPrivacy: z.boolean().refine((value) => value === true, {
    message: 'privacy policy must be accepted',
  }),
  // Honeypot: must accept any value (including bot-filled garbage) so a
  // filled-in submission still passes validation — the route handler is
  // what turns a non-empty value into a silent fake-success response.
  // A max(0) constraint here would instead reject bots with a distinct
  // 422, telling them apart from real users instead of hiding that.
  company_website: z.string().max(200).optional().or(z.literal('')),
  // Informational only (not shown in the UI): which locale the form was
  // submitted from and which page it was submitted from, for the email/
  // webhook payload. Loosely validated since neither drives any logic.
  locale: z.string().trim().max(10).optional(),
  pageUrl: z.string().trim().url().max(300).optional(),
})

export type ContactInput = z.output<typeof contactSchema>
export type ContactFormInput = z.input<typeof contactSchema>
