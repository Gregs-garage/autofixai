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

/** Get OBD-II system description from code prefix letter */
function getCodeSystem(code: string): string {
  const prefix = (code || '').charAt(0).toUpperCase()
  switch (prefix) {
    case 'P': return 'Powertrain (engine, transmission, fuel, emissions)'
    case 'B': return 'Body (BCM, airbags, comfort systems, lighting, windows, seats)'
    case 'C': return 'Chassis (ABS, traction control, stability control, steering, suspension, brakes)'
    case 'U': return 'Network/Communication (CAN bus, module communication, data link)'
    default: return ''
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

  const mfrCodeNote = `CRITICAL INSTRUCTIONS FOR CODE INTERPRETATION:
1. OBD-II codes are categorised by their FIRST LETTER — this determines the vehicle SYSTEM:
   - P = Powertrain (engine, transmission, fuel, emissions)
   - B = Body (BCM, airbags, comfort, lighting, windows, seats)
   - C = Chassis (ABS, traction control, stability control, steering, suspension, brakes, wheel speed sensors)
   - U = Network/Communication (CAN bus, module communication)
   NEVER confuse these categories. A C-code is ALWAYS a Chassis code, NEVER a Body code.
2. Extended manufacturer codes with hyphens (e.g. C2100-16, U0100-00) are valid — the suffix after the hyphen is a manufacturer-specific failure type sub-code. Interpret the full code including the suffix.
3. Manufacturer-specific code examples for Stellantis/Chrysler (FCA):
   - C2100-16 on Jeep/Chrysler = Battery Voltage Low (Chassis — ABS/ESP/electronic brake system module detecting low battery supply voltage). Failure type -16 = signal circuit low voltage.
   - C2100-04 = Battery Voltage High
   - P000B = B Camshaft Position Slow Response Bank 1 (VVT)
4. When the vehicle make is known, ALWAYS interpret codes using that manufacturer's DTC definitions.
5. NEVER respond with "unknown code", "not recognized", "code not found", or "not applicable". You MUST provide a complete, meaningful diagnosis for EVERY code entered.`

  let prompt: string

  if (isMulti) {
    prompt = `You are a master automotive technician with comprehensive knowledge of OBD-II diagnostics, all manufacturer-specific DTC databases, and vehicle repair across all makes and models.
A vehicle has multiple fault codes active simultaneously: ${codeList}${vehicleInfo ? ` on a ${vehicleInfo}${engineInfo ? ` (${engineInfo})` : ''}` : ''}.
${mfrContext ? '\n' + mfrContext : ''}
${vinContext ? vinContext + '\n' : ''}
${mfrCodeNote}
${langNote}
Analyse these codes TOGETHER as a combination. Identify the single most likely common root cause and repair that explains all or most codes firing together.
Return ONLY a valid JSON object with exactly these fields (no markdown, no code fences, just raw JSON):
{
  "name": "short combined diagnosis name",
  "system": "primary vehicle system affected",
  "code_type": "Generic (SAE), Manufacturer-specific (${mfrGroup || 'OEM'}), or Mixed",
  "severity": "high | medium | low",
  "severity_note": "one sentence on whether it is safe to drive with these codes active",
  "vehicle": "${vehicleInfo ?? ''}",
  "vehicle_note": "known TSBs or common issues for this code combination on this specific make/model/year",
  "common_repair": "the single most likely combined repair that addresses all or most of these codes together",
  "causes": ["root cause 1 explaining multiple codes", "root cause 2", "root cause 3"],
  "tests": ["diagnostic step 1", "diagnostic step 2", "diagnostic step 3"],
  "fixes": ["combined repair 1", "combined repair 2", "combined repair 3"],
  "repair_estimate": "rough cost range and labour time estimate for the combined repair"
}`
  } else {
    const code = codes[0]
    const codePrefix = code.charAt(0).toUpperCase()
    const secondChar = code.length >= 2 ? code[1] : '0'
    const isMfrSpecific = secondChar !== '0' || codePrefix !== 'P'
    const codeSystemDesc = getCodeSystem(code)
    const codeTypeHint = codeSystemDesc
      ? `This is a ${codePrefix}-code: ${codeSystemDesc}. You MUST diagnose it within that system — do not reassign it to a different system.${isMfrSpecific && mfrGroup ? ` It is manufacturer-specific for ${mfrGroup} — use the ${mfrGroup} DTC database.` : ''}`
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
  "name": "specific, accurate name for this code on this vehicle (e.g. 'Battery Voltage Low — ABS/ESP Module' for C2100-16 on Jeep/Chrysler)",
  "system": "exact vehicle system affected (e.g. Chassis — ABS/Electronic Brake System, Body — BCM, Powertrain — VVT)",
  "code_type": "Generic (SAE) or Manufacturer-specific (${mfrGroup || 'OEM'})",
  "severity": "high | medium | low",
  "severity_note": "one sentence on whether it is safe to drive",
  "vehicle": "${vehicleInfo ?? ''}",
  "vehicle_note": "specific known TSBs, common failures, or issues for this exact code on this make/model/year — be detailed",
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
