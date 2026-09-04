import type { Metadata } from 'next'
import { AcceptInviteForm } from './accept-invite-form'

export const metadata: Metadata = {
  title: 'Activar cuenta — ReservaNex',
}

export default function AcceptInvitePage() {
  return <AcceptInviteForm />
}
