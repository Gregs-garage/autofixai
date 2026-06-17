import type { Config } from '@netlify/functions'
import { getStore } from '@netlify/blobs'

export default async function handler(req: Request) {
  const userId = '6e2d401c-c594-4ff0-b0d3-64891b3f8b75'
    const store = getStore('subscriptions')
      const existing = await store.get(userId, { type: 'json' }) as any ?? {}
        const record = {
            ...existing,
                netlify_user_id: userId,
                    email: existing.email ?? 'greggarage@gmail.com',
                        stripe_customer_id: existing.stripe_customer_id ?? null,
                            stripe_subscription_id: existing.stripe_subscription_id ?? null,
                                status: 'active',
                                    current_period_end: null,
                                      }
                                        await store.setJSON(userId, record)
                                          return new Response(JSON.stringify({ ok: true, record }), {
                                              status: 200,
                                                  headers: { 'Content-Type': 'application/json' },
                                                    })
                                                    }

                                                    export const config: Config = { path: '/api/admin-activate' }
