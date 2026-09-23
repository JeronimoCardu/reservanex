import { describe, expect, it } from 'vitest'
import { renderInvitationEmail, type InvitationEmailInput } from './invitation-email'

// ════════════════════════════════════════════════════════════════════════════
// Los emails de acceso: copy por rol, y la variante recovery que NO puede
// hacerse pasar por invitación.
//
// El rol acá es sólo presentación. Que un email diga "administrador" no le da
// permisos a nadie: eso lo deciden platform_users / tenant_users y el hook del
// JWT. Lo que estos tests cuidan es que el texto no mienta y que el markup
// sobreviva a Gmail, Outlook y un celular.
// ════════════════════════════════════════════════════════════════════════════

const URL_INVITE   = 'https://reservanex.com/auth/confirm?token_hash=abc123hash&type=invite'
const URL_RECOVERY = 'https://reservanex.com/auth/confirm?token_hash=def456hash&type=recovery'

// En un atributo HTML el & va escapado (&amp;): es la codificación correcta y
// el cliente de correo la decodifica al abrir el link. En text/plain va crudo.
const enAtributo = (url: string) => url.replace(/&/g, '&amp;')
const href       = (url: string) => `href="${enAtributo(url)}"`

const base = (o: Partial<InvitationEmailInput> = {}): InvitationEmailInput => ({
  role: 'owner', kind: 'invite', accessUrl: URL_INVITE, ...o,
})

describe('OWNER — invitación', () => {
  const r = renderInvitationEmail(base({ role: 'owner', businessName: 'Restaurante Prueba ReservaNex' }))

  it('subject y preheader', () => {
    expect(r.subject).toBe('Te invitaron a administrar tu negocio en ReservaNex')
    expect(r.preheader).toBe('Activá tu acceso y empezá a gestionar tu negocio.')
  })

  it('eyebrow, título y copy con el negocio', () => {
    expect(r.html).toContain('Invitación')
    expect(r.html).toContain('Tu acceso a ReservaNex está listo')
    expect(r.html).toContain('Fuiste invitado como administrador de Restaurante Prueba ReservaNex.')
    expect(r.html).toContain('gestionar la operación de tu negocio desde un solo lugar')
    expect(r.text).toContain('INVITACIÓN')
    expect(r.text).toContain('Fuiste invitado como administrador de Restaurante Prueba ReservaNex.')
  })

  it('CTA', () => {
    expect(r.html).toContain('>Aceptar invitación<')
    expect(r.html).toContain(href(URL_INVITE))
    expect(r.text).toContain(`Aceptar invitación: ${URL_INVITE}`)
  })

  it('el footer nombra el negocio', () => {
    expect(r.html).toContain('Notificación automática de ReservaNex')
    expect(r.html).toContain('Restaurante Prueba ReservaNex')
  })

  it('sin businessName el copy se adapta y no deja un hueco', () => {
    const sin = renderInvitationEmail(base({ role: 'owner', businessName: null }))
    expect(sin.subject).toBe('Te invitaron a administrar tu negocio en ReservaNex')
    expect(sin.html).toContain('Fuiste invitado como administrador de tu negocio en ReservaNex.')
    expect(sin.html).toContain('Desde tu cuenta vas a poder gestionar su operación desde un solo lugar.')
    expect(sin.html).not.toMatch(/administrador de\s*\./)
    expect(sin.html).not.toContain('undefined')
    expect(sin.html).not.toContain('null')
    // El footer queda con una sola línea, sin <br /> colgando.
    expect(sin.html).not.toMatch(/ReservaNex<br \/><\/td>/)
  })

  it('businessName en blanco se trata como ausente', () => {
    const blanco = renderInvitationEmail(base({ role: 'owner', businessName: '   ' }))
    expect(blanco.html).toContain('administrador de tu negocio en ReservaNex.')
  })
})

describe('RECEPTIONIST — invitación', () => {
  const r = renderInvitationEmail(base({ role: 'receptionist', businessName: 'Café Central' }))

  it('subject con el negocio y preheader', () => {
    expect(r.subject).toBe('Te invitaron al equipo de Café Central')
    expect(r.preheader).toBe('Activá tu acceso a ReservaNex.')
  })

  it('título y copy', () => {
    expect(r.html).toContain('Te damos la bienvenida al equipo')
    expect(r.html).toContain('Fuiste invitado a colaborar en Café Central.')
    expect(r.html).toContain('las tareas y funciones habilitadas para tu rol')
  })

  it('CTA', () => {
    expect(r.html).toContain('>Aceptar invitación<')
    expect(r.text).toContain(`Aceptar invitación: ${URL_INVITE}`)
  })

  it('sin businessName no queda un subject con el hueco', () => {
    const sin = renderInvitationEmail(base({ role: 'receptionist', businessName: null }))
    expect(sin.subject).toBe('Te invitaron a un equipo en ReservaNex')
    expect(sin.html).toContain('Fuiste invitado a colaborar en un equipo de ReservaNex.')
    expect(sin.subject).not.toMatch(/equipo de\s*$/)
  })
})

describe('SELLER — invitación', () => {
  const r = renderInvitationEmail(base({ role: 'seller' }))

  it('subject y preheader', () => {
    expect(r.subject).toBe('Te invitaron al equipo comercial de ReservaNex')
    expect(r.preheader).toBe('Activá tu acceso a la plataforma.')
  })

  it('título y copy', () => {
    expect(r.html).toContain('Te damos la bienvenida a ReservaNex')
    expect(r.html).toContain('Fuiste invitado a formar parte del equipo comercial de ReservaNex.')
    expect(r.html).toContain('las herramientas correspondientes a tu rol')
  })

  it('no menciona ningún negocio: el seller es de la plataforma', () => {
    expect(r.html).not.toMatch(/colaborar en|administrador de/)
    const footer = r.html.slice(r.html.lastIndexOf('Notificación automática'))
    expect(footer).not.toContain('<br />')
  })

  it('CTA', () => {
    expect(r.html).toContain('>Aceptar invitación<')
    expect(r.text).toContain(`Aceptar invitación: ${URL_INVITE}`)
  })
})

describe('RECOVERY — cuenta existente', () => {
  const r = renderInvitationEmail(base({ role: 'owner', kind: 'recovery', accessUrl: URL_RECOVERY, businessName: 'Café Central' }))

  it('subject, preheader, eyebrow y título propios', () => {
    expect(r.subject).toBe('Accedé nuevamente a tu cuenta de ReservaNex')
    expect(r.preheader).toBe('Usá este enlace seguro para recuperar tu acceso.')
    expect(r.html).toContain('Acceso a ReservaNex')
    expect(r.html).toContain('Recuperá tu acceso')
    expect(r.text).toContain('ACCESO A RESERVANEX')
  })

  it('NO dice "Aceptar invitación" ni afirma que es una invitación nueva', () => {
    for (const s of [r.subject, r.preheader, r.html, r.text]) {
      expect(s).not.toContain('Aceptar invitación')
      expect(s).not.toMatch(/Fuiste invitado|Te invitaron|INVITACIÓN/i)
    }
  })

  it('CTA "Recuperar acceso" y URL con type=recovery', () => {
    expect(r.html).toContain('>Recuperar acceso<')
    expect(r.html).toContain(href(URL_RECOVERY))
    expect(r.html).toContain('type=recovery')
    expect(r.text).toContain(`Recuperar acceso: ${URL_RECOVERY}`)
  })

  it('explica por qué le llega', () => {
    expect(r.html).toContain('Ya existe una cuenta asociada a este correo.')
    expect(r.html).toContain('configurar una nueva contraseña')
  })

  it('el mismo cuerpo para los tres roles: recovery no depende del rol', () => {
    const a = renderInvitationEmail(base({ role: 'seller',       kind: 'recovery', accessUrl: URL_RECOVERY }))
    const b = renderInvitationEmail(base({ role: 'receptionist', kind: 'recovery', accessUrl: URL_RECOVERY }))
    expect(a.subject).toBe(b.subject)
    expect(a.html).toBe(b.html)
  })
})

describe('generales — seguridad y markup', () => {
  const casos: [string, InvitationEmailInput][] = [
    ['owner',        base({ role: 'owner', businessName: 'Negocio' })],
    ['receptionist', base({ role: 'receptionist', businessName: 'Negocio' })],
    ['seller',       base({ role: 'seller' })],
    ['recovery',     base({ kind: 'recovery', accessUrl: URL_RECOVERY })],
  ]

  it.each(casos)('%s — la URL está en HTML y en texto, y el link de respaldo también', (_n, input) => {
    const r = renderInvitationEmail(input)
    expect(r.html).toContain(href(input.accessUrl))
    expect(r.text).toContain(input.accessUrl)
    expect(r.html).toContain('Si el botón no funciona, copiá y pegá este enlace en tu navegador:')
    expect(r.text).toContain('Si el botón no funciona, copiá y pegá este enlace en tu navegador:')
    // La URL aparece dos veces en HTML: el botón y el respaldo copiable.
    expect(r.html.split(enAtributo(input.accessUrl)).length - 1).toBeGreaterThanOrEqual(2)
  })

  it.each(casos)('%s — el token NUNCA está en subject ni preheader', (_n, input) => {
    const r = renderInvitationEmail(input)
    const token = new URL(input.accessUrl).searchParams.get('token_hash')!
    expect(token.length).toBeGreaterThan(5)
    expect(r.subject).not.toContain(token)
    expect(r.preheader).not.toContain(token)
    expect(r.subject).not.toContain('token_hash')
    expect(r.preheader).not.toContain('token_hash')
  })

  it.each(casos)('%s — markup email-safe', (_n, input) => {
    const r = renderInvitationEmail(input)
    expect(r.html).toMatch(/^<!DOCTYPE html/)
    expect(r.html).toContain('max-width:600px')
    expect(r.html).toContain('width="600"')
    expect(r.html).toContain('role="presentation"')
    expect(r.html).not.toMatch(/<script/i)
    expect(r.html).not.toMatch(/<link\s/i)
    expect(r.html).not.toMatch(/@import|fonts\.googleapis|<style/i)
    expect(r.html).not.toMatch(/rgba?\(/i)
    expect(r.html).not.toMatch(/display:\s*(flex|grid)/i)
    expect(r.html).not.toMatch(/<img/i)
  })

  it.each(casos)('%s — paleta de marca', (_n, input) => {
    const r = renderInvitationEmail(input)
    for (const c of ['#EEF2F7', '#FFFFFF', '#0F2A47', '#0EA5A4']) expect(r.html, c).toContain(c)
  })

  it('escaping: el nombre del negocio no puede inyectar markup', () => {
    const hostil = renderInvitationEmail(base({
      role: 'receptionist',
      businessName: '<script>alert(1)</script> Bar & "Grill"',
    }))
    expect(hostil.html).not.toContain('<script>alert(1)</script>')
    expect(hostil.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Bar &amp; &quot;Grill&quot;')
    // El subject es texto plano: va sin escapar, pero tampoco se renderiza como HTML.
    expect(hostil.subject).toContain('<script>alert(1)</script> Bar & "Grill"')
  })

  it('escaping: una URL con caracteres especiales no rompe el atributo href', () => {
    const r = renderInvitationEmail(base({
      accessUrl: 'https://reservanex.com/auth/confirm?token_hash=a"b&c<d&type=invite',
    }))
    expect(r.html).toContain('&quot;')
    expect(r.html).toContain('&amp;')
    expect(r.html).not.toMatch(/href="[^"]*"[a-z]/i)
  })

  it('no promete una duración que no podemos comprobar', () => {
    for (const [, input] of casos) {
      const r = renderInvitationEmail(input)
      expect(r.html).toContain('Este enlace es temporal')
      expect(r.html).not.toMatch(/\d+\s*(horas|hs|días|minutos)/i)
      expect(r.text).not.toMatch(/vence en \d+/i)
    }
  })

  it('la invitación invita a ignorar si no se esperaba; recovery tiene su propia nota', () => {
    expect(renderInvitationEmail(base()).html).toContain('Si no esperabas esta invitación, podés ignorar este correo.')
    expect(renderInvitationEmail(base({ kind: 'recovery', accessUrl: URL_RECOVERY })).html)
      .toContain('Si no pediste este acceso, podés ignorar este correo.')
  })

  it('snapshot del texto plano — seller invite', () => {
    expect(renderInvitationEmail(base({ role: 'seller' })).text).toMatchInlineSnapshot(`
      "ReservaNex

      INVITACIÓN
      Te damos la bienvenida a ReservaNex

      Fuiste invitado a formar parte del equipo comercial de ReservaNex.
      Activá tu cuenta para acceder a las herramientas correspondientes a tu rol.

      Aceptar invitación: https://reservanex.com/auth/confirm?token_hash=abc123hash&type=invite

      Si el botón no funciona, copiá y pegá este enlace en tu navegador:
      https://reservanex.com/auth/confirm?token_hash=abc123hash&type=invite

      Si no esperabas esta invitación, podés ignorar este correo. Este enlace es temporal y de un solo uso.

      Notificación automática de ReservaNex"
    `)
  })
})
