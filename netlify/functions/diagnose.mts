// POST /api/diagnose
// Accepts an OBD-II DTC code + vehicle context and returns an AI diagnosis.
// Requires an active AutoFix Pro subscription or valid preview cookie.

import type { Config, Context } from '@netlify/functions'
import { getByUserId, isActive } from '../lib/subscriptions.mts'
import { previewConfigured } from '../lib/preview.mts'

const OPENAI_API = 'https://api.openai.com/v1/chat/completions'

export default async (req: Request, context: Context) => {
  // Check if user is signed in via Netlify Identity
  const user = context.clientContext?.user

  // If signed in, check subscription
  if (user) {
    const sub = await getByUserId(user.sub)
    if (!isActive(sub)) {
      // Not subscribed — check for preview mode
      if (!previewConfigured()) {
        return Response.json({ error: 'AutoFix Pro subscription required.' }, { status: 403 })
      }
    }
  } else {
    // Not signed in — allow only if preview mode is configured
    if (!previewConfigured()) {
      return Response.json({ error: 'You must be signed in with an active subscription.' }, { status: 401 })
    }
  }

  const openaiKey = process.env.OPENAI_API_KEY
  if (!openaiKey) {
    return Response.json(
      { error: 'AI diagnosis is not configured. Set OPENAI_API_KEY in your Netlify site settings.' },
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
  ]
    .filter(Boolean)
    .join(', ')

  const symptomText = symptoms ? `Additional symptoms reported: ${symptoms}` : ''

  const prompt = [
    `You are an expert automotive technician. Diagnose the following OBD-II fault code.`,
    vehicleInfo ? `Vehicle: ${vehicleInfo}` : '',
    `Fault code: ${dtc}`,
    symptomText,
    `Provide: 1) What the code means, 2) Likely causes (most to least common), 3) Recommended repairs, 4) Urgency level (safe to drive / drive with caution / do not drive). Be concise and practical.`,
  ]
    .filter(Boolean)
    .join('\n')

  try {
    const aiRes = await fetch(OPENAI_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 600,
        temperature: 0.3,
      }),
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
