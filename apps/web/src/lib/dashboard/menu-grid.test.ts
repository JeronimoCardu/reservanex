import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  EMPTY_FILTERS,
  activeFilterCount,
  buildChanges,
  dirtyRowIds,
  draftFromRow,
  draftsFromRows,
  filterMenuRows,
  hasActiveFilters,
  inactiveCategoryIds,
  isRowDirty,
  menuRowLabels,
  registroLabel,
  samePrice,
  type MenuFilters,
  type MenuGridRow,
  type MenuRowDraft,
} from './menu-grid'

// Refinamiento UX de 3E-C3A1 — la lógica de la grilla.
//
// Todo lo que decide qué se ve y qué cambió es puro, así que se prueba sin
// renderizar. Lo que sí es del componente (permisos, readonly) va como test de
// CABLEADO leyendo el fuente, que es lo que se puede afirmar sin jsdom.

const CAT_ENTRADAS = '11111111-1111-4111-8111-111111111111'
const CAT_PIZZAS   = '22222222-2222-4222-8222-222222222222'
const CAT_BEBIDAS  = '33333333-3333-4333-8333-333333333333'

function row(over: Partial<MenuGridRow> & { id: string }): MenuGridRow {
  return {
    categoryId:     CAT_ENTRADAS,
    categoryName:   'Entradas',
    categoryActive: true,
    name:           'Producto',
    description:    '',
    price:          '1000.00',
    published:      false,
    available:      true,
    archived:       false,
    ...over,
  }
}

const EMPANADA = row({
  id: 'a1', name: 'Empanada de carne', description: 'Carne cortada a cuchillo',
  price: '1500.00', published: true,
})
const PIZZA_CHICA = row({
  id: 'a2', categoryId: CAT_PIZZAS, categoryName: 'Pizzas',
  name: 'Pizza Muzzarella Chica', description: 'Salsa, muzzarella y orégano',
  price: '10000.00', published: true,
})
const PIZZA_GRANDE = row({
  id: 'a3', categoryId: CAT_PIZZAS, categoryName: 'Pizzas',
  name: 'Pizza Muzzarella Grande', description: 'Salsa, muzzarella y orégano',
  price: '15000.00', published: false, available: false,
})
// Espeja el dato real del fixture manual: publicado, NO disponible y en una
// categoría inactiva. Es exactamente la fila que se leía mal.
const AGUA = row({
  id: 'a4', categoryId: CAT_BEBIDAS, categoryName: 'Bebidas', categoryActive: false,
  name: 'Agua 500ml', description: 'Sin gas', price: '2000.00',
  published: true, available: false,
})
const PAN = row({
  id: 'a5', name: 'Pan de cortesía', description: 'Con chimichurri',
  price: '0.00', published: true, archived: true,
})

const ROWS: MenuGridRow[] = [EMPANADA, PIZZA_CHICA, PIZZA_GRANDE, AGUA, PAN]

const con = (over: Partial<MenuFilters>): MenuFilters => ({ ...EMPTY_FILTERS, ...over })
const ids = (rs: MenuGridRow[]) => rs.map((r) => r.id)

// ─── Búsqueda ────────────────────────────────────────────────────────────────

describe('filterMenuRows — búsqueda', () => {
  it('A. encuentra por nombre', () => {
    expect(ids(filterMenuRows(ROWS, con({ query: 'empanada' })))).toEqual(['a1'])
  })

  it('A. un nombre parcial trae todas las coincidencias', () => {
    expect(ids(filterMenuRows(ROWS, con({ query: 'pizza' })))).toEqual(['a2', 'a3'])
  })

  it('B. no distingue mayúsculas', () => {
    for (const q of ['EMPANADA', 'Empanada', 'eMpAnAdA']) {
      expect(ids(filterMenuRows(ROWS, con({ query: q }))), q).toEqual(['a1'])
    }
  })

  it('B. recorta espacios', () => {
    expect(ids(filterMenuRows(ROWS, con({ query: '   pizza   ' })))).toEqual(['a2', 'a3'])
  })

  it('C. encuentra por descripción', () => {
    expect(ids(filterMenuRows(ROWS, con({ query: 'cuchillo' })))).toEqual(['a1'])
    expect(ids(filterMenuRows(ROWS, con({ query: 'orégano' })))).toEqual(['a2', 'a3'])
  })

  it('D. encuentra por nombre de categoría', () => {
    expect(ids(filterMenuRows(ROWS, con({ query: 'bebidas' })))).toEqual(['a4'])
  })

  it('una búsqueda vacía no filtra nada', () => {
    expect(ids(filterMenuRows(ROWS, con({ query: '   ', status: 'all' })))).toHaveLength(5)
  })

  it('una búsqueda sin coincidencias devuelve vacío', () => {
    expect(filterMenuRows(ROWS, con({ query: 'sushi' }))).toEqual([])
  })
})

// ─── Filtros ─────────────────────────────────────────────────────────────────

describe('filterMenuRows — filtros', () => {
  it('E. filtra por categoría', () => {
    expect(ids(filterMenuRows(ROWS, con({ categoryId: CAT_PIZZAS })))).toEqual(['a2', 'a3'])
    expect(ids(filterMenuRows(ROWS, con({ categoryId: CAT_BEBIDAS })))).toEqual(['a4'])
  })

  it('F. filtra por publicación', () => {
    expect(ids(filterMenuRows(ROWS, con({ publication: 'published' })))).toEqual(['a1', 'a2', 'a4'])
    expect(ids(filterMenuRows(ROWS, con({ publication: 'draft' })))).toEqual(['a3'])
  })

  it('G. filtra por disponibilidad', () => {
    expect(ids(filterMenuRows(ROWS, con({ availability: 'unavailable' })))).toEqual(['a3', 'a4'])
    expect(ids(filterMenuRows(ROWS, con({ availability: 'available' })))).toEqual(['a1', 'a2'])
  })

  it('H. filtra por estado activo/archivado', () => {
    // 'active' es el default: los archivados no se ven salvo que se los pida.
    expect(ids(filterMenuRows(ROWS, EMPTY_FILTERS))).toEqual(['a1', 'a2', 'a3', 'a4'])
    expect(ids(filterMenuRows(ROWS, con({ status: 'archived' })))).toEqual(['a5'])
    expect(ids(filterMenuRows(ROWS, con({ status: 'all' })))).toHaveLength(5)
  })

  it('published y available son independientes', () => {
    // a3 está en borrador Y no disponible; a2 publicado y disponible.
    expect(ids(filterMenuRows(ROWS, con({ publication: 'draft', availability: 'unavailable' })))).toEqual(['a3'])
    // a4 es publicado Y no disponible: la combinación existe y es válida.
    expect(ids(filterMenuRows(ROWS, con({ publication: 'published', availability: 'unavailable' })))).toEqual(['a4'])
  })

  it('I. combina búsqueda con todos los filtros', () => {
    // El ejemplo textual del pedido: query=pizza + categoría Pizzas +
    // no disponibles + activos.
    const r = filterMenuRows(ROWS, con({
      query: 'pizza', categoryId: CAT_PIZZAS, availability: 'unavailable', status: 'active',
    }))
    expect(ids(r)).toEqual(['a3'])
  })

  it('I. una combinación sin coincidencias devuelve vacío', () => {
    expect(filterMenuRows(ROWS, con({ query: 'pizza', categoryId: CAT_BEBIDAS }))).toEqual([])
  })

  it('I. buscar un archivado exige además cambiar Estado', () => {
    expect(filterMenuRows(ROWS, con({ query: 'cortesía' }))).toEqual([])
    expect(ids(filterMenuRows(ROWS, con({ query: 'cortesía', status: 'archived' })))).toEqual(['a5'])
  })

  it('conserva el orden del servidor: filtrar oculta, no reordena', () => {
    const r = filterMenuRows(ROWS, con({ status: 'all' }))
    expect(ids(r)).toEqual(ids(ROWS))
  })
})

describe('J. contador', () => {
  it('total y visibles se calculan sobre el mismo dataset', () => {
    const filtros = con({ categoryId: CAT_PIZZAS })
    expect(ROWS.length).toBe(5)
    expect(filterMenuRows(ROWS, filtros)).toHaveLength(2)
  })

  it('sin filtros, "visibles" no se muestra porque no hay nada filtrado', () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false)
  })

  it('con filtros, hay algo que contar', () => {
    expect(hasActiveFilters(con({ query: 'pizza' }))).toBe(true)
    expect(hasActiveFilters(con({ categoryId: CAT_PIZZAS }))).toBe(true)
    expect(hasActiveFilters(con({ publication: 'draft' }))).toBe(true)
    expect(hasActiveFilters(con({ availability: 'unavailable' }))).toBe(true)
    expect(hasActiveFilters(con({ status: 'archived' }))).toBe(true)
  })

  it('una búsqueda de solo espacios no cuenta como filtro activo', () => {
    expect(hasActiveFilters(con({ query: '   ' }))).toBe(false)
  })
})

describe('K. limpiar filtros', () => {
  it('EMPTY_FILTERS deja todo sin filtrar', () => {
    const sucios = con({
      query: 'pizza', categoryId: CAT_PIZZAS, publication: 'draft',
      availability: 'unavailable', status: 'archived',
    })
    expect(hasActiveFilters(sucios)).toBe(true)
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false)
    expect(ids(filterMenuRows(ROWS, EMPTY_FILTERS))).toEqual(['a1', 'a2', 'a3', 'a4'])
  })

  it('el contador de filtros para el badge de móvil ignora la búsqueda', () => {
    // La búsqueda tiene su propio campo siempre visible; el badge cuenta lo que
    // está escondido detrás del botón "Filtros".
    expect(activeFilterCount(con({ query: 'pizza' }))).toBe(0)
    expect(activeFilterCount(con({ categoryId: CAT_PIZZAS, publication: 'draft' }))).toBe(2)
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0)
  })
})

describe('T. filtrar no muta el dataset original', () => {
  it('no reordena ni modifica el arreglo de entrada', () => {
    const copia = JSON.parse(JSON.stringify(ROWS))
    filterMenuRows(ROWS, con({ query: 'pizza', categoryId: CAT_PIZZAS, status: 'all' }))
    expect(ROWS).toEqual(copia)
  })

  it('devuelve un arreglo nuevo', () => {
    const r = filterMenuRows(ROWS, con({ status: 'all' }))
    expect(r).not.toBe(ROWS)
  })
})

// ─── Cambios sin guardar ─────────────────────────────────────────────────────

describe('samePrice', () => {
  it('compara como dinero, no como texto', () => {
    expect(samePrice('1500.50', '1500.5')).toBe(true)
    expect(samePrice('1000.00', '1000')).toBe(true)
    expect(samePrice('0.00', '0')).toBe(true)
  })

  it('distingue montos distintos', () => {
    expect(samePrice('1500.50', '1500.51')).toBe(false)
  })

  it('cae a comparación de texto cuando un precio no es válido', () => {
    // Mientras el usuario tipea "1500." todavía no parsea: la fila queda
    // marcada y el error aparece al guardar.
    expect(samePrice('1500.', '1500.00')).toBe(false)
    expect(samePrice('1500.999', '1500.999')).toBe(true)
  })
})

describe('L/M/N. detección de cambios', () => {
  const base = draftsFromRows(ROWS)

  it('L. sin ediciones no hay filas modificadas', () => {
    expect(dirtyRowIds(ROWS, base)).toEqual([])
  })

  it('M. editar el nombre marca la fila', () => {
    const d = { ...base, a1: { ...base.a1!, name: 'Empanada de pollo' } }
    expect(dirtyRowIds(ROWS, d)).toEqual(['a1'])
  })

  it('M. editar precio, descripción, categoría o los toggles también marca', () => {
    const casos: [string, Partial<MenuRowDraft>][] = [
      ['precio',      { price: '1600.00' }],
      ['descripción', { description: 'Otra cosa' }],
      ['categoría',   { categoryId: CAT_PIZZAS }],
      ['publicado',   { published: false }],
      ['disponible',  { available: false }],
    ]
    for (const [etiqueta, patch] of casos) {
      const d = { ...base, a1: { ...base.a1!, ...patch } }
      expect(dirtyRowIds(ROWS, d), etiqueta).toEqual(['a1'])
    }
  })

  it('N. volver a mano al valor original deja de estar modificada', () => {
    const editada  = { ...base, a1: { ...base.a1!, name: 'Otro nombre' } }
    expect(dirtyRowIds(ROWS, editada)).toEqual(['a1'])

    const revertida = { ...base, a1: { ...base.a1!, name: EMPANADA.name } }
    expect(dirtyRowIds(ROWS, revertida)).toEqual([])
  })

  it('N. vale también para los toggles', () => {
    const apagado  = { ...base, a1: { ...base.a1!, published: false } }
    expect(dirtyRowIds(ROWS, apagado)).toEqual(['a1'])
    const vuelto = { ...base, a1: { ...base.a1!, published: true } }
    expect(dirtyRowIds(ROWS, vuelto)).toEqual([])
  })

  it('N. escribir el mismo precio con otra forma no marca la fila', () => {
    // a1 vale 1500.00; "1500" es el MISMO dinero escrito distinto.
    const d = { ...base, a1: { ...base.a1!, price: '1500' } }
    expect(dirtyRowIds(ROWS, d)).toEqual([])

    // Y un monto realmente distinto sí marca, aunque se parezca.
    const otro = { ...base, a1: { ...base.a1!, price: '1500.5' } }
    expect(dirtyRowIds(ROWS, otro)).toEqual(['a1'])
  })

  it('los espacios al borde no cuentan como cambio', () => {
    const d = { ...base, a1: { ...base.a1!, name: '  Empanada de carne  ' } }
    expect(isRowDirty(EMPANADA, d.a1!)).toBe(false)
  })

  it('varias filas modificadas se reportan todas, en el orden del dataset', () => {
    const d = {
      ...base,
      a4: { ...base.a4!, price: '2500.00' },
      a1: { ...base.a1!, name: 'X' },
    }
    expect(dirtyRowIds(ROWS, d)).toEqual(['a1', 'a4'])
  })
})

describe('O. descartar', () => {
  it('draftsFromRows restaura exactamente lo que hay guardado', () => {
    const base = draftsFromRows(ROWS)
    const editados = {
      ...base,
      a1: { ...base.a1!, name: 'X', price: '9.99', published: false },
      a3: { ...base.a3!, description: 'Y' },
    }
    expect(dirtyRowIds(ROWS, editados)).toEqual(['a1', 'a3'])

    const restaurados = draftsFromRows(ROWS)
    expect(dirtyRowIds(ROWS, restaurados)).toEqual([])
    expect(restaurados.a1).toEqual(draftFromRow(EMPANADA))
  })
})

describe('P. el lote solo lleva las filas modificadas', () => {
  const base = draftsFromRows(ROWS)

  it('sin cambios, no se manda nada', () => {
    expect(buildChanges(ROWS, base)).toEqual([])
  })

  it('manda solo las tocadas, con todos sus campos', () => {
    const d = {
      ...base,
      a2: { ...base.a2!, price: '11000.50', available: false },
    }
    const changes = buildChanges(ROWS, d)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toEqual({
      id:          'a2',
      category_id: CAT_PIZZAS,
      name:        'Pizza Muzzarella Chica',
      description: 'Salsa, muzzarella y orégano',
      base_price:  '11000.50',
      published:   true,
      available:   false,
    })
  })

  it('el precio viaja como string, sin normalizar', () => {
    // Es lo que permite que el servidor rechace >2 decimales con mensaje en
    // lugar de que NUMERIC(14,2) lo redondee en silencio.
    const d = { ...base, a1: { ...base.a1!, price: '1500.999' } }
    const changes = buildChanges(ROWS, d)
    expect(changes[0]!.base_price).toBe('1500.999')
  })

  it('recorta espacios de nombre y descripción antes de mandar', () => {
    const d = { ...base, a1: { ...base.a1!, name: '  Empanada X  ', description: '  Y  ' } }
    const changes = buildChanges(ROWS, d)
    expect(changes[0]!.name).toBe('Empanada X')
    expect(changes[0]!.description).toBe('Y')
  })

  it('una fila revertida a mano no entra en el lote', () => {
    const d = { ...base, a1: { ...base.a1!, name: EMPANADA.name } }
    expect(buildChanges(ROWS, d)).toEqual([])
  })

  it('incluye filas archivadas si se editaron', () => {
    const d = { ...base, a5: { ...base.a5!, price: '1.00' } }
    expect(buildChanges(ROWS, d).map((c) => c.id)).toEqual(['a5'])
  })
})

// ─── Vocabulario: tres dimensiones que no se pisan ───────────────────────────

describe('vocabulario de las tres dimensiones', () => {
  it('1. no disponible + no archivado → "No disponible" y "Vigente"', () => {
    // El caso exacto que se veía mal: decía "Activo" en verde al lado de un
    // toggle apagado, y las dos cosas se leían como lo mismo.
    const r = row({ id: 'x', available: false, archived: false, published: true })
    expect(menuRowLabels(r)).toEqual({
      publicacion:    'Publicado',
      disponibilidad: 'No disponible',
      registro:       'Vigente',
    })
  })

  it('2. disponible + no archivado → "Disponible" y "Vigente"', () => {
    const r = row({ id: 'x', available: true, archived: false, published: false })
    expect(menuRowLabels(r)).toEqual({
      publicacion:    'Borrador',
      disponibilidad: 'Disponible',
      registro:       'Vigente',
    })
  })

  it('3. archivado → "Archivado", sin importar disponibilidad ni publicación', () => {
    for (const available of [true, false]) {
      for (const published of [true, false]) {
        const r = row({ id: 'x', archived: true, available, published })
        expect(menuRowLabels(r).registro, `av=${available} pub=${published}`).toBe('Archivado')
      }
    }
  })

  it('"Activo" no existe en el vocabulario de los productos', () => {
    const todas = [true, false].flatMap((archived) =>
      [true, false].flatMap((available) =>
        [true, false].map((published) =>
          Object.values(menuRowLabels(row({ id: 'x', archived, available, published }))),
        ),
      ),
    ).flat()
    expect(todas).not.toContain('Activo')
    expect(todas).not.toContain('Activos')
  })

  it('registro depende SOLO de archived', () => {
    expect(registroLabel(false)).toBe('Vigente')
    expect(registroLabel(true)).toBe('Archivado')
  })

  it('las tres dimensiones son independientes entre sí', () => {
    // Un producto puede estar publicado, no disponible y vigente a la vez.
    const r = row({ id: 'x', published: true, available: false, archived: false })
    const l = menuRowLabels(r)
    expect(l.publicacion).toBe('Publicado')
    expect(l.disponibilidad).toBe('No disponible')
    expect(l.registro).toBe('Vigente')
    expect(new Set(Object.values(l)).size).toBe(3)
  })
})

describe('4. categoría inactiva', () => {
  const CATS = [
    { id: CAT_ENTRADAS, active: true },
    { id: CAT_BEBIDAS,  active: false },
  ]

  it('se identifica la categoría inactiva', () => {
    const inactivas = inactiveCategoryIds(CATS)
    expect(inactivas.has(CAT_BEBIDAS)).toBe(true)
    expect(inactivas.has(CAT_ENTRADAS)).toBe(false)
  })

  it('no altera published, available ni archived del producto', () => {
    // AGUA vive en Bebidas, que está inactiva en este fixture de categorías.
    const antes = { ...AGUA }
    inactiveCategoryIds(CATS)
    expect(menuRowLabels(AGUA)).toEqual({
      publicacion:    'Publicado',
      disponibilidad: 'No disponible',
      registro:       'Vigente',
    })
    expect(AGUA).toEqual(antes)
  })

  it('un producto de categoría inactiva se filtra igual que cualquier otro', () => {
    // La categoría inactiva es un aviso visual, no un filtro encubierto.
    expect(ids(filterMenuRows(ROWS, EMPTY_FILTERS))).toContain('a4')
    expect(ids(filterMenuRows(ROWS, con({ availability: 'unavailable' })))).toContain('a4')
    expect(ids(filterMenuRows(ROWS, con({ status: 'active' })))).toContain('a4')
  })

  it('y se marca igual de sucio que cualquier otro al editarlo', () => {
    const base = draftsFromRows(ROWS)
    const d = { ...base, a4: { ...base.a4!, price: '2100.00' } }
    expect(dirtyRowIds(ROWS, d)).toEqual(['a4'])
  })
})

describe('5. el filtro Registro mira deleted_at, nunca available', () => {
  // Dos filas construidas para que available y archived se contradigan: si el
  // filtro confundiera las dimensiones, estas dos caerían del lado equivocado.
  const NO_DISPONIBLE_VIGENTE = row({ id: 'v1', name: 'No disponible vigente', available: false, archived: false })
  const DISPONIBLE_ARCHIVADO  = row({ id: 'v2', name: 'Disponible archivado',  available: true,  archived: true  })
  const MIX = [NO_DISPONIBLE_VIGENTE, DISPONIBLE_ARCHIVADO]

  it('Vigentes trae el no disponible y deja fuera el archivado', () => {
    expect(ids(filterMenuRows(MIX, con({ status: 'active' })))).toEqual(['v1'])
  })

  it('Archivados trae el disponible archivado y deja fuera el vigente', () => {
    expect(ids(filterMenuRows(MIX, con({ status: 'archived' })))).toEqual(['v2'])
  })

  it('Todos los registros trae los dos', () => {
    expect(ids(filterMenuRows(MIX, con({ status: 'all' })))).toEqual(['v1', 'v2'])
  })

  it('el filtro de disponibilidad sigue siendo otro eje', () => {
    expect(ids(filterMenuRows(MIX, con({ status: 'all', availability: 'unavailable' })))).toEqual(['v1'])
    expect(ids(filterMenuRows(MIX, con({ status: 'all', availability: 'available' })))).toEqual(['v2'])
  })

  it('combinar los dos ejes no los mezcla', () => {
    // Vigentes + disponibles: ninguno, porque el único vigente no está disponible.
    expect(filterMenuRows(MIX, con({ status: 'active', availability: 'available' }))).toEqual([])
  })
})

// ─── Cableado ────────────────────────────────────────────────────────────────

const MENU_DIR = path.resolve(
  import.meta.dirname, '..', '..', 'app', '(tenant)', 'dashboard', 'menu',
)
const leer = (f: string) => fs.readFileSync(path.join(MENU_DIR, f), 'utf8')

describe('Q/R/S. permisos en la grilla', () => {
  it('R/S. la página calcula canManage por rol o por permiso', () => {
    const page = leer('page.tsx')
    expect(page).toContain("ctx.role === 'owner' || ctx.canManageMenu")
    expect(page).toContain('canManage={canManage}')
  })

  it('Q. sin permiso, los campos quedan deshabilitados y de solo lectura', () => {
    const client = leer('menu-client.tsx')
    // puedeEditar es la única compuerta de edición, y sale de canManage.
    expect(client).toContain('const puedeEditar = canManage && !isPending')
    expect(client).toContain('disabled={!puedeEditar}')
    expect(client).toContain('readOnly={!canManage}')
  })

  it('Q. sin permiso no se dibujan crear, guardar ni archivar', () => {
    const client = leer('menu-client.tsx')
    expect(client).toContain('{canManage && hayCambios && (')   // barra de guardado
    expect(client).toContain('{canManage && creando && (')       // alta inline
    // El menú de acciones de fila (archivar/restaurar/ordenar) va detrás de
    // canManage. Sin anclar la indentación, que cambia con cualquier reformateo.
    expect(client).toMatch(/\{canManage && \(\s*<DropdownMenu>/)
  })

  it('Q. los toggles no son mutables sin permiso', () => {
    const client = leer('menu-client.tsx')
    const toggles = client.match(/<Toggle\b[\s\S]*?\/>/g) ?? []
    expect(toggles.length).toBeGreaterThanOrEqual(2)
    for (const t of toggles) expect(t).toContain('disabled={!puedeEditar}')
  })
})

describe('cableado de la grilla', () => {
  it('no reimplementa el parseo de precios', () => {
    const client = leer('menu-client.tsx')
    // El precio se valida con el schema canónico del lado del servidor; el
    // componente solo transporta el string.
    expect(client).not.toContain('parseFloat')
    expect(client).not.toContain('Number(')
    expect(client).not.toMatch(/\/\^\\d/)
  })

  it('guarda por lotes, no una llamada por fila', () => {
    const client = leer('menu-client.tsx')
    expect(client).toContain('saveMenuItemsAction({ changes })')
    expect(client).toContain('buildChanges(rows, drafts)')
  })

  it('la grilla no rotula ningún producto como "Activo"', () => {
    const client = leer('menu-client.tsx')
    // Se mira solo lo RENDERIZADO: los comentarios sí explican por qué la
    // palabra se fue, y tienen que poder hacerlo.
    const sinComentarios = client
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

    for (const prohibido of ["'Activo'", "'Activos'", '>Activo<', '>Activos<']) {
      expect(sinComentarios, prohibido).not.toContain(prohibido)
    }
    // Y el rótulo sale de la función, no de un ternario suelto en el JSX.
    expect(sinComentarios).toContain('registroLabel(row.archived)')
  })

  it('la columna de deleted_at se llama Registro, no Estado', () => {
    const client = leer('menu-client.tsx')
    expect(client).toContain("'Registro'")
    expect(client).toContain('<Etiqueta>Registro</Etiqueta>')
    expect(client).toContain('ariaLabel="Filtrar por registro"')
    expect(client).toContain('<option value="active">Vigentes</option>')
    expect(client).toContain('<option value="all">Todos los registros</option>')
  })

  it('el badge de Registro no usa el verde de "disponible"', () => {
    const client = leer('menu-client.tsx')
    const celda = client.slice(
      client.indexOf('<Etiqueta>Registro</Etiqueta>'),
      client.indexOf('registroLabel(row.archived)'),
    )
    // El verde era la mitad de la confusión: un producto no disponible mostraba
    // su registro en verde justo al lado del toggle apagado.
    expect(celda).not.toContain('green')
  })

  it('avisa cuando la categoría de la fila está inactiva', () => {
    const client = leer('menu-client.tsx')
    expect(client).toContain('Categoría inactiva')
    // Mira la categoría del BORRADOR, para que el aviso salga al mover el item.
    expect(client).toContain('categoriaInactiva(d.categoryId)')
    expect(client).toContain('inactiveCategoryIds(categories)')
  })

  it('archivar sigue siendo deleted_at y nunca DELETE', () => {
    const client = leer('menu-client.tsx')
    expect(client).toContain('setMenuItemArchivedAction(row.id, true)')
    expect(client).toContain('setMenuItemArchivedAction(row.id, false)')
    expect(client).not.toContain('deleteMenuItem')
  })

  it('las capacidades ya validadas siguen accesibles', () => {
    const client = leer('menu-client.tsx')
    const cats   = leer('menu-categories-dialog.tsx')
    for (const accion of [
      'createMenuItemAction', 'saveMenuItemsAction',
      'setMenuItemArchivedAction', 'moveMenuItemAction',
    ]) expect(client, accion).toContain(accion)
    for (const accion of [
      'createMenuCategoryAction', 'updateMenuCategoryAction',
      'setMenuCategoryActiveAction', 'moveMenuCategoryAction',
    ]) expect(cats, accion).toContain(accion)
  })
})
