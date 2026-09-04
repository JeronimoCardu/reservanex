import type { Metadata } from 'next'
import { ConfirmEmailClient } from './confirm-email-client'

export const metadata: Metadata = {
  title: 'Confirmá tu email — ReservaNex',
}

export default function ConfirmEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  return <ConfirmEmailClient searchParams={searchParams} />
}
