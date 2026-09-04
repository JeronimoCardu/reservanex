import { redirect } from 'next/navigation'

// The public marketing site now lives at /es, /pt, /en. This route used to
// gate on the Supabase session and send everyone to /login — the CRM's
// entry points are /login, /dashboard and /platform now, not "/".
export default function HomePage() {
  redirect('/es')
}
