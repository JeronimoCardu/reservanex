// Fase 10 Paso 3 — kept out of actions/platform-danger.ts deliberately: that
// file has 'use server' at the top, and Next.js requires every export from a
// 'use server' file to be an async Server Action — a plain sync helper like
// this one breaks the production build if it lives there (confirmed the hard
// way). See platform-danger.ts's resetQaDataExceptSuperAdminAction for the
// full rationale of this gate.
export function isGlobalTenantResetAllowed(): boolean {
  return process.env.ALLOW_GLOBAL_TENANT_RESET === 'true'
}
