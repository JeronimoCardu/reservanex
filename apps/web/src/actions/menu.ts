'use server'

import { revalidatePath } from 'next/cache'
import {
  createMenuCategorySchema,
  updateMenuCategorySchema,
  createMenuItemSchema,
  updateMenuItemSchema,
} from '@orderflow/validators'
import { requireTenantContext, type TenantContext } from '@/lib/auth/require-tenant-context'
import { routeAllowsVertical } from '@/lib/dashboard/module-verticals'
import * as repo from '@/lib/repositories/menu.repository'
import { MenuRepositoryError } from '@/lib/repositories/menu.repository'
import type { ActionResult } from '@/lib/action-result'

// Fase 3E-C3A1 — administración del catálogo gastronómico.
//
// Dos guardas distintas, en este orden, y no son lo mismo:
//
//   1. RUBRO   ¿existe este módulo para el tenant? Una server action es un
//              endpoint POST alcanzable por cualquier usuario autenticado, así
//              que esconder la ruta no alcanza: se revalida acá con el MISMO
//              mapa que usa el guard de ruta.
//
//   2. PERMISO ¿puede este usuario modificarlo? Es un chequeo de UX que
//              adelanta el error con un mensaje útil. La AUTORIDAD son las
//              policies tenant_insert/update_menu_*, que exigen
//              (owner OR can_manage_menu) dentro de la base: si alguien
//              llamara a estas actions salteándose el chequeo, la escritura
//              fallaría igual.

const MENU_PATH  = '/dashboard/menu'
const MENU_ROUTE = '/dashboard/menu'

type Guard = { ok: true; ctx: TenantContext } | { ok: false; error: string }

async function guard(): Promise<Guard> {
  const ctx = await requireTenantContext()

  if (!routeAllowsVertical(MENU_ROUTE, ctx.vertical)) {
    return { ok: false, error: 'El menú no está disponible para este rubro.' }
  }
  if (!(ctx.role === 'owner' || ctx.canManageMenu)) {
    return { ok: false, error: 'No tenés permiso para administrar el menú.' }
  }
  return { ok: true, ctx }
}

/**
 * Traduce los errores que la BASE produce, no los que adivinamos.
 *
 * 23505 lo tira el índice único normalizado de categorías; 23503 lo tira
 * guard_menu_item_tenant(); 42501 es una policy de RLS rechazando la escritura,
 * que es lo que pasaría si el permiso se revocara entre el render y el submit.
 */
function mensajeDeError(err: unknown, contexto: 'categoria' | 'item'): string {
  if (err instanceof MenuRepositoryError) {
    switch (err.code) {
      case repo.UNIQUE_VIOLATION:
        return contexto === 'categoria'
          ? 'Ya existe una categoría con ese nombre. Los nombres se comparan sin distinguir mayúsculas ni espacios.'
          : 'Ese registro ya existe.'
      case repo.FK_VIOLATION:
        return 'Esa categoría no pertenece a tu organización.'
      case '42501':
        return 'No tenés permiso para administrar el menú.'
      case '23514':
        return contexto === 'categoria'
          ? 'El nombre de la categoría no es válido.'
          : 'Los datos del producto no son válidos.'
      case '22003':
        return 'El precio es demasiado grande.'
    }
  }
  return contexto === 'categoria'
    ? 'Error al guardar la categoría. Intentá de nuevo.'
    : 'Error al guardar el producto. Intentá de nuevo.'
}

// ─── Categorías ──────────────────────────────────────────────────────────────

export async function createMenuCategoryAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const g = await guard()
  if (!g.ok) return { success: false, error: g.error }

  const parsed = createMenuCategorySchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos.' }
  }

  try {
    const categoria = await repo.createMenuCategory(g.ctx.tenantId, parsed.data)
    revalidatePath(MENU_PATH)
    return { success: true, data: { id: categoria.id } }
  } catch (err) {
    console.error('[menu] createMenuCategoryAction failed:', err)
    return { success: false, error: mensajeDeError(err, 'categoria') }
  }
}

export async function updateMenuCategoryAction(
  id: string,
  input: unknown,
): Promise<ActionResult> {
  const g = await guard()
  if (!g.ok) return { success: false, error: g.error }

  const parsed = updateMenuCategorySchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos.' }
  }

  try {
    await repo.updateMenuCategory(g.ctx.tenantId, id, parsed.data)
    revalidatePath(MENU_PATH)
    return { success: true }
  } catch (err) {
    console.error('[menu] updateMenuCategoryAction failed:', err)
    return { success: false, error: mensajeDeError(err, 'categoria') }
  }
}

export async function setMenuCategoryActiveAction(
  id: string,
  active: boolean,
): Promise<ActionResult> {
  const g = await guard()
  if (!g.ok) return { success: false, error: g.error }

  try {
    await repo.setMenuCategoryActive(g.ctx.tenantId, id, active)
    revalidatePath(MENU_PATH)
    return { success: true }
  } catch (err) {
    console.error('[menu] setMenuCategoryActiveAction failed:', err)
    return { success: false, error: mensajeDeError(err, 'categoria') }
  }
}

export async function moveMenuCategoryAction(
  id: string,
  direction: 'up' | 'down',
): Promise<ActionResult> {
  const g = await guard()
  if (!g.ok) return { success: false, error: g.error }

  try {
    await repo.moveMenuCategory(g.ctx.tenantId, id, direction)
    revalidatePath(MENU_PATH)
    return { success: true }
  } catch (err) {
    console.error('[menu] moveMenuCategoryAction failed:', err)
    return { success: false, error: mensajeDeError(err, 'categoria') }
  }
}

// ─── Items ───────────────────────────────────────────────────────────────────

export async function createMenuItemAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const g = await guard()
  if (!g.ok) return { success: false, error: g.error }

  const parsed = createMenuItemSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos.' }
  }

  try {
    const item = await repo.createMenuItem(g.ctx.tenantId, parsed.data)
    revalidatePath(MENU_PATH)
    return { success: true, data: { id: item.id } }
  } catch (err) {
    console.error('[menu] createMenuItemAction failed:', err)
    return { success: false, error: mensajeDeError(err, 'item') }
  }
}

export async function updateMenuItemAction(id: string, input: unknown): Promise<ActionResult> {
  const g = await guard()
  if (!g.ok) return { success: false, error: g.error }

  const parsed = updateMenuItemSchema.safeParse(input)
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0]?.message ?? 'Datos inválidos.' }
  }

  try {
    await repo.updateMenuItem(g.ctx.tenantId, id, parsed.data)
    revalidatePath(MENU_PATH)
    return { success: true }
  } catch (err) {
    console.error('[menu] updateMenuItemAction failed:', err)
    return { success: false, error: mensajeDeError(err, 'item') }
  }
}

export async function setMenuItemPublishedAction(
  id: string,
  published: boolean,
): Promise<ActionResult> {
  const g = await guard()
  if (!g.ok) return { success: false, error: g.error }

  try {
    await repo.setMenuItemFlag(g.ctx.tenantId, id, 'published', published)
    revalidatePath(MENU_PATH)
    return { success: true }
  } catch (err) {
    console.error('[menu] setMenuItemPublishedAction failed:', err)
    return { success: false, error: mensajeDeError(err, 'item') }
  }
}

export async function setMenuItemAvailableAction(
  id: string,
  available: boolean,
): Promise<ActionResult> {
  const g = await guard()
  if (!g.ok) return { success: false, error: g.error }

  try {
    await repo.setMenuItemFlag(g.ctx.tenantId, id, 'available', available)
    revalidatePath(MENU_PATH)
    return { success: true }
  } catch (err) {
    console.error('[menu] setMenuItemAvailableAction failed:', err)
    return { success: false, error: mensajeDeError(err, 'item') }
  }
}

/**
 * Archivar y restaurar son la misma action con un booleano, no dos, porque son
 * la misma escritura sobre la misma columna. Nunca hay DELETE físico.
 */
export async function setMenuItemArchivedAction(
  id: string,
  archived: boolean,
): Promise<ActionResult> {
  const g = await guard()
  if (!g.ok) return { success: false, error: g.error }

  try {
    await repo.setMenuItemArchived(g.ctx.tenantId, id, archived)
    revalidatePath(MENU_PATH)
    return { success: true }
  } catch (err) {
    console.error('[menu] setMenuItemArchivedAction failed:', err)
    return { success: false, error: mensajeDeError(err, 'item') }
  }
}

export async function moveMenuItemAction(
  id: string,
  direction: 'up' | 'down',
): Promise<ActionResult> {
  const g = await guard()
  if (!g.ok) return { success: false, error: g.error }

  try {
    await repo.moveMenuItem(g.ctx.tenantId, id, direction)
    revalidatePath(MENU_PATH)
    return { success: true }
  } catch (err) {
    console.error('[menu] moveMenuItemAction failed:', err)
    return { success: false, error: mensajeDeError(err, 'item') }
  }
}
