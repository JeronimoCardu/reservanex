export default function ReservationsLoading() {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-6 py-4">
        <div className="h-5 w-24 animate-pulse rounded bg-muted" />
        <div className="mt-1.5 h-3.5 w-16 animate-pulse rounded bg-muted" />
      </div>
      <div className="flex items-center gap-3 border-b px-6 py-3">
        <div className="h-8 w-64 animate-pulse rounded bg-muted" />
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
      </div>
      <div className="flex-1 overflow-auto px-0">
        <table className="w-full">
          <tbody>
            {Array.from({ length: 6 }).map((_, i) => (
              <tr key={i} className="border-b">
                {Array.from({ length: 6 }).map((_, j) => (
                  <td key={j} className="px-4 py-3">
                    <div className="h-4 animate-pulse rounded bg-muted" style={{ width: `${60 + (i + j) % 4 * 10}%` }} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
