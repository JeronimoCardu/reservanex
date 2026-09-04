export { loginSchema } from './auth'
export type { LoginInput } from './auth'

export {
  workspaceTypeSchema,
  createWorkspaceSchema,
  updateWorkspaceSchema,
} from './workspaces'
export type { CreateWorkspaceInput, UpdateWorkspaceInput } from './workspaces'

export {
  tenantRoleSchema,
  createTenantUserSchema,
  updateTenantUserSchema,
  assignWorkspacesSchema,
} from './users'
export type {
  CreateTenantUserInput,
  UpdateTenantUserInput,
  AssignWorkspacesInput,
} from './users'

export {
  customFieldSchema,
  propertyImageSchema,
  createPropertySchema,
  updatePropertySchema,
} from './properties'
export type { CreatePropertyInput, UpdatePropertyInput } from './properties'

export { currencySchema, createUnitSchema, updateUnitSchema } from './units'
export type { CreateUnitInput, UpdateUnitInput } from './units'

export { createContactSchema, updateContactSchema } from './contacts'
export type { CreateContactInput, UpdateContactInput } from './contacts'

export {
  aiModeSchema,
  createConversationSchema,
  updateConversationSchema,
  assignConversationSchema,
  setAiModeSchema,
} from './conversations'
export type {
  CreateConversationInput,
  UpdateConversationInput,
  AssignConversationInput,
  SetAiModeInput,
} from './conversations'

export { messageContentTypeSchema, sendMessageSchema } from './messages'
export type { SendMessageInput } from './messages'

export { normalizePhoneForWhatsApp, isValidARWhatsAppPhone, normalizeEmail } from './phone'

export { createNoteSchema } from './notes'
export type { CreateNoteInput } from './notes'

export {
  taskStatusSchema,
  taskPrioritySchema,
  createTaskSchema,
  updateTaskSchema,
  updateTaskStatusSchema,
} from './tasks'
export type { CreateTaskInput, UpdateTaskInput, UpdateTaskStatusInput, TaskStatus, TaskPriority } from './tasks'
