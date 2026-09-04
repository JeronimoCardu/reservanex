function initials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

function Bubble({
  align,
  tone = 'client',
  children,
}: {
  align: 'left' | 'right'
  tone?: 'client' | 'ai' | 'human'
  children: string
}) {
  const toneClasses =
    tone === 'client'
      ? 'bg-slate-100 text-brand-deep'
      : tone === 'ai'
        ? 'bg-brand-green/10 text-brand-deep'
        : 'bg-brand-deep text-white'

  return (
    <div className={align === 'right' ? 'flex justify-end' : 'flex justify-start'}>
      <p className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${toneClasses}`}>
        {children}
      </p>
    </div>
  )
}

export function WhatsappMockup({
  ariaLabel,
  contactName,
  badgeAi,
  badgeHuman,
  clientMessage,
  aiMessage,
  handoffMessage,
  humanMessage,
}: {
  ariaLabel: string
  contactName: string
  badgeAi: string
  badgeHuman: string
  clientMessage: string
  aiMessage: string
  handoffMessage: string
  humanMessage: string
}) {
  return (
    <div
      role="img"
      aria-label={ariaLabel}
      className="mx-auto w-full max-w-sm overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-soft"
    >
      <div className="flex items-center gap-3 bg-brand-deep px-4 py-3 text-white">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-xs font-semibold">
          {initials(contactName)}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{contactName}</p>
          <p className="text-xs text-white/60">WhatsApp</p>
        </div>
      </div>

      <div className="space-y-3 bg-[#F4F1EB] px-4 py-4">
        <Bubble align="right">{clientMessage}</Bubble>

        <div className="space-y-1.5">
          <span className="inline-flex items-center rounded-full bg-brand-green/15 px-2.5 py-0.5 text-[11px] font-semibold text-brand-green">
            {badgeAi}
          </span>
          <Bubble align="left" tone="ai">
            {aiMessage}
          </Bubble>
        </div>

        <Bubble align="right">{handoffMessage}</Bubble>

        <div className="space-y-1.5">
          <span className="inline-flex items-center rounded-full bg-brand-deep/10 px-2.5 py-0.5 text-[11px] font-semibold text-brand-deep">
            {badgeHuman}
          </span>
          <Bubble align="left" tone="human">
            {humanMessage}
          </Bubble>
        </div>
      </div>
    </div>
  )
}
