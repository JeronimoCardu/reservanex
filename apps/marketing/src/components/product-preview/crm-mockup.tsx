'use client'

import { useState } from 'react'
import Image from 'next/image'
import { Building2, CalendarCheck, MessageSquare, Users2 } from 'lucide-react'
import { cn } from '@/lib/utils'

type TabKey = 'conversations' | 'properties' | 'reservations' | 'team'

const sidebarIcons: { key: TabKey; icon: typeof MessageSquare }[] = [
  { key: 'conversations', icon: MessageSquare },
  { key: 'properties', icon: Building2 },
  { key: 'reservations', icon: CalendarCheck },
  { key: 'team', icon: Users2 },
]

function ConversationsPanel({ labels }: { labels: Record<string, string> }) {
  const rows = [
    { name: 'Sofía Ramírez', preview: 'IA: ¿Te muestro los detalles y precios?', tag: labels.aiActive, tagTone: 'ai' },
    { name: 'Diego Fontana', preview: 'Perfecto, ¿a qué hora podemos coordinar?', tag: labels.assignedToMe, tagTone: 'assigned' },
    { name: 'Valentina Cruz', preview: 'Gracias, quedo atenta a la confirmación.', tag: labels.unassigned, tagTone: 'unassigned' },
  ]

  return (
    <div className="divide-y divide-slate-100">
      {rows.map((row) => (
        <div key={row.name} className="flex items-center gap-3 px-4 py-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-500">
            {row.name
              .split(' ')
              .map((p) => p[0])
              .join('')}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-brand-deep">{row.name}</p>
            <p className="truncate text-xs text-slate-500">{row.preview}</p>
          </div>
          <span
            className={cn(
              'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold',
              row.tagTone === 'ai' && 'bg-brand-green/15 text-brand-green',
              row.tagTone === 'assigned' && 'bg-brand-deep/10 text-brand-deep',
              row.tagTone === 'unassigned' && 'bg-slate-100 text-slate-500',
            )}
          >
            {row.tag}
          </span>
        </div>
      ))}
    </div>
  )
}

function PropertiesPanel() {
  const items = [
    { name: 'Loft Puerto Norte', meta: '4 huéspedes · 2 amb.' },
    { name: 'Casa Alameda 42', meta: '6 huéspedes · 3 amb.' },
    { name: 'Depto. Vista Sur', meta: '2 huéspedes · 1 amb.' },
  ]

  return (
    <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
      {items.map((item) => (
        <div key={item.name} className="overflow-hidden rounded-xl border border-slate-100">
          <div className="h-20 bg-gradient-to-br from-brand-green/20 to-brand-yellow/20" />
          <div className="p-3">
            <p className="truncate text-sm font-semibold text-brand-deep">{item.name}</p>
            <p className="text-xs text-slate-500">{item.meta}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

function ReservationsPanel({ labels }: { labels: Record<string, string> }) {
  const rows = [
    { property: 'Loft Puerto Norte', dates: '12–15 jul', status: labels.confirmed, tone: 'confirmed' },
    { property: 'Casa Alameda 42', dates: '20–22 jul', status: labels.pending, tone: 'pending' },
  ]

  return (
    <div className="divide-y divide-slate-100">
      {rows.map((row) => (
        <div key={row.property} className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-brand-deep">{row.property}</p>
            <p className="text-xs text-slate-500">{row.dates}</p>
          </div>
          <span
            className={cn(
              'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold',
              row.tone === 'confirmed' ? 'bg-brand-green/15 text-brand-green' : 'bg-brand-yellow/20 text-amber-700',
            )}
          >
            {row.status}
          </span>
        </div>
      ))}
    </div>
  )
}

function TeamPanel({ labels }: { labels: Record<string, string> }) {
  const rows = [
    { name: 'Camila Ortiz', role: labels.owner },
    { name: 'Lucas Peralta', role: labels.receptionist },
    { name: 'Julia Navarro', role: labels.receptionist },
  ]

  return (
    <div className="divide-y divide-slate-100">
      {rows.map((row) => (
        <div key={row.name} className="flex items-center gap-3 px-4 py-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-500">
            {row.name
              .split(' ')
              .map((p) => p[0])
              .join('')}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-brand-deep">{row.name}</p>
          </div>
          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500">
            {row.role}
          </span>
        </div>
      ))}
    </div>
  )
}

export function CrmMockup({
  tabs,
  captions,
  labels,
  images,
  placeholderNote,
}: {
  tabs: Record<TabKey, string>
  captions: Record<TabKey, string>
  labels: Record<string, string>
  images?: Partial<Record<TabKey, string | null>>
  placeholderNote: string
}) {
  const [active, setActive] = useState<TabKey>('conversations')
  const activeImage = images?.[active]

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-soft">
      <div className="flex items-center gap-1 border-b border-slate-100 bg-slate-50/60 px-2 py-2">
        {sidebarIcons.map(({ key, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setActive(key)}
            aria-pressed={active === key}
            aria-label={tabs[key]}
            className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition-colors',
              active === key
                ? 'bg-white text-brand-deep shadow-sm'
                : 'text-slate-500 hover:text-brand-deep',
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">{tabs[key]}</span>
          </button>
        ))}
      </div>

      {activeImage ? (
        <div className="relative aspect-[16/10] w-full bg-slate-50">
          <Image
            src={activeImage}
            alt={captions[active]}
            fill
            sizes="(min-width: 768px) 672px, 100vw"
            className="object-cover"
          />
        </div>
      ) : (
        <div className="min-h-[220px]">
          {active === 'conversations' ? <ConversationsPanel labels={labels} /> : null}
          {active === 'properties' ? <PropertiesPanel /> : null}
          {active === 'reservations' ? <ReservationsPanel labels={labels} /> : null}
          {active === 'team' ? <TeamPanel labels={labels} /> : null}
        </div>
      )}

      <div className="flex flex-col gap-1 border-t border-slate-100 bg-slate-50/60 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <p className="text-xs text-slate-500">{captions[active]}</p>
        {activeImage ? null : <p className="text-[11px] text-slate-400">{placeholderNote}</p>}
      </div>
    </div>
  )
}
