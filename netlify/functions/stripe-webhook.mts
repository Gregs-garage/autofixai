// POST /api/stripe-webhook
// Receives Stripe webhook events and keeps our subscription records in sync.
// Stripe sends a signed payload; we verify the signature before processing.

import type { Config, Context } from '@netlify/functions'
import { getStripe } from '../lib/stripe.mts'
import { getByUserId, updateSubscription, upsertCustomer } from '../lib/subscriptions.mts'

// Helper to extract the Netlify user ID from Stripe metadata
function getUserId(obj: { metadata?: Record<string, string> } | null): string | null {
  return obj?.metadata?.netlify_user_id ?? null
}

export default async (req: Request, context: Context) => {
  const stripe = getStripe()
  if (!stripe) {
    return new Response('Stripe not configured', { status: 503 })
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    return new Response('Webhook secret not configured', { status: 503 })
  }

  const sig = req.headers.get('stripe-signature')
  if (!sig) {
    return new Response('Missing stripe-signature header', { status: 400 })
  }

  let event: ReturnType<typeof stripe.webhooks.constructEvent>
  try {
    const raw = await req.text()
    event = stripe.webhooks.constructEvent(raw, sig, secret)
  } catch (err: any) {
    return new Response('Webhook signature verification failed: ' + err.message, { status: 400 })
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as {
          customer: string
          subscription: string
          metadata?: Record<string, string>
          subscription_data?: { metadata?: Record<string, string> }
          customer_details?: { email?: string }
        }
        const userId = getUserId(session) ?? getUserId(session.subscription_data as any)
        if (userId) {
          const sub = await stripe.subscriptions.retrieve(session.subscription as string)
          await upsertCustomer(
            { id: userId, email: session.customer_details?.email },
            session.customer_details?.email ?? null,
            session.customer as string,
          )
          await updateSubscription(userId, {
            stripe_subscription_id: sub.id,
            status: sub.status,
            current_period_end: (sub as any).current_period_end ?? null,
          })
        }
        break
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as {
          id: string
          status: string
          customer: string
          metadata?: Record<string, string>
          current_period_end?: number
        }
        const userId = getUserId(sub)
        if (userId) {
          await updateSubscription(userId, {
            stripe_subscription_id: sub.id,
            status: sub.status,
            current_period_end: sub.current_period_end ?? null,
          })
        }
        break
      }

      default:
        // Ignore unhandled event types
        break
    }
  } catch (err: any) {
    console.error('Webhook handler error:', err)
    return new Response('Internal error: ' + err.message, { status: 500 })
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

export const config: Config = {
  path: '/api/stripe-webhook',
  method: 'POST',
}
