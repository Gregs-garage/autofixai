import type { Config, Context } from '@netlify/functions'
import { isActive, getByUserId } from '../lib/subscriptions.mts'

// Grants temporary preview access to a subscriber. Requires signed-in user
// and either an active subscription or the correct PRO_PREVIEW_PASSWORD env var.
export default async (req: Request, context: Context) => {
  const user = context.clientContext?.user
  if (!user) return Response.json({ error: 'You must be signed in.' }, { status: 401 })

  const sub = await getByUserId(user.sub)

  // Allow access if subscription is active
  if (isActive(sub)) {
    return Response.json({ access: true, reason: 'subscription' })
  }

  // Allow access if PRO_PREVIEW_PASSWORD matches (for testing/preview purposes)
  const body = await req.json().catch(() => ({}))
  const password = body?.password
  const previewPassword = process.env.PRO_PREVIEW_PASSWORD
  if (previewPassword && password === previewPassword) {
    return Response.json({ access: true, reason: 'preview_password' })
  }

  return Response.json({ access: false }, { status: 403 })
}

export const config: Config = {
  path: '/api/preview-access',
  method: 'POST',
}
