import { Hono, type Next } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { secureHeaders } from 'hono/secure-headers'
import { serveStatic } from 'hono/cloudflare-workers'
import indexHtml from '../public/index.html?raw'

type Bindings = {
  THREADS_APP_ID?: string
  THREADS_APP_SECRET?: string
  THREADS_REDIRECT_URI?: string
  OAUTH_SESSION_KEY?: string
}

type OAuthDraft = {
  appId: string
  redirectUri: string
  scope: string
  state: string
  createdAt: number
}

type SessionData = {
  accessToken: string
  userId?: string
  requestedScope: string
  createdAt: number
}

type RateBucket = {
  count: number
  windowStartedAt: number
}

const app = new Hono<{ Bindings: Bindings }>()
const AUTH_HOST = 'threads.com'
const GRAPH_HOST = 'graph.threads.net'
const API_VERSION = 'v1.0'
const COOKIE_DRAFT = 'threads_oauth_draft'
const COOKIE_SESSION = 'threads_test_session'
const COOKIE_RATE = 'threads_rate_bucket'
const MAX_BODY_BYTES = 1_000_000
const MAX_REQUEST_BYTES = 65_536
const RATE_LIMIT_PER_MINUTE = 30

app.use('*', secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    imgSrc: ["'self'", 'data:', 'https:'],
    connectSrc: ["'self'"],
    frameAncestors: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'", `https://${AUTH_HOST}`],
  },
  referrerPolicy: 'no-referrer',
}))
app.use('/static/*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'public, max-age=3600, must-revalidate')
})
app.use('/api/*', async (c, next) => {
  if (c.req.method !== 'POST') {
    await next()
    return
  }
  const contentLength = Number(c.req.header('content-length') || '0')
  if (contentLength > MAX_REQUEST_BYTES) return jsonError(c, 413, 'INVALID_PARAMETER', 'Request body exceeds the 64 KB safety limit.', 'Send a smaller request payload.')
  return rateLimit(c, next)
})
app.use('/static/*', serveStatic({ root: './public' }))

function jsonError(c: any, status: number, category: string, message: string, action: string) {
  return c.json({ ok: false, error: { category, status, message, likelyCause: message, recommendedAction: action } }, status)
}

function normalizeScope(value: unknown) {
  const scope = String(value || 'threads_basic')
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
  return [...new Set(scope)].join(',')
}

function maskToken(token: string) {
  if (token.length < 10) return `${token.slice(0, 2)}${'*'.repeat(Math.max(4, token.length - 4))}${token.slice(-2)}`
  return `${token.slice(0, 2)}${'*'.repeat(Math.min(18, token.length - 6))}${token.slice(-4)}`
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  bytes.forEach((byte) => { binary += String.fromCharCode(byte) })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64ToBytes(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function cryptoKey(secret: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

async function seal(value: object, secret: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plaintext = new TextEncoder().encode(JSON.stringify(value))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptoKey(secret), plaintext)
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipher))}`
}

async function unseal<T>(value: string | undefined, secret: string): Promise<T | null> {
  if (!value) return null
  try {
    const [ivPart, cipherPart] = value.split('.')
    if (!ivPart || !cipherPart) return null
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(ivPart) },
      await cryptoKey(secret),
      base64ToBytes(cipherPart),
    )
    return JSON.parse(new TextDecoder().decode(plain)) as T
  } catch {
    return null
  }
}

function sessionSecret(env: Bindings) {
  return env.OAUTH_SESSION_KEY || env.THREADS_APP_SECRET || ''
}

function cookieOptions(maxAge = 3600) {
  return { httpOnly: true, secure: true, sameSite: 'Lax' as const, path: '/', maxAge }
}

async function readSession(c: any) {
  const key = sessionSecret(c.env)
  if (!key) return null
  return unseal<SessionData>(getCookie(c, COOKIE_SESSION), key)
}

async function rateLimit(c: any, next: Next) {
  const key = sessionSecret(c.env)
  if (!key) {
    await next()
    return
  }
  const now = Date.now()
  const previous = await unseal<RateBucket>(getCookie(c, COOKIE_RATE), key)
  const bucket = !previous || now - previous.windowStartedAt >= 60_000
    ? { count: 1, windowStartedAt: now }
    : { count: previous.count + 1, windowStartedAt: previous.windowStartedAt }
  if (bucket.count > RATE_LIMIT_PER_MINUTE) {
    c.header('Retry-After', String(Math.max(1, Math.ceil((60_000 - (now - bucket.windowStartedAt)) / 1000))))
    return jsonError(c, 429, 'RATE_LIMITED', 'Too many API actions in this browser session.', 'Wait for the one-minute window to reset, then retry.')
  }
  setCookie(c, COOKIE_RATE, await seal(bucket, key), cookieOptions(60))
  await next()
}

function diagnose(status: number, payload: any) {
  const meta = payload?.error || payload
  const code = meta?.code ?? meta?.error_code ?? null
  const message = meta?.message ?? meta?.error_message ?? 'Cause could not be determined from API response.'
  let category = 'UNKNOWN_ERROR'
  let likelyCause = 'Cause could not be determined from API response.'
  let recommendedAction = 'Inspect the official Meta response and Threads API documentation.'

  if (status === 401 || code === 190) {
    category = 'INVALID_TOKEN'
    likelyCause = 'The API rejected the access token.'
    recommendedAction = 'Run OAuth again and retry with a newly issued token.'
  } else if (status === 403 || code === 10 || code === 200) {
    category = 'MISSING_PERMISSION'
    likelyCause = 'The token may not have the permission required by this endpoint, or the app lacks access.'
    recommendedAction = 'Check requested permissions, app access level, and App Review requirements in Meta App Dashboard.'
  } else if (status === 404) {
    category = 'ENDPOINT_NOT_AVAILABLE'
    likelyCause = 'The requested endpoint or object was not available.'
    recommendedAction = 'Verify the endpoint and API version against current Meta Threads API documentation.'
  } else if (status === 400) {
    category = 'INVALID_PARAMETER'
    likelyCause = 'Meta rejected one or more request parameters.'
    recommendedAction = 'Compare the endpoint, fields, and parameters with the current official documentation.'
  } else if (status >= 500) {
    category = 'UNKNOWN_ERROR'
    likelyCause = 'The upstream Threads API returned a server error.'
    recommendedAction = 'Retry later and check Meta platform status.'
  }

  return { category, httpStatus: status, metaCode: code, metaMessage: message, likelyCause, recommendedAction }
}

app.get('/api/health', (c) => c.json({
  ok: true,
  service: 'threads-api-test-explorer',
  environment: 'production',
}))

app.get('/api/config/status', (c) => {
  const appIdConfigured = Boolean(c.env.THREADS_APP_ID?.trim())
  const appSecretConfigured = Boolean(c.env.THREADS_APP_SECRET?.trim())
  const redirectUriConfigured = Boolean(c.env.THREADS_REDIRECT_URI?.trim())

  return c.json({
    appIdConfigured,
    appSecretConfigured,
    redirectUriConfigured,
    oauthReady: appIdConfigured && appSecretConfigured && redirectUriConfigured,
  })
})

app.post('/api/oauth/prepare', async (c) => {
  const key = sessionSecret(c.env)
  if (!c.env.THREADS_APP_SECRET || !key) {
    return jsonError(c, 503, 'APP_CONFIGURATION', 'Server-side Threads App Secret is not configured.', 'Set THREADS_APP_SECRET as a Cloudflare Pages secret, then retry.')
  }
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>
  const appId = String(body.appId || '').trim()
  const redirectUri = String(body.redirectUri || '').trim()
  const scope = normalizeScope(body.scope)
  if (!/^\d{5,30}$/.test(appId)) return jsonError(c, 400, 'APP_CONFIGURATION', 'Threads App ID must be numeric.', 'Enter the Threads App ID shown in Meta App Dashboard.')
  let parsedRedirect: URL
  try { parsedRedirect = new URL(redirectUri) } catch { return jsonError(c, 400, 'INVALID_REDIRECT_URI', 'Redirect URI is not a valid absolute URL.', 'Use the exact HTTPS callback URI configured in Meta App Dashboard.') }
  if (parsedRedirect.protocol !== 'https:' && parsedRedirect.hostname !== 'localhost') return jsonError(c, 400, 'INVALID_REDIRECT_URI', 'Redirect URI must use HTTPS.', 'Use the exact HTTPS callback URI configured in Meta App Dashboard.')

  const state = bytesToBase64(crypto.getRandomValues(new Uint8Array(24)))
  const draft: OAuthDraft = { appId, redirectUri, scope, state, createdAt: Date.now() }
  setCookie(c, COOKIE_DRAFT, await seal(draft, key), cookieOptions(600))
  const url = new URL(`https://${AUTH_HOST}/oauth/authorize`)
  url.searchParams.set('client_id', appId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', scope)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('state', state)
  return c.json({ ok: true, authorizationUrl: url.toString(), state, responseType: 'code' })
})

app.get('/oauth/callback', async (c) => {
  const key = sessionSecret(c.env)
  const error = c.req.query('error')
  const errorDescription = c.req.query('error_description') || c.req.query('error_reason') || ''
  const code = (c.req.query('code') || '').replace(/#_$/, '')
  const returnedState = c.req.query('state') || ''
  if (!key) return c.redirect('/?oauth=fail&reason=server_configuration')
  const draft = await unseal<OAuthDraft>(getCookie(c, COOKIE_DRAFT), key)
  deleteCookie(c, COOKIE_DRAFT, { path: '/' })
  if (error) return c.redirect(`/?oauth=fail&reason=${encodeURIComponent(errorDescription || error)}`)
  if (!draft || !code || returnedState !== draft.state || Date.now() - draft.createdAt > 600_000) {
    return c.redirect('/?oauth=fail&reason=state_or_code_validation_failed')
  }

  const form = new FormData()
  form.set('client_id', draft.appId)
  form.set('client_secret', c.env.THREADS_APP_SECRET || '')
  form.set('grant_type', 'authorization_code')
  form.set('redirect_uri', draft.redirectUri)
  form.set('code', code)
  try {
    const response = await fetch(`https://${GRAPH_HOST}/oauth/access_token`, { method: 'POST', body: form })
    const payload = await response.json().catch(() => ({})) as Record<string, any>
    if (!response.ok || !payload.access_token) {
      const message = payload.error_message || payload.error?.message || 'token_exchange_failed'
      return c.redirect(`/?oauth=fail&reason=${encodeURIComponent(message)}`)
    }
    const session: SessionData = {
      accessToken: String(payload.access_token),
      userId: payload.user_id ? String(payload.user_id) : undefined,
      requestedScope: draft.scope,
      createdAt: Date.now(),
    }
    setCookie(c, COOKIE_SESSION, await seal(session, key), cookieOptions(3600))
    return c.redirect('/?oauth=pass&code=received&token=received')
  } catch {
    return c.redirect('/?oauth=fail&reason=token_exchange_network_error')
  }
})

app.get('/api/session', async (c) => {
  const session = await readSession(c)
  if (!session) return c.json({ ok: true, authenticated: false, authorization: 'UNKNOWN', token: null, requestedScopes: [] })
  return c.json({
    ok: true,
    authenticated: true,
    authorization: 'PASS',
    authorizationCode: 'RECEIVED',
    tokenStatus: 'TOKEN RECEIVED',
    maskedToken: maskToken(session.accessToken),
    userId: session.userId || null,
    requestedScopes: session.requestedScope.split(',').filter(Boolean),
    tokenStoredPermanently: false,
  })
})

app.post('/api/session/clear', (c) => {
  deleteCookie(c, COOKIE_SESSION, { path: '/' })
  return c.json({ ok: true })
})

app.post('/api/permissions/probe', async (c) => {
  const session = await readSession(c)
  if (!session) return jsonError(c, 401, 'INVALID_TOKEN', 'No active OAuth test token is available.', 'Complete OAuth before testing permissions.')
  const requested = session.requestedScope.split(',').filter(Boolean)
  const statuses = requested.map((scope) => ({ scope, status: 'UNKNOWN', evidence: 'No endpoint probe has verified this permission.' }))
  try {
    const url = `https://${GRAPH_HOST}/${API_VERSION}/me?fields=id,username`
    const response = await fetch(url, { headers: { Authorization: `Bearer ${session.accessToken}` } })
    const payload = await response.json().catch(() => ({}))
    if (response.ok) {
      const basic = statuses.find((item) => item.scope === 'threads_basic')
      if (basic) {
        basic.status = 'GRANTED'
        basic.evidence = 'Verified by a successful official GET /v1.0/me profile request, which requires threads_basic.'
      }
      return c.json({ ok: true, statuses, probe: { method: 'GET', endpoint: `/${API_VERSION}/me`, status: response.status }, profile: payload })
    }
    statuses.forEach((item) => { item.status = 'FAILED'; item.evidence = 'The permission probe request was rejected.' })
    return c.json({ ok: false, statuses, probe: { status: response.status }, diagnostics: diagnose(response.status, payload) }, response.status as any)
  } catch {
    return jsonError(c, 502, 'UNKNOWN_ERROR', 'Could not reach the Threads API permission probe.', 'Retry and verify network availability.')
  }
})

app.post('/api/proxy', async (c) => {
  const session = await readSession(c)
  if (!session) return jsonError(c, 401, 'INVALID_TOKEN', 'No active OAuth test token is available.', 'Complete OAuth before sending a request.')
  const body = await c.req.json().catch(() => ({})) as Record<string, any>
  const method = String(body.method || 'GET').toUpperCase()
  if (!['GET', 'POST', 'DELETE'].includes(method)) return jsonError(c, 400, 'INVALID_PARAMETER', 'Only GET, POST, and DELETE are allowed.', 'Select a supported HTTP method.')
  let url: URL
  try { url = new URL(String(body.url || '')) } catch { return jsonError(c, 400, 'INVALID_PARAMETER', 'Request URL is invalid.', `Use an HTTPS URL on ${GRAPH_HOST}.`) }
  if (url.protocol !== 'https:' || url.hostname !== GRAPH_HOST) return jsonError(c, 400, 'ENDPOINT_NOT_AVAILABLE', `Only https://${GRAPH_HOST} endpoints are allowed.`, 'Use a current official Threads API endpoint.')
  url.username = ''
  url.password = ''
  url.searchParams.delete('access_token')
  const parameters = Array.isArray(body.parameters) ? body.parameters : []
  for (const item of parameters.slice(0, 50)) {
    const key = String(item?.key || '').trim()
    if (key && key !== 'access_token') url.searchParams.set(key, String(item?.value ?? ''))
  }
  const requestHeaders = new Headers({ Accept: 'application/json', Authorization: `Bearer ${session.accessToken}` })
  const headers = Array.isArray(body.headers) ? body.headers : []
  for (const item of headers.slice(0, 30)) {
    const key = String(item?.key || '').trim()
    if (!key || ['authorization', 'cookie', 'host', 'content-length'].includes(key.toLowerCase())) continue
    requestHeaders.set(key, String(item?.value ?? ''))
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const init: RequestInit = { method, headers: requestHeaders, signal: controller.signal }
    if (method !== 'GET' && body.requestBody) {
      init.body = typeof body.requestBody === 'string' ? body.requestBody : JSON.stringify(body.requestBody)
      if (!requestHeaders.has('Content-Type')) requestHeaders.set('Content-Type', 'application/json')
    }
    const started = Date.now()
    const response = await fetch(url.toString(), init)
    const rawBuffer = await response.arrayBuffer()
    if (rawBuffer.byteLength > MAX_BODY_BYTES) return jsonError(c, 502, 'UNKNOWN_ERROR', 'Upstream response exceeded the 1 MB safety limit.', 'Request fewer fields or a smaller result set.')
    const raw = new TextDecoder().decode(rawBuffer)
    let parsed: unknown = raw
    try { parsed = JSON.parse(raw) } catch { /* raw response */ }
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      if (!['set-cookie', 'authorization'].includes(key.toLowerCase())) responseHeaders[key] = value
    })
    return c.json({
      ok: response.ok,
      request: { method, url: url.toString(), authorization: 'OAuth Token (server-side, masked)' },
      response: { status: response.status, statusText: response.statusText, headers: responseHeaders, body: parsed, raw, durationMs: Date.now() - started },
      validation: response.ok ? 'PASS' : 'FAIL',
      diagnostics: response.ok ? null : diagnose(response.status, parsed),
    }, response.ok ? 200 : 207)
  } catch (error: any) {
    const timedOut = error?.name === 'AbortError'
    return jsonError(c, 502, 'UNKNOWN_ERROR', timedOut ? 'Threads API request timed out.' : 'Threads API request could not be completed.', timedOut ? 'Retry with a simpler request.' : 'Verify the endpoint and network availability.')
  } finally {
    clearTimeout(timer)
  }
})

app.get('/api/presets', (c) => c.json({
  ok: true,
  verifiedAt: '2026-09-10',
  documentation: 'https://developers.facebook.com/docs/threads/threads-profiles',
  presets: [{
    id: 'my-profile',
    label: 'Get my Threads profile',
    method: 'GET',
    endpoint: `https://${GRAPH_HOST}/${API_VERSION}/me`,
    requiredPermission: 'threads_basic',
    requiredParameters: [{ key: 'fields', value: 'id,username,name,threads_profile_picture_url,threads_biography,is_verified' }],
    expectedResponse: 'JSON object containing the requested profile fields for the app-scoped user.',
    verification: 'Verified against current official Meta Threads Profiles documentation.',
  }],
}))

app.get('/', (c) => c.html(indexHtml))
app.get('/favicon.ico', (c) => c.body(null, 204))
app.all('/api/*', (c) => c.json({ ok: false, error: { category: 'ENDPOINT_NOT_AVAILABLE', status: 404, message: 'Route not found.', likelyCause: 'The requested local tester route does not exist.', recommendedAction: 'Use a documented API route or return to the explorer.' } }, 404))
app.all('*', (c) => c.json({ ok: false, error: { category: 'ENDPOINT_NOT_AVAILABLE', status: 404, message: 'Route not found.', likelyCause: 'The requested tester route does not exist.', recommendedAction: 'Return to the explorer root.' } }, 404))
app.onError((_error, c) => c.json({ ok: false, error: { category: 'UNKNOWN_ERROR', status: 500, message: 'Internal server error.', likelyCause: 'An unexpected server-side failure occurred.', recommendedAction: 'Retry and inspect server logs without exposing credentials.' } }, 500))

export default app
