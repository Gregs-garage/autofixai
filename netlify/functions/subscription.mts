// GET /api/subscription
// Returns the current user's subscription status.
// Used by the frontend to decide whether to show Pro features.

import type { Config, Context } from '@netlify/functions'
import { getUser } from '@netlify/identity'
import { getByUserId, isActive } from '../lib/subscriptions.mts'
import { previewConfigured } from '../lib/preview.mts'

export default async (req: Request, context: Context) => {
  // Allow preview cookie to act as a Pro pass
  const cookie = req.headers.get('cookie') ?? ''
  const hasPreviewCookie = cookie.includes('pro_preview=')

  const user = await getUser()

  if (!user && !hasPreviewCookie) {
    return Response.json({ active: false, preview: false }, { status: 200 })
  }

  if (hasPreviewCookie && previewConfigured()) {
    return Response.json({ active: true, preview: true }, { status: 200 })
  }

  if (!user) {
    return Response.json({ active: false, preview: false }, { status: 200 })
  }

  const sub = await getByUserId(user.id)

  return Response.json(
    {
      active: isActive(sub),
      preview: false,
      status: sub?.status ?? null,
      shop_name: sub?.shop_name ?? null,
      current_period_end: sub?.current_period_end ?? null,
    },
    { status: 200 },
  )
}

export const config: Config = {
  path: '/api/subscription',
  method: 'GET',
}
