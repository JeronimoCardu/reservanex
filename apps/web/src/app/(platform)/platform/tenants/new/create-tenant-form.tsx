'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createPlatformTenantAction } from '@/actions/platform'
import { SUPPORTED_COUNTRIES, DEFAULT_COUNTRY_CODE, defaultsForCountry } from '@/lib/tenant-provisioning'
import {
  TENANT_KINDS,
  TENANT_KIND_LABELS,
  TENANT_KIND_HINTS,
  DEFAULT_FOOD_CAPABILITIES,
  type TenantKind,
} from '@orderflow/validators'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

// Alta de cliente — tres tipos comerciales sobre dos verticales.
//
// La persona que da de alta elige Inmobiliaria / Particular / Gastronomía.
// Nunca ve 'real_estate', 'food_service', 'agency' ni 'private_owner': esos son
// valores técnicos y la traducción vive en @orderflow/validators.
//
// Todos los campos que este formulario ya pedía son COMUNES a los tres tipos
// —nombre, país, moneda, owner prospecto, notas—; no había ninguno propio de
// una inmobiliaria, así que Particular no necesita quitar nada. Lo único
// condicional es el bloque de Servicios, que sólo existe para gastronomía.

export function CreateTenantForm() {
  const router  = useRouter()
  const [isPending, startTransition] = useTransition()

  const [kind, setKind] = useState<TenantKind>('agency')
  const [caps, setCaps] = useState({ ...DEFAULT_FOOD_CAPABILITIES })

  const esGastronomico = kind === 'food_business'

  const [form, setForm] = useState({
    name:                '',
    country:             DEFAULT_COUNTRY_CODE,
    currency:            defaultsForCountry(DEFAULT_COUNTRY_CODE).currency,
    activate_immediately: false,
    primary_owner_name:  '',
    primary_owner_email: '',
    primary_owner_phone: '',
    onboarding_notes:    '',
  })

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }))
  }

  function handleCountryChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const country = e.target.value
    // Currency follows the country pick by default — still editable
    // independently right after, since a tenant may legitimately price in
    // a different currency than its local one.
    setForm((prev) => ({ ...prev, country, currency: defaultsForCountry(country).currency }))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const result = await createPlatformTenantAction({
        name:                 form.name,
        kind,
        // Sólo viajan si aplican. El servidor igual las ignora para los otros
        // dos tipos: no es el cliente quien decide cuándo cuentan.
        ...(esGastronomico ? { capabilities: caps } : {}),
        country:              form.country,
        currency:             form.currency,
        activate_immediately: form.activate_immediately,
        primary_owner_name:   form.primary_owner_name   || null,
        primary_owner_email:  form.primary_owner_email  || null,
        primary_owner_phone:  form.primary_owner_phone  || null,
        onboarding_notes:     form.onboarding_notes     || null,
      })
      if (result.success) {
        toast.success(`${TENANT_KIND_LABELS[kind]} creada. Estado: pendiente de revisión.`)
        router.push(`/platform/tenants/${result.data!.id}`)
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 rounded-lg border bg-background p-5">
      {/* ── Tipo de cliente ── */}
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Tipo de cliente</legend>
        <div className="space-y-2">
          {TENANT_KINDS.map((k) => (
            <label
              key={k}
              className={`flex cursor-pointer gap-3 rounded-md border p-3 transition-colors ${
                kind === k ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
              }`}
            >
              <input
                type="radio"
                name="kind"
                value={k}
                checked={kind === k}
                onChange={() => setKind(k)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-current"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{TENANT_KIND_LABELS[k]}</span>
                <span className="block text-xs text-muted-foreground">{TENANT_KIND_HINTS[k]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {/* ── Servicios: sólo gastronomía ──
          Editables antes de crear, y editables después por el owner desde su
          Configuración. No requieren intervención de plataforma para cambiar. */}
      {esGastronomico && (
        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">Servicios</legend>
          <p className="text-xs text-muted-foreground">
            El owner va a poder cambiarlos después desde su Configuración.
          </p>
          {([
            ['delivery',          'Delivery',             'Acepta pedidos con envío.'],
            ['takeaway',          'Retiro en el local',   'Acepta pedidos para retirar.'],
            ['tableReservations', 'Reserva de mesas',     'Acepta reservas de mesa desde el sitio público.'],
          ] as const).map(([key, label, hint]) => (
            <label key={key} className="flex cursor-pointer select-none items-start gap-2">
              <input
                type="checkbox"
                checked={caps[key]}
                onChange={(e) => setCaps((prev) => ({ ...prev, [key]: e.target.checked }))}
                className="mt-0.5 h-4 w-4 shrink-0"
              />
              <span className="min-w-0">
                <span className="block text-sm">{label}</span>
                <span className="block text-xs text-muted-foreground">{hint}</span>
              </span>
            </label>
          ))}
          {!caps.delivery && !caps.takeaway && (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Sin delivery ni retiro, el sitio funciona como carta digital: se puede ver el
              menú y hacer consultas, pero no generar pedidos.
            </p>
          )}
        </fieldset>
      )}

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">
          {esGastronomico ? 'Datos del negocio' : 'Datos del cliente'}
        </legend>
        <div className="space-y-1">
          <Label htmlFor="name">Nombre *</Label>
          <Input
            id="name"
            name="name"
            value={form.name}
            onChange={handleChange}
            placeholder="Ej: Inmobiliaria San Giles"
            required
            minLength={2}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="country">País</Label>
            <select
              id="country"
              name="country"
              value={form.country}
              onChange={handleCountryChange}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
            >
              {SUPPORTED_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>{c.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="currency">Moneda principal</Label>
            <select
              id="currency"
              name="currency"
              value={form.currency}
              onChange={handleChange}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
            >
              {Array.from(new Set(SUPPORTED_COUNTRIES.map((c) => c.currency))).map((code) => (
                <option key={code} value={code}>{code}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="onboarding_notes">Notas internas</Label>
          <Textarea
            id="onboarding_notes"
            name="onboarding_notes"
            value={form.onboarding_notes}
            onChange={handleChange}
            placeholder="Contexto del cliente, acuerdos previos, observaciones..."
            rows={3}
          />
        </div>
        <label className="flex items-center gap-2 cursor-pointer select-none pt-1">
          <input
            type="checkbox"
            checked={form.activate_immediately}
            onChange={(e) => setForm((prev) => ({ ...prev, activate_immediately: e.target.checked }))}
            className="rounded border"
          />
          <span className="text-sm">Activar inmediatamente (si no, queda en prueba/trial)</span>
        </label>
      </fieldset>

      <hr className="border-border" />

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Datos del Owner prospecto</legend>
        <p className="text-xs text-muted-foreground">
          El owner no recibirá invitación ahora. Se invita cuando el onboarding esté listo.
        </p>
        <div className="space-y-1">
          <Label htmlFor="primary_owner_name">Nombre</Label>
          <Input
            id="primary_owner_name"
            name="primary_owner_name"
            value={form.primary_owner_name}
            onChange={handleChange}
            placeholder="Nombre completo del dueño"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="primary_owner_email">Email</Label>
          <Input
            id="primary_owner_email"
            name="primary_owner_email"
            type="email"
            value={form.primary_owner_email}
            onChange={handleChange}
            placeholder="owner@ejemplo.com"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="primary_owner_phone">Teléfono</Label>
          <Input
            id="primary_owner_phone"
            name="primary_owner_phone"
            value={form.primary_owner_phone}
            onChange={handleChange}
            placeholder="+54 9 11 ..."
          />
        </div>
      </fieldset>

      <div className="flex gap-3 pt-1">
        <Button type="submit" disabled={isPending || !form.name.trim()}>
          {isPending ? 'Creando...' : `Crear ${TENANT_KIND_LABELS[kind].toLowerCase()}`}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={isPending}>
          Cancelar
        </Button>
      </div>
    </form>
  )
}
