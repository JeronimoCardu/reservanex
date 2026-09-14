'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { createClient } from '@orderflow/supabase/server'
import {
  createMenuCategorySchema,
  updateMenuCategorySchema,
  createMenuItemSchema,
  updateMenuItemSchema,
  saveMenuItemsSchema,
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

/**
 * Guardado por lotes de la grilla.
 *
 * Una sola llamada para todas las filas modificadas. Las tres capas de siempre y
 * en el mismo orden: rubro → permiso → RLS. La validación de cada fila usa
 * saveMenuItemsSchema, que extiende createMenuItemSchema y por lo tanto sigue
 * usando menuPriceSchema — el único parser de precios del producto. "1500.999" se
 * rechaza acá, con mensaje, antes de que NUMERIC(14,2) lo redondee en silencio.
 *
 * Si una fila falla, las demás se guardan igual y se devuelve cuáles fallaron con
 * su nombre. No se finge un éxito global.
 */
export async function saveMenuItemsAction(
  input: unknown,
): Promise<ActionResult<{ saved: number; failed: { id: string; error: string }[] }>> {
  const g = await guard()
  if (!g.ok) return { success: false, error: g.error }

  const parsed = saveMenuItemsSchema.safeParse(input)
  if (!parsed.success) {
    const primero = parsed.error.errors[0]
    // El índice de la fila ayuda: "Ingresá un precio válido" sin decir dónde no
    // sirve de nada cuando hay veinte filas editadas.
    const fila = typeof primero?.path?.[1] === 'number' ? ` (fila ${primero.path[1] + 1})` : ''
    return { success: false, error: `${primero?.message ?? 'Datos inválidos.'}${fila}` }
  }

  try {
    const resultados = await repo.updateMenuItemsBatch(g.ctx.tenantId, parsed.data.changes)
    revalidatePath(MENU_PATH)

    const fallidas = resultados.filter((r) => !r.ok)
    const nombrePorId = new Map(parsed.data.changes.map((c) => [c.id, c.name]))

    if (fallidas.length === 0) {
      return { success: true, data: { saved: resultados.length, failed: [] } }
    }

    return {
      success: true,
      data: {
        saved:  resultados.length - fallidas.length,
        failed: fallidas.map((f) => ({
          id:    f.id,
          error: `${nombrePorId.get(f.id) ?? 'Producto'}: ${mensajeDeError(
            new MenuRepositoryError(f.error ?? '', f.code ?? null), 'item',
          )}`,
        })),
      },
    }
  } catch (err) {
    console.error('[menu] saveMenuItemsAction failed:', err)
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

// ─── Imágenes ────────────────────────────────────────────────────────────────

const MENU_BUCKET = 'menu-images'
const IMG_MIME    = ['image/jpeg', 'image/png', 'image/webp'] as const
const IMG_MAX     = 5 * 1024 * 1024

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
}

/**
 * Sube (o reemplaza) la foto de un producto.
 *
 * ── EL TENANT NUNCA VIENE DEL BROWSER ─────────────────────────────────────
 * Sale de requireTenantContext(). El path se arma con ese tenant, y además la
 * policy de storage exige que el primer segmento sea auth_tenant_id(): aunque
 * alguien llamara a esta action con otro item, no podría escribir fuera de su
 * carpeta.
 *
 * ── ORDEN SEGURO AL REEMPLAZAR (§6) ───────────────────────────────────────
 *   1. sube la nueva (uuid nuevo, upsert:false — nunca pisa un objeto)
 *   2. actualiza la DB
 *   3. recién entonces borra la anterior
 *
 * Al revés —borrar y después subir— un fallo en el medio dejaría al producto
 * sin imagen. Así, el peor caso es un archivo viejo que sobrevive, y eso no
 * rompe nada: queda registrado en el log y la purga del tenant lo levanta igual
 * porque enumera por fila, no por prefijo... salvo que la fila ya apunte a la
 * nueva. Por eso el huérfano se reporta explícitamente en vez de esconderse.
 */
export async function uploadMenuImageAction(
  itemId: string,
  formData: FormData,
): Promise<ActionResult<{ publicUrl: string; storagePath: string }>> {
  const g = await guard()
  if (!g.ok) return { success: false, error: g.error }

  const raw = formData.get('file')
  if (!raw || typeof raw === 'string') {
    return { success: false, error: 'No se recibió ningún archivo.' }
  }
  const file = raw as File

  if (!IMG_MIME.includes(file.type as (typeof IMG_MIME)[number])) {
    return { success: false, error: 'Solo se admiten imágenes JPG, PNG o WebP.' }
  }
  if (file.size > IMG_MAX) {
    return { success: false, error: 'La imagen no puede superar 5 MB.' }
  }
  if (file.size === 0) {
    return { success: false, error: 'El archivo está vacío.' }
  }

  // El item tiene que existir y ser de este tenant. Se lee con el cliente del
  // usuario, así que RLS ya lo limita a su tenant; el maybeSingle vacío cubre
  // tanto "no existe" como "es de otro".
  const actual = await repo.getMenuItemImage(g.ctx.tenantId, itemId).catch(() => null)
  if (!actual) return { success: false, error: 'Producto no encontrado.' }

  const path = `${g.ctx.tenantId}/${randomUUID()}.${EXT[file.type]}`

  // Cliente del USUARIO: las policies de storage.objects son la autoridad, igual
  // que RLS lo es para las tablas.
  const supabase = await createClient()
  const { error: upErr } = await supabase.storage
    .from(MENU_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false })

  if (upErr) {
    console.error('[menu] uploadMenuImageAction: upload failed', { code: upErr.message })
    return { success: false, error: 'Error al subir la imagen. Intentá de nuevo.' }
  }

  const { data: urlData } = supabase.storage.from(MENU_BUCKET).getPublicUrl(path)
  const publicUrl = urlData.publicUrl

  try {
    await repo.setMenuItemImage(g.ctx.tenantId, itemId, { url: publicUrl, storagePath: path })
  } catch (err) {
    // La DB no quedó apuntando al archivo nuevo: se borra para no dejar basura.
    await supabase.storage.from(MENU_BUCKET).remove([path]).catch(() => undefined)
    console.error('[menu] uploadMenuImageAction: db update failed', err)
    return { success: false, error: mensajeDeError(err, 'item') }
  }

  // Paso 3: la anterior, si había. Ya no la referencia nadie.
  let warning: string | undefined
  if (actual.image_storage_path && actual.image_storage_path !== path) {
    const { error: delErr } = await supabase.storage
      .from(MENU_BUCKET).remove([actual.image_storage_path])
    if (delErr) {
      // NO se rompe el item: la imagen nueva ya está guardada y visible. Queda
      // un archivo huérfano, y se dice en voz alta en vez de fingir que no.
      console.error('[menu] uploadMenuImageAction: orphan file left in storage', {
        bucket: MENU_BUCKET, path: actual.image_storage_path, reason: delErr.message,
      })
      warning = 'La imagen se guardó, pero no se pudo borrar la anterior del almacenamiento.'
    }
  }

  revalidatePath(MENU_PATH)
  return { success: true, data: { publicUrl, storagePath: path }, ...(warning && { warning }) }
}

/**
 * Quita la foto de un producto. NO archiva el item: la imagen es opcional.
 *
 * Orden inverso al de subir, y por la misma razón: primero se limpia la DB y
 * después el archivo. Si el borrado del archivo falla, el producto ya quedó sin
 * imagen (que es lo que se pidió) y lo único que sobra es un objeto huérfano
 * reportado. Al revés, un fallo entre borrar el archivo y limpiar la DB dejaría
 * al item apuntando a una imagen rota.
 */
export async function removeMenuImageAction(itemId: string): Promise<ActionResult> {
  const g = await guard()
  if (!g.ok) return { success: false, error: g.error }

  const actual = await repo.getMenuItemImage(g.ctx.tenantId, itemId).catch(() => null)
  if (!actual) return { success: false, error: 'Producto no encontrado.' }
  if (!actual.image_storage_path) {
    return { success: false, error: 'Ese producto no tiene imagen.' }
  }

  try {
    await repo.setMenuItemImage(g.ctx.tenantId, itemId, null)
  } catch (err) {
    console.error('[menu] removeMenuImageAction: db update failed', err)
    return { success: false, error: mensajeDeError(err, 'item') }
  }

  const supabase = await createClient()
  const { error: delErr } = await supabase.storage
    .from(MENU_BUCKET).remove([actual.image_storage_path])

  revalidatePath(MENU_PATH)

  if (delErr) {
    console.error('[menu] removeMenuImageAction: orphan file left in storage', {
      bucket: MENU_BUCKET, path: actual.image_storage_path, reason: delErr.message,
    })
    return {
      success: true,
      warning: 'Se quitó la imagen del producto, pero el archivo sigue en el almacenamiento.',
    }
  }
  return { success: true }
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
