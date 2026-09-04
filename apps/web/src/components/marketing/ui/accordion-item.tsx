import { ChevronDown } from 'lucide-react'

/**
 * Native <details>/<summary> keeps FAQ items keyboard- and screen-reader
 * accessible with zero JS, and works before hydration.
 */
export function AccordionItem({ question, answer }: { question: string; answer: string }) {
  return (
    <details className="group rounded-xl border border-slate-200 bg-white open:shadow-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-left font-semibold text-brand-deep marker:content-none">
        <span>{question}</span>
        <ChevronDown
          className="h-5 w-5 shrink-0 text-slate-400 transition-transform duration-200 group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <p className="px-5 pb-4 text-slate-600">{answer}</p>
    </details>
  )
}
