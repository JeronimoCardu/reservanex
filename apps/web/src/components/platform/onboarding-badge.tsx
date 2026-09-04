import { cn } from '@/lib/utils'

const ONBOARDING_CONFIG: Record<string, { label: string; className: string }> = {
  pending_review:   { label: 'Pendiente revisión', className: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300' },
  approved:         { label: 'Aprobada',           className: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' },
  meta_setup:       { label: 'Config. Meta',       className: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300' },
  testing:          { label: 'En pruebas',          className: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300' },
  ready_to_deliver: { label: 'Lista para entregar', className: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' },
  delivered:        { label: 'Entregada',           className: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300' },
  rejected:         { label: 'Rechazada',           className: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300' },
}

const TENANT_STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  trial:     { label: 'Trial',      className: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' },
  active:    { label: 'Activo',     className: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' },
  suspended: { label: 'Suspendido', className: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300' },
  cancelled: { label: 'Cancelado',  className: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300' },
  churned:   { label: 'Churned',    className: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' },
}

type Props = { status: string; type?: 'onboarding' | 'tenant' }

export function StatusBadge({ status, type = 'onboarding' }: Props) {
  const config = type === 'onboarding'
    ? (ONBOARDING_CONFIG[status] ?? { label: status, className: 'bg-gray-100 text-gray-600' })
    : (TENANT_STATUS_CONFIG[status] ?? { label: status, className: 'bg-gray-100 text-gray-600' })

  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', config.className)}>
      {config.label}
    </span>
  )
}

export function isDelayed(createdAt: string, onboardingStatus: string): boolean {
  if (onboardingStatus === 'delivered' || onboardingStatus === 'rejected') return false
  const hours = (Date.now() - new Date(createdAt).getTime()) / 36e5
  return hours > 72
}
