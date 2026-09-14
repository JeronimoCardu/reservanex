import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createSubmissionResponseSchema, type CreateSubmissionResponse } from '@orderflow/validators'
import {
  INITIAL_CHECKOUT_STATE,
  fromStructuredError,
  onSheetClosed,
  showsForm,
  successReference,
  toCart,
  toCheckout,
  toSuccess,
  type CheckoutState,
} from './checkout-flow'
import { buildSubmissionWhatsAppHref } from './submission-whatsapp'

// ════════════════════════════════════════════════════════════════════════════
// Fase 3E-C3B1 (fix) — el bug del success del checkout.
//
// LO QUE PASÓ: el pedido se creaba (SUB-WXS23Q en la base), el endpoint
// respondía 201, y en pantalla quedaba el formulario vacío en CHECKOUT. Sin
// referencia, sin CTA, sin nada.
//
// LA CAUSA: el sheet no tenía paso SUCCESS. El "¡Listo!" lo dibujaba el estado
// interno de DynamicForm, y el callback de éxito renovaba la clave de
// idempotencia que era la `key` de ese mismo DynamicForm. React lo desmontó.
//
// Como este repo no tiene entorno DOM (vitest corre en 'node', sin jsdom ni
// testing-library), el caso se defiende por dos lados:
//
//   1. la máquina de pasos, que es pura y es la que el componente USA;
//   2. aserciones ESTRUCTURALES sobre el fuente del componente, para el error
//      que es específicamente de React — que ninguna función pura podría ver.
// ════════════════════════════════════════════════════════════════════════════

const SRC  = path.resolve(import.meta.dirname, '..', '..')
const leer = (...p: string[]) => fs.readFileSync(path.join(SRC, ...p), 'utf8')

/** El fuente sin comentarios: lo que se menciona en una explicación no cuenta. */
function soloCodigo(texto: string): string {
  return texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')
}

const EXITO: CreateSubmissionResponse = {
  ok: true, reference: 'SUB-TEST01', deduplicated: false,
}

const enCheckout = (): CheckoutState => toCheckout(INITIAL_CHECKOUT_STATE)

// ── A. el resultado del POST llega completo ────────────────────────────────

describe('A. la respuesta real del POST', () => {
  it('el contrato acepta la forma que devuelve el endpoint', () => {
    const parsed = createSubmissionResponseSchema.safeParse({
      ok: true, reference: 'SUB-TEST01', deduplicated: false,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.reference).toBe('SUB-TEST01')
      expect(parsed.data.deduplicated).toBe(false)
    }
  })

  it('rechaza una respuesta a la que le falta deduplicated', () => {
    // Antes del fix el endpoint NO lo mandaba: solo se podía inferir del
    // 200-vs-201. El wrapper necesita el dato explícito.
    expect(createSubmissionResponseSchema.safeParse({ ok: true, reference: 'SUB-TEST01' }).success).toBe(false)
  })

  it('rechaza una referencia vacía: no hay éxito sin referencia que mostrar', () => {
    expect(createSubmissionResponseSchema.safeParse({ ok: true, reference: '', deduplicated: false }).success).toBe(false)
  })

  it('DynamicForm valida la respuesta con ESE schema y propaga el objeto entero', () => {
    const codigo = soloCodigo(leer('components', 'site', 'dynamic-form.tsx'))
    expect(codigo).toContain('createSubmissionResponseSchema.safeParse(data)')
    expect(codigo).toContain('onSubmitted?.(exito.data)')
    // Ya no propaga solo la referencia.
    expect(codigo).not.toContain('onSubmitted?.(ref)')
  })
})

// ── B / C. CHECKOUT + resultado → SUCCESS con la referencia ────────────────

describe('B/C. la transición a success', () => {
  it('B. desde checkout, un resultado lleva a success', () => {
    const s = toSuccess(enCheckout(), EXITO)
    expect(s.step).toBe('success')
  })

  it('C. y la referencia queda disponible para mostrarla', () => {
    const s = toSuccess(enCheckout(), EXITO)
    expect(s.result?.reference).toBe('SUB-TEST01')
    expect(successReference(s)).toBe('SUB-TEST01')
  })

  it('en cart o checkout no hay referencia que mostrar', () => {
    expect(successReference(INITIAL_CHECKOUT_STATE)).toBeNull()
    expect(successReference(enCheckout())).toBeNull()
  })

  it('success limpia el aviso y las marcas de un 409 anterior', () => {
    const conRuido: CheckoutState = {
      step: 'checkout', result: null,
      notice: { tone: 'price', text: 'algo' }, flagged: ['cl-1'],
    }
    const s = toSuccess(conRuido, EXITO)
    expect(s.notice).toBeNull()
    expect(s.flagged).toEqual([])
  })
})

// ── D / E. el CTA de WhatsApp ──────────────────────────────────────────────

describe('D/E. CTA de WhatsApp', () => {
  it('D. hay link cuando hay número y referencia', () => {
    expect(buildSubmissionWhatsAppHref('5491122334455', 'SUB-TEST01')).not.toBeNull()
  })

  it('E. el mensaje contiene la MISMA referencia', () => {
    const href = buildSubmissionWhatsAppHref('5491122334455', 'SUB-TEST01')!
    expect(href).toContain('SUB-TEST01')
    expect(decodeURIComponent(href)).toContain('Referencia: SUB-TEST01')
    expect(href.startsWith('https://wa.me/5491122334455?text=')).toBe(true)
  })

  it('el formato es EXACTAMENTE el de los otros formularios públicos', () => {
    // Un solo helper lo arma, y los dos lo importan: no hay una segunda forma
    // del mensaje que pueda divergir.
    const esperado = 'https://wa.me/549111?text='
      + encodeURIComponent('Hola, completé el formulario en ReservaNex.\nReferencia: SUB-TEST01')
    expect(buildSubmissionWhatsAppHref('549111', 'SUB-TEST01')).toBe(esperado)

    for (const archivo of ['dynamic-form.tsx', 'cart-sheet.tsx']) {
      expect(soloCodigo(leer('components', 'site', archivo)), archivo)
        .toContain('buildSubmissionWhatsAppHref')
    }
    // Y nadie se quedó una copia local.
    expect(soloCodigo(leer('components', 'site', 'dynamic-form.tsx'))).not.toContain('https://wa.me/')
    expect(soloCodigo(leer('components', 'site', 'cart-sheet.tsx'))).not.toContain('https://wa.me/')
  })

  it('sin número o sin referencia NO se ofrece un link roto', () => {
    expect(buildSubmissionWhatsAppHref(null, 'SUB-TEST01')).toBeNull()
    expect(buildSubmissionWhatsAppHref('', 'SUB-TEST01')).toBeNull()
    expect(buildSubmissionWhatsAppHref('549111', null)).toBeNull()
    expect(buildSubmissionWhatsAppHref('549111', undefined)).toBeNull()
  })

  it('§5 — el CTA es un <a> visible, no una apertura automática', () => {
    const codigo = soloCodigo(leer('components', 'site', 'cart-sheet.tsx'))
    expect(codigo).toContain('Confirmar por WhatsApp')
    expect(codigo).toContain('href={waHref}')
    // Nada que intente abrir la ventana solo: un popup bloqueado dejaría al
    // visitante sin nada.
    expect(codigo).not.toContain('window.open')
    expect(codigo).not.toContain('location.href =')
    expect(codigo).not.toContain('location.assign')
  })
})

// ── F. el reset del formulario no puede borrar el éxito ────────────────────

describe('F. el resultado sobrevive al reset del formulario', () => {
  it('en el paso success el formulario NO se monta', () => {
    const s = toSuccess(enCheckout(), EXITO)
    expect(showsForm(s)).toBe(false)
    expect(showsForm(enCheckout())).toBe(true)
    expect(showsForm(INITIAL_CHECKOUT_STATE)).toBe(false)
  })

  it('EL BUG: la vista de success no contiene un DynamicForm que pueda remontarse', () => {
    const codigo = soloCodigo(leer('components', 'site', 'cart-sheet.tsx'))
    // Un solo montaje, y detrás de showsForm().
    expect((codigo.match(/<DynamicForm/g) ?? []).length).toBe(1)
    expect(codigo).toContain('showsForm(flujo) ? (')

    // El bloque de success va ANTES del montaje del formulario en el árbol, y
    // entre los dos no hay otro <DynamicForm>.
    const iSuccess = codigo.indexOf("flujo.step === 'success' ? (")
    const iForm    = codigo.indexOf('<DynamicForm')
    expect(iSuccess).toBeGreaterThan(-1)
    expect(iSuccess).toBeLessThan(iForm)
  })

  it('EL BUG: el resultado se guarda ANTES de limpiar el carrito y de renovar la clave', () => {
    // El orden es el fix. Al revés, renovar la clave (que es la `key` del
    // DynamicForm) lo desmontaba y se perdía el éxito.
    const codigo = soloCodigo(leer('components', 'site', 'cart-sheet.tsx'))
    const i = codigo.indexOf('onSubmitted={(result) => {')
    expect(i).toBeGreaterThan(-1)
    const cuerpo = codigo.slice(i, codigo.indexOf('}}', i))

    const iSuccess = cuerpo.indexOf('toSuccess')
    const iLimpiar = cuerpo.indexOf('onLines([])')
    const iClave   = cuerpo.indexOf('setClaveIdem')

    expect(iSuccess).toBeGreaterThan(-1)
    expect(iSuccess).toBeLessThan(iLimpiar)
    expect(iSuccess).toBeLessThan(iClave)
  })

  it('el resultado vive en el wrapper, no en el estado interno del formulario', () => {
    const flujo = soloCodigo(leer('lib', 'site', 'checkout-flow.ts'))
    expect(flujo).toContain('result: CreateSubmissionResponse | null')
  })
})

// ── G. cerrar success ──────────────────────────────────────────────────────

describe('G. cerrar el success', () => {
  it('vuelve al estado inicial y descarta el resultado', () => {
    const cerrado = onSheetClosed()
    expect(cerrado).toEqual(INITIAL_CHECKOUT_STATE)
    expect(cerrado.step).toBe('cart')
    expect(cerrado.result).toBeNull()
  })

  it('el carrito ya quedó vacío al entrar a success, no al cerrar', () => {
    // Así el menú de atrás ya no muestra la barra del pedido viejo, y ese
    // carrito no se puede reenviar por accidente (§7).
    const codigo = soloCodigo(leer('components', 'site', 'cart-sheet.tsx'))
    const i = codigo.indexOf('onSubmitted={(result) => {')
    expect(codigo.slice(i, codigo.indexOf('}}', i))).toContain('onLines([])')
  })

  it('§6 — el sheet NO se cierra solo al recibir el éxito', () => {
    const codigo = soloCodigo(leer('components', 'site', 'cart-sheet.tsx'))
    const i = codigo.indexOf('onSubmitted={(result) => {')
    const cuerpo = codigo.slice(i, codigo.indexOf('}}', i))
    expect(cuerpo).not.toContain('onClose')
    // Y hay una acción explícita para cerrarlo.
    expect(codigo).toContain('Cerrar')
  })

  it('el resultado se descarta recién al cerrar el panel', () => {
    const codigo = soloCodigo(leer('components', 'site', 'cart-sheet.tsx'))
    expect(codigo).toContain('if (!open) setFlujo(onSheetClosed())')
  })
})

// ── H. deduplicated no es un error ─────────────────────────────────────────

describe('H. reintento idempotente', () => {
  it('deduplicated=true llega a SUCCESS con la misma referencia', () => {
    const repetido: CreateSubmissionResponse = {
      ok: true, reference: 'SUB-TEST01', deduplicated: true,
    }
    const s = toSuccess(enCheckout(), repetido)
    expect(s.step).toBe('success')
    expect(successReference(s)).toBe('SUB-TEST01')
    expect(s.result?.deduplicated).toBe(true)
  })

  it('la máquina no ramifica por deduplicated: el éxito es el mismo', () => {
    const nuevo    = toSuccess(enCheckout(), { ok: true, reference: 'SUB-AAA111', deduplicated: false })
    const repetido = toSuccess(enCheckout(), { ok: true, reference: 'SUB-AAA111', deduplicated: true })
    expect(nuevo.step).toBe(repetido.step)
    expect(successReference(nuevo)).toBe(successReference(repetido))
  })

  it('el CTA se arma igual para un reintento', () => {
    const s = toSuccess(enCheckout(), { ok: true, reference: 'SUB-AAA111', deduplicated: true })
    expect(buildSubmissionWhatsAppHref('549111', s.result?.reference)).toContain('SUB-AAA111')
  })
})

// ── I / J. los 409 no producen success ─────────────────────────────────────

describe('I/J. errores estructurados', () => {
  it('I. price_changed vuelve a cart, NO a success', () => {
    const salida = fromStructuredError(enCheckout(), {
      code: 'price_changed',
      changes: [{ item_id: 'it-1', previous_unit_price: '9000.00', current_unit_price: '10000.00' }],
    })
    expect(salida).not.toBeNull()
    expect(salida!.code).toBe('price_changed')
    expect(salida!.state.step).toBe('cart')
    expect(salida!.state.step).not.toBe('success')
    expect(salida!.state.result).toBeNull()
    expect(salida!.prices).toEqual([{ item_id: 'it-1', current_unit_price: '10000.00' }])
    expect(salida!.itemIds).toEqual(['it-1'])
    expect(salida!.state.notice?.tone).toBe('price')
  })

  it('J. cart_changed vuelve a cart, NO a success', () => {
    const salida = fromStructuredError(enCheckout(), {
      code: 'cart_changed',
      items: [{ item_id: 'it-1', reason: 'not_orderable' }, { item_id: 'it-2', reason: 'not_orderable' }],
    })
    expect(salida).not.toBeNull()
    expect(salida!.code).toBe('cart_changed')
    expect(salida!.state.step).toBe('cart')
    expect(salida!.itemIds).toEqual(['it-1', 'it-2'])
    // No trae precios: no hay nada que actualizar, hay que corregir el carrito.
    expect(salida!.prices).toEqual([])
    expect(salida!.state.notice?.tone).toBe('catalog')
  })

  it('I/J. un 409 NO borra un éxito anterior de la misma sesión', () => {
    const conExito = toSuccess(enCheckout(), EXITO)
    const salida = fromStructuredError(conExito, { code: 'cart_changed', items: [{ item_id: 'it-1' }] })
    expect(salida!.state.result?.reference).toBe('SUB-TEST01')
  })

  it('I/J. DynamicForm no resetea los campos en el camino del 409', () => {
    // Devolver true del handler solo vuelve a 'idle'. Si acá apareciera un
    // setValues(initialFormValues(...)), el visitante perdería lo que escribió.
    const codigo = soloCodigo(leer('components', 'site', 'dynamic-form.tsx'))
    const i = codigo.indexOf('onStructuredError?.(data)')
    const cuerpo = codigo.slice(i, i + 200)
    expect(cuerpo).toContain("setStatus('idle')")
    expect(cuerpo).not.toContain('setValues')
    expect(cuerpo).not.toContain('initialFormValues')
  })

  it('un cuerpo que no es ninguno de los dos 409 devuelve null', () => {
    expect(fromStructuredError(enCheckout(), { code: 'otra_cosa' })).toBeNull()
    expect(fromStructuredError(enCheckout(), {})).toBeNull()
    // Con el code correcto pero sin el array esperado, tampoco se inventa nada.
    expect(fromStructuredError(enCheckout(), { code: 'price_changed' })).toBeNull()
    expect(fromStructuredError(enCheckout(), { code: 'cart_changed' })).toBeNull()
  })

  it('descarta entradas malformadas en vez de propagar undefined', () => {
    const salida = fromStructuredError(enCheckout(), {
      code: 'price_changed',
      changes: [{ item_id: 'ok', current_unit_price: '1.00' }, { item_id: 42 }, { current_unit_price: '2.00' }],
    })
    expect(salida!.prices).toEqual([{ item_id: 'ok', current_unit_price: '1.00' }])
  })
})

// ── K. los otros formularios no cambian ────────────────────────────────────

describe('K. sin onSubmitted, DynamicForm se comporta como antes', () => {
  it('el callback es opcional y se invoca con ?.', () => {
    const codigo = soloCodigo(leer('components', 'site', 'dynamic-form.tsx'))
    expect(codigo).toContain('onSubmitted?: (result: CreateSubmissionResponse) => void')
    expect(codigo).toContain('onSubmitted?.(exito.data)')
  })

  it('DynamicForm conserva su propia pantalla de éxito', () => {
    const crudo = leer('components', 'site', 'dynamic-form.tsx')
    expect(crudo).toContain("if (status === 'success')")
    expect(crudo).toContain('¡Listo! Recibimos tu consulta.')
    expect(crudo).toContain('Continuar por WhatsApp')
  })

  it('la página de formulario de los otros intents no pasa onSubmitted', () => {
    const pagina = leer('app', 'site', '[tenantSlug]', 'formulario', '[intent]', 'page.tsx')
    expect(pagina).toContain('<DynamicForm')
    expect(pagina).not.toContain('onSubmitted')
    expect(pagina).not.toContain('extraPayload')
    expect(pagina).not.toContain('onStructuredError')
  })

  it('no hay branching por food_order dentro de DynamicForm', () => {
    const codigo = soloCodigo(leer('components', 'site', 'dynamic-form.tsx')).toLowerCase()
    for (const prohibido of ['food_order', 'cart', 'item_id', 'unit_price', 'subtotal']) {
      expect(codigo, prohibido).not.toContain(prohibido)
    }
  })
})

// ── El recorrido completo ──────────────────────────────────────────────────

describe('el recorrido completo', () => {
  it('cart → checkout → success → cerrar → cart vacío', () => {
    let s = INITIAL_CHECKOUT_STATE
    expect(s.step).toBe('cart')

    s = toCheckout(s)
    expect(s.step).toBe('checkout')
    expect(showsForm(s)).toBe(true)

    s = toSuccess(s, EXITO)
    expect(s.step).toBe('success')
    expect(showsForm(s)).toBe(false)
    expect(successReference(s)).toBe('SUB-TEST01')

    s = onSheetClosed()
    expect(s.step).toBe('cart')
    expect(s.result).toBeNull()
  })

  it('cart → checkout → 409 → cart → checkout → success', () => {
    let s = toCheckout(INITIAL_CHECKOUT_STATE)

    const salida = fromStructuredError(s, {
      code: 'price_changed',
      changes: [{ item_id: 'it-1', current_unit_price: '10000.00' }],
    })!
    s = { ...salida.state, flagged: ['cl-1'] }
    expect(s.step).toBe('cart')
    expect(s.notice).not.toBeNull()

    // El visitante revisa y vuelve a enviar A MANO: nada de auto-submit.
    s = toCheckout(s)
    expect(s.notice).toBeNull()
    expect(s.step).toBe('checkout')

    s = toSuccess(s, EXITO)
    expect(s.step).toBe('success')
    expect(s.flagged).toEqual([])
  })

  it('volver al pedido desde el checkout no pierde nada', () => {
    const s = toCart(toCheckout(INITIAL_CHECKOUT_STATE))
    expect(s.step).toBe('cart')
    expect(s.result).toBeNull()
  })
})
