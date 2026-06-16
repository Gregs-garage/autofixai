// POST /api/diagnose
// Accepts an OBD-II DTC code + vehicle context and returns an AI diagnosis.
// Requires an active AutoFix Pro subscription or valid preview cookie.

import type { Config, Context } from '@netlify/functions'
import { getUser } from '@netlify/identity'
import { getByUserId, isActive } from '../lib/subscriptions.mts'
import { previewConfigured } from '../lib/preview.mts'

const OPENAI_API = 'https://api.openai.com/v1/chat/completions'

export default async (req: Request, context: Context) => {
  // Check Pro access (subscription or preview cookie)
  const cookie = req.headers.get('cookie') ?? ''
  const hasPreviewCookie = cookie.includes('pro_preview=')

  const user = await getUser()

  let isPro = false
  if (hasPreviewCookie && previewConfigured()) {
    isPro = true
  } else if (user) {
    const sub = await getByUserId(user.id)
    isPro = isActive(sub)
  }

  if (!isPro) {
    return Response.json(
      { error: 'AutoFix Pro subscription required.' },
      { status: 402 },
    )
  }

  let body: { code?: string; vehicle?: Record<string, unknown> } = {}
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const { code, vehicle } = body
  if (!code) {
    return Response.json({ error: 'code is required.' }, { status: 400 })
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    return Response.json(
      { error: 'AI service is not configured. Set OPENAI_API_KEY in Netlify env vars.' },
      { status: 503 },
    )
  }

  const vehicleDesc = vehicle
    ? `${vehicle.year ?? ''} ${vehicle.make ?? ''} ${vehicle.model ?? ''} ${vehicle.engine ?? ''}`.trim()
    : 'unknown vehicle'

  const systemPrompt = `You are AutoFix AI, an expert automotive diagnostic assistant.
When given an OBD-II diagnostic trouble code (DTC) and vehicle information, provide:
1. What the code means in plain English
2. Common causes (list the most likely causes first)
3. Symptoms the driver may notice
4. Recommended repair steps
5. Estimated repair cost range (USD)
6. Urgency level: Low / Medium / High / Critical
Keep your response clear and practical for a vehicle owner or mechanic.`

  const userPrompt = `Vehicle: ${vehicleDesc}
DTC Code: ${code}

Please diagnose this fault code.`

  try {
    const aiRes = await fetch(OPENAI_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 800,
        temperature: 0.3,
      }),
    })

    if (!aiRes.ok) {
      const err = await aiRes.text()
      return Response.json({ error: 'AI request failed: ' + err }, { status: 502 })
    }

    const data = (await aiRes.json()) as {
      choices: Array<{ message: { content: string } }>
    }
    const diagnosis = data.choices?.[0]?.message?.content ?? ''

    return Response.json({ diagnosis, code, vehicle: vehicleDesc }, { status: 200 })
  } catch (err: any) {
    return Response.json({ error: err.message ?? 'AI request failed.' }, { status: 502 })
  }
}

export const config: Config = {
  path: '/api/diagnose',
  method: 'POST',
}
