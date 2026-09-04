// Auth claim types
export type { AppClaims, PlatformUserClaims, TenantUserClaims, UserType } from './auth'

// Raw role types (same values as DB enums, kept separate for auth claim usage)
export type { PlatformRole, TenantRole } from './auth'

// Database types
export type { Database, Json, Tables, TablesInsert, TablesUpdate, Enums } from './database'

// Row aliases from database
export type {
  WorkspaceRow,
  WorkspaceInsert,
  WorkspaceUpdate,
  TenantRow,
  TenantUserRow,
  PlatformUserRow,
  UserWorkspaceAssignment,
  PropertyRow,
  PropertyImageRow,
  PropertyVideoRow,
  UnitRow,
  ContactRow,
  ConversationRow,
  MessageRow,
  ReservationRow,
  TaskRow,
  NoteRow,
  NotificationRow,
  AuditLogRow,
  ImpersonationSessionRow,
  MonthlyRentalContractRow,
  MonthlyRentalChargeRow,
  MonthlyRentalPaymentRow,
} from './aliases'

// Enum aliases from database (prefixed to avoid clash with auth.ts scalar types)
export type {
  WorkspaceType,
  TenantStatus,
  PlanTier,
  ReservationStatus,
  TaskStatus,
  ConversationStatus,
  AiMode,
} from './aliases'
