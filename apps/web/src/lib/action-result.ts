export type ActionResult<T = undefined> =
  | { success: true; data?: T; warning?: string }
  | { success: false; error: string }
