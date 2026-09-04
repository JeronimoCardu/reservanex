import { Container } from '@/components/marketing/ui/container'
import { Link } from '@/i18n/navigation'
import { ArrowLeft } from 'lucide-react'

type Section = { heading: string; body: string }

export function LegalPage({
  title,
  intro,
  sections,
  backHomeLabel,
  placeholderNotice,
}: {
  title: string
  intro: string
  sections: Section[]
  backHomeLabel: string
  placeholderNotice: string
}) {
  return (
    <div className="bg-white py-16 sm:py-20">
      <Container className="max-w-3xl">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-brand-deep"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          {backHomeLabel}
        </Link>

        <h1 className="mt-6 text-3xl font-bold tracking-tight text-brand-deep sm:text-4xl">
          {title}
        </h1>
        <p className="mt-4 text-base leading-relaxed text-slate-600">{intro}</p>

        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          {placeholderNotice}
        </div>

        <div className="mt-10 space-y-8">
          {sections.map((section) => (
            <div key={section.heading}>
              <h2 className="text-lg font-semibold text-brand-deep">{section.heading}</h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{section.body}</p>
            </div>
          ))}
        </div>
      </Container>
    </div>
  )
}
