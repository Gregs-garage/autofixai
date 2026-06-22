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
    const id = payload.sub || payload.id || payload.user_id || null
    const email = payload.email || null
    if (!id) return null
    return { id, email }
  } catch {
    return null
  }
}

function getCodeSystem(code: string): string {
  const upper = code.toUpperCase()
  const prefix = upper.charAt(0)
  if (prefix === 'P') return 'Powertrain'
  if (prefix === 'B') return 'Body'
  if (prefix === 'U') return 'Network/Communication'
  if (prefix === 'C') {
    const num = parseInt(upper.substring(1, 5), 16)
    if (upper.startsWith('C0')) return 'Chassis - ABS/Traction Control'
    if (upper.startsWith('C1') || upper.startsWith('C2')) return 'Chassis - Manufacturer Specific'
    return 'Chassis'
  }
  return 'Unknown'
}

// Normalize make name to match dtcdecode.com URL format
function normalizeMake(make: string): string {
  const m = make.trim()
  const map: Record<string, string> = {
    'jeep': 'Jeep',
    'dodge': 'Dodge',
    'chrysler': 'Chrysler',
    'ram': 'RAM',
    'fiat': 'FIAT',
    'ford': 'Ford',
    'lincoln': 'Lincoln',
    'mercury': 'Mercury',
    'toyota': 'Toyota',
    'lexus': 'Lexus',
    'scion': 'Scion',
    'honda': 'Honda',
    'acura': 'Acura',
    'nissan': 'Nissan',
    'infiniti': 'Infiniti',
    'mazda': 'Mazda',
    'chevrolet': 'Chevrolet',
    'chevy': 'Chevrolet',
    'gmc': 'GMC',
    'buick': 'Buick',
    'cadillac': 'Cadillac',
    'pontiac': 'Pontiac',
    'oldsmobile': 'Oldsmobile',
    'saturn': 'Saturn',
    'hummer': 'HUMMER',
    'bmw': 'BMW',
    'mini': 'MINI',
    'mercedes': 'Mercedes-Benz',
    'mercedes-benz': 'Mercedes-Benz',
    'volkswagen': 'Volkswagen',
    'vw': 'Volkswagen',
    'audi': 'Audi',
    'volvo': 'Volvo',
    'subaru': 'Subaru',
    'mitsubishi': 'Mitsubishi',
    'hyundai': 'Hyundai',
    'kia': 'Kia',
    'isuzu': 'Isuzu',
    'jaguar': 'Jaguar',
    'land rover': 'Land Rover',
    'landrover': 'Land Rover',
    'saab': 'Saab',
    'suzuki': 'Suzuki',
    'geo': 'Geo',
    'daewoo': 'Daewoo',
    'eagle': 'Eagle',
    'plymouth': 'Plymouth',
    'alfa romeo': 'Alfa Romeo',
    'alfaromeo': 'Alfa Romeo',
  }
  return map[m.toLowerCase()] || m
}

// Look up a DTC code on dtcdecode.com for a specific make
async function lookupDTCDecode(make: string, code: string): Promise<{ found: boolean; definition?: string; description?: string; causes?: string[]; failureType?: string } | null> {
  try {
    const normalizedMake = normalizeMake(make)
    // Format code: strip spaces, uppercase
    const formattedCode = code.trim().toUpperCase().replace(/\s+/g, '')
    const url = `https://www.dtcdecode.com/${encodeURIComponent(normalizedMake)}/${encodeURIComponent(formattedCode)}`

    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AutoFixAI/1.0)',
        'Accept': 'text/html',
      },
      signal: AbortSignal.timeout(8000),
    })

    if (!resp.ok) return { found: false }

    const html = await resp.text()

    // Check for error page
    if (html.includes('The page you requested cannot be found') || html.includes('You Got an Error')) {
      return { found: false }
    }

    // Parse definition
    const defMatch = html.match(/Definition:\s*<\/[^>]+>\s*<[^>]+>([^<]+)</)
    const definition = defMatch ? defMatch[1].trim() : null

    if (!definition) return { found: false }

    // Parse description
    const descMatch = html.match(/Description:\s*<\/[^>]+>\s*<[^>]+>([^<]+)</)
    const description = descMatch ? descMatch[1].trim() : undefined

    // Parse causes
    const causesMatch = html.match(/Cause:\s*<\/[^>]+>([\s\S]*?)(?:Failure Type:|<\/section>|$)/)
    const causes: string[] = []
    if (causesMatch) {
      const causeHtml = causesMatch[1]
      const liMatches = causeHtml.match(/<li[^>]*>([^<]+)<\/li>/g) || []
      liMatches.forEach(li => {
        const text = li.replace(/<[^>]+>/g, '').trim()
        if (text) causes.push(text)
      })
    }

    // Parse failure type
    const ftMatch = html.match(/Failure Type:\s*<\/[^>]+>\s*<[^>]+>([^<]+)</)
    const failureType = ftMatch ? ftMatch[1].trim() : undefined

    return { found: true, definition, description, causes, failureType }
  } catch {
    return null
  }
}

function safeArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

export default async function handler(req: Request, context: Context) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    })
  }

  const user = getUserFromRequest(req)
  if (!user) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
  }

  const sub = await getByUserId(user.id)
  if (!isActive(sub)) {
    return new Response(JSON.stringify({ error: 'Subscription required' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
  }

  let body: { codes?: string[]; vin?: string; make?: string; model?: string; year?: string | number; engine?: string }
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
  }

  const codes: string[] = safeArr(body.codes).map((c: string) => c.trim().toUpperCase()).filter(Boolean)
  if (!codes.length) {
    return new Response(JSON.stringify({ error: 'No codes provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
  }

  const make = typeof body.make === 'string' ? body.make.trim() : ''
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  const year = body.year ? String(body.year).trim() : ''
  const engine = typeof body.engine === 'string' ? body.engine.trim() : ''
  const vehicleDesc = [year, make, model, engine].filter(Boolean).join(' ')

  const apiKey = Netlify.env.get('OPENAI_API_KEY')
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Server configuration error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    })
  }

  // ── Step 1: Look up each code on DTCDecode for verified real-world definitions ──
  const verifiedLookups: Array<{ code: string; verified: boolean; definition?: string; description?: string; causes?: string[]; failureType?: string }> = []

  for (const code of codes) {
    if (make) {
      const result = await lookupDTCDecode(make, code)
      if (result && result.found && result.definition) {
        verifiedLookups.push({ code, verified: true, ...result })
      } else {
        verifiedLookups.push({ code, verified: false })
      }
    } else {
      verifiedLookups.push({ code, verified: false })
    }
  }

  // ── Step 2: Build enriched context for GPT ──
  const verifiedContext = verifiedLookups
    .filter(v => v.verified)
    .map(v => {
      let ctx = `Code ${v.code}: VERIFIED DEFINITION = "${v.definition}"`
      if (v.description) ctx += `. Description: ${v.description}`
      if (v.causes && v.causes.length > 0) ctx += `. Known causes: ${v.causes.join('; ')}`
      if (v.failureType) ctx += `. Failure type: ${v.failureType}`
      return ctx
    })
    .join('\n')

  const unverifiedCodes = verifiedLookups.filter(v => !v.verified).map(v => v.code)

  // ── Step 3: Build GPT prompt ──
  const systemPrompt = `You are an expert automotive diagnostic technician with 30+ years of experience across all makes and models.

CRITICAL RULES:
1. If a VERIFIED DEFINITION is provided for a code, you MUST use exactly that definition. Do not alter, guess, or replace it.
2. Manufacturer-specific codes (e.g. C155E-92, C212A-16, B1C29) mean DIFFERENT things on different makes. Always use the make-specific meaning.
3. When multiple codes are entered, treat them as CLUES that together point to a single root cause. Cross-reference them to find the ONE most likely root cause.
4. Base your diagnosis on real-world mechanic knowledge, not generic guesses.
5. For C-codes on FCA/Jeep/Dodge/Chrysler/Ram: C0xxx = ABS/Chassis; C1xxx/C2xxx = manufacturer-specific (charging, air suspension, damping, body, network). Never call C1xxx/C2xxx FCA codes ABS codes.

${verifiedContext ? `VERIFIED CODE DEFINITIONS (from manufacturer database - use these exactly):\n${verifiedContext}` : ''}
${unverifiedCodes.length > 0 ? `Codes without verified definitions (use your best manufacturer-specific knowledge for ${make || 'this vehicle'}): ${unverifiedCodes.join(', ')}` : ''}

Vehicle: ${vehicleDesc || 'Unknown vehicle'}
Codes to diagnose: ${codes.join(', ')}

Respond with valid JSON only. No markdown, no explanation outside JSON. Use this exact structure:
{
  "name": "short combined fault name (e.g. Air Ride High Pressure Vent Control - Performance Fault)",
  "system": "affected vehicle system",
  "severity": "Low|Medium|High",
  "driveAdvice": "Is it safe to drive?",
  "rootCause": "The single most likely root cause combining all codes",
  "vehicleSpecificNote": "Any known issues specific to this make/model/year/engine",
  "causes": ["cause 1", "cause 2", "cause 3"],
  "tests": ["test 1", "test 2", "test 3"],
  "fixes": ["fix 1", "fix 2", "fix 3"],
  "estimatedCost": "cost range and labor hours",
  "combinedRepair": "The most likely single repair that addresses all codes"
}`

  const userMessage = codes.length === 1
    ? `Diagnose code ${codes[0]} on a ${vehicleDesc}.`
    : `Diagnose these codes together on a ${vehicleDesc}: ${codes.join(', ')}. Find the single root cause that explains all of them.`

  // ── Step 4: Call OpenAI ──
  let aiResult: Record<string, unknown> = {}
  try {
    const aiResp = await fetch(OPENAI_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.2,
        max_tokens: 1000,
      }),
    })

    const aiJson = await aiResp.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message: string } }

    if (aiJson.error) throw new Error(aiJson.error.message)

    const content = aiJson.choices?.[0]?.message?.content?.trim() || '{}'
    const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
    aiResult = JSON.parse(cleaned)
  } catch (err) {
    console.error('AI error:', err)
    aiResult = {
      name: verifiedLookups[0]?.definition || codes.join(', '),
      system: getCodeSystem(codes[0]),
      severity: 'Medium',
      driveAdvice: 'Have vehicle inspected before driving.',
      rootCause: 'Unable to determine - AI analysis failed. Please consult a certified technician.',
      vehicleSpecificNote: '',
      causes: verifiedLookups.map(v => v.definition || v.code),
      tests: ['Perform manufacturer-specific scan with factory tool'],
      fixes: ['Consult a certified dealer technician'],
      estimatedCost: 'Unknown',
      combinedRepair: 'Dealer diagnosis recommended',
    }
  }

  // ── Step 5: Override AI name/definition with verified data if available ──
  const primaryVerified = verifiedLookups.find(v => v.verified)
  if (primaryVerified && primaryVerified.definition) {
    if (codes.length === 1) {
      aiResult.name = primaryVerified.definition
    }
    // Always tag as verified
    aiResult.verifiedDefinitions = verifiedLookups
      .filter(v => v.verified)
      .map(v => ({ code: v.code, definition: v.definition, source: 'dtcdecode.com' }))
  }

  aiResult.codes = codes
  aiResult.vehicle = vehicleDesc
  aiResult.codesCount = codes.length

  return new Response(JSON.stringify(aiResult), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

export const config: Config = {
  path: '/api/diagnose',
}
