export type UserType = 'platform_user' | 'tenant_user'
export type PlatformRole = 'super_admin' | 'seller' | 'operator'
export type TenantRole = 'owner' | 'receptionist'

export interface PlatformUserClaims {
  user_type: 'platform_user'
  role: PlatformRole
}

export interface TenantUserClaims {
  user_type: 'tenant_user'
  role: TenantRole
  tenant_id: string
  workspace_ids: string[] | null
}

export type AppClaims = PlatformUserClaims | TenantUserClaims
