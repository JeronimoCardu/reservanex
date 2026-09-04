'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import type { Json } from '@orderflow/types'
import type { PropertyListItem } from '@/lib/repositories/properties.repository'
import type { PropertyFormPayload } from './property-form'
import { PropertyForm } from './property-form'
import { updatePropertyAction, uploadPropertyImageAction } from '@/actions/properties'
import { PropertyVideoManager } from './property-video-manager'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type CustomField = { key: string; value: string }

interface EditPropertyDialogProps {
  property:     PropertyListItem | null
  open:         boolean
  onOpenChange: (open: boolean) => void
}

export function EditPropertyDialog({ property, open, onOpenChange }: EditPropertyDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  if (!property) return null

  const rawCustomFields = property.custom_fields as Json
  const customFields: CustomField[] = Array.isArray(rawCustomFields)
    ? (rawCustomFields as CustomField[]).filter((f) => f?.key && f?.value)
    : []

  const defaultValues = {
    title:         property.title,
    description:   property.description ?? '',
    location_label:
      property.location_label ??
      [property.neighborhood, property.city].filter(Boolean).join(', ') ??
      '',
    internal_address: property.internal_address ?? property.address ?? '',
    google_maps_url:  property.google_maps_url ?? '',
    capacity:         property.capacity != null ? String(property.capacity) : '',
    area_m2:          property.area_m2  != null ? String(property.area_m2)  : '',
    custom_fields:    customFields,
    initialCover:     property.cover_image_url ?? null,
    initialGallery:   property.images.map((img) => ({
      url:     img.image_url,
      alt:     img.alt ?? '',
      id:      img.id,
      isCover: img.is_cover,
    })),
    operation_type:            (property.operation_type as 'sale' | 'long_term_rental' | 'temporary_rental' | undefined) ?? 'temporary_rental',
    pricing_mode:              (property.pricing_mode as 'fixed' | 'consult' | undefined) ?? 'consult',
    currency:                  property.currency ?? 'ARS',
    show_price_public:         property.show_price_public ?? true,
    sale_price:                property.sale_price != null ? String(property.sale_price) : '',
    monthly_rent_price:        property.monthly_rent_price != null ? String(property.monthly_rent_price) : '',
    expenses_amount:           property.expenses_amount != null ? String(property.expenses_amount) : '',
    long_term_deposit_amount:  property.long_term_deposit_amount != null ? String(property.long_term_deposit_amount) : '',
    long_term_price_notes:     property.long_term_price_notes ?? '',
    base_price_per_night:      property.base_price_per_night != null ? String(property.base_price_per_night) : '',
    minimum_stay_nights:       String(property.minimum_stay_nights ?? 1),
    cleaning_fee:              String(property.cleaning_fee ?? 0),
    temporary_deposit_amount:  property.temporary_deposit_amount != null ? String(property.temporary_deposit_amount) : '',
    temporary_deposit_percent: property.temporary_deposit_percent != null ? String(property.temporary_deposit_percent) : '',
    temporary_price_notes:     property.temporary_price_notes ?? '',
    check_in_time:             property.check_in_time  ? String(property.check_in_time).slice(0, 5)  : '',
    check_out_time:            property.check_out_time ? String(property.check_out_time).slice(0, 5) : '',
    published:                 property.published ?? false,
    slug:                      property.slug ?? '',
    public_code:               property.public_code ?? undefined,
    show_exact_address_public: property.show_exact_address_public ?? false,
  }

  async function handleSubmit(payload: PropertyFormPayload): Promise<void> {
    return new Promise((resolve) => {
      startTransition(async () => {
        // 1. Upload cover if new file; keep existing URL; treat 'none' as "don't change"
        let coverUrl: string | undefined
        let coverStoragePath: string | undefined
        if (payload.cover.type === 'file') {
          const fd = new FormData()
          fd.append('file', payload.cover.file)
          const r = await uploadPropertyImageAction(fd)
          if (!r.success) { toast.error(r.error); resolve(); return }
          coverUrl         = r.data!.publicUrl
          coverStoragePath = r.data!.path
        } else if (payload.cover.type === 'url') {
          coverUrl = payload.cover.url
        }
        // cover.type === 'none' → coverUrl stays undefined → field not updated in DB

        // 2. Upload gallery
        const images: { url: string; alt?: string; storage_path?: string }[] = []
        for (const entry of payload.gallery) {
          if (entry.type === 'file') {
            const fd = new FormData()
            fd.append('file', entry.file)
            const r = await uploadPropertyImageAction(fd)
            if (!r.success) { toast.error(r.error); resolve(); return }
            images.push({ url: r.data!.publicUrl, alt: entry.alt || undefined, storage_path: r.data!.path })
          } else {
            images.push({ url: entry.url, alt: entry.alt || undefined })
          }
        }

        // 3. Update property (cleanup de Storage ocurre en el servidor)
        const result = await updatePropertyAction(property!.id, {
          title:                    payload.title,
          description:              payload.description,
          location_label:           payload.location_label,
          internal_address:         payload.internal_address,
          google_maps_url:          payload.google_maps_url,
          cover_image_url:          coverUrl,
          cover_image_storage_path: coverStoragePath,
          capacity:                 payload.capacity,
          area_m2:                  payload.area_m2,
          custom_fields:            payload.custom_fields,
          images,
          operation_type:            payload.operation_type,
          pricing_mode:              payload.pricing_mode,
          currency:                  payload.currency,
          show_price_public:         payload.show_price_public,
          sale_price:                payload.sale_price,
          monthly_rent_price:        payload.monthly_rent_price,
          expenses_amount:           payload.expenses_amount,
          long_term_deposit_amount:  payload.long_term_deposit_amount,
          long_term_price_notes:     payload.long_term_price_notes,
          base_price_per_night:      payload.base_price_per_night,
          minimum_stay_nights:       payload.minimum_stay_nights,
          cleaning_fee:              payload.cleaning_fee,
          temporary_deposit_amount:  payload.temporary_deposit_amount,
          temporary_deposit_percent: payload.temporary_deposit_percent,
          temporary_price_notes:     payload.temporary_price_notes,
          check_in_time:             payload.check_in_time,
          check_out_time:            payload.check_out_time,
          published:                 payload.published,
          slug:                      payload.slug,
          show_exact_address_public: payload.show_exact_address_public,
        })

        if (result.success) {
          toast.success('Propiedad actualizada correctamente')
          onOpenChange(false)
          router.refresh()
        } else {
          toast.error(result.error)
        }
        resolve()
      })
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Editar Propiedad</DialogTitle>
          <DialogDescription>Actualizá los datos de la propiedad.</DialogDescription>
        </DialogHeader>
        <PropertyForm
          key={property.id}
          defaultValues={defaultValues}
          onSubmit={handleSubmit}
          isPending={isPending}
          submitLabel="Guardar Cambios"
          onCancel={() => onOpenChange(false)}
          videoSlot={<PropertyVideoManager propertyId={property.id} />}
        />
      </DialogContent>
    </Dialog>
  )
}
