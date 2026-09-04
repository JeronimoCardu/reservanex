# Secret rotation runbook

Procedure for rotating every secret/sensitive-URL in this system. **No real
values anywhere in this file — placeholders only.** This is a runbook, not
an audit — see the Fase 10 report for which secrets are believed to have
been exposed during development and therefore need rotating before a real
pilot goes live.

**None of these are rotated automatically by any script. Every rotation
below is either a manual Dashboard/provider action, or a code deploy you
trigger yourself — nothing in this repo rotates a credential on its own.**

## Recommended order (minimizes downtime)

Rotate in this order — each group is safe to do independently, and later
groups depend on nothing from earlier ones:

1. DeepSeek API key
2. Groq API key
3. Resend API key / Custom SMTP credentials
4. Supabase service-role key
5. Pilot tenant's AutoResponder device token
6. Pilot tenant's MacroDroid webhook URL (only if it needs rotating — see below)

Items 1–3 have effectively zero user-facing downtime (worst case: a few
seconds of failed AI/transcription/email calls during a worker restart,
which already fail-safe with no retry-storm). Item 4 needs a short
coordinated deploy window. Items 5–6 require physically touching the
Android — do them together, in one sitting, with the phone in hand, so the
device is only silent for one short window instead of two.

---

## 1. DeepSeek API key

| | |
|---|---|
| **Where used** | `apps/worker` only (`DEEPSEEK_API_KEY` env var) |
| **Impact of rotating** | New AI replies fail until the new key is deployed; in-flight requests using the old key fail cleanly (no partial/corrupted state) |
| **Downtime** | None beyond the worker's own restart time |
| **Manual step** | Generate a new key in the DeepSeek dashboard. Revoke the old one only **after** confirming the new one works (step below) — don't revoke first. |
| **Update** | Set `DEEPSEEK_API_KEY` in the worker's hosting environment, redeploy/restart the worker |
| **Verify** | Send a real inbound WhatsApp message, confirm an AI reply is generated (check `apps/worker` logs for a successful DeepSeek call, no auth error) |
| **Rollback** | Revert the env var to the old key (only until you've revoked it) and restart |

## 2. Groq API key

| | |
|---|---|
| **Where used** | `apps/worker` only (`GROQ_API_KEY` env var) — Whisper audio transcription |
| **Impact of rotating** | New voice-note transcriptions fail until deployed; the AI pipeline for audio messages degrades gracefully (message still arrives, transcription marked failed — this path already exists for real transcription failures) |
| **Downtime** | None beyond the worker's own restart time |
| **Manual step** | Generate a new key in the Groq console |
| **Update** | Set `GROQ_API_KEY` in the worker's hosting environment, redeploy/restart |
| **Verify** | Send a real voice note, confirm it transcribes successfully |
| **Rollback** | Revert the env var to the old key and restart |

## 3. Resend API key / Custom SMTP credentials

| | |
|---|---|
| **Where used** | Supabase Auth's Custom SMTP configuration (Dashboard-only setting, not an app env var) |
| **Impact of rotating** | New invite/recovery emails fail to send until updated; already-sent tokens/links are unaffected |
| **Downtime** | None |
| **Manual step** | Generate a new Resend API key |
| **Update** | Supabase Dashboard → Authentication → SMTP Settings → update the password field with the new key |
| **Verify** | Send a real test invite from `/platform`, confirm it arrives from the ReservaNex-branded address |
| **Rollback** | Paste the old key back into the same Dashboard field |

## 4. Supabase service-role key

| | |
|---|---|
| **Where used** | Every admin-client call in `apps/web` (`SUPABASE_SERVICE_ROLE_KEY`) and every worker DB call (`apps/worker/src/lib/supabase.ts`) — this is the single most powerful credential in the system, bypasses RLS entirely |
| **Impact of rotating** | The OLD key stops working the moment Supabase issues a new one — every admin-client call using the stale key fails until every deployment is updated |
| **Downtime** | Real, but short if coordinated: plan a brief window, update both `apps/web` and `apps/worker` hosting environments as close together as possible |
| **Manual step** | Supabase Dashboard → Project Settings → API → regenerate the service-role key (confirm this is scoped to `akvaswvkdqfguksinrwa` — never the original project) |
| **Update** | Set `SUPABASE_SERVICE_ROLE_KEY` in BOTH the web app's and the worker's hosting environments, redeploy both as close together as possible |
| **Verify** | `pnpm --filter @orderflow/web validate:onboarding` (exercises the admin client end-to-end against real Supabase) — should pass fully; check the worker picks up a real inbound message afterward |
| **Rollback** | Supabase does not let you "un-regenerate" a key — if the rotation goes wrong, generate ANOTHER new key and redeploy again. There is no path back to the exact old key once regenerated. |

## 5. AutoResponder device token (per tenant)

| | |
|---|---|
| **Where used** | The Android's MacroDroid macro (header `x-reservanex-device-token`, all 4 webhooks); stored server-side only as a SHA-256 hash (`whatsapp_accounts.inbound_token_hash`) |
| **Impact of rotating** | The OLD token is invalid **immediately** — the Android goes fully silent (no heartbeat, no inbound, no media, no outbound ACK) until the macro's header is manually updated |
| **Downtime** | The device is effectively offline until you update it — plan to do this with the phone in hand |
| **Manual step** | None external — this is entirely a `/platform` action |
| **Update** | `/platform/tenants/[id]/whatsapp` → "Rotar token" → copy the new raw token (shown exactly once) → on the Android, update the `x-reservanex-device-token` header value in **every** MacroDroid action that sends it (main macro's outbound branch, media branch, heartbeat macro's own action) |
| **Verify** | `/platform` should show the device back "Online" after the next heartbeat; send a real inbound message and confirm it arrives in the CRM |
| **Rollback** | None — the old token is gone the moment you rotate. If something goes wrong, rotate again to get a fresh one and update the Android again. |

## 6. MacroDroid webhook URL (per tenant)

| | |
|---|---|
| **Where used** | The worker's dispatcher (`apps/worker/src/dispatcher.ts`, `apps/worker/src/media-dispatcher.ts`) — this is the URL ReservaNex calls to trigger the Android's macro |
| **When to rotate** | Only if you believe this specific URL leaked (it's the one true bearer-token-like secret in this whole system) — MacroDroid webhook trigger IDs don't expire/rotate on their own schedule the way an API key would |
| **Impact of rotating** | Outbound text/media dispatch fails until updated — inbound/heartbeat/ACK are unaffected (they use the device token, not this URL) |
| **Downtime** | Outbound sends only, until updated |
| **Manual step** | In MacroDroid, delete and recreate the webhook trigger for the main macro (or use MacroDroid's own regeneration mechanism if it has one) — this produces a new trigger URL. Since the OLD MacroDroid URL is generated as `AUTORESPONDER_PUBLIC_BASE_URL` allows only `trigger.macrodroid.com` as the host (Fase 10 hardening), confirm the new URL is still on that host. |
| **Update** | `/platform/tenants/[id]/whatsapp` → "Reemplazar webhook MacroDroid" → paste the new URL |
| **Verify** | Send a real message from the CRM, confirm it dispatches and the outbound ACK returns |
| **Rollback** | The old URL, once deleted/regenerated in MacroDroid, is gone — recreate again in MacroDroid if something goes wrong |

---

## Notes

- Rotating the Supabase service-role key does **not** require rotating device tokens or MacroDroid URLs — they are independent credential spaces.
- `AUTORESPONDER_PUBLIC_BASE_URL` and `NEXT_PUBLIC_SITE_URL` (see `docs/production-security-checklist.md` §4) are not secrets in the traditional sense (they're just origins, not bearer tokens), but confirm they point at the real production domain, not a leftover dev tunnel, as part of any broader environment cutover.
- None of Fase 10's `AUTORESPONDER_*` dev-seed env vars (`AUTORESPONDER_TENANT_ID`, `AUTORESPONDER_PHONE_NUMBER`, `AUTORESPONDER_MACRODROID_WEBHOOK_URL`, `AUTORESPONDER_DEVICE_TOKEN`, `AUTORESPONDER_DEVICE_NAME`) are read by any production code path — they only feed `apps/worker/src/scripts/seed-autoresponder-account.ts`, a one-off dev bootstrap script. Nothing to rotate there beyond making sure they're never committed (already gitignored via `.env.local`).
