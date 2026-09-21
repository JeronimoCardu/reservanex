'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import type { FoodCapabilities } from '@orderflow/validators'
import { updateFoodCapabilitiesAction } from '@/actions/tenant-settings'
import { Button } from '@/components/ui/button'

// Tres interruptores y nada más. Lo que cada uno enciende y apaga está escrito
// al lado, porque la consecuencia no es obvia: apagar delivery y retiro deja el
// sitio como carta digital, y eso hay que poder anticiparlo antes de guardar.
//
// Lo que NO cambia al apagarlos: los pedidos y reservas que ya existen. Siguen
// su ciclo de vida normal. Las capacidades gobiernan lo nuevo.

const OPCIONES = [
  {
    key:   'delivery' as const,
    label: 'Delivery',
    hint:  'Los clientes pueden pedir con envío a domicilio.',
  },
  {
    key:   'takeaway' as const,
    label: 'Retiro en el local',
    hint:  'Los clientes pueden pedir para retirar.',
  },
  {
    key:   'tableReservations' as const,
    label: 'Reserva de mesas',
    hint:  'Los clientes pueden reservar mesa desde el sitio público.',
  },
]

export function ServicesSettingsForm({ initial }: { initial: FoodCapabilities }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [caps, setCaps] = useState<FoodCapabilities>(initial)

  const sinPedidos = !caps.delivery && !caps.takeaway
  const cambiado =
    caps.delivery !== initial.delivery ||
    caps.takeaway !== initial.takeaway ||
    caps.tableReservations !== initial.tableReservations

  function guardar() {
    startTransition(async () => {
      const r = await updateFoodCapabilitiesAction(caps)
      if (r.success) {
        toast.success('Servicios actualizados.')
        router.refresh()
      } else {
        toast.error(r.error)
      }
    })
  }

  return (
    <div className="max-w-xl space-y-4 rounded-lg border bg-background p-5">
      <div className="space-y-3">
        {OPCIONES.map((o) => (
          <label
            key={o.key}
            className="flex cursor-pointer select-none items-start justify-between gap-4 rounded-md border p-3 transition-colors hover:bg-muted/40"
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium">{o.label}</span>
              <span className="block text-xs text-muted-foreground">{o.hint}</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              aria-checked={caps[o.key]}
              checked={caps[o.key]}
              disabled={isPending}
              onChange={(e) => setCaps((prev) => ({ ...prev, [o.key]: e.target.checked }))}
              className="mt-0.5 h-5 w-5 shrink-0"
            />
          </label>
        ))}
      </div>

      {sinPedidos && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Sin delivery ni retiro tu sitio funciona como carta digital: se ve el menú y se
          pueden hacer consultas, pero no generar pedidos. Los pedidos que ya tenés siguen
          normalmente.
        </p>
      )}

      <div className="flex justify-end">
        <Button onClick={guardar} disabled={isPending || !cambiado}>
          {isPending ? (
            <>
              <Loader2 className="animate-spin" />
              Guardando...
            </>
          ) : (
            'Guardar cambios'
          )}
        </Button>
      </div>
    </div>
  )
}
