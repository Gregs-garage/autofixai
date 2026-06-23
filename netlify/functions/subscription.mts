import type { Config, Context } from '@netlify/functions'
import { getByUserId, isActive } from '../lib/subscriptions.mts'

function getUserFromRequest(req: Request): { id: string; email: string | null } | null {
  const auth = req.headers.get('authorization') || req.headers.get('Authorization') || ''
  const token = auth.replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'))
    if (!payload?.sub) return null
    return { id: payload.sub, email: payload.email ?? null }
  } catch {
    return null
  }
}

export default async (req: Request, context: Context) => {
  const user = getUserFromRequest(req)
  if (!user) return Response.json({ error: 'You must be signed in.' }, { status: 401 })

  const sub = await getByUserId(user.id)
  const active = isActive(sub)

  return Response.json({
    subscribed: active,
    plan: active ? 'pro' : 'free',
    stripe_customer_id: sub?.stripe_customer_id ?? null,
    stripe_subscription_id: sub?.stripe_subscription_id ?? null,
    stripe_status: sub?.status ?? null,
    period_end: sub?.current_period_end ?? null,
  })
}

export const config: Config = {
  path: '/api/subscription',
  method: 'GET',
}
