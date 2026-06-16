import type { Config, Context } from '@netlify/functions'
import { getUser } from '@netlify/identity'
import { getStripe, planLineItem } from '../lib/stripe.mts'
import { getByUserId, upsertCustomer, isActive } from '../lib/subscriptions.mts'

// Creates a Stripe Checkout session for AutoFix Pro, or a Billing Portal session
// for an existing subscriber (?action=portal). Requires a signed-in user.
export default async (req: Request, context: Context) => {
  const user = await getUser()
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

  // Reuse the stored Stripe customer, or create one on first checkout.
  let sub = await getByUserId(user.id)
  let customerId = sub?.stripe_customer_id ?? null
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email ?? undefined,
      metadata: { netlify_user_id: user.id },
    })
    customerId = customer.id
    await upsertCustomer(user.id, user.email ?? null, customerId)
  }

  try {
    // Existing subscriber → send them to the billing portal to manage/cancel.
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

    // Already subscribed → no need for a second checkout.
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
