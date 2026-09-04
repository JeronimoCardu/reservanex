import Link from 'next/link'

export default function RootNotFound() {
  return (
    <html lang="es">
      <body style={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif' }}>
        <Link href="/es">Volver a ReservaNex</Link>
      </body>
    </html>
  )
}
