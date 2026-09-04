'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import Link from 'next/link'
import { Plus, Pencil, Trash2, Building, ExternalLink, Power, PowerOff } from 'lucide-react'
import type { TenantRole } from '@orderflow/types'
import type { PropertyListItem } from '@/lib/repositories/properties.repository'
import { activatePropertyAction, deactivatePropertyAction, changePropertyCommercialStatusAction } from '@/actions/properties'
import { COMMERCIAL_STATUS_LABEL, getCommercialStatusBadgeClass } from '@/lib/property-commercial-status'
import { Button } from '@/components/ui/button'
import { Badge }  from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { CreatePropertyDialog } from './create-property-dialog'
import { EditPropertyDialog }   from './edit-property-dialog'
import { ArchivePropertyDialog } from './archive-property-dialog'

const STATUS_LABEL: Record<string, string> = {
  active:   'Activo',
  draft:    'Borrador',
  archived: 'Archivado',
}

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  active:   'default',
  draft:    'secondary',
  archived: 'outline',
}

interface PropertyTableProps {
  properties:           PropertyListItem[]
  currentRole:          TenantRole
  canCreateProperties:  boolean
}

export function PropertyTable({
  properties,
  currentRole,
  canCreateProperties,
}: PropertyTableProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [createOpen, setCreateOpen]  = useState(false)
  const [editTarget, setEditTarget]  = useState<PropertyListItem | null>(null)
  const [archiveTarget, setArchiveTarget] = useState<PropertyListItem | null>(null)

  const canEdit    = canCreateProperties
  const canPublish = currentRole === 'owner'
  const canDelete  = currentRole === 'owner'

  function handleTogglePublished(property: PropertyListItem) {
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

  function handleCommercialStatusChange(propertyId: string, newStatus: string) {
    startTransition(async () => {
      const result = await changePropertyCommercialStatusAction(propertyId, newStatus)
      if (result.success) {
        toast.success('Estado comercial actualizado')
        router.refresh()
      } else {
        toast.error(result.error)
      }
    })
  }

  const activeProperties = properties.filter((p) => p.status !== 'archived')

  return (
    <div className="space-y-6">
      {/* Table action bar */}
      {canEdit && (
        <div className="flex justify-end">
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-4 w-4" />
            Nueva Propiedad
          </Button>
        </div>
      )}

      {/* Empty state */}
      {activeProperties.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
          <Building className="mb-3 h-10 w-10 text-muted-foreground" />
          <p className="text-sm font-medium">No hay propiedades</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {canEdit
              ? 'Creá tu primera propiedad para empezar.'
              : 'No hay propiedades disponibles.'}
          </p>
          {canEdit && (
            <Button className="mt-4" size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1 h-4 w-4" />
              Crear Propiedad
            </Button>
          )}
        </div>
      )}

      {/* Table */}
      {activeProperties.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Foto</TableHead>
                <TableHead>Título</TableHead>
                <TableHead>Ubicación</TableHead>
                <TableHead className="text-center">Capacidad</TableHead>
                <TableHead className="text-center">m²</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Comercial</TableHead>
                <TableHead className="w-[140px] text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activeProperties.map((property) => {
                const coverUrl =
                  property.cover_image_url ??
                  property.images.find((i) => i.is_cover)?.image_url ??
                  property.images[0]?.image_url

                return (
                  <TableRow key={property.id}>
                    <TableCell>
                      {coverUrl ? (
                        <img
                          src={coverUrl}
                          alt={property.title}
                          className="h-10 w-14 rounded object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="flex h-10 w-14 items-center justify-center rounded bg-muted">
                          <Building className="h-4 w-4 text-muted-foreground" />
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-medium">
                      <Link
                        href={`/dashboard/properties/${property.id}`}
                        className="hover:underline"
                      >
                        {property.title}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {property.location_label ??
                        [property.neighborhood, property.city].filter(Boolean).join(', ') ??
                        '—'}
                    </TableCell>
                    <TableCell className="text-center text-sm text-muted-foreground">
                      {property.capacity != null ? `${property.capacity} pers.` : '—'}
                    </TableCell>
                    <TableCell className="text-center text-sm text-muted-foreground">
                      {property.area_m2 != null ? `${property.area_m2} m²` : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[property.status] ?? 'outline'}>
                        {STATUS_LABEL[property.status] ?? property.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {canPublish ? (
                        <select
                          value={property.commercial_status ?? 'available'}
                          disabled={isPending}
                          onChange={(e) => handleCommercialStatusChange(property.id, e.target.value)}
                          className="rounded border border-input bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                        >
                          {Object.entries(COMMERCIAL_STATUS_LABEL).map(([value, label]) => (
                            <option key={value} value={value}>{label}</option>
                          ))}
                        </select>
                      ) : (
                        <span
                          className={`inline-flex items-center rounded border px-2 py-0.5 text-[11px] font-medium ${getCommercialStatusBadgeClass(property.commercial_status ?? 'available')}`}
                        >
                          {COMMERCIAL_STATUS_LABEL[property.commercial_status ?? 'available'] ?? 'Disponible'}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon" title="Ver detalle" asChild>
                          <Link href={`/dashboard/properties/${property.id}`}>
                            <ExternalLink className="h-4 w-4" />
                            <span className="sr-only">Ver detalle</span>
                          </Link>
                        </Button>
                        {canEdit && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Editar"
                            onClick={() => setEditTarget(property)}
                          >
                            <Pencil className="h-4 w-4" />
                            <span className="sr-only">Editar</span>
                          </Button>
                        )}
                        {canPublish && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title={property.status === 'active' ? 'Desactivar' : 'Activar'}
                            disabled={isPending}
                            onClick={() => handleTogglePublished(property)}
                          >
                            {property.status === 'active' ? (
                              <PowerOff className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <Power className="h-4 w-4 text-muted-foreground" />
                            )}
                            <span className="sr-only">
                              {property.status === 'active' ? 'Desactivar' : 'Activar'}
                            </span>
                          </Button>
                        )}
                        {canDelete && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Eliminar"
                            onClick={() => setArchiveTarget(property)}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                            <span className="sr-only">Eliminar</span>
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Dialogs */}
      <CreatePropertyDialog open={createOpen} onOpenChange={setCreateOpen} />

      <EditPropertyDialog
        property={editTarget}
        open={!!editTarget}
        onOpenChange={(open) => { if (!open) setEditTarget(null) }}
      />

      <ArchivePropertyDialog
        property={archiveTarget}
        open={!!archiveTarget}
        onOpenChange={(open) => { if (!open) setArchiveTarget(null) }}
      />
    </div>
  )
}
