// Preview ("test") access for AutoFix Pro.
//
// Lets the site owner try every Pro feature without going through Stripe — handy
// while billing is still being configured. It is enabled only when the
// PRO_PREVIEW_PASSWORD environment variable is set; if that variable is absent,
// every function here behaves as if preview access does not exist.
//
// When the correct password is supplied, a signed cookie is issued. The cookie
// never contains the password itself — only an HMAC derived from it — so it can
// be verified on later requests without storing or exposing the secret.

const COOKIE_NAME = 'pro_preview'
const PAYLOAD = 'autofix-pro-preview-v1'
const MAX_AGE = 60 * 60 * 24 * 30 // 30 days

function getSecret(): string | null {
  const value = process.env.PRO_PREVIEW_PASSWORD
  return value && value.length > 0 ? value : null
}

// Whether the preview-access feature is switched on for this deploy.
export function previewConfigured(): boolean {
  return getSecret() !== null
}

// Deterministic token derived from the configured password.
async function token(secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(PAYLOAD))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

// Constant-time string comparison to avoid leaking timing information.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function verifyPassword(password: string): Promise<boolean> {
  const secret = getSecret()
  if (!secret) return false
  return safeEqual(password, secret)
}

// Set-Cookie value that grants preview access.
export async function grantCookie(): Promise<string> {
  const secret = getSecret()
  if (!secret) throw new Error('preview access not configured')
  const value = encodeURIComponent(await token(secret))
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`
}

// Set-Cookie value that clears preview access.
export function clearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
}

// True when the incoming request carries a valid preview cookie.
export async function hasPreviewAccess(req: Request): Promise<boolean> {
  const secret = getSecret()
  if (!secret) return false
  const cookie = req.headers.get('cookie') || ''
  const match = cookie.match(/(?:^|;\s*)pro_preview=([^;]+)/)
  if (!match) return false
  const provided = decodeURIComponent(match[1])
  const expected = await token(secret)
  return safeEqual(provided, expected)
}
