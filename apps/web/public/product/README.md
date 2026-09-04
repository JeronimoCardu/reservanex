# Product screenshots — drop-in slots

The "product preview" section (`src/components/sections/product-preview.tsx`
+ `src/components/product-preview/crm-mockup.tsx`) currently renders a fully
custom, fictional recreation of the CRM UI — no real data, no real
screenshot — because the only screenshot available while building this
site had a real client's name, phone number and email visible in it, which
can't be published as-is.

Drop real, sanitized screenshots into this folder with these exact names
and each tab switches from the fictional mockup to the real image
automatically (checked via `src/lib/product-assets.ts`, no code changes
needed):

| File | Tab |
|---|---|
| `conversations.webp` | Conversaciones / Conversas / Conversations |
| `properties.webp` | Propiedades / Imóveis / Listings |
| `reservations.webp` | Reservas / Reservas / Bookings |
| `team.webp` | Equipo / Equipe / Team |
| `video-poster.webp` | Background behind the "coming soon" play button in the video demo section (`src/components/sections/video-demo.tsx`) |

A tab with no matching file keeps showing the fictional mockup — nothing
breaks, and no import ever references a file that might not exist yet.

**Before adding a screenshot here**, double-check it doesn't show real
tenant data — contact names, phone numbers, emails, or any other real
customer information. This folder is public.
