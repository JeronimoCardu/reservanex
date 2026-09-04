'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import type { PropertyFormPayload } from './property-form'
import { PropertyForm } from './property-form'
import { createPropertyAction, uploadPropertyImageAction } from '@/actions/properties'
import { generatePublicCode } from '@/lib/slugify'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface CreatePropertyDialogProps {
  open:         boolean
  onOpenChange: (open: boolean) => void
}

export function CreatePropertyDialog({ open, onOpenChange }: CreatePropertyDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  async function handleSubmit(payload: PropertyFormPayload): Promise<void> {
    return new Promise((resolve) => {
      startTransition(async () => {
        // 1. Upload cover if new file
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

        // 3. Create property
        const result = await createPropertyAction({
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
          public_code:               generatePublicCode(),
          show_exact_address_public: payload.show_exact_address_public,
        })

        if (result.success) {
          toast.success('Propiedad creada correctamente')
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
          <DialogTitle>Nueva Propiedad</DialogTitle>
          <DialogDescription>Completá los datos de la propiedad.</DialogDescription>
        </DialogHeader>
        <PropertyForm
          onSubmit={handleSubmit}
          isPending={isPending}
          submitLabel="Crear Propiedad"
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
