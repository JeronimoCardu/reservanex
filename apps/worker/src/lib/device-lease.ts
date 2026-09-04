// Fase 6B.2 — shared cross-queue device-dispatch lease constant.
// messaging_outbox (text sends) and media_events (media extraction
// triggers) are each serialized independently per account by their own
// claim_next_* RPC (see migration 20260826000003_device_dispatch_lease.sql),
// but both ultimately fire a MacroDroid webhook trigger against the SAME
// physical Android — a text dispatch and a media dispatch for the same
// account must never be "in flight" (HTTP call issued, MacroDroid possibly
// mid-macro) at the same time. The claim RPCs reserve
// whatsapp_accounts.device_dispatch_reserved_until atomically, under the
// same per-account advisory lock both already use, as part of the claim
// itself — see dispatcher.ts and media-dispatcher.ts's dispatchOne().
//
// Fase 6B.2 correction (this file previously also exported
// releaseDeviceReservation()): a resolved fetch() — even a "200 OK" from
// MacroDroid — only proves the trigger was ACKNOWLEDGED, not that the
// physical macro (Screen On/Wait/Send, or Wait/locate-file/upload)
// actually finished running on the Android. Releasing the lease as soon as
// the HTTP call resolved could let the OTHER queue fire a second trigger
// at the same device while the first macro is still physically executing.
// Neither dispatcher now releases the lease explicitly, on success OR
// failure — it is always left to expire naturally at
// device_dispatch_reserved_until. This constant remains the single shared
// source of truth for that lease duration (both claim_next_outbox_item and
// claim_next_media_event are called with p_lease_seconds set to it).
export const DEVICE_DISPATCH_LEASE_SECONDS = 20
