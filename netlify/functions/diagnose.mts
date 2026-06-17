import type { Config, Context } from '@netlify/functions'
import { getByUserId, isActive } from '../lib/subscriptions.mts'

const OPENAI_API = 'https://api.openai.com/v1/chat/completions'

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
  if (!isActive(sub)) {
    return Response.json({ error: 'AutoFix Pro subscription required.' }, { status: 403 })
  }

  const openaiKey = process.env.OPENAI_API_KEY
  if (!openaiKey) {
    return Response.json(
      { error: 'AI diagnosis is not configured. Set OPENAI_API_KEY in Netlify site settings.' },
      { status: 503 },
    )
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const { dtc, make, model, year, mileage, symptoms } = body ?? {}
  if (!dtc) return Response.json({ error: 'dtc is required.' }, { status: 400 })

  const vehicleInfo = [
    year && make && model ? `${year} ${make} ${model}` : null,
    mileage ? `${mileage} miles` : null,
  ].filter(Boolean).join(', ')

  const symptomText = symptoms ? `Additional symptoms: ${symptoms}` : ''

  const prompt = [
    `You are an expert automotive technician. Diagnose the following OBD-II fault code.`,
    vehicleInfo ? `Vehicle: ${vehicleInfo}` : '',
    `Fault code: ${dtc}`,
    symptomText,
    `Provide: 1) What the code means, 2) Likely causes (most to least common), 3) Recommended repairs, 4) Urgency level (safe to drive / drive with caution / do not drive). Be concise and practical.`,
  ].filter(Boolean).join('\n')

  try {
    const aiRes = await fetch(OPENAI_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 600, temperature: 0.3 }),
    })
    if (!aiRes.ok) {
      const err = await aiRes.text()
      return Response.json({ error: `OpenAI error: ${err}` }, { status: 502 })
    }
    const aiJson = await aiRes.json()
    const diagnosis = aiJson.choices?.[0]?.message?.content ?? ''
    return Response.json({ diagnosis, dtc })
  } catch (err: any) {
    return Response.json({ error: err?.message || 'AI request failed.' }, { status: 502 })
  }
}

export const config: Config = {
  path: '/api/diagnose',
  method: 'POST',
}
