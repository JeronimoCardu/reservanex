import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// Fase 10 Paso 3 — RESET RESERVANEX gate tests. These never touch a real
// database: requireSuperAdmin/createAdminClient/createClient are all
// mocked, so a "permitido" case exercises the gate logic only (identity +
// phrase + ALLOW_GLOBAL_TENANT_RESET) up to the first real destructive
// call, which is then asserted to have actually fired — the test never
// lets a genuine purge run against anything.

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/auth/require-platform-context', () => ({ requireSuperAdmin: vi.fn() }))
vi.mock('@orderflow/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@orderflow/supabase/server', () => ({ createClient: vi.fn() }))

import { requireSuperAdmin } from '@/lib/auth/require-platform-context'
import { createAdminClient } from '@orderflow/supabase/admin'
import { createClient } from '@orderflow/supabase/server'
import { resetQaDataExceptSuperAdminAction } from './platform-danger'
import { isGlobalTenantResetAllowed } from '@/lib/global-tenant-reset'

const CORRECT_PHRASE = 'RESET RESERVANEX'
const CURRENT_SA_ID = 'sa-current-11111111'

function mockSuperAdminOk() {
  vi.mocked(requireSuperAdmin).mockResolvedValue({
    userId: CURRENT_SA_ID, role: 'super_admin', email: 'sa@example.test',
    isSuperAdmin: true, isSeller: false, isOperator: false,
  })
}

function mockSuperAdminDenied() {
  // requireSuperAdmin() calls Next.js redirect() on failure, which throws.
  vi.mocked(requireSuperAdmin).mockRejectedValue(new Error('NEXT_REDIRECT'))
}

function mockAdminClient() {
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'update', 'delete', 'is', 'not']) {
    chain[method] = vi.fn().mockReturnValue(chain)
  }
  const admin = { from: vi.fn().mockReturnValue(chain) }
  vi.mocked(createAdminClient).mockReturnValue(admin as never)
  return admin
}

function mockSessionClient() {
  const client = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: CURRENT_SA_ID } } }) },
  }
  vi.mocked(createClient).mockResolvedValue(client as never)
  return client
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isGlobalTenantResetAllowed()', () => {
  it('is false when ALLOW_GLOBAL_TENANT_RESET is unset', () => {
    vi.stubEnv('ALLOW_GLOBAL_TENANT_RESET', undefined as unknown as string)
    expect(isGlobalTenantResetAllowed()).toBe(false)
  })

  it('is false for any value other than the literal string "true"', () => {
    vi.stubEnv('ALLOW_GLOBAL_TENANT_RESET', 'TRUE')
    expect(isGlobalTenantResetAllowed()).toBe(false)
    vi.stubEnv('ALLOW_GLOBAL_TENANT_RESET', '1')
    expect(isGlobalTenantResetAllowed()).toBe(false)
  })

  it('is true only for the exact string "true"', () => {
    vi.stubEnv('ALLOW_GLOBAL_TENANT_RESET', 'true')
    expect(isGlobalTenantResetAllowed()).toBe(true)
  })
})

describe('resetQaDataExceptSuperAdminAction — fail-closed gate', () => {
  it('superadmin + correct phrase + env=false → denied, no destructive call made', async () => {
    mockSuperAdminOk()
    const admin = mockAdminClient()
    vi.stubEnv('ALLOW_GLOBAL_TENANT_RESET', 'false')

    const result = await resetQaDataExceptSuperAdminAction(CORRECT_PHRASE)

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toMatch(/deshabilitado por configuración/)
    expect(admin.from).not.toHaveBeenCalled()
  })

  it('superadmin + correct phrase + env missing → denied, no destructive call made', async () => {
    mockSuperAdminOk()
    const admin = mockAdminClient()
    // ALLOW_GLOBAL_TENANT_RESET intentionally left unset.

    const result = await resetQaDataExceptSuperAdminAction(CORRECT_PHRASE)

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toMatch(/deshabilitado por configuración/)
    expect(admin.from).not.toHaveBeenCalled()
  })

  it('superadmin + wrong phrase + env=true → denied, no destructive call made', async () => {
    mockSuperAdminOk()
    const admin = mockAdminClient()
    vi.stubEnv('ALLOW_GLOBAL_TENANT_RESET', 'true')

    const result = await resetQaDataExceptSuperAdminAction('reset reservanex')

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).toMatch(/Texto de confirmación incorrecto/)
    expect(admin.from).not.toHaveBeenCalled()
  })

  it('non-superadmin + env=true → denied before any DB access, regardless of phrase', async () => {
    mockSuperAdminDenied()
    const admin = mockAdminClient()
    vi.stubEnv('ALLOW_GLOBAL_TENANT_RESET', 'true')

    await expect(resetQaDataExceptSuperAdminAction(CORRECT_PHRASE)).rejects.toThrow()
    expect(admin.from).not.toHaveBeenCalled()
  })

  it('superadmin + correct phrase + env=true → gate passes, the real destructive path is reached', async () => {
    mockSuperAdminOk()
    mockSessionClient()
    const admin = mockAdminClient()
    vi.stubEnv('ALLOW_GLOBAL_TENANT_RESET', 'true')

    await resetQaDataExceptSuperAdminAction(CORRECT_PHRASE)

    // The gate itself doesn't reject — proven by the code reaching the
    // first real admin-client call (the super_admin-count guard query),
    // which only happens after identity+phrase+env all pass.
    expect(admin.from).toHaveBeenCalledWith('platform_users')
  })
})
