import type { Config, Context } from '@netlify/functions'
import { getByUserId } from '../lib/subscriptions.mts'
import { isActive } from '../lib/subscriptions.mts'

// Returns the current user's subscription status.
// Requires a signed-in Netlify Identity user (JWT in Authorization header).
export default async (req: Request, context: Context) => {
  const user = context.clientContext?.user
  if (!user) return Response.json({ error: 'You must be signed in.' }, { status: 401 })

  const sub = await getByUserId(user.sub)
  const active = isActive(sub)

  return Response.json({
    subscribed: active,
    plan: active ? 'pro' : 'free',
    stripe_customer_id: sub?.stripe_customer_id ?? null,
    stripe_subscription_id: sub?.stripe_subscription_id ?? null,
    stripe_status: sub?.stripe_status ?? null,
    period_end: sub?.current_period_end ?? null,
  })
}

export const config: Config = {
  path: '/api/subscription',
  method: 'GET',
}
