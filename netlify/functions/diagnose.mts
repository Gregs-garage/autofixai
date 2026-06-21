import type { Config, Context } from '@netlify/functions'
import { getByUserId, isActive } from '../lib/subscriptions.mts'

const OPENAI_API = 'https://api.openai.com/v1/chat/completions'

function getUserFromRequest(req: Request): { id: string; email: string | null } | null {
  const auth = req.headers.get('authorization') || req.headers.get('Authorization') || ''
  const token = auth.replace(/^Bearer\s+/i, '').trim()
  if (!token) return null
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'))
    if (!payload?.sub) return null
    return { id: payload.sub, email: payload.email ?? null }
  } catch {
    return null
  }
}

export default async (req: Request, context: Context) => {
  const user = getUserFromRequest(req)
  if (!user) return Response.json({ error: 'You must be signed in.' }, { status: 401 })

  const sub = await getByUserId(user.id)
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

  // Support multi-code array (codes) or single code (code/dtc) for backwards compat
  let codes: string[] = []
  if (Array.isArray(body?.codes) && body.codes.length > 0) {
    codes = body.codes.map((c: string) => String(c).toUpperCase().trim()).filter(Boolean)
  } else {
    const single = (body?.code || body?.dtc || '').toUpperCase().trim()
    if (single) codes = [single]
  }
  if (codes.length === 0) return Response.json({ error: 'At least one code is required.' }, { status: 400 })

  const vehicle = body?.vehicle ?? null
  const lang: string = body?.lang === 'es' ? 'es' : 'en'

  const vehicleInfo = vehicle
    ? [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ')
    : null

  const engineInfo = vehicle?.engine || null
  const langNote = lang === 'es' ? 'Respond entirely in Spanish.' : 'Respond in English.'
  const isMulti = codes.length > 1
  const codeList = codes.join(', ')

  let prompt: string

  if (isMulti) {
    prompt = `You are an expert automotive technician. A vehicle has multiple OBD-II fault codes active at the same time: ${codeList}${vehicleInfo ? ` on a ${vehicleInfo}${engineInfo ? ` (${engineInfo})` : ''}` : ''}.

${langNote}

Your job is to analyse these codes TOGETHER as a combination and identify the most likely common root cause and repair, rather than diagnosing each code in isolation. Think about what single underlying problem could trigger all or most of these codes simultaneously.

Return ONLY a valid JSON object with exactly these fields (no markdown, no code fences, just raw JSON):
{
  "name": "short combined diagnosis name (e.g. 'Timing Chain / Cam & Crank Sensor Fault')",
  "system": "primary vehicle system affected",
  "code_type": "Generic (SAE) or Manufacturer-specific",
  "severity": "high | medium | low",
  "severity_note": "one sentence on whether it is safe to drive with these codes active",
  "vehicle": "${vehicleInfo ?? ''}",
  "vehicle_note": "any known issue or TSB for this code combination on this specific make/model/engine, or empty string",
  "common_repair": "the single most likely combined repair that addresses all or most of these codes together (e.g. 'Timing chain replacement and cam/crank sensor replacement — common on Ford 4.6L/5.4L engines when timing chain stretches')",
  "causes": ["root cause 1 that explains multiple codes", "root cause 2", "root cause 3"],
  "tests": ["diagnostic step 1", "diagnostic step 2", "diagnostic step 3"],
  "fixes": ["combined repair 1", "combined repair 2", "combined repair 3"],
  "repair_estimate": "rough cost range and labour time estimate for the combined repair"
}`
  } else {
    const code = codes[0]
    prompt = `You are an expert automotive technician. A user needs help diagnosing OBD-II fault code ${code}${vehicleInfo ? ` on their ${vehicleInfo}${engineInfo ? ` (${engineInfo})` : ''}` : ''}.

${langNote}

Return ONLY a valid JSON object with exactly these fields (no markdown, no code fences, just raw JSON):
{
  "name": "short human-readable name for the code",
  "system": "which vehicle system (e.g. Ignition, Fuel System, Emissions)",
  "code_type": "Generic (SAE) or Manufacturer-specific",
  "severity": "high | medium | low",
  "severity_note": "one sentence on whether it is safe to drive",
  "vehicle": "${vehicleInfo ?? ''}",
  "vehicle_note": "any known issue specific to this make/model/engine for this code, or empty string",
  "common_repair": "",
  "causes": ["cause 1", "cause 2", "cause 3"],
  "tests": ["step 1 test", "step 2 test"],
  "fixes": ["fix 1", "fix 2"],
  "repair_estimate": "rough cost range and labour time estimate"
}`
  }

  try {
    const aiRes = await fetch(OPENAI_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1000,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
    })

    if (!aiRes.ok) {
      const err = await aiRes.text()
      return Response.json({ error: `OpenAI error: ${err}` }, { status: 502 })
    }

    const aiJson = await aiRes.json()
    const raw = aiJson.choices?.[0]?.message?.content ?? '{}'

    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch {
      return Response.json({ error: 'AI returned invalid JSON.' }, { status: 502 })
    }

    // Ensure arrays are arrays even if AI skipped them
    const safeArr = (v: any) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : [])

    return Response.json({
      name: parsed.name || codeList,
      system: parsed.system || '',
      code_type: parsed.code_type || '',
      severity: parsed.severity || 'medium',
      severity_note: parsed.severity_note || '',
      vehicle: parsed.vehicle || vehicleInfo || '',
      vehicle_note: parsed.vehicle_note || '',
      common_repair: parsed.common_repair || '',
      causes: safeArr(parsed.causes),
      tests: safeArr(parsed.tests),
      fixes: safeArr(parsed.fixes),
      repair_estimate: parsed.repair_estimate || '',
    })
  } catch (err: any) {
    return Response.json({ error: err?.message || 'AI request failed.' }, { status: 502 })
  }
}

export const config: Config = {
  path: '/api/diagnose',
  method: 'POST',
}
