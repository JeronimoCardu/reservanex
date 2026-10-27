import { NextResponse } from 'next/server'

// Redirect de un route handler a una ruta de esta misma app, con Location
// RELATIVO.
//
// Detrás del proxy de Hostinger, el server standalone de Next arma request.url
// con su propia dirección de escucha (HOSTNAME, por defecto 0.0.0.0, y PORT),
// no con el Host público: en producción un route handler recibe
// https://0.0.0.0:3000/... Todo redirect absoluto que salga de request.url
// (new URL(request.url).origin, new URL('/x', request.url),
// request.nextUrl.origin) manda al navegador a 0.0.0.0 (PROD-HOSTINGER-D2).
// El middleware no tiene el problema porque Next relativiza su Location; la
// respuesta de un route handler sale tal cual.
//
// Un Location relativo lo resuelve el navegador contra la URL que él mismo
// pidió (RFC 9110 §10.2.2): el destino queda en el host correcto en Hostinger,
// Vercel, localhost o detrás de cualquier proxy, sin leer Host, X-Forwarded-*
// ni variables de entorno.
//
// NextResponse.redirect() no sirve para esto: valida con new URL() y tira con
// una ruta relativa. Por eso la respuesta se arma a mano, como el 307 de
// api/property-videos/[videoId].

// Origen centinela (TLD reservado, RFC 2606): el destino se valida con el
// mismo parser de URL que usa el navegador.
const SENTINEL = 'http://local-redirect.invalid'

/**
 * 307 —el status por defecto de NextResponse.redirect()— a `path`, que tiene
 * que ser una ruta de esta app.
 *
 * Tira si el navegador terminaría resolviendo el destino fuera del sitio:
 * `//host`, `/\host`, o una ruta con tabs o saltos de línea, que el parser de
 * URL descarta.
 */
export function localRedirect(path: `/${string}`): NextResponse {
  const target = new URL(path, SENTINEL)
  if (!path.startsWith('/') || target.origin !== SENTINEL) {
    throw new Error(`[local-redirect] destino fuera del sitio: ${JSON.stringify(path)}`)
  }
  return new NextResponse(null, {
    status:  307,
    headers: { Location: target.pathname + target.search + target.hash },
  })
}
