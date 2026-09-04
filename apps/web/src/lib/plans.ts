export type PlanCode = 'agents_4' | 'agents_6' | 'agents_8' | 'agents_10' | 'custom'

export type PlanConfig = {
  label:            string
  maxOwners:        number
  maxReceptionists: number
  maxTotalUsers:    number
}

export const PLANS: Record<PlanCode, PlanConfig> = {
  agents_4:  { label: 'Plan 4 agentes',  maxOwners: 1, maxReceptionists: 4,  maxTotalUsers: 5  },
  agents_6:  { label: 'Plan 6 agentes',  maxOwners: 1, maxReceptionists: 6,  maxTotalUsers: 7  },
  agents_8:  { label: 'Plan 8 agentes',  maxOwners: 1, maxReceptionists: 8,  maxTotalUsers: 9  },
  agents_10: { label: 'Plan 10 agentes', maxOwners: 1, maxReceptionists: 10, maxTotalUsers: 11 },
  custom:    { label: 'Plan personalizado', maxOwners: 1, maxReceptionists: 99, maxTotalUsers: 100 },
}

export const PLAN_OPTIONS = Object.entries(PLANS).map(([code, cfg]) => ({
  code: code as PlanCode,
  label: cfg.label,
}))

export function getPlanConfig(code: string | null | undefined): PlanConfig {
  if (code && code in PLANS) return PLANS[code as PlanCode]
  return PLANS['agents_4']
}
