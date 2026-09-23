import {
  escapeHtml,
  renderEmailShell,
  renderShellText,
  type EmailCta,
  type RenderedEmail,
} from './shell'

// ════════════════════════════════════════════════════════════════════════════
// Los emails de acceso: invitación por rol, y recuperación.
//
// Reemplazan al template global "Invite user" de Supabase Auth para los flujos
// migrados. El motivo no es estético: ese template es uno solo para toda la
// plataforma, vive en el Dashboard (sin versionar, sin tests, sin review) y no
// recibe el rol — el rol ni siquiera existe en auth.users, lo deriva el
// custom_access_token_hook de platform_users/tenant_users al emitir el JWT.
//
// Acá el rol decide ÚNICAMENTE el copy. La autorización real sigue donde
// estaba: platform_users (seller), tenant_users (owner/receptionist) y el hook.
// Un email con el texto equivocado no concede ni un permiso.
//
// El token lo sigue acuñando Supabase (generateLink) y lo sigue canjeando
// /auth/confirm con verifyOtp. Este módulo sólo transporta la URL.
// ════════════════════════════════════════════════════════════════════════════

/** Rol del destinatario. Decide el copy, nunca los permisos. */
export type InvitationRole = 'owner' | 'receptionist' | 'seller'

/**
 * Qué tipo de acceso se está mandando.
 *
 * 'invite'   → cuenta nueva o invitación sin aceptar → /auth/accept-invite
 * 'recovery' → la cuenta ya existe y está confirmada → /auth/reset-password
 *
 * La distinción importa: mandarle "te invitaron" a alguien que ya tiene cuenta
 * y que en realidad va a resetear su contraseña es mentirle.
 */
export type InvitationKind = 'invite' | 'recovery'

export interface InvitationEmailInput {
  role:          InvitationRole
  kind:          InvitationKind
  /** Nombre del destinatario, si lo tenemos. Hoy sólo se usa en el saludo del texto. */
  recipientName?: string | null
  /** Nombre del negocio. No existe para seller, y puede faltar para owner. */
  businessName?:  string | null
  /** La URL completa de /auth/confirm con su token_hash y su type. */
  accessUrl:      string
}

const FALLBACK_INTRO = 'Si el botón no funciona, copiá y pegá este enlace en tu navegador:'

// No afirmamos una duración: el TTL del link lo fija Supabase en la
// configuración del proyecto, no está expuesto de forma fiable acá, y decir
// "vence en 24 horas" sin poder comprobarlo es peor que no decir nada.
const TEMPORAL_NOTE = 'Este enlace es temporal y de un solo uso.'

const IGNORE_NOTE = 'Si no esperabas esta invitación, podés ignorar este correo.'

// ── Copy por rol ────────────────────────────────────────────────────────────

interface Copy {
  subject:   string
  preheader: string
  eyebrow:   string
  title:     string
  intro:     string[]
  ctaLabel:  string
  note:      string
}

function inviteCopy(role: InvitationRole, businessName: string | null): Copy {
  const eyebrow  = 'Invitación'
  const ctaLabel = 'Aceptar invitación'
  const note     = `${IGNORE_NOTE} ${TEMPORAL_NOTE}`

  if (role === 'seller') {
    return {
      subject:   'Te invitaron al equipo comercial de ReservaNex',
      preheader: 'Activá tu acceso a la plataforma.',
      eyebrow,
      title:     'Te damos la bienvenida a ReservaNex',
      intro: [
        'Fuiste invitado a formar parte del equipo comercial de ReservaNex.',
        'Activá tu cuenta para acceder a las herramientas correspondientes a tu rol.',
      ],
      ctaLabel,
      note,
    }
  }

  if (role === 'owner') {
    return {
      subject:   'Te invitaron a administrar tu negocio en ReservaNex',
      preheader: 'Activá tu acceso y empezá a gestionar tu negocio.',
      eyebrow,
      title:     'Tu acceso a ReservaNex está listo',
      intro: businessName
        ? [
            `Fuiste invitado como administrador de ${businessName}.`,
            'Desde ReservaNex vas a poder gestionar la operación de tu negocio desde un solo lugar.',
          ]
        : [
            'Fuiste invitado como administrador de tu negocio en ReservaNex.',
            'Desde tu cuenta vas a poder gestionar su operación desde un solo lugar.',
          ],
      ctaLabel,
      note,
    }
  }

  // receptionist
  return {
    subject:   businessName
      ? `Te invitaron al equipo de ${businessName}`
      : 'Te invitaron a un equipo en ReservaNex',
    preheader: 'Activá tu acceso a ReservaNex.',
    eyebrow,
    title:     'Te damos la bienvenida al equipo',
    intro: businessName
      ? [
          `Fuiste invitado a colaborar en ${businessName}.`,
          'Desde ReservaNex vas a poder gestionar las tareas y funciones habilitadas para tu rol.',
        ]
      : [
          'Fuiste invitado a colaborar en un equipo de ReservaNex.',
          'Desde ReservaNex vas a poder gestionar las tareas y funciones habilitadas para tu rol.',
        ],
    ctaLabel,
    note,
  }
}

/**
 * El acceso para una cuenta que YA existe y está confirmada.
 *
 * No dice "invitación" en ningún lado, porque no lo es: el link lleva al flujo
 * de contraseña nueva (type=recovery → /auth/reset-password). El rol no cambia
 * el cuerpo; a lo sumo el pie contextualiza el negocio.
 */
function recoveryCopy(): Copy {
  return {
    subject:   'Accedé nuevamente a tu cuenta de ReservaNex',
    preheader: 'Usá este enlace seguro para recuperar tu acceso.',
    eyebrow:   'Acceso a ReservaNex',
    title:     'Recuperá tu acceso',
    intro: [
      'Ya existe una cuenta asociada a este correo.',
      'Usá el siguiente enlace para configurar una nueva contraseña y volver a ingresar a ReservaNex.',
    ],
    ctaLabel: 'Recuperar acceso',
    note:     `Si no pediste este acceso, podés ignorar este correo. ${TEMPORAL_NOTE}`,
  }
}

// ── Render ──────────────────────────────────────────────────────────────────

export function renderInvitationEmail(input: InvitationEmailInput): RenderedEmail {
  const businessName = input.businessName?.trim() || null
  const copy = input.kind === 'recovery' ? recoveryCopy() : inviteCopy(input.role, businessName)

  const ctas: EmailCta[] = [{ href: input.accessUrl, label: copy.ctaLabel, primary: true }]
  const fallbackLink = { intro: FALLBACK_INTRO, url: input.accessUrl }

  // El pie nombra el negocio cuando lo tenemos: ubica al destinatario sin
  // afirmar nada sobre el tipo de acceso.
  const footerLines = businessName
    ? ['Notificación automática de ReservaNex', businessName]
    : ['Notificación automática de ReservaNex']

  const shell = renderEmailShell({
    subject:   copy.subject,
    preheader: copy.preheader,
    eyebrow:   copy.eyebrow,
    title:     copy.title,
    intro:     copy.intro,
    ctas,
    fallbackLink,
    note:      copy.note,
    footerLines,
  })

  const text = renderShellText({
    eyebrow: copy.eyebrow,
    title:   copy.title,
    intro:   copy.intro,
    ctas,
    fallbackLink,
    note:    copy.note,
    footerLines,
  })

  return { ...shell, text }
}

/** Expuesto para los tests: que el escaping sea el mismo del shell. */
export { escapeHtml }
