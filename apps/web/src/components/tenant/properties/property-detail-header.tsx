'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import Link from 'next/link'
import { ArrowLeft, Pencil, Trash2, Power, PowerOff, MapPin, ExternalLink } from 'lucide-react'
import type { TenantRole, Json } from '@orderflow/types'
import type {
  PropertyWithUnits,
  PropertyStatus,
  PropertyListItem,
} from '@/lib/repositories/properties.repository'
import { activatePropertyAction, deactivatePropertyAction } from '@/actions/properties'
import { Button } from '@/components/ui/button'
import { Badge }  from '@/components/ui/badge'
import { EditPropertyDialog }   from './edit-property-dialog'
import { ArchivePropertyDialog } from './archive-property-dialog'

const STATUS_LABEL: Record<PropertyStatus, string> = {
  active:   'Activo',
  draft:    'Borrador',
  archived: 'Archivado',
}

const STATUS_VARIANT: Record<PropertyStatus, 'default' | 'secondary' | 'outline'> = {
  active:   'default',
  draft:    'secondary',
  archived: 'outline',
}

type CustomField = { key: string; value: string }

interface PropertyDetailHeaderProps {
  property:            PropertyWithUnits
  currentRole:         TenantRole
  canCreateProperties: boolean
}

export function PropertyDetailHeader({
  property,
  currentRole,
  canCreateProperties,
}: PropertyDetailHeaderProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [editOpen, setEditOpen]     = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const canEdit   = canCreateProperties
  const canPublish = currentRole === 'owner'
  const canDelete  = currentRole === 'owner'

  const asListItem = { ...property, unitCount: property.units.length } as PropertyListItem

  const rawCustomFields = property.custom_fields as Json
  const customFields: CustomField[] = Array.isArray(rawCustomFields)
    ? (rawCustomFields as CustomField[]).filter((f) => f?.key && f?.value)
    : []

  const coverUrl =
    property.cover_image_url ??
    property.images.find((i) => i.is_cover)?.image_url ??
    property.images[0]?.image_url

  const galleryImages = property.images.filter((img) => img.image_url !== coverUrl)

  function handleTogglePublished() {
    const action = property.status === 'active' ? deactivatePropertyAction : activatePropertyAction
    startTransition(async () => {
      const result = await action(property.id)
      if (result.success) {
        toast.success(property.status === 'active' ? 'Propiedad desactivada' : 'Propiedad activada')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  return (
    <>
      <div className="space-y-5">
        {/* Back link */}
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/dashboard/properties">
            <ArrowLeft className="mr-1 h-4 w-4" />
            Propiedades
          </Link>
        </Button>

        {/* Cover image */}
        {coverUrl && (
          <div className="overflow-hidden rounded-lg">
            <img
              src={coverUrl}
              alt={property.title}
              className="h-56 w-full object-cover"
            />
          </div>
        )}

        {/* Gallery strip */}
        {galleryImages.length > 0 && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {galleryImages.map((img) => (
              <img
                key={img.id}
                src={img.image_url}
                alt={img.alt ?? property.title}
                className="h-20 w-28 shrink-0 rounded object-cover"
                loading="lazy"
              />
            ))}
          </div>
        )}

        {/* Title row */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight">{property.title}</h1>
              <Badge variant={STATUS_VARIANT[property.status]}>
                {STATUS_LABEL[property.status]}
              </Badge>
            </div>

            {/* Location */}
            {(property.location_label ?? property.city ?? property.neighborhood) && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <MapPin className="h-3.5 w-3.5 shrink-0" />
                <span>
                  {property.location_label ??
                    [property.neighborhood, property.city].filter(Boolean).join(', ')}
                </span>
                {property.google_maps_url && (
                  <a
                    href={property.google_maps_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-1 flex items-center gap-0.5 hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Maps
                  </a>
                )}
              </div>
            )}
          </div>

          {/* Action buttons */}
          <div className="flex flex-wrap gap-2">
            {canPublish && (
              <Button variant="outline" size="sm" disabled={isPending} onClick={handleTogglePublished}>
                {property.status === 'active' ? (
                  <><PowerOff className="mr-1 h-4 w-4" />Desactivar</>
                ) : (
                  <><Power className="mr-1 h-4 w-4" />Activar</>
                )}
              </Button>
            )}
            {canEdit && (
              <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                <Pencil className="mr-1 h-4 w-4" />
                Editar
              </Button>
            )}
            {canDelete && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDeleteOpen(true)}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="mr-1 h-4 w-4" />
                Eliminar
              </Button>
            )}
          </div>
        </div>

        {/* Stats strip */}
        {(property.capacity != null || property.area_m2 != null) && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-lg border bg-muted/40 px-4 py-3 text-sm">
            {property.capacity != null && (
              <span>{property.capacity} persona{property.capacity !== 1 ? 's' : ''}</span>
            )}
            {property.area_m2 != null && (
              <span>{property.area_m2} m²</span>
            )}
          </div>
        )}

        {/* Check-in / check-out */}
        {(property.check_in_time || property.check_out_time) && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-lg border bg-muted/40 px-4 py-3 text-sm">
            {property.check_in_time && (
              <span>Check-in: {String(property.check_in_time).slice(0, 5)}</span>
            )}
            {property.check_out_time && (
              <span>Check-out: {String(property.check_out_time).slice(0, 5)}</span>
            )}
          </div>
        )}

        {/* Pricing */}
        {(() => {
          const op = (property as PropertyWithUnits & { operation_type?: string; pricing_mode?: string; currency?: string; show_price_public?: boolean; sale_price?: number | null; monthly_rent_price?: number | null; expenses_amount?: number | null; base_price_per_night?: number | null; minimum_stay_nights?: number; cleaning_fee?: number; long_term_price_notes?: string | null; temporary_price_notes?: string | null })
          const fmt = (n: number) => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 }).format(n)
          const cur = op.currency ?? 'ARS'

          if (op.pricing_mode === 'consult' || !op.pricing_mode) {
            return (
              <p className="text-sm text-muted-foreground italic">Precio a consultar</p>
            )
          }

          if (op.operation_type === 'sale' && op.sale_price) {
            return (
              <div className="text-sm">
                <span className="font-semibold">{cur} {fmt(op.sale_price)}</span>
                <span className="ml-2 text-muted-foreground">Venta</span>
              </div>
            )
          }

          if (op.operation_type === 'long_term_rental' && op.monthly_rent_price) {
            return (
              <div className="space-y-0.5 text-sm">
                <div>
                  <span className="font-semibold">{cur} {fmt(op.monthly_rent_price)}</span>
                  <span className="ml-1 text-muted-foreground">/ mes</span>
                </div>
                {op.expenses_amount != null && op.expenses_amount > 0 && (
                  <div className="text-xs text-muted-foreground">+ Expensas {cur} {fmt(op.expenses_amount)}</div>
                )}
              </div>
            )
          }

          if (op.operation_type === 'temporary_rental' && op.base_price_per_night) {
            return (
              <div className="space-y-0.5 text-sm">
                <div>
                  <span className="font-semibold">{cur} {fmt(op.base_price_per_night)}</span>
                  <span className="ml-1 text-muted-foreground">/ noche</span>
                </div>
                {(op.minimum_stay_nights ?? 1) > 1 && (
                  <div className="text-xs text-muted-foreground">Mínimo {op.minimum_stay_nights} noches</div>
                )}
                {op.cleaning_fee != null && op.cleaning_fee > 0 && (
                  <div className="text-xs text-muted-foreground">Limpieza: {cur} {fmt(op.cleaning_fee)}</div>
                )}
              </div>
            )
          }

          return null
        })()}

        {/* Description */}
        {property.description && (
          <p className="text-sm text-muted-foreground">{property.description}</p>
        )}

        {/* Internal address (private — only visible in CRM) */}
        {property.internal_address && (
          <p className="text-xs text-muted-foreground">
            Dirección: {property.internal_address}
          </p>
        )}

        {/* Custom fields */}
        {customFields.length > 0 && (
          <div className="rounded-lg border px-4 py-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Características</p>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-3">
              {customFields.map((f, i) => (
                <div key={i} className="flex gap-2">
                  <dt className="text-muted-foreground">{f.key}:</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>

      {/* Dialogs */}
      <EditPropertyDialog
        property={asListItem}
        open={editOpen}
        onOpenChange={setEditOpen}
      />

      <ArchivePropertyDialog
        property={asListItem}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        redirectAfter
      />
    </>
  )
}
