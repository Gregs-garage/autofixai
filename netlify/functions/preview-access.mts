// POST /api/preview-access
// Grants or revokes preview (Pro test) access via a signed cookie.
// Body: { password: string } to grant, { action: 'exit' } to revoke.

import type { Config, Context } from '@netlify/functions'
import {
  previewConfigured,
  verifyPassword,
  grantCookie,
} from '../lib/preview.mts'

export default async (req: Request, context: Context) => {
  if (!previewConfigured()) {
    return Response.json(
      { error: 'Preview access is not configured on this site.' },
      { status: 404 },
    )
  }

  let body: { password?: string; action?: string } = {}
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  // Exit / revoke preview access
  if (body.action === 'exit') {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'set-cookie': 'pro_preview=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
      },
    })
  }

  // Grant preview access
  if (!body.password) {
    return Response.json({ error: 'password is required.' }, { status: 400 })
  }

  const ok = await verifyPassword(body.password)
  if (!ok) {
    return Response.json({ error: 'Incorrect password.' }, { status: 401 })
  }

  const cookie = await grantCookie()
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': cookie,
    },
  })
}

export const config: Config = {
  path: '/api/preview-access',
  method: 'POST',
}
