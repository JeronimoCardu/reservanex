import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { requireTenantContext } from '@/lib/auth/require-tenant-context'
import { listPendingHumanAttention } from '@/lib/repositories/conversations.repository'
import { canAttendCustomers } from '@/lib/auth/attend-customers'
import { AttentionList } from './attention-list'

// ════════════════════════════════════════════════════════════════════════════
// Atención humana — la bandeja de clientes que están esperando una persona.
//
// NO es un inbox: no muestra el historial, no tiene input, no responde. La
// atención ocurre en WhatsApp / WhatsApp Web. Acá se ve QUIÉN espera, DESDE
// CUÁNDO y POR QUÉ, y se declara cuando alguien se hizo cargo.
//
// Qué aparece lo decide human_attention_pending (columna generada en la base:
// open ∧ requested_at ∧ no resuelto después). No depende de ai_mode: que la IA
// haya vuelto sola porque venció la ventana HUMAN no significa que una persona
// haya atendido al cliente.
//
// Qué ve cada usuario lo deciden las RLS de conversations (owner: todo;
// receptionist: sin asignar o asignadas a él). La query usa el cliente del
// usuario a propósito.
// ════════════════════════════════════════════════════════════════════════════

export const metadata: Metadata = { title: 'Atención humana — ReservaNex' }

export default async function AttentionPage() {
  const ctx = await requireTenantContext()
  // Misma regla que tenía Conversaciones (setupBlocked): el operator de setup
  // no atiende clientes.
  if (ctx.accessMode === 'setup_operator') redirect('/dashboard/properties')

  const items = await listPendingHumanAttention(ctx.tenantId)

  // Permisos V2 — VER la bandeja es el trabajo y no requiere permiso; CERRAR
  // una atención reactiva la IA y sí lo requiere. El guard real está en la
  // action y en la RLS: esto sólo evita ofrecer un botón que iba a fallar.
  const puedeAtender = canAttendCustomers(ctx)

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-4 sm:px-6">
        <h1 className="text-lg font-semibold">Atención humana</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {items.length === 0
            ? 'Nadie está esperando una persona.'
            : `${items.length} cliente${items.length !== 1 ? 's' : ''} esperando una persona`}
        </p>
      </div>

      <AttentionList items={items} currentUserId={ctx.userId} canAttend={puedeAtender} />
    </div>
  )
}
