'use client'

import { useState, useTransition, useEffect } from 'react'
import { Building2Icon, SearchIcon, XIcon, CheckIcon } from 'lucide-react'
import { toast } from 'sonner'
import { associatePropertyAction } from '@/actions/conversations'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { createClient } from '@orderflow/supabase/browser'
import { cn } from '@/lib/utils'

type Property = {
  id:    string
  title: string
  city:  string | null
  neighborhood: string | null
  units: { id: string; name: string }[]
}

interface AssociatePropertyDialogProps {
  conversationId:    string
  currentPropertyId: string | null
  currentUnitId:     string | null
  tenantId:          string
}

export function AssociatePropertyDialog({
  conversationId,
  currentPropertyId,
  currentUnitId,
  tenantId,
}: AssociatePropertyDialogProps) {
  const [open, setOpen]             = useState(false)
  const [isPending, startTransition] = useTransition()
  const [properties, setProperties]  = useState<Property[]>([])
  const [search, setSearch]          = useState('')
  const [selectedProp, setSelectedProp] = useState<Property | null>(null)
  const [selectedUnit, setSelectedUnit] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const supabase = createClient()
    void (async () => {
      const { data } = await supabase
        .from('properties')
        .select('id, title, city, neighborhood, units:units(id, name)')
        .eq('tenant_id', tenantId)
        .is('deleted_at', null)
        .order('title')
        .limit(100)
      setProperties((data ?? []) as unknown as Property[])
    })()
    setSelectedProp(null)
    setSelectedUnit(currentUnitId)
    setSearch('')
  }, [open, tenantId, currentUnitId])

  const filtered = search
    ? properties.filter(p =>
        p.title.toLowerCase().includes(search.toLowerCase()) ||
        p.city?.toLowerCase().includes(search.toLowerCase()) ||
        p.neighborhood?.toLowerCase().includes(search.toLowerCase()),
      )
    : properties

  function handleSave() {
    startTransition(async () => {
      const propId  = selectedProp?.id ?? null
      const unitId  = selectedUnit
      const result  = await associatePropertyAction(conversationId, propId, unitId)
      if (result.success) {
        toast.success(propId ? 'Propiedad asociada.' : 'Asociación quitada.')
        setOpen(false)
      } else {
        toast.error(result.error)
      }
    })
  }

  function handleRemove() {
    startTransition(async () => {
      const result = await associatePropertyAction(conversationId, null, null)
      if (result.success) {
        toast.success('Asociación quitada.')
        setOpen(false)
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs">
          <Building2Icon className="h-3 w-3" />
          {currentPropertyId ? 'Cambiar' : 'Asociar propiedad'}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Asociar propiedad</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Buscar por título, ciudad, barrio..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-8 text-sm"
            />
          </div>

          <div className="max-h-60 overflow-y-auto rounded-md border divide-y">
            {filtered.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {search ? 'Sin resultados.' : 'No hay propiedades activas.'}
              </p>
            ) : (
              filtered.map(prop => {
                const isSelected = selectedProp?.id === prop.id
                return (
                  <button
                    key={prop.id}
                    type="button"
                    onClick={() => {
                      setSelectedProp(isSelected ? null : prop)
                      setSelectedUnit(null)
                    }}
                    className={cn(
                      'flex w-full items-start justify-between gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/50',
                      isSelected && 'bg-muted',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{prop.title}</p>
                      {(prop.city || prop.neighborhood) && (
                        <p className="text-xs text-muted-foreground truncate">
                          {[prop.neighborhood, prop.city].filter(Boolean).join(', ')}
                        </p>
                      )}
                    </div>
                    {isSelected && <CheckIcon className="h-4 w-4 shrink-0 text-primary mt-0.5" />}
                  </button>
                )
              })
            )}
          </div>

          {/* Unit selector */}
          {selectedProp && selectedProp.units.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Unidad (opcional)</p>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setSelectedUnit(null)}
                  className={cn(
                    'rounded border px-2.5 py-1 text-xs transition-colors',
                    selectedUnit === null
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted',
                  )}
                >
                  Sin unidad específica
                </button>
                {selectedProp.units.map(u => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => setSelectedUnit(u.id)}
                    className={cn(
                      'rounded border px-2.5 py-1 text-xs transition-colors',
                      selectedUnit === u.id
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {u.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-between gap-2 pt-1">
          {currentPropertyId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRemove}
              disabled={isPending}
              className="text-destructive hover:text-destructive gap-1"
            >
              <XIcon className="h-3.5 w-3.5" />
              Quitar
            </Button>
          )}
          <div className="flex gap-2 ml-auto">
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={isPending || !selectedProp}
            >
              {isPending ? 'Guardando…' : 'Asociar'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
