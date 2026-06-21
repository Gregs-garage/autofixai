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

/** Map vehicle make to manufacturer group for manufacturer-specific code context */
function getMfrGroup(make: string): string {
  const m = (make || '').toLowerCase()
  if (['jeep','chrysler','dodge','ram','fiat','alfa romeo','maserati'].some(x => m.includes(x))) return 'Stellantis/Chrysler (FCA)'
  if (['ford','lincoln','mercury'].some(x => m.includes(x))) return 'Ford Motor Company'
  if (['chevrolet','chevy','gmc','buick','cadillac','pontiac','oldsmobile','saturn'].some(x => m.includes(x))) return 'General Motors (GM)'
  if (['toyota','lexus','scion'].some(x => m.includes(x))) return 'Toyota Motor Corporation'
  if (['honda','acura'].some(x => m.includes(x))) return 'Honda Motor Company'
  if (['nissan','infiniti'].some(x => m.includes(x))) return 'Nissan Motor Company'
  if (['volkswagen','vw','audi','porsche','seat','skoda'].some(x => m.includes(x))) return 'Volkswagen Group (VAG)'
  if (['bmw','mini','rolls-royce'].some(x => m.includes(x))) return 'BMW Group'
  if (['mercedes','mercedes-benz','sprinter','smart'].some(x => m.includes(x))) return 'Mercedes-Benz (Daimler)'
  if (['hyundai','kia','genesis'].some(x => m.includes(x))) return 'Hyundai Motor Group'
  if (['subaru'].some(x => m.includes(x))) return 'Subaru (Fuji Heavy Industries)'
  if (['mazda'].some(x => m.includes(x))) return 'Mazda Motor Corporation'
  if (['volvo'].some(x => m.includes(x))) return 'Volvo Cars (Geely)'
  return ''
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
  const makeStr: string = vehicle?.make || ''
  const mfrGroup = getMfrGroup(makeStr)
  const vinStr: string = vehicle?.vin || ''

  const langNote = lang === 'es' ? 'Respond entirely in Spanish.' : 'Respond in English.'
  const isMulti = codes.length > 1
  const codeList = codes.join(', ')

  const mfrContext = mfrGroup
    ? `The vehicle manufacturer group is ${mfrGroup}. Use your knowledge of ${mfrGroup} manufacturer-specific DTCs when interpreting these codes.`
    : ''

  const vinContext = vinStr
    ? `VIN: ${vinStr}. Use the VIN to confirm the exact platform, engine family, and model year when interpreting codes.`
    : ''

  const mfrCodeNote = `CRITICAL INSTRUCTION: OBD-II codes whose second character is NOT '0' (e.g. P1xxx, P2xxx, P3xxx) and all B, C, U codes are often manufacturer-specific. When the vehicle make is known, ALWAYS interpret the code using that manufacturer's DTC definitions — not generic SAE definitions. You MUST provide a complete, meaningful diagnosis for every code entered. NEVER respond with "unknown code", "not recognized", "code not found", or any similar non-answer. Use your full knowledge of manufacturer service documentation, TSBs, and known issues. For example: P000B on a Jeep/Chrysler vehicle = "B Camshaft Position Slow Response Bank 1" (VVT system fault).`

  let prompt: string

  if (isMulti) {
    prompt = `You are a master automotive technician with comprehensive knowledge of OBD-II diagnostics, all manufacturer-specific DTC databases, and vehicle repair across all makes and models.

A vehicle has multiple fault codes active simultaneously: ${codeList}${vehicleInfo ? ` on a ${vehicleInfo}${engineInfo ? ` (${engineInfo})` : ''}` : ''}.
${mfrContext ? '\n' + mfrContext : ''}
${vinContext ? vinContext + '\n' : ''}
${mfrCodeNote}

${langNote}

Analyse these codes TOGETHER as a combination. Identify the single most likely common root cause and repair that explains all or most codes firing together. Think about what underlying failure (e.g. timing chain, wiring harness, oil pressure, software fault, sensor failure) would trigger this exact combination on this specific vehicle.

Return ONLY a valid JSON object with exactly these fields (no markdown, no code fences, just raw JSON):
{
  "name": "short combined diagnosis name (e.g. 'Timing Chain / Cam & Crank Sensor Fault')",
  "system": "primary vehicle system affected",
  "code_type": "Generic (SAE), Manufacturer-specific (${mfrGroup || 'OEM'}), or Mixed",
  "severity": "high | medium | low",
  "severity_note": "one sentence on whether it is safe to drive with these codes active",
  "vehicle": "${vehicleInfo ?? ''}",
  "vehicle_note": "known TSBs, technical service bulletins, or common issues for this code combination on this specific make/model/year/engine — be specific and detailed",
  "common_repair": "the single most likely combined repair that addresses all or most of these codes together, with make/model-specific detail",
  "causes": ["root cause 1 explaining multiple codes", "root cause 2", "root cause 3"],
  "tests": ["diagnostic step 1", "diagnostic step 2", "diagnostic step 3"],
  "fixes": ["combined repair 1", "combined repair 2", "combined repair 3"],
  "repair_estimate": "rough cost range and labour time estimate for the combined repair"
}`
  } else {
    const code = codes[0]
    const secondChar = code.length >= 2 ? code[1] : '0'
    const isMfrSpecific = secondChar !== '0' || code[0] !== 'P'
    const codeTypeHint = isMfrSpecific && mfrGroup
      ? `This code appears to be manufacturer-specific for ${mfrGroup}. Interpret it using the ${mfrGroup} DTC database.`
      : ''

    prompt = `You are a master automotive technician with comprehensive knowledge of OBD-II diagnostics, all manufacturer-specific DTC databases, and vehicle repair across all makes and models.

Diagnose fault code ${code}${vehicleInfo ? ` on a ${vehicleInfo}${engineInfo ? ` (${engineInfo})` : ''}` : ''}.
${mfrContext ? '\n' + mfrContext : ''}
${vinContext ? vinContext + '\n' : ''}
${codeTypeHint ? codeTypeHint + '\n' : ''}
${mfrCodeNote}

${langNote}

Return ONLY a valid JSON object with exactly these fields (no markdown, no code fences, just raw JSON):
{
  "name": "specific, accurate name for this code on this vehicle (e.g. 'B Camshaft Position Slow Response Bank 1' for P000B on Jeep/Chrysler)",
  "system": "vehicle system affected (e.g. Variable Valve Timing, Engine Timing, Fuel System)",
  "code_type": "Generic (SAE) or Manufacturer-specific (${mfrGroup || 'OEM'})",
  "severity": "high | medium | low",
  "severity_note": "one sentence on whether it is safe to drive",
  "vehicle": "${vehicleInfo ?? ''}",
  "vehicle_note": "specific known TSBs, common failures, or issues for this exact code on this make/model/year/engine — be detailed and specific",
  "common_repair": "",
  "causes": ["cause 1 specific to this vehicle/code", "cause 2", "cause 3"],
  "tests": ["diagnostic step 1 with specific procedure", "diagnostic step 2", "diagnostic step 3"],
  "fixes": ["fix 1 with part names where applicable", "fix 2", "fix 3"],
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
        max_tokens: 1100,
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
