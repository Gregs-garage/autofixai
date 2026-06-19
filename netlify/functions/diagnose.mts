import type { Config, Context } from '@netlify/functions'
import { getByUserId, isActive } from '../lib/subscriptions.mts'

// Resolve the chat-completions endpoint and key. Prefer a user-supplied
// OpenAI key/base URL if one is configured, otherwise fall back to Netlify
// AI Gateway, which is injected automatically and needs no API key of its own.
function resolveOpenAI(): { url: string; key: string } | null {
  const userKey = process.env.OPENAI_API_KEY
  if (userKey) {
    const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
    return { url: `${base}/chat/completions`, key: userKey }
  }

  const gatewayBase = process.env.NETLIFY_AI_GATEWAY_BASE_URL
  const gatewayKey = process.env.NETLIFY_AI_GATEWAY_KEY
  if (gatewayBase && gatewayKey) {
    return { url: `${gatewayBase.replace(/\/$/, '')}/openai/v1/chat/completions`, key: gatewayKey }
  }

  return null
}

// Determine, from the code's second character, whether its meaning is
// standardized by SAE/ISO (the same on every vehicle) or defined by the
// individual manufacturer (the same number means different things on a
// Ford vs. a Honda). Per SAE J2012: a second digit of 0 or 2 is generic,
// while 1 or 3 is manufacturer-specific.
function classifyCode(code: string): { codeType: string; manufacturerSpecific: boolean } {
  const secondDigit = code.charAt(1)
  const manufacturerSpecific = secondDigit === '1' || secondDigit === '3'
  return {
    codeType: manufacturerSpecific ? 'Manufacturer-specific' : 'Generic (SAE)',
    manufacturerSpecific,
  }
}

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

  const openai = resolveOpenAI()
  if (!openai) {
    return Response.json(
      { error: 'AI diagnosis is not configured. Enable Netlify AI Gateway or set OPENAI_API_KEY.' },
      { status: 503 },
    )
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  // Accept either 'code' (frontend field name) or 'dtc' for backwards compat
  const code: string = (body?.code || body?.dtc || '').toUpperCase().trim()
  if (!code) return Response.json({ error: 'code is required.' }, { status: 400 })

  const vehicle = body?.vehicle ?? null
  const lang: string = body?.lang === 'es' ? 'es' : 'en'

  const vehicleInfo = vehicle
    ? [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ')
    : null

  const make: string = (vehicle?.make || '').toString().trim()
  const engineInfo = vehicle?.engine || null
  const langNote = lang === 'es' ? 'Respond entirely in Spanish.' : 'Respond in English.'

  // The manufacturer is decisive for manufacturer-specific codes: the same
  // number is defined differently by each automaker, so the decode must be
  // anchored to the vehicle's make rather than a generic interpretation.
  const { codeType, manufacturerSpecific } = classifyCode(code)
  const needsVehicle = manufacturerSpecific && !make

  let codeTypeNote: string
  if (manufacturerSpecific) {
    if (make) {
      codeTypeNote = `${code} is a MANUFACTURER-SPECIFIC code (second digit "${code.charAt(1)}"). Manufacturer-specific codes are NOT standardized: the same code number is assigned a different meaning by each automaker, so a definition valid for one brand is wrong for another. Decode ${code} using the specific official definition that ${make} assigns to it for this ${vehicleInfo}${engineInfo ? ` (${engineInfo})` : ''}. Never substitute a generic meaning or the meaning another manufacturer uses for this number. If you are not confident of ${make}'s exact definition for ${code}, say so plainly in "name" and "severity_note" instead of guessing.`
    } else {
      codeTypeNote = `${code} is a MANUFACTURER-SPECIFIC code (second digit "${code.charAt(1)}"), and no vehicle make was provided. Because each automaker defines manufacturer-specific codes differently, ${code} CANNOT be reliably decoded without knowing the manufacturer. Set "name" to make this clear, and in "severity_note" instruct the user to decode their VIN or select their vehicle so the code can be decoded for their exact make. Keep "causes", "tests" and "fixes" to general, clearly-caveated guidance about the system this code family covers; do not present a specific definition as authoritative.`
    }
  } else {
    codeTypeNote = `${code} is a GENERIC (SAE/ISO standardized) code, so its core definition is the same across all manufacturers.${make ? ` Tailor the likely causes, tests, fixes and known issues to the ${vehicleInfo}${engineInfo ? ` (${engineInfo})` : ''} where relevant.` : ''}`
  }

  const prompt = `You are an expert automotive technician. A user needs help diagnosing OBD-II fault code ${code}${vehicleInfo ? ` on their ${vehicleInfo}${engineInfo ? ` (${engineInfo})` : ''}` : ''}.

${codeTypeNote}

${langNote}

Return ONLY a valid JSON object with exactly these fields (no markdown, no code fences, just raw JSON):
{
  "name": "short human-readable name for the code",
  "system": "which vehicle system (e.g. Ignition, Fuel System, Emissions)",
  "code_type": "${codeType}",
  "severity": "high | medium | low",
  "severity_note": "one sentence on whether it is safe to drive",
  "vehicle": "${vehicleInfo ?? ''}",
  "vehicle_note": "any known issue specific to this make/model/engine for this code, or empty string",
  "causes": ["cause 1", "cause 2", "cause 3"],
  "tests": ["step 1 test", "step 2 test"],
  "fixes": ["fix 1", "fix 2"],
  "repair_estimate": "rough cost range and labour time estimate"
}`

  try {
    const aiRes = await fetch(openai.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openai.key}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 900,
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
      name: parsed.name || code,
      system: parsed.system || '',
      // Trust the deterministic classification over the model's guess.
      code_type: codeType,
      manufacturer_specific: manufacturerSpecific,
      needs_vehicle: needsVehicle,
      severity: parsed.severity || 'medium',
      severity_note: parsed.severity_note || '',
      vehicle: parsed.vehicle || vehicleInfo || '',
      vehicle_note: parsed.vehicle_note || '',
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
