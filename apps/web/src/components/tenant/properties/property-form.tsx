'use client'

import { useRef, useState, useEffect, useCallback } from 'react'
import { slugify } from '@/lib/slugify'
import { useFieldArray, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Plus, Trash2, Upload, X, ImageIcon, ChevronUp, ChevronDown } from 'lucide-react'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { Input }    from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button }   from '@/components/ui/button'

// ── Text-only schema (images managed via useState) ──────────────────────────────
const textSchema = z.object({
  title:            z.string().min(1, 'El título es requerido').max(200),
  description:      z.string().max(2000).optional(),
  location_label:   z.string().min(1, 'La ubicación es requerida').max(300),
  internal_address: z.string().max(300).optional(),
  google_maps_url:  z.string().url('URL de Google Maps inválida').or(z.literal('')).optional(),
  capacity:         z.string().optional(),
  area_m2:          z.string().optional(),
  custom_fields:    z.array(z.object({ key: z.string(), value: z.string() })).optional().default([]),
  // Pricing
  operation_type:            z.enum(['sale', 'long_term_rental', 'temporary_rental']).default('temporary_rental'),
  pricing_mode:              z.enum(['fixed', 'consult']).default('consult'),
  currency:                  z.string().default('ARS'),
  show_price_public:         z.boolean().default(true),
  sale_price:                z.string().optional(),
  monthly_rent_price:        z.string().optional(),
  expenses_amount:           z.string().optional(),
  long_term_deposit_amount:  z.string().optional(),
  long_term_price_notes:     z.string().optional(),
  base_price_per_night:      z.string().optional(),
  minimum_stay_nights:       z.string().optional(),
  cleaning_fee:              z.string().optional(),
  temporary_deposit_amount:  z.string().optional(),
  temporary_deposit_percent: z.string().optional(),
  temporary_price_notes:     z.string().optional(),
  check_in_time:             z.string().optional(),
  check_out_time:            z.string().optional(),
  // Public site
  published:                 z.boolean().default(false),
  slug:                      z.string().optional(),
  show_exact_address_public: z.boolean().default(false),
})
type TextValues = z.infer<typeof textSchema>

// ── Image state types ───────────────────────────────────────────────────────────
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_BYTES     = 5 * 1024 * 1024

export type CoverState =
  | { type: 'none' }
  | { type: 'url';  url: string }
  | { type: 'file'; file: File; preview: string }

export type GalleryEntry =
  | { type: 'url';  url: string; alt: string }
  | { type: 'file'; file: File; preview: string; alt: string }

export type PropertyFormPayload = {
  title:             string
  description?:      string
  location_label:    string
  internal_address?: string
  google_maps_url?:  string
  capacity?:         number
  area_m2?:          number
  custom_fields:     { key: string; value: string }[]
  cover:             CoverState
  gallery:           GalleryEntry[]
  // Pricing
  operation_type:            'sale' | 'long_term_rental' | 'temporary_rental'
  pricing_mode:              'fixed' | 'consult'
  currency:                  string
  show_price_public:         boolean
  sale_price:                number | null
  monthly_rent_price:        number | null
  expenses_amount:           number | null
  long_term_deposit_amount:  number | null
  long_term_price_notes:     string | null
  base_price_per_night:      number | null
  minimum_stay_nights:       number
  cleaning_fee:              number
  temporary_deposit_amount:  number | null
  temporary_deposit_percent: number | null
  temporary_price_notes:     string | null
  check_in_time:             string | null
  check_out_time:            string | null
  // Public site
  published:                 boolean
  slug:                      string | null
  public_code?:              string | null
  show_exact_address_public: boolean
}

function validateFile(f: File): string | null {
  if (!ALLOWED_TYPES.includes(f.type)) return 'Solo se admiten imágenes JPG, PNG o WebP'
  if (f.size > MAX_BYTES) return 'La imagen no puede superar 5 MB'
  return null
}

// ── Props ───────────────────────────────────────────────────────────────────────
export interface PropertyFormDefaultValues {
  title?:            string
  description?:      string
  location_label?:   string
  internal_address?: string
  google_maps_url?:  string
  capacity?:         string
  area_m2?:          string
  custom_fields?:    { key: string; value: string }[]
  initialCover?:     string | null
  initialGallery?:   { url: string; alt: string; id?: string; isCover?: boolean }[]
  // Pricing
  operation_type?:            'sale' | 'long_term_rental' | 'temporary_rental'
  pricing_mode?:              'fixed' | 'consult'
  currency?:                  string
  show_price_public?:         boolean
  sale_price?:                string
  monthly_rent_price?:        string
  expenses_amount?:           string
  long_term_deposit_amount?:  string
  long_term_price_notes?:     string
  base_price_per_night?:      string
  minimum_stay_nights?:       string
  cleaning_fee?:              string
  temporary_deposit_amount?:  string
  temporary_deposit_percent?: string
  temporary_price_notes?:     string
  check_in_time?:             string
  check_out_time?:            string
  // Public site
  published?:                 boolean
  slug?:                      string
  public_code?:               string | null
  show_exact_address_public?: boolean
}

interface PropertyFormProps {
  defaultValues?: PropertyFormDefaultValues
  onSubmit:       (payload: PropertyFormPayload) => Promise<void>
  isPending:      boolean
  submitLabel?:   string
  onCancel?:      () => void
  videoSlot?:     React.ReactNode
}

export function PropertyForm({
  defaultValues,
  onSubmit,
  isPending,
  submitLabel = 'Guardar',
  onCancel,
  videoSlot,
}: PropertyFormProps) {
  // ── Cover state ───────────────────────────────────────────────────────────────
  const [cover, setCover] = useState<CoverState>(
    defaultValues?.initialCover
      ? { type: 'url', url: defaultValues.initialCover }
      : { type: 'none' }
  )
  const [gallery, setGallery] = useState<GalleryEntry[]>(
    (defaultValues?.initialGallery ?? []).map((img) => ({
      type: 'url' as const,
      url:  img.url,
      alt:  img.alt,
    }))
  )
  const [fileErrors, setFileErrors] = useState<string[]>([])

  // Track all created object URLs so we can revoke on unmount
  const previewUrlsRef = useRef<Set<string>>(new Set())

  function mkPreview(file: File): string {
    const url = URL.createObjectURL(file)
    previewUrlsRef.current.add(url)
    return url
  }
  function dropPreview(url: string) {
    URL.revokeObjectURL(url)
    previewUrlsRef.current.delete(url)
  }

  useEffect(() => {
    return () => {
      previewUrlsRef.current.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [])

  const coverInputRef   = useRef<HTMLInputElement>(null)
  const galleryInputRef = useRef<HTMLInputElement>(null)

  // ── Text form ─────────────────────────────────────────────────────────────────
  const form = useForm<TextValues>({
    resolver: zodResolver(textSchema),
    defaultValues: {
      title:            defaultValues?.title            ?? '',
      description:      defaultValues?.description      ?? '',
      location_label:   defaultValues?.location_label   ?? '',
      internal_address: defaultValues?.internal_address ?? '',
      google_maps_url:  defaultValues?.google_maps_url  ?? '',
      capacity:         defaultValues?.capacity          ?? '',
      area_m2:          defaultValues?.area_m2           ?? '',
      custom_fields:    defaultValues?.custom_fields     ?? [],
      operation_type:            defaultValues?.operation_type            ?? 'temporary_rental',
      pricing_mode:              defaultValues?.pricing_mode              ?? 'consult',
      currency:                  defaultValues?.currency                  ?? 'ARS',
      show_price_public:         defaultValues?.show_price_public         ?? true,
      sale_price:                defaultValues?.sale_price                ?? '',
      monthly_rent_price:        defaultValues?.monthly_rent_price        ?? '',
      expenses_amount:           defaultValues?.expenses_amount           ?? '',
      long_term_deposit_amount:  defaultValues?.long_term_deposit_amount  ?? '',
      long_term_price_notes:     defaultValues?.long_term_price_notes     ?? '',
      base_price_per_night:      defaultValues?.base_price_per_night      ?? '',
      minimum_stay_nights:       defaultValues?.minimum_stay_nights       ?? '1',
      cleaning_fee:              defaultValues?.cleaning_fee              ?? '0',
      temporary_deposit_amount:  defaultValues?.temporary_deposit_amount  ?? '',
      temporary_deposit_percent: defaultValues?.temporary_deposit_percent ?? '',
      temporary_price_notes:     defaultValues?.temporary_price_notes     ?? '',
      check_in_time:             defaultValues?.check_in_time             ?? '',
      check_out_time:            defaultValues?.check_out_time            ?? '',
      published:                 defaultValues?.published                 ?? false,
      slug:                      defaultValues?.slug                      ?? '',
      show_exact_address_public: defaultValues?.show_exact_address_public ?? false,
    },
  })

  const watchedOperation  = form.watch('operation_type')
  const watchedPricingMode = form.watch('pricing_mode')

  const autoSlug = useCallback((title: string) => {
    const currentSlug = form.getValues('slug')
    if (!currentSlug) form.setValue('slug', slugify(title))
  }, [form])

  const {
    fields: fieldFields,
    append: appendField,
    remove: removeField,
  } = useFieldArray({ control: form.control, name: 'custom_fields' })

  // ── File handlers ─────────────────────────────────────────────────────────────
  function handleCoverChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const err = validateFile(file)
    if (err) { setFileErrors([err]); e.target.value = ''; return }
    if (cover.type === 'file') dropPreview(cover.preview)
    setCover({ type: 'file', file, preview: mkPreview(file) })
    setFileErrors([])
    e.target.value = ''
  }

  function removeCover() {
    if (cover.type === 'file') dropPreview(cover.preview)
    setCover({ type: 'none' })
  }

  function handleGalleryChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files  = Array.from(e.target.files ?? [])
    const errors: string[] = []
    const added:  GalleryEntry[] = []
    for (const f of files) {
      const err = validateFile(f)
      if (err) { errors.push(`${f.name}: ${err}`); continue }
      added.push({ type: 'file', file: f, preview: mkPreview(f), alt: '' })
    }
    if (errors.length) setFileErrors(errors)
    if (added.length)  setGallery((prev) => [...prev, ...added])
    e.target.value = ''
  }

  function removeGallery(idx: number) {
    setGallery((prev) => {
      const item = prev[idx]
      if (item?.type === 'file') dropPreview(item.preview)
      return prev.filter((_, i) => i !== idx)
    })
  }

  function setGalleryAlt(idx: number, alt: string) {
    setGallery((prev) => prev.map((item, i) => (i === idx ? { ...item, alt } : item)))
  }

  function moveGallery(idx: number, dir: 'up' | 'down') {
    const swap = dir === 'up' ? idx - 1 : idx + 1
    if (swap < 0 || swap >= gallery.length) return
    const next = [...gallery]
    ;[next[idx], next[swap]] = [next[swap]!, next[idx]!]
    setGallery(next)
  }

  // ── Submit ────────────────────────────────────────────────────────────────────
  function handleSubmit(text: TextValues) {
    const payload: PropertyFormPayload = {
      title:            text.title,
      description:      text.description      || undefined,
      location_label:   text.location_label,
      internal_address: text.internal_address || undefined,
      google_maps_url:  text.google_maps_url  || undefined,
      capacity:         text.capacity ? Number(text.capacity) : undefined,
      area_m2:          text.area_m2  ? Number(text.area_m2)  : undefined,
      custom_fields:    (text.custom_fields ?? []).filter((f) => f.key.trim() && f.value.trim()),
      cover,
      gallery,
      operation_type:            text.operation_type,
      pricing_mode:              text.pricing_mode,
      currency:                  text.currency,
      show_price_public:         text.show_price_public,
      sale_price:                text.sale_price ? Number(text.sale_price) : null,
      monthly_rent_price:        text.monthly_rent_price ? Number(text.monthly_rent_price) : null,
      expenses_amount:           text.expenses_amount ? Number(text.expenses_amount) : null,
      long_term_deposit_amount:  text.long_term_deposit_amount ? Number(text.long_term_deposit_amount) : null,
      long_term_price_notes:     text.long_term_price_notes || null,
      base_price_per_night:      text.base_price_per_night ? Number(text.base_price_per_night) : null,
      minimum_stay_nights:       text.minimum_stay_nights ? Number(text.minimum_stay_nights) : 1,
      cleaning_fee:              text.cleaning_fee ? Number(text.cleaning_fee) : 0,
      temporary_deposit_amount:  text.temporary_deposit_amount ? Number(text.temporary_deposit_amount) : null,
      temporary_deposit_percent: text.temporary_deposit_percent ? Number(text.temporary_deposit_percent) : null,
      temporary_price_notes:     text.temporary_price_notes || null,
      check_in_time:             text.check_in_time  || null,
      check_out_time:            text.check_out_time || null,
      published:                 text.published,
      slug:                      text.slug || null,
      public_code:               defaultValues?.public_code ?? null,
      show_exact_address_public: text.show_exact_address_public,
    }
    return onSubmit(payload)
  }

  // ── Derived cover preview src ─────────────────────────────────────────────────
  const coverSrc =
    cover.type === 'none' ? null :
    cover.type === 'url'  ? cover.url :
    cover.preview

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-5">

        {/* ── Foto principal ── */}
        <div>
          <p className="mb-2 text-sm font-medium">Foto principal</p>
          {coverSrc ? (
            <div className="relative">
              <img
                src={coverSrc}
                alt="Foto principal"
                className="h-44 w-full rounded-md object-cover"
              />
              <button
                type="button"
                onClick={removeCover}
                className="absolute right-2 top-2 rounded-full bg-black/60 p-1 text-white hover:bg-black/80"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => coverInputRef.current?.click()}
              className="flex h-44 w-full flex-col items-center justify-center rounded-md border-2 border-dashed border-muted-foreground/30 text-muted-foreground hover:border-muted-foreground/60 transition-colors"
            >
              <ImageIcon className="mb-1.5 h-8 w-8 opacity-30" />
              <span className="text-xs">Subir foto principal</span>
              <span className="mt-0.5 text-xs opacity-50">JPG, PNG o WebP · máx. 5 MB</span>
            </button>
          )}
          {coverSrc && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => coverInputRef.current?.click()}
            >
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              Cambiar foto
            </Button>
          )}
          <input
            ref={coverInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={handleCoverChange}
          />
        </div>

        {/* ── Galería ── */}
        <div>
          <p className="mb-0.5 text-sm font-medium">Galería</p>
          {videoSlot
            ? <p className="mb-2 text-xs text-muted-foreground">Agregá fotos y hasta 2 videos cortos de la propiedad.</p>
            : null
          }

          {/* Fotos */}
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Fotos</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => galleryInputRef.current?.click()}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Agregar fotos
            </Button>
          </div>
          <input
            ref={galleryInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            className="hidden"
            onChange={handleGalleryChange}
          />
          {gallery.length > 0 ? (
            <div className="space-y-2">
              {gallery.map((entry, idx) => {
                const src = entry.type === 'url' ? entry.url : entry.preview
                return (
                  <div key={idx} className="flex items-center gap-1.5">
                    {/* ↑↓ order controls */}
                    <div className="flex shrink-0 flex-col">
                      <button
                        type="button"
                        onClick={() => moveGallery(idx, 'up')}
                        disabled={idx === 0}
                        aria-label="Mover arriba"
                        className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-25 disabled:cursor-not-allowed"
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveGallery(idx, 'down')}
                        disabled={idx === gallery.length - 1}
                        aria-label="Mover abajo"
                        className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-25 disabled:cursor-not-allowed"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {/* Thumbnail */}
                    <img
                      src={src}
                      alt={entry.alt || 'Imagen'}
                      className="h-16 w-20 shrink-0 rounded object-cover"
                    />

                    {/* Alt text */}
                    <Input
                      placeholder="Texto alternativo (opcional)"
                      value={entry.alt}
                      onChange={(e) => setGalleryAlt(idx, e.target.value)}
                      className="flex-1 text-xs"
                    />

                    {/* Delete */}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => removeGallery(idx)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Sin imágenes de galería. Podés seleccionar varias a la vez.
            </p>
          )}

          {/* Videos — solo en edición (requiere propertyId, inyectado desde el dialog) */}
          {videoSlot && (
            <div className="mt-4 border-t pt-4">
              <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">Videos</p>
              {videoSlot}
            </div>
          )}
        </div>

        {/* ── Errores de archivo ── */}
        {fileErrors.length > 0 && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2">
            {fileErrors.map((e, i) => (
              <p key={i} className="text-xs text-destructive">{e}</p>
            ))}
          </div>
        )}

        {/* ── Datos básicos ── */}
        <FormField
          control={form.control}
          name="title"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Título *</FormLabel>
              <FormControl>
                <Input
                  placeholder="Ej: Departamento Palermo"
                  {...field}
                  onBlur={e => { field.onBlur(); autoSlug(e.target.value) }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Descripción</FormLabel>
              <FormControl>
                <Textarea placeholder="Describí la propiedad..." className="min-h-[80px]" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="location_label"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Ubicación visible *</FormLabel>
              <FormControl>
                <Input placeholder="Ej: Palermo, Buenos Aires" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="internal_address"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Dirección interna <span className="text-muted-foreground">(privada)</span>
              </FormLabel>
              <FormControl>
                <Input placeholder="Av. Santa Fe 1234, Piso 3, Depto B" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="google_maps_url"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Link Google Maps</FormLabel>
              <FormControl>
                <Input placeholder="https://maps.google.com/..." {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* ── Tipo de operación ── */}
        <FormField
          control={form.control}
          name="operation_type"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Tipo de operación</FormLabel>
              <FormControl>
                <select
                  {...field}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
                >
                  <option value="temporary_rental">Alquiler temporal</option>
                  <option value="long_term_rental">Alquiler tradicional</option>
                  <option value="sale">Venta</option>
                </select>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* ── Características ── */}
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="capacity"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Capacidad (personas)</FormLabel>
                <FormControl>
                  <Input type="number" min={1} placeholder="0" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="area_m2"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Superficie (m²)</FormLabel>
                <FormControl>
                  <Input type="number" min={0} step="0.1" placeholder="0" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* ── Campos personalizados ── */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium">Campos personalizados</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => appendField({ key: '', value: '' })}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Agregar campo
            </Button>
          </div>
          <div className="space-y-2">
            {fieldFields.map((f, idx) => (
              <div key={f.id} className="flex items-start gap-2">
                <FormField
                  control={form.control}
                  name={`custom_fields.${idx}.key`}
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormControl>
                        <Input placeholder="Ej: baños" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name={`custom_fields.${idx}.value`}
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormControl>
                        <Input placeholder="Ej: 2" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeField(idx)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {fieldFields.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Sin campos personalizados. Ejemplos: baños, cochera, wifi, pileta.
              </p>
            )}
          </div>
        </div>

        {/* ── Precio ── */}
        <div className="space-y-4 rounded-lg border p-4">
          <p className="text-sm font-medium">Precio</p>

          {/* Modo de precio */}
          <FormField
            control={form.control}
            name="pricing_mode"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Modo</FormLabel>
                <FormControl>
                  <select
                    {...field}
                    className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
                  >
                    <option value="consult">A consultar</option>
                    <option value="fixed">Precio fijo</option>
                  </select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Moneda + visibilidad */}
          <div className="grid grid-cols-2 gap-3">
            <FormField
              control={form.control}
              name="currency"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Moneda</FormLabel>
                  <FormControl>
                    <select
                      {...field}
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
                    >
                      <option value="ARS">ARS — Pesos</option>
                      <option value="USD">USD — Dólares</option>
                      <option value="BRL">BRL — Reales</option>
                      <option value="UYU">UYU — Pesos uruguayos</option>
                      <option value="EUR">EUR — Euros</option>
                    </select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="show_price_public"
              render={({ field }) => (
                <FormItem className="flex flex-col">
                  <FormLabel>Mostrar precio</FormLabel>
                  <FormControl>
                    <div className="flex items-center gap-2 mt-1">
                      <input
                        type="checkbox"
                        checked={field.value}
                        onChange={e => field.onChange(e.target.checked)}
                        className="h-4 w-4"
                      />
                      <span className="text-sm text-muted-foreground">Visible públicamente</span>
                    </div>
                  </FormControl>
                </FormItem>
              )}
            />
          </div>

          {/* Venta */}
          {watchedOperation === 'sale' && watchedPricingMode === 'fixed' && (
            <FormField
              control={form.control}
              name="sale_price"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Precio de venta</FormLabel>
                  <FormControl>
                    <Input type="number" min={0} step="1000" placeholder="Ej: 120000" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          {/* Alquiler tradicional */}
          {watchedOperation === 'long_term_rental' && watchedPricingMode === 'fixed' && (
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="monthly_rent_price"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Precio mensual</FormLabel>
                    <FormControl>
                      <Input type="number" min={0} placeholder="Ej: 450000" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="expenses_amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Expensas</FormLabel>
                    <FormControl>
                      <Input type="number" min={0} placeholder="Ej: 50000" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="long_term_deposit_amount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Depósito</FormLabel>
                    <FormControl>
                      <Input type="number" min={0} placeholder="Ej: 900000" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          )}
          {watchedOperation === 'long_term_rental' && (
            <FormField
              control={form.control}
              name="long_term_price_notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notas de precio</FormLabel>
                  <FormControl>
                    <Input placeholder="Ej: Precio + expensas, negociable..." {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          {/* Alquiler temporal */}
          {watchedOperation === 'temporary_rental' && watchedPricingMode === 'fixed' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="base_price_per_night"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Precio por noche</FormLabel>
                      <FormControl>
                        <Input type="number" min={0} placeholder="Ej: 45000" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="minimum_stay_nights"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Mínimo de noches</FormLabel>
                      <FormControl>
                        <Input type="number" min={1} placeholder="1" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="cleaning_fee"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Limpieza</FormLabel>
                      <FormControl>
                        <Input type="number" min={0} placeholder="Ej: 10000" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="temporary_deposit_amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Seña fija</FormLabel>
                      <FormControl>
                        <Input type="number" min={0} placeholder="Ej: 50000" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="temporary_deposit_percent"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Seña % del total</FormLabel>
                      <FormControl>
                        <Input type="number" min={0} max={100} step="0.1" placeholder="Ej: 30" {...field} />
                      </FormControl>
                      <p className="text-[11px] text-muted-foreground">Si hay seña fija, tiene prioridad</p>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>
          )}
          {watchedOperation === 'temporary_rental' && (
            <FormField
              control={form.control}
              name="temporary_price_notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notas de precio</FormLabel>
                  <FormControl>
                    <Input placeholder="Ej: Precio incluye limpieza final..." {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </div>

        {/* ── Horarios ── */}
        {watchedOperation === 'temporary_rental' && (
          <div className="space-y-3 rounded-lg border p-4">
            <p className="text-sm font-medium">Horarios</p>
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="check_in_time"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Check-in</FormLabel>
                    <FormControl>
                      <Input type="time" {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="check_out_time"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Check-out</FormLabel>
                    <FormControl>
                      <Input type="time" {...field} value={field.value ?? ''} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </div>
        )}

        {/* ── Publicación en web ── */}
        <div className="space-y-3 rounded-lg border p-4">
          <p className="text-sm font-medium">Publicación en sitio público</p>

          <FormField
            control={form.control}
            name="published"
            render={({ field }) => (
              <FormItem className="flex items-center gap-3">
                <FormControl>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={field.value}
                    onClick={() => field.onChange(!field.value)}
                    className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none ${field.value ? 'bg-primary' : 'bg-input'}`}
                  >
                    <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${field.value ? 'translate-x-5' : 'translate-x-0'}`} />
                  </button>
                </FormControl>
                <div>
                  <FormLabel className="cursor-pointer">Publicar en web</FormLabel>
                  <p className="text-xs text-muted-foreground">Visible en el catálogo público</p>
                </div>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="slug"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Slug público</FormLabel>
                <FormControl>
                  <Input
                    placeholder="mi-propiedad"
                    {...field}
                    onChange={e => field.onChange(slugify(e.target.value))}
                  />
                </FormControl>
                <p className="text-xs text-muted-foreground">
                  URL: /site/[slug-inmobiliaria]/properties/<strong>{field.value || 'mi-propiedad'}</strong>
                </p>
                <FormMessage />
              </FormItem>
            )}
          />

          {defaultValues?.public_code && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Código de referencia</p>
              <code className="rounded bg-muted px-2 py-1 text-sm font-mono">
                {defaultValues.public_code}
              </code>
              <p className="text-xs text-muted-foreground mt-1">
                Se incluye en el mensaje de WhatsApp para identificar la propiedad.
              </p>
            </div>
          )}

          <FormField
            control={form.control}
            name="show_exact_address_public"
            render={({ field }) => (
              <FormItem className="flex items-center gap-3">
                <FormControl>
                  <input
                    type="checkbox"
                    checked={field.value}
                    onChange={e => field.onChange(e.target.checked)}
                    className="h-4 w-4"
                  />
                </FormControl>
                <div>
                  <FormLabel className="cursor-pointer">Mostrar dirección exacta y mapa en la web pública</FormLabel>
                  <p className="text-xs text-muted-foreground">Si está desactivado, solo se mostrará la zona/ubicación pública.</p>
                </div>
              </FormItem>
            )}
          />
        </div>

        {/* ── Acciones ── */}
        <div className="flex justify-end gap-2 pt-2">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
              Cancelar
            </Button>
          )}
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Guardando...' : submitLabel}
          </Button>
        </div>
      </form>
    </Form>
  )
}
