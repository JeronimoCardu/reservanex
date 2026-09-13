import { z } from 'zod'

// Fase 3E-C3A1 — catálogo gastronómico.
//
// Estos schemas validan lo que escribe el DASHBOARD, que es la fuente
// autorizada del tenant para su propia carta. No tienen nada que ver con un
// futuro carrito público: ahí el browser va a mandar identificadores y
// cantidades, y el precio lo va a resolver el servidor contra menu_items.

// ── Precio ────────────────────────────────────────────────────────────────
//
// La columna es NUMERIC(14,2), y eso NO rechaza más de dos decimales: los
// REDONDEA. Verificado contra la base real:
//
//   1000.999 → 1001.00     1000.994 → 1000.99
//   1000.995 → 1001.00     0.001    → 0.00
//
// O sea que si dejáramos pasar 1000.999, el dueño vería un precio distinto al
// que escribió y nadie se lo avisaría. Por eso el rechazo es acá, explícito y
// con mensaje: la base es la ÚLTIMA garantía, no la única ni la primera.
//
// 12 dígitos enteros es exactamente lo que entra en NUMERIC(14,2). El regex lo
// hace explícito en vez de dejar que la base tire un 22003 sin mensaje útil.
const PRICE_PATTERN = /^\d{1,12}(\.\d{1,2})?$/

export const menuPriceSchema = z.preprocess(
  (v) => {
    // Un number llega del código; un string, del formulario. Se normaliza a
    // string para poder mirar los decimales TAL COMO se escribieron: una vez
    // que es number, 1000.999 y 1001 son indistinguibles después del redondeo.
    if (typeof v === 'number') return String(v)
    if (typeof v === 'string') return v.trim()
    return v
  },
  z
    .string({ required_error: 'El precio es requerido.' })
    .min(1, 'El precio es requerido.')
    // Cubre de una sola vez: negativos, NaN, Infinity, notación científica,
    // texto suelto y más de dos decimales.
    .regex(PRICE_PATTERN, 'Ingresá un precio válido, con hasta dos decimales. Por ejemplo: 1500.50')
    .transform((s) => Number(s)),
)

// ── Categorías ────────────────────────────────────────────────────────────
//
// El largo coincide con el CHECK de menu_categories_name_check.
export const createMenuCategorySchema = z.object({
  name: z
    .string({ required_error: 'El nombre es requerido.' })
    .trim()
    .min(1, 'El nombre es requerido.')
    .max(60, 'Máximo 60 caracteres.'),
})

// Misma forma que create: renombrar es lo único editable de una categoría
// (activar/desactivar y ordenar son acciones propias, no ediciones de campos).
export const updateMenuCategorySchema = createMenuCategorySchema

// ── Items ─────────────────────────────────────────────────────────────────
//
// create y update comparten forma a propósito: los campos editables de un item
// son exactamente los mismos que los de creación. published y available NO
// están acá — se cambian con acciones propias, porque son decisiones distintas
// a "editar el producto" y tienen su propio permiso de lectura en la UI.
//
// currency tampoco está, y no es un olvido: la moneda es tenants.currency y el
// usuario no puede escribirla.
export const createMenuItemSchema = z.object({
  category_id: z
    .string({ required_error: 'Elegí una categoría.' })
    .uuid('Categoría inválida.'),

  name: z
    .string({ required_error: 'El nombre es requerido.' })
    .trim()
    .min(1, 'El nombre es requerido.')
    .max(120, 'Máximo 120 caracteres.'),

  description: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
    z.string().trim().max(1000, 'Máximo 1000 caracteres.').optional(),
  ),

  base_price: menuPriceSchema,
})

export const updateMenuItemSchema = createMenuItemSchema

export type CreateMenuCategoryInput = z.infer<typeof createMenuCategorySchema>
export type UpdateMenuCategoryInput = z.infer<typeof updateMenuCategorySchema>
export type CreateMenuItemInput     = z.infer<typeof createMenuItemSchema>
export type UpdateMenuItemInput     = z.infer<typeof updateMenuItemSchema>
