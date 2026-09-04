'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import type { BlockedInterval } from '@/lib/repositories/public-site.repository'

interface Props {
  tenantSlug:       string
  propertySlug:     string
  propertyTitle:    string
  publicCode:       string | null
  minimumStay:      number
  capacityMax:      number | null
  checkInTime:      string | null
  checkOutTime:     string | null
  waPhone:          string | null
}

function addDays(date: Date, n: number): Date {
  const d = new Date(date)
  d.setUTCDate(d.getUTCDate() + n)
  return d
}

function toLocalDateStr(d: Date): string {
  return d.toISOString().split('T')[0]!
}

function parseDate(s: string): Date {
  return new Date(s + 'T00:00:00Z')
}

function formatDisplayDate(s: string): string {
  const d = parseDate(s)
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
}

function isDateBlocked(dateStr: string, intervals: BlockedInterval[]): boolean {
  for (const iv of intervals) {
    if (dateStr >= iv.start && dateStr < iv.end) return true
  }
  return false
}

function hasBlockedBetween(startStr: string, endStr: string, intervals: BlockedInterval[]): boolean {
  let d = parseDate(startStr)
  const end = parseDate(endStr)
  while (d < end) {
    if (isDateBlocked(toLocalDateStr(d), intervals)) return true
    d = addDays(d, 1)
  }
  return false
}

const WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']
const MONTHS   = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre']

function getDayOfWeekMonday(date: Date): number {
  const dow = date.getUTCDay()
  return dow === 0 ? 6 : dow - 1
}

function buildCalendarMonth(year: number, month: number): (string | null)[][] {
  const firstDay = new Date(Date.UTC(year, month, 1))
  const offset   = getDayOfWeekMonday(firstDay)
  const weeks: (string | null)[][] = []
  let week: (string | null)[] = Array(offset).fill(null)

  const d = new Date(firstDay)
  while (d.getUTCMonth() === month) {
    week.push(toLocalDateStr(d))
    if (week.length === 7) { weeks.push(week); week = [] }
    d.setUTCDate(d.getUTCDate() + 1)
  }
  if (week.length > 0) {
    while (week.length < 7) week.push(null)
    weeks.push(week)
  }
  return weeks
}

export function AvailabilityCalendar({
  tenantSlug, propertySlug, propertyTitle, publicCode,
  minimumStay, capacityMax, checkInTime, checkOutTime, waPhone,
}: Props) {
  const today     = toLocalDateStr(new Date())
  const maxDate   = toLocalDateStr(addDays(new Date(), 6 * 30))

  const [intervals, setIntervals] = useState<BlockedInterval[] | null>(null)
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [checkIn,   setCheckIn]   = useState<string | null>(null)
  const [checkOut,  setCheckOut]  = useState<string | null>(null)
  const [guests,    setGuests]    = useState(1)
  const [hover,     setHover]     = useState<string | null>(null)
  const [monthOffset, setMonthOffset] = useState(0)

  const firstMonthDate = useMemo(() => {
    const now = new Date()
    const d   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1))
    return d
  }, [monthOffset])

  const secondMonthDate = useMemo(() => {
    return new Date(Date.UTC(firstMonthDate.getUTCFullYear(), firstMonthDate.getUTCMonth() + 1, 1))
  }, [firstMonthDate])

  useEffect(() => {
    setLoading(true)
    setError(null)
    fetch(`/api/public/availability?tenant=${tenantSlug}&property=${propertySlug}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((d: { blockedIntervals: BlockedInterval[] }) => {
        setIntervals(d.blockedIntervals)
      })
      .catch(() => setError('No se pudo cargar la disponibilidad.'))
      .finally(() => setLoading(false))
  }, [tenantSlug, propertySlug])

  const handleDayClick = useCallback((dateStr: string) => {
    if (dateStr < today || dateStr > maxDate) return
    if (!intervals) return
    if (isDateBlocked(dateStr, intervals)) return

    if (!checkIn || (checkIn && checkOut)) {
      setCheckIn(dateStr)
      setCheckOut(null)
      return
    }

    if (dateStr <= checkIn) {
      setCheckIn(dateStr)
      setCheckOut(null)
      return
    }

    const nights = Math.round((parseDate(dateStr).getTime() - parseDate(checkIn).getTime()) / 86400000)
    if (nights < minimumStay) {
      setError(`Estadía mínima: ${minimumStay} noche${minimumStay !== 1 ? 's' : ''}.`)
      return
    }

    if (hasBlockedBetween(checkIn, dateStr, intervals)) {
      setError('No podés seleccionar un rango que incluye fechas no disponibles.')
      return
    }

    setError(null)
    setCheckOut(dateStr)
  }, [checkIn, checkOut, intervals, minimumStay, today, maxDate])

  const waMessage = useMemo(() => {
    if (!waPhone) return null
    const lines = [
      `Hola, quiero consultar por esta propiedad:`,
      ``,
      propertyTitle,
    ]
    if (publicCode) lines.push(`Ref: ${publicCode}`)
    if (checkIn && checkOut) {
      const nights = Math.round((parseDate(checkOut).getTime() - parseDate(checkIn).getTime()) / 86400000)
      lines.push(``, `Fechas: ${formatDisplayDate(checkIn)} al ${formatDisplayDate(checkOut)}`)
      lines.push(`Personas: ${guests}`)
      lines.push(`Noches: ${nights}`)
    }
    return `https://wa.me/${waPhone}?text=${encodeURIComponent(lines.join('\n'))}`
  }, [waPhone, propertyTitle, publicCode, checkIn, checkOut, guests])

  function renderMonth(year: number, month: number) {
    const weeks    = buildCalendarMonth(year, month)
    const isFirst  = year === firstMonthDate.getUTCFullYear() && month === firstMonthDate.getUTCMonth()
    const prevDisabled = isFirst && monthOffset === 0

    return (
      <div className="w-full">
        <div className="flex items-center justify-between mb-3">
          {isFirst && (
            <button
              disabled={prevDisabled}
              onClick={() => setMonthOffset(o => o - 1)}
              className="rounded p-1 hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed"
            >
              &lsaquo;
            </button>
          )}
          <span className="flex-1 text-center font-semibold text-sm">
            {MONTHS[month]} {year}
          </span>
          {!isFirst && (
            <button
              onClick={() => setMonthOffset(o => o + 1)}
              className="rounded p-1 hover:bg-muted"
            >
              &rsaquo;
            </button>
          )}
          {isFirst && <div className="w-6" />}
        </div>
        <div className="grid grid-cols-7 text-center text-xs text-muted-foreground mb-1">
          {WEEKDAYS.map(d => <div key={d}>{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-y-1">
          {weeks.flat().map((dateStr, i) => {
            if (!dateStr) return <div key={i} />
            const blocked      = intervals ? isDateBlocked(dateStr, intervals) : false
            const past         = dateStr < today
            const beyond       = dateStr > maxDate
            const isStart      = dateStr === checkIn
            const isEnd        = dateStr === checkOut
            const hoverEnd     = hover && checkIn && !checkOut && hover > checkIn
            const inRange      = checkIn && checkOut && dateStr > checkIn && dateStr < checkOut
            const hoverRange   = hoverEnd && checkIn && hover && dateStr > checkIn && dateStr < hover
            const isHoveredDay = hover === dateStr && !(blocked || past || beyond)
            const disabled     = blocked || past || beyond

            let className = 'relative flex h-8 w-full items-center justify-center text-xs rounded transition-colors select-none '
            const dayStyle: React.CSSProperties = {}

            if (disabled) {
              className += 'text-muted-foreground/40 cursor-not-allowed '
              if (blocked && !past) className += 'bg-red-50 dark:bg-red-950/20 line-through '
            } else if (isStart || isEnd) {
              dayStyle.background = 'var(--tenant-primary)'
              dayStyle.color      = 'white'
              className += 'font-bold cursor-pointer '
            } else if (inRange || hoverRange) {
              dayStyle.background = 'var(--tenant-primary-soft)'
              className += 'cursor-pointer '
            } else {
              if (isHoveredDay) dayStyle.background = 'var(--tenant-primary-soft)'
              className += 'cursor-pointer '
            }

            return (
              <button
                key={dateStr}
                disabled={disabled}
                onClick={() => handleDayClick(dateStr)}
                onMouseEnter={() => !disabled && setHover(dateStr)}
                onMouseLeave={() => setHover(null)}
                className={className}
                style={dayStyle}
                title={blocked ? 'No disponible' : dateStr}
              >
                {parseInt(dateStr.slice(8), 10)}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Disponibilidad</h2>
        {(checkIn || checkOut) && (
          <button
            onClick={() => { setCheckIn(null); setCheckOut(null); setError(null) }}
            className="text-xs text-muted-foreground underline hover:text-foreground"
          >
            Limpiar fechas
          </button>
        )}
      </div>

      {loading && (
        <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
          Cargando disponibilidad...
        </div>
      )}

      {!loading && (
        <>
          <div className="grid gap-6 md:grid-cols-2">
            {renderMonth(firstMonthDate.getUTCFullYear(),  firstMonthDate.getUTCMonth())}
            {renderMonth(secondMonthDate.getUTCFullYear(), secondMonthDate.getUTCMonth())}
          </div>

          <div className="flex flex-wrap gap-4 text-xs">
            <div className="flex items-center gap-1.5">
              <div className="h-3 w-3 rounded-sm" style={{ background: 'var(--tenant-primary)' }} />
              <span>Seleccionado</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="h-3 w-3 rounded-sm bg-red-100 dark:bg-red-950/30" />
              <span>No disponible</span>
            </div>
          </div>

          {error && (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          {checkIn && (
            <div className="rounded-xl border bg-muted/30 p-4 space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Check-in</p>
                  <p className="font-medium">{formatDisplayDate(checkIn)}</p>
                  {checkInTime && <p className="text-xs text-muted-foreground">desde {String(checkInTime).slice(0, 5)}</p>}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Check-out</p>
                  <p className="font-medium">{checkOut ? formatDisplayDate(checkOut) : '—'}</p>
                  {checkOut && checkOutTime && <p className="text-xs text-muted-foreground">hasta {String(checkOutTime).slice(0, 5)}</p>}
                </div>
              </div>

              {checkIn && checkOut && (
                <div className="flex items-center gap-3">
                  <label className="text-sm font-medium whitespace-nowrap">Personas:</label>
                  <input
                    type="number"
                    min={1}
                    max={capacityMax ?? 20}
                    value={guests}
                    onChange={e => setGuests(Math.min(capacityMax ?? 20, Math.max(1, Number(e.target.value))))}
                    className="w-20 rounded border bg-background px-2 py-1 text-sm"
                  />
                  {capacityMax && (
                    <span className="text-xs text-muted-foreground">máx. {capacityMax}</span>
                  )}
                </div>
              )}

              {waMessage && (
                <a
                  href={waMessage}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ background: '#25D366' }}
                  className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 font-semibold text-white hover:opacity-90 transition-opacity"
                >
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/>
                    <path d="M12 0C5.373 0 0 5.373 0 12c0 2.127.556 4.121 1.528 5.855L.057 23.215c-.063.242.014.498.197.664.14.127.32.19.501.19.057 0 .115-.007.172-.02l5.537-1.437A11.92 11.92 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.886 0-3.67-.496-5.215-1.365L2.586 21.7l1.085-4.122A9.954 9.954 0 012 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/>
                  </svg>
                  {checkOut ? 'Consultar por WhatsApp con fechas' : 'Consultar por WhatsApp'}
                </a>
              )}
            </div>
          )}

          {!checkIn && (
            <p className="text-sm text-muted-foreground text-center py-2">
              Seleccioná la fecha de entrada para ver disponibilidad
            </p>
          )}
        </>
      )}
    </div>
  )
}
