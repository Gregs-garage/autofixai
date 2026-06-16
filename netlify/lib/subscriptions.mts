// Subscription record helpers using Netlify Blobs (key-value store).
// Each record is keyed by Netlify user ID and holds the Stripe customer /
// subscription data we need to gate Pro features.

import { getStore } from '@netlify/blobs'

export interface SubscriptionRecord {
  netlify_user_id: string
  email: string | null
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  status: string | null          // 'active' | 'trialing' | 'past_due' | 'canceled' | null
  shop_name: string | null
  current_period_end: number | null   // unix timestamp
}

function store() {
  return getStore('subscriptions')
}

export async function getByUserId(userId: string): Promise<SubscriptionRecord | null> {
  const raw = await store().get(userId, { type: 'json' })
  return (raw as SubscriptionRecord) ?? null
}

export async function upsertCustomer(
  user: { id: string; email?: string | null },
  email: string | null,
  stripeCustomerId: string,
): Promise<void> {
  const existing = await getByUserId(user.id)
  const record: SubscriptionRecord = {
    netlify_user_id: user.id,
    email: email ?? existing?.email ?? null,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: existing?.stripe_subscription_id ?? null,
    status: existing?.status ?? null,
    shop_name: existing?.shop_name ?? null,
    current_period_end: existing?.current_period_end ?? null,
  }
  await store().setJSON(user.id, record)
}

export async function updateSubscription(
  userId: string,
  patch: Partial<SubscriptionRecord>,
): Promise<void> {
  const existing = await getByUserId(userId)
  if (!existing) return
  await store().setJSON(userId, { ...existing, ...patch })
}

/**
 * Returns true if the record represents an active or trialing subscription.
 */
export function isActive(record: SubscriptionRecord | null): boolean {
  if (!record) return false
  return record.status === 'active' || record.status === 'trialing'
}
