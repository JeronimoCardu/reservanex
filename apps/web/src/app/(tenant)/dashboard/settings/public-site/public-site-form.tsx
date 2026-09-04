'use client'

import { useState, useTransition, useRef } from 'react'
import { useRouter }              from 'next/navigation'
import { toast }                  from 'sonner'
import Image                      from 'next/image'
import {
  savePublicSiteAction,
  uploadTenantPublicAssetAction,
  type PublicSiteInput,
} from '@/actions/public-site'
import { slugify } from '@/lib/slugify'

interface Props {
  settings: {
    public_site_enabled:             boolean
    public_slug:                     string | null
    public_name:                     string | null
    public_description:              string | null
    public_cover_image_url:          string | null
    public_cover_image_storage_path: string | null
    public_logo_url:                 string | null
    public_logo_storage_path:        string | null
    public_primary_color:            string | null
    public_secondary_color:          string | null
    public_phone:                    string | null
    public_email:                    string | null
    public_instagram_url:            string | null
    public_website_url:              string | null
  } | null
  siteUrl: string
}

type AssetState =
  | { status: 'idle' }
  | { status: 'uploading' }
  | { status: 'done'; publicUrl: string; path: string }
  | { status: 'error'; message: string }

function ImageUploadField({
  label,
  hint,
  currentUrl,
  assetType,
  onUploaded,
  onRemove,
}: {
  label:     string
  hint:      string
  currentUrl: string | null
  assetType: 'logo' | 'cover'
  onUploaded: (publicUrl: string, path: string) => void
  onRemove:   () => void
}) {
  const inputRef  = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<AssetState>({ status: 'idle' })
  const [preview, setPreview] = useState<string | null>(null)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setPreview(URL.createObjectURL(file))
    setState({ status: 'uploading' })

    const fd = new FormData()
    fd.append('file', file)

    const r = await uploadTenantPublicAssetAction(fd, assetType)
    if (r.success && r.data) {
      setState({ status: 'done', publicUrl: r.data.publicUrl, path: r.data.path })
      onUploaded(r.data.publicUrl, r.data.path)
    } else if (!r.success) {
      setState({ status: 'error', message: r.error })
      setPreview(null)
    }

    if (inputRef.current) inputRef.current.value = ''
  }

  const displayUrl = preview ?? currentUrl

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">{label}</label>
      <p className="text-xs text-muted-foreground">{hint}</p>

      <div className="flex items-start gap-4">
        {displayUrl ? (
          <div className="relative h-20 w-20 rounded-lg overflow-hidden border bg-muted flex-shrink-0">
            <Image src={displayUrl} alt={label} fill className="object-cover" />
          </div>
        ) : (
          <div className="h-20 w-20 rounded-lg border-2 border-dashed border-muted-foreground/30 flex items-center justify-center flex-shrink-0 bg-muted/30">
            <svg className="h-6 w-6 text-muted-foreground/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={state.status === 'uploading'}
            className="rounded-lg border bg-background px-3 py-1.5 text-sm hover:bg-muted transition-colors disabled:opacity-60"
          >
            {state.status === 'uploading' ? 'Subiendo...' : displayUrl ? 'Cambiar imagen' : 'Subir imagen'}
          </button>
          {displayUrl && (
            <button
              type="button"
              onClick={() => { setPreview(null); setState({ status: 'idle' }); onRemove() }}
              className="text-xs text-destructive hover:underline text-left"
            >
              Eliminar
            </button>
          )}
          {state.status === 'error' && (
            <p className="text-xs text-destructive">{state.message}</p>
          )}
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={handleFile}
      />
    </div>
  )
}

export function PublicSiteForm({ settings, siteUrl }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [enabled,       setEnabled]       = useState(settings?.public_site_enabled ?? false)
  const [slug,          setSlug]          = useState(settings?.public_slug          ?? '')
  const [name,          setName]          = useState(settings?.public_name          ?? '')
  const [description,   setDescription]   = useState(settings?.public_description   ?? '')
  const [phone,         setPhone]         = useState(settings?.public_phone          ?? '')
  const [email,         setEmail]         = useState(settings?.public_email          ?? '')
  const [instagramUrl,  setInstagramUrl]  = useState(settings?.public_instagram_url  ?? '')
  const [websiteUrl,    setWebsiteUrl]    = useState(settings?.public_website_url    ?? '')

  // Logo asset state
  const [logoUrl,  setLogoUrl]  = useState<string | null>(settings?.public_logo_url ?? null)
  const [logoPath, setLogoPath] = useState<string | null>(settings?.public_logo_storage_path ?? null)

  // Cover asset state
  const [coverUrl,  setCoverUrl]  = useState<string | null>(settings?.public_cover_image_url ?? null)
  const [coverPath, setCoverPath] = useState<string | null>(settings?.public_cover_image_storage_path ?? null)

  const publicUrl = slug ? `${siteUrl}/site/${slug}` : null

  function handleNameBlur() {
    if (!slug && name) setSlug(slugify(name))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const input: PublicSiteInput = {
      public_site_enabled:             enabled,
      public_slug:                     slug   || null,
      public_name:                     name   || null,
      public_description:              description || null,
      public_cover_image_url:          coverUrl || null,
      public_cover_image_storage_path: coverPath || null,
      public_logo_url:                 logoUrl || null,
      public_logo_storage_path:        logoPath || null,
      public_primary_color:            null,
      public_secondary_color:          null,
      public_phone:                    phone || null,
      public_email:                    email || null,
      public_instagram_url:            instagramUrl || null,
      public_website_url:              websiteUrl || null,
    }
    startTransition(async () => {
      const r = await savePublicSiteAction(input)
      if (r.success) {
        toast.success('Configuración guardada')
        router.refresh()
      } else {
        toast.error(r.error)
      }
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-8 max-w-xl">
      {/* Enable toggle */}
      <div className="flex items-start justify-between gap-4 rounded-xl border bg-card p-4">
        <div>
          <p className="font-medium">Sitio público activo</p>
          <p className="text-sm text-muted-foreground">
            Cuando está activo, cualquiera puede ver el catálogo en la URL pública.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => setEnabled(v => !v)}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none ${enabled ? 'bg-primary' : 'bg-input'}`}
        >
          <span className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : 'translate-x-0'}`} />
        </button>
      </div>

      {/* Slug */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Slug público</label>
        <p className="text-xs text-muted-foreground">
          Dirección de tu sitio: /site/<strong>{slug || 'tu-slug'}</strong>
        </p>
        <input
          type="text"
          value={slug}
          onChange={e => setSlug(slugify(e.target.value))}
          placeholder="mi-inmobiliaria"
          className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
        {publicUrl && (
          <div className="flex items-center gap-2 mt-1">
            <a href={publicUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-primary truncate hover:underline">
              {publicUrl}
            </a>
            <button
              type="button"
              onClick={() => { navigator.clipboard.writeText(publicUrl); toast.success('Link copiado') }}
              className="text-xs text-muted-foreground hover:text-foreground shrink-0"
            >
              Copiar
            </button>
          </div>
        )}
      </div>

      {/* Name */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Nombre público</label>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          onBlur={handleNameBlur}
          placeholder="Inmobiliaria San Andrés"
          className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </div>

      {/* Description */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium">Descripción</label>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          rows={3}
          placeholder="Breve descripción de tu inmobiliaria..."
          className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary resize-none"
        />
      </div>

      {/* Logo upload */}
      <ImageUploadField
        label="Logo"
        hint="Se muestra en el encabezado del sitio público. Formatos: JPG, PNG, WebP. Máx. 2 MB."
        currentUrl={logoUrl}
        assetType="logo"
        onUploaded={(url, path) => { setLogoUrl(url); setLogoPath(path) }}
        onRemove={() => { setLogoUrl(null); setLogoPath(null) }}
      />

      {/* Cover upload */}
      <ImageUploadField
        label="Imagen de portada"
        hint="Fondo del encabezado en el catálogo público. Formatos: JPG, PNG, WebP. Máx. 5 MB."
        currentUrl={coverUrl}
        assetType="cover"
        onUploaded={(url, path) => { setCoverUrl(url); setCoverPath(path) }}
        onRemove={() => { setCoverUrl(null); setCoverPath(null) }}
      />

      {/* Contact info */}
      <div className="space-y-4">
        <p className="text-sm font-medium">Información de contacto pública</p>

        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Teléfono visible</label>
          <input
            type="text"
            value={phone}
            onChange={e => setPhone(e.target.value)}
            placeholder="+54 9 232 555-5555"
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Email visible</label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="contacto@inmobiliaria.com"
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Instagram URL</label>
          <input
            type="url"
            value={instagramUrl}
            onChange={e => setInstagramUrl(e.target.value)}
            placeholder="https://instagram.com/mi-inmobiliaria"
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground">Sitio web externo</label>
          <input
            type="url"
            value={websiteUrl}
            onChange={e => setWebsiteUrl(e.target.value)}
            placeholder="https://mi-inmobiliaria.com"
            className="w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
      </div>

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-primary px-6 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60 transition-colors"
      >
        {pending ? 'Guardando...' : 'Guardar cambios'}
      </button>
    </form>
  )
}
