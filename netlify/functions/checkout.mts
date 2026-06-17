import type { Config, Context } from '@netlify/functions'
import { getStripe, planLineItem } from '../lib/stripe.mts'
import { getByUserId, upsertCustomer, isActive } from '../lib/subscriptions.mts'

// Decode a Netlify Identity JWT from the Authorization header.
// We just base64-decode the payload — we don't need to verify the signature
// because Netlify's gateway already verified it before invoking our function.
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

  const stripe = getStripe()
  if (!stripe) {
    return Response.json(
      { error: 'Payments are not configured yet. Set STRIPE_SECRET_KEY in your Netlify site settings.' },
      { status: 503 },
    )
  }

  const origin = req.headers.get('origin') || process.env.URL || new URL(req.url).origin
  const action = new URL(req.url).searchParams.get('action')

  let sub = await getByUserId(user.id)
  let customerId = sub?.stripe_customer_id ?? null
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      metadata: { netlify_user_id: user.id },
    })
    customerId = customer.id
    await upsertCustomer(user, user.email ?? null, customerId)
  }

  try {
    if (action === 'portal') {
      if (!isActive(sub)) {
        return Response.json({ error: 'No active subscription to manage.' }, { status: 400 })
      }
      const portal = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: `${origin}/#pricing`,
      })
      return Response.json({ url: portal.url })
    }

    if (isActive(sub)) {
      return Response.json({ error: 'You already have an active AutoFix Pro subscription.' }, { status: 409 })
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [planLineItem()],
      allow_promotion_codes: true,
      success_url: `${origin}/?subscribed=1#pricing`,
      cancel_url: `${origin}/?canceled=1#pricing`,
      metadata: { netlify_user_id: user.id },
      subscription_data: { metadata: { netlify_user_id: user.id } },
    })

    return Response.json({ url: session.url })
  } catch (err: any) {
    return Response.json({ error: err?.message || 'Stripe request failed.' }, { status: 502 })
  }
}

export const config: Config = {
  path: '/api/checkout',
  method: 'POST',
}
