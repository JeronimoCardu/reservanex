import type { PublicTenant } from '@/lib/repositories/public-site.repository'

interface Props {
  tenant: Pick<PublicTenant,
    'public_name' | 'name' |
    'public_phone' | 'public_email' |
    'public_instagram_url' | 'public_website_url'
  >
}

export function PublicSiteFooter({ tenant }: Props) {
  const name       = tenant.public_name ?? tenant.name
  const hasContact = !!(tenant.public_phone || tenant.public_email || tenant.public_instagram_url || tenant.public_website_url)

  return (
    <footer className="border-t px-6 py-10 mt-auto" style={{ background: 'var(--tenant-primary-soft)' }}>
      <div className="mx-auto max-w-6xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
        <p className="font-semibold text-zinc-800 text-sm">{name}</p>

        {hasContact && (
          <div className="flex flex-wrap gap-5 text-sm text-zinc-600">
            {tenant.public_phone && (
              <span>{tenant.public_phone}</span>
            )}
            {tenant.public_email && (
              <a href={`mailto:${tenant.public_email}`} className="hover:text-zinc-800 transition-colors">
                {tenant.public_email}
              </a>
            )}
            {tenant.public_instagram_url && (
              <a href={tenant.public_instagram_url} target="_blank" rel="noopener noreferrer" className="hover:text-zinc-800 transition-colors">
                Instagram
              </a>
            )}
            {tenant.public_website_url && (
              <a href={tenant.public_website_url} target="_blank" rel="noopener noreferrer" className="hover:text-zinc-800 transition-colors">
                Sitio web
              </a>
            )}
          </div>
        )}
      </div>
    </footer>
  )
}
