'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createPlatformTenantAction } from '@/actions/platform'
import { SUPPORTED_COUNTRIES, DEFAULT_COUNTRY_CODE, defaultsForCountry } from '@/lib/tenant-provisioning'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

export function CreateTenantForm() {
  const router  = useRouter()
  const [isPending, startTransition] = useTransition()

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
        country:              form.country,
        currency:             form.currency,
        activate_immediately: form.activate_immediately,
        primary_owner_name:   form.primary_owner_name   || null,
        primary_owner_email:  form.primary_owner_email  || null,
        primary_owner_phone:  form.primary_owner_phone  || null,
        onboarding_notes:     form.onboarding_notes     || null,
      })
      if (result.success) {
        toast.success('Inmobiliaria creada. Estado: pendiente de revisión.')
        router.push(`/platform/tenants/${result.data!.id}`)
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 rounded-lg border bg-background p-5">
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">Datos de la inmobiliaria</legend>
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
            placeholder="owner@inmobiliaria.com"
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
          {isPending ? 'Creando...' : 'Crear inmobiliaria'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={isPending}>
          Cancelar
        </Button>
      </div>
    </form>
  )
}
