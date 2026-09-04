import type { Tables, TablesInsert, TablesUpdate, Enums } from './database'

// ── Row type aliases ───────────────────────────────────────────
export type WorkspaceRow            = Tables<'workspaces'>
export type WorkspaceInsert         = TablesInsert<'workspaces'>
export type WorkspaceUpdate         = TablesUpdate<'workspaces'>
export type TenantRow               = Tables<'tenants'>
export type TenantUserRow           = Tables<'tenant_users'>
export type PlatformUserRow         = Tables<'platform_users'>
export type UserWorkspaceAssignment = Tables<'user_workspace_assignments'>
export type PropertyRow             = Tables<'properties'>
export type PropertyImageRow        = Tables<'property_images'>
export type PropertyVideoRow        = Tables<'property_videos'>
export type UnitRow                 = Tables<'units'>
export type ContactRow              = Tables<'contacts'>
export type ConversationRow         = Tables<'conversations'>
export type MessageRow              = Tables<'messages'>
export type ReservationRow          = Tables<'reservations'>
export type TaskRow                 = Tables<'tasks'>
export type NoteRow                 = Tables<'notes'>
export type NotificationRow         = Tables<'notifications'>
export type AuditLogRow              = Tables<'audit_logs'>
export type ImpersonationSessionRow  = Tables<'impersonation_sessions'>
export type WhatsAppAccountRow       = Tables<'whatsapp_accounts'>
export type MonthlyRentalContractRow = Tables<'monthly_rental_contracts'>
export type MonthlyRentalChargeRow   = Tables<'monthly_rental_charges'>
export type MonthlyRentalPaymentRow  = Tables<'monthly_rental_payments'>

// ── Enum type aliases ──────────────────────────────────────────
export type WorkspaceType      = Enums<'workspace_type'>
export type TenantStatus       = Enums<'tenant_status'>
export type PlanTier           = Enums<'plan_tier'>
export type ReservationStatus  = Enums<'reservation_status'>
export type TaskStatus         = Enums<'task_status'>
export type ConversationStatus = Enums<'conversation_status'>
export type AiMode             = Enums<'ai_mode'>
