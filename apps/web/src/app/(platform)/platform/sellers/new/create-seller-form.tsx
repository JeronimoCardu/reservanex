'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createSellerAction } from '@/actions/platform'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function CreateSellerForm() {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()
  const [form, setForm] = useState({ name: '', email: '' })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const res = await createSellerAction({ name: form.name.trim(), email: form.email.trim() })
      if (res.success) {
        if (res.warning) {
          toast.warning(res.warning, { duration: 10000 })
        } else {
          toast.success('Seller creado. Se envió la invitación por email.')
        }
        router.push('/platform/sellers')
      } else {
        toast.error(res.error)
      }
    })
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-lg border bg-background p-5 space-y-4">
      <div className="space-y-1">
        <Label htmlFor="name">Nombre completo</Label>
        <Input
          id="name"
          value={form.name}
          onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
          placeholder="Nombre Apellido"
          required
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          value={form.email}
          onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
          placeholder="seller@ejemplo.com"
          required
        />
      </div>
      <Button type="submit" disabled={isPending} className="w-full">
        {isPending ? 'Creando...' : 'Crear seller y enviar invitación'}
      </Button>
    </form>
  )
}
