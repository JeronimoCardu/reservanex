import Link from 'next/link'

// Fase 3E-C3C (pulido UX) — la barra de filtros por estado.
//
// ── POR QUÉ ES COMPARTIDA ───────────────────────────────────────────────────
//
// Solicitudes y Pedidos hacían exactamente lo mismo con dos copias distintas:
// pills que navegan por query param. No es una abstracción especulativa —son
// dos usos reales del MISMO patrón— y es chica a propósito: recibe una lista de
// opciones y el filtro activo, y no sabe nada de solicitudes ni de pedidos.
//
// ── SON LINKS, NO BOTONES ───────────────────────────────────────────────────
//
// El filtro vive en la URL (?status=…), así que navegar es lo que realmente
// ocurre: un <Link> da middle-click, "abrir en pestaña nueva", back/forward y
// foco de teclado gratis. Con un <button onClick={router.push}> todo eso hay
// que reimplementarlo, y en la práctica no se reimplementa.
//
// ── EL ESTADO ACTIVO NO DEPENDE DEL COLOR ───────────────────────────────────
//
// El activo cambia FONDO y PESO tipográfico, no un matiz. El `tone` es un punto
// diminuto y opcional que acompaña a la etiqueta; nunca es la única señal, y no
// pinta el fondo de la pill. Además lleva aria-current="page", que es lo que
// leen los lectores de pantalla.

export type FilterTone = 'pending' | 'positive' | 'negative' | 'neutral'

export interface StatusFilterOption<T extends string = string> {
  value: T
  label: string
  /** Énfasis semántico discreto. Opcional: sin esto la pill es neutra. */
  tone?: FilterTone
  /** Se muestra al lado de la etiqueta solo si viene definido. */
  count?: number
}

/** Puntos muy apagados. Acompañan al texto, no lo reemplazan. */
const DOT: Record<FilterTone, string> = {
  pending:  'bg-amber-500',
  positive: 'bg-emerald-500',
  negative: 'bg-rose-400',
  neutral:  'bg-zinc-400',
}

export function StatusFilterTabs<T extends string>({
  options,
  active,
  hrefFor,
  ariaLabel = 'Filtrar por estado',
}: {
  options: ReadonlyArray<StatusFilterOption<T>>
  active:  T
  /** Cómo se arma la URL de cada filtro. La decide cada página. */
  hrefFor: (value: T) => string
  ariaLabel?: string
}) {
  return (
    <nav
      aria-label={ariaLabel}
      // Mobile-first: UNA fila que se desliza. flex-nowrap + shrink-0 evitan
      // que las pills se partan en dos o tres renglones en pantallas chicas.
      className="flex flex-nowrap gap-2 overflow-x-auto border-b px-4 py-3 sm:px-6"
    >
      {options.map((o) => {
        const esActivo = o.value === active
        return (
          <Link
            key={o.value}
            href={hrefFor(o.value)}
            scroll={false}
            aria-current={esActivo ? 'page' : undefined}
            className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-sm transition
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 ${
              esActivo
                ? 'bg-zinc-900 font-medium text-white'
                : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
            }`}
          >
            {o.tone && (
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${DOT[o.tone]} ${esActivo ? 'opacity-90' : 'opacity-70'}`}
              />
            )}
            {o.label}
            {o.count !== undefined && (
              <span className={`tabular-nums ${esActivo ? 'text-zinc-300' : 'text-zinc-500'}`}>
                {o.count}
              </span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}
