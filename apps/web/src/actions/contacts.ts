'use server'

import { revalidatePath } from 'next/cache'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import {
  createContactSchema,
  updateContactSchema,
  normalizePhoneForWhatsApp,
  isValidARWhatsAppPhone,
  normalizeEmail,
} from '@orderflow/validators'
import * as repo from '@/lib/repositories/contacts.repository'
import type { ActionResult } from '@/lib/action-result'

const LIST_PATH   = '/dashboard/contacts'
const DETAIL_PATH = (id: string) => `/dashboard/contacts/${id}`

function handleContactRepoError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message === 'DUPLICATE_PHONE') {
      return 'Ya existe un contacto con ese teléfono.'
    }
    if (err.message === 'DUPLICATE_EMAIL') {
      return 'Ya existe un contacto con ese email.'
    }
  }
  return 'Error inesperado. Intentá de nuevo.'
}

export async function createContactAction(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  const raw = input as Record<string, unknown>

  // Normalize phone before validation
  const normalizedPhone = typeof raw?.phone === 'string' && raw.phone
    ? normalizePhoneForWhatsApp(raw.phone)
    : ''

  if (normalizedPhone && !isValidARWhatsAppPhone(normalizedPhone)) {
    return { success: false, error: 'Teléfono inválido. Ingresá un número móvil argentino (ej: 11 1234 5678).' }
  }

  const normalizedInput = {
    ...raw,
    phone: normalizedPhone || raw?.phone,
    email: normalizeEmail(typeof raw?.email === 'string' ? raw.email : undefined),
  }

  const parsed = createContactSchema.safeParse(normalizedInput)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  try {
    const contact = await repo.createContact(ctx.tenantId, parsed.data)
    revalidatePath(LIST_PATH)
    return { success: true, data: { id: contact.id } }
  } catch (err) {
    return { success: false, error: handleContactRepoError(err) }
  }
}

export async function updateContactAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  const contact = await repo.getContactById(ctx.tenantId, id)
  if (!contact) return { success: false, error: 'Contacto no encontrado.' }

  const raw = input as Record<string, unknown>

  // Normalize phone if provided
  if (typeof raw?.phone === 'string' && raw.phone) {
    const normalizedPhone = normalizePhoneForWhatsApp(raw.phone)
    if (!isValidARWhatsAppPhone(normalizedPhone)) {
      return { success: false, error: 'Teléfono inválido. Ingresá un número móvil argentino (ej: 11 1234 5678).' }
    }
    ;(raw as Record<string, unknown>).phone = normalizedPhone
  }

  const normalizedInput = {
    ...raw,
    email: typeof raw?.email === 'string' ? normalizeEmail(raw.email) : raw?.email,
  }

  const parsed = updateContactSchema.safeParse(normalizedInput)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos' }
  }

  try {
    await repo.updateContact(ctx.tenantId, id, parsed.data)
    revalidatePath(LIST_PATH)
    revalidatePath(DETAIL_PATH(id))
    return { success: true }
  } catch (err) {
    return { success: false, error: handleContactRepoError(err) }
  }
}

export async function archiveContactAction(id: string): Promise<ActionResult> {
  const ctx = await requireTenantContext()
  if (ctx.accessMode === 'setup_operator') return { success: false, error: 'No disponible en modo setup.' }

  if (ctx.role !== 'owner') {
    return { success: false, error: 'Solo los owners pueden archivar contactos.' }
  }

  const contact = await repo.getContactById(ctx.tenantId, id)
  if (!contact) return { success: false, error: 'Contacto no encontrado.' }

  const hasOpen = await repo.hasActiveConversations(ctx.tenantId, id)
  if (hasOpen) {
    return {
      success: false,
      error: 'El contacto tiene conversaciones abiertas. Cerralas antes de archivarlo.',
    }
  }

  try {
    await repo.archiveContact(ctx.tenantId, id)
    revalidatePath(LIST_PATH)
    revalidatePath(DETAIL_PATH(id))
    return { success: true }
  } catch {
    return { success: false, error: 'Error al archivar el contacto. Intentá de nuevo.' }
  }
}
