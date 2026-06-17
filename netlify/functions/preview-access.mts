import type { Config, Context } from '@netlify/functions'
import { isActive, getByUserId } from '../lib/subscriptions.mts'

function getUserFromRequest(req: Request): { sub: string; email: string | null } | null {
  const auth = req.headers.get('authorization') || req.headers.get('Authorization') || ''
  const token = auth.replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'))
    if (!payload?.sub) return null
    return { sub: payload.sub, email: payload.email ?? null }
  } catch {
    return null
  }
}

export default async (req: Request, context: Context) => {
  const user = getUserFromRequest(req)
  if (!user) return Response.json({ error: 'You must be signed in.' }, { status: 401 })

  const sub = await getByUserId(user.sub)
  if (isActive(sub)) {
    return Response.json({ access: true, reason: 'subscription' })
  }

  const body = await req.json().catch(() => ({}))
  const password = body?.password
  const previewPassword = process.env.PRO_PREVIEW_PASSWORD
  if (previewPassword && password === previewPassword) {
    return Response.json({ access: true, reason: 'preview_password' })
  }

  return Response.json({ access: false }, { status: 403 })
}

export const config: Config = {
  path: '/api/preview-access',
  method: 'POST',
}
