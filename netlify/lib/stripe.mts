// Stripe client singleton and shared line-item helper.
// Import this from any Netlify function that needs to talk to Stripe.

import Stripe from 'stripe'

let _stripe: Stripe | null = null

/**
 * Returns an initialised Stripe client, or null if STRIPE_SECRET_KEY is not set.
 */
export function getStripe(): Stripe | null {
  if (_stripe) return _stripe
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return null
  _stripe = new Stripe(key, { apiVersion: '2024-06-20' })
  return _stripe
}

/**
 * The line-item for AutoFix Pro, driven by the STRIPE_PRICE_ID env var.
 * Throws if the env var is missing so misconfiguration is caught early.
 */
export function planLineItem(): Stripe.Checkout.SessionCreateParams.LineItem {
  const priceId = process.env.STRIPE_PRICE_ID
  if (!priceId) throw new Error('STRIPE_PRICE_ID env var is not set.')
  return { price: priceId, quantity: 1 }
}
