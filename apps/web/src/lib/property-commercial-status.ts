// Centralised labels and helpers for properties.commercial_status.
// Values: 'available' | 'rented' | 'paused' | 'sold'

export const COMMERCIAL_STATUS_LABEL: Record<string, string> = {
  available: 'Disponible',
  rented:    'Alquilado',
  paused:    'Pausado',
  sold:      'Vendido',
}

export function getCommercialStatusLabel(status: string): string {
  return COMMERCIAL_STATUS_LABEL[status] ?? status
}

export function isCommerciallyAvailable(status: string): boolean {
  return status === 'available'
}

/** Tailwind classes for small badge — works in both light and dark themes. */
export function getCommercialStatusBadgeClass(status: string): string {
  switch (status) {
    case 'available':
      return 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-400 dark:border-green-900'
    case 'rented':
      return 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-400 dark:border-blue-900'
    case 'paused':
      return 'bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-400 dark:border-yellow-900'
    case 'sold':
      return 'bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-800/40 dark:text-gray-400 dark:border-gray-700'
    default:
      return 'bg-muted text-muted-foreground border'
  }
}
