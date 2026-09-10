const $ = (id) => document.getElementById(id)
const state = { health: null, config: null, session: null, permission: null, lastResult: null, presets: [] }
const statusClass = (value) => {
  const normalized = String(value || 'unknown').toUpperCase()
  if (normalized.includes('PASS') || normalized.includes('READY') && !normalized.includes('NOT READY') || normalized === 'GRANTED' || normalized === 'RECEIVED' || normalized === 'CONFIGURED') return 'pass'
  if (normalized.includes('FAIL') || normalized.includes('ERROR') || normalized.includes('NOT READY') || normalized === 'FAILED' || normalized === 'ACTION REQUIRED') return 'fail'
  return normalized === 'REQUESTED' || normalized === 'WARN' ? 'warn' : 'unknown'
}

function setBadge(id, text) { const el = $(id); el.textContent = text; el.className = `badge ${statusClass(text)}` }
function toast(message) { const el = $('toast'); el.textContent = message; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 1800) }
function log(message) { const item = document.createElement('li'); item.innerHTML = `<time>${new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time>${escapeHtml(message)}`; $('log-list').prepend(item) }
function escapeHtml(value) { const node = document.createElement('span'); node.textContent = String(value); return node.innerHTML }
function randomState() { const bytes = crypto.getRandomValues(new Uint8Array(18)); return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('') }
function rows(containerId) { return [...$(containerId).querySelectorAll('.kv-row')].map(row => ({ key: row.querySelector('[data-key]').value.trim(), value: row.querySelector('[data-value]').value })).filter(x => x.key) }
function addRow(containerId, key = '', value = '') { const row = document.createElement('div'); row.className = 'kv-row'; row.innerHTML = `<input data-key placeholder="Key" aria-label="Key"><input data-value placeholder="Value" aria-label="Value"><button type="button" aria-label="Remove row">×</button>`; row.querySelector('[data-key]').value = key; row.querySelector('[data-value]').value = value; row.querySelector('button').onclick = () => row.remove(); $(containerId).append(row) }
async function api(url, options = {}) { const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } }); const data = await response.json().catch(() => ({ ok:false, error:{ message:'Invalid JSON response.' } })); if (!response.ok && response.status !== 207) throw Object.assign(new Error(data.error?.message || 'Request failed'), { data, status: response.status }); return data }
function updateResponse(result) { state.lastResult = result; const response = result.response || result; $('http-status').textContent = response.status || result.error?.status || '—'; $('duration').textContent = response.durationMs != null ? `${response.durationMs} ms` : '—'; $('response-json').textContent = JSON.stringify(response.body ?? result, null, 2); $('response-raw').textContent = response.raw ?? JSON.stringify(response.body ?? result); $('response-headers').textContent = JSON.stringify(response.headers || {}, null, 2) }
function diagnostics(info) { const d = info || {}; const values = [d.category, d.httpStatus, d.metaCode, d.metaMessage, d.likelyCause, d.recommendedAction].map(v => v ?? '—'); [...$('diagnostic-list').querySelectorAll('dd')].forEach((el, i) => { el.textContent = values[i] }); setBadge('diagnostic-badge', info ? 'FAIL' : 'NO ERROR') }
function renderScopes(items) { $('scope-list').innerHTML = ''; (items.length ? items : [{ scope:'threads_basic', status:'REQUESTED', evidence:'Requested scope has not been tested.' }]).forEach(item => { const row = document.createElement('div'); row.className = 'scope-row'; row.innerHTML = `<div><code>${escapeHtml(item.scope)}</code><small>${escapeHtml(item.evidence || 'Requested in OAuth configuration.')}</small></div><span class="badge ${statusClass(item.status)}">${escapeHtml(item.status)}</span>`; $('scope-list').append(row) }) }

function showReadinessDiagnostics(serverHealth, backendConfig, oauthBackend) {
  setBadge('server-health-result', serverHealth)
  setBadge('backend-config-result', backendConfig)
  setBadge('oauth-backend-result', oauthBackend)
}

async function loadHealth() {
  try {
    state.health = await api('/api/health')
    if (state.health.ok !== true || state.health.service !== 'threads-api-test-explorer') throw new Error('Unexpected health response.')
    setBadge('server-status', 'SERVER READY')
    setBadge('server-health-result', 'PASS')
    log('Server health check passed: HTTP 200.')
  } catch (error) {
    const detail = error.status ? `HTTP ${error.status}: ${error.message}` : `NETWORK_ERROR: ${error.message}`
    setBadge('server-status', 'SERVER ERROR')
    setBadge('server-health-result', 'FAIL')
    diagnostics({ category:'SERVER_HEALTH_FAILED', httpStatus:error.status || 'NETWORK_ERROR', metaCode:'—', metaMessage:detail, likelyCause:'The deployed backend health endpoint is unreachable or returned an invalid response.', recommendedAction:'Verify /api/health on the deployed Cloudflare Pages URL.' })
    log(`Server health check failed: ${detail}`)
  }
}

async function loadConfig() {
  try {
    state.config = await api('/api/config/status')
    const missing = [
      ['THREADS_APP_ID', state.config.appIdConfigured],
      ['THREADS_APP_SECRET', state.config.appSecretConfigured],
      ['THREADS_REDIRECT_URI', state.config.redirectUriConfigured],
    ].filter(([, configured]) => !configured).map(([name]) => name)
    setBadge('secret-status', state.config.appSecretConfigured ? 'CONFIGURED' : 'ACTION REQUIRED')
    showReadinessDiagnostics(state.health?.ok ? 'PASS' : 'FAIL', missing.length ? 'FAIL' : 'PASS', state.config.oauthReady ? 'READY' : 'NOT READY')
    if (missing.length) log(`MISSING_ENVIRONMENT_VARIABLE: ${missing.join(', ')}`)
    validateConfig()
  } catch (error) {
    setBadge('secret-status', 'ACTION REQUIRED')
    setBadge('backend-config-result', 'FAIL')
    setBadge('oauth-backend-result', 'NOT READY')
    const detail = error.status ? `HTTP ${error.status}: ${error.message}` : `NETWORK_ERROR: ${error.message}`
    log(`Configuration status failed: ${detail}`)
  }
}
function validateConfig() { const ok = /^\d+$/.test($('app-id').value.trim()) && /^https?:\/\//.test($('redirect-uri').value.trim()) && $('scope').value.trim() && state.config?.oauthReady; setBadge('config-badge', ok ? 'PASS' : 'FAIL'); return Boolean(ok) }

async function loadSession() {
  try { state.session = await api('/api/session'); if (state.session.authenticated) { setBadge('auth-badge','PASS'); setBadge('token-badge','PASS'); $('authorization-result').textContent='PASS'; $('code-result').textContent='RECEIVED'; $('masked-token').textContent=state.session.maskedToken; renderScopes(state.session.requestedScopes.map(scope => ({scope,status:'REQUESTED'}))); log('Active ephemeral OAuth session detected.') } else { setBadge('auth-badge','UNKNOWN'); setBadge('token-badge','UNKNOWN'); $('masked-token').textContent='Not available' } }
  catch (error) { log(`Session check failed: ${error.message}`) }
}

async function loadPresets() {
  try { const data = await api('/api/presets'); state.presets = data.presets; data.presets.forEach(p => { const option=document.createElement('option'); option.value=p.id; option.textContent=p.label; $('preset').append(option) }) }
  catch (error) { log(`Preset load failed: ${error.message}`) }
}

$('start-oauth').onclick = async () => {
  if (!validateConfig()) return toast('Complete valid configuration first.')
  try { const data = await api('/api/oauth/prepare', { method:'POST', body:JSON.stringify({ appId:$('app-id').value.trim(), redirectUri:$('redirect-uri').value.trim(), scope:$('scope').value.trim() }) }); $('oauth-url').value=data.authorizationUrl; $('state').value=data.state; $('open-oauth').disabled=false; setBadge('auth-badge','REQUESTED'); log('OAuth URL generated with state protection.'); updateResponse(data) }
  catch (error) { setBadge('auth-badge','FAIL'); diagnostics(error.data?.error); updateResponse(error.data || {error:error.message}); log(`OAuth preparation failed: ${error.message}`) }
}
$('open-oauth').onclick = () => { const url=$('oauth-url').value; if (url) window.location.assign(url) }
$('refresh-session').onclick = loadSession
$('clear-session').onclick = async () => { await api('/api/session/clear',{method:'POST',body:'{}'}); state.session=null; state.permission=null; setBadge('auth-badge','UNKNOWN'); setBadge('token-badge','UNKNOWN'); setBadge('permission-badge','UNKNOWN'); $('authorization-result').textContent='NOT RUN'; $('code-result').textContent='NOT RECEIVED'; $('masked-token').textContent='Not available'; renderScopes([]); log('Ephemeral OAuth token cleared.'); toast('Token cleared') }

$('probe-permissions').onclick = async () => {
  try { const data=await api('/api/permissions/probe',{method:'POST',body:'{}'}); state.permission=data; renderScopes(data.statuses); const pass=data.statuses.some(s=>s.status==='GRANTED'); setBadge('permission-badge',pass?'PASS':'UNKNOWN'); updateResponse(data); diagnostics(data.diagnostics); log(`Permission probe completed with HTTP ${data.probe?.status || 'unknown'}.`) }
  catch(error){ const data=error.data||{}; state.permission=data; renderScopes(data.statuses||[]); setBadge('permission-badge','FAIL'); diagnostics(data.diagnostics||data.error); updateResponse(data); log(`Permission probe failed: ${error.message}`) }
}

$('preset').onchange = () => { const p=state.presets.find(x=>x.id===$('preset').value); if(!p){$('preset-meta').textContent='Manual mode. Only current official graph.threads.com endpoints are accepted.';return} $('method').value=p.method; $('endpoint').value=p.endpoint; $('params-list').innerHTML=''; p.requiredParameters.forEach(x=>addRow('params-list',x.key,x.value)); $('preset-meta').innerHTML=`<strong>${escapeHtml(p.requiredPermission)}</strong> required · ${escapeHtml(p.expectedResponse)}<br>${escapeHtml(p.verification)}`; methodChanged() }
function methodChanged(){ $('body-wrap').classList.toggle('hidden',$('method').value==='GET') }
$('method').onchange=methodChanged
$('add-param').onclick=()=>addRow('params-list')
$('add-header').onclick=()=>addRow('headers-list')
function requestUrl(){ try { const url=new URL($('endpoint').value); rows('params-list').forEach(x=>url.searchParams.set(x.key,x.value)); return url.toString() } catch { return $('endpoint').value } }
$('copy-request').onclick=()=>copyText(requestUrl())

$('send-request').onclick = async () => {
  setBadge('request-badge','REQUESTED'); diagnostics(null); log(`${$('method').value} request started.`)
  let requestBody=null; if($('method').value!=='GET'&&$('request-body').value.trim()){ try{requestBody=JSON.parse($('request-body').value)}catch{return toast('Request body must be valid JSON.')} }
  try { const data=await api('/api/proxy',{method:'POST',body:JSON.stringify({method:$('method').value,url:$('endpoint').value,parameters:rows('params-list'),headers:rows('headers-list'),requestBody})}); state.lastResult=data; setBadge('request-badge',data.validation); updateResponse(data); diagnostics(data.diagnostics); log(`Request completed: HTTP ${data.response.status} ${data.validation}.`) }
  catch(error){ const data=error.data||{error:{message:error.message,status:error.status}}; state.lastResult=data; setBadge('request-badge','FAIL'); diagnostics(data.diagnostics||data.error); updateResponse(data); log(`Request failed: ${error.message}`) }
}

const checks=['CONFIGURATION','OAUTH','AUTH CODE','ACCESS TOKEN','PERMISSION','API REQUEST','API RESPONSE']
function renderChecklist(results={}){ $('checklist').innerHTML=''; checks.forEach(name=>{const value=results[name]||'UNKNOWN';const row=document.createElement('div');row.className='check-row';row.innerHTML=`<span>${name}</span><span class="badge ${statusClass(value)}">${value}</span>`;$('checklist').append(row)}) }
$('run-full-test').onclick=()=>{ const response=state.lastResult?.response; const results={CONFIGURATION:validateConfig()?'PASS':'FAIL',OAUTH:state.session?.authenticated?'PASS':'FAIL','AUTH CODE':state.session?.authorizationCode==='RECEIVED'?'PASS':'FAIL','ACCESS TOKEN':state.session?.authenticated?'PASS':'FAIL',PERMISSION:state.permission?.statuses?.some(s=>s.status==='GRANTED')?'PASS':'FAIL','API REQUEST':response?'PASS':'FAIL','API RESPONSE':response?.status>=200&&response?.status<300?'PASS':'FAIL'}; renderChecklist(results); const pass=Object.values(results).every(v=>v==='PASS'); setBadge('readiness-badge',pass?'PASS':'FAIL'); setBadge('api-test-status',pass?'API TEST PASSED':'API TEST FAILED'); log(`Full readiness test: ${pass?'PASS':'FAIL'}.`); document.querySelector('#full-test').scrollIntoView({behavior:'smooth'}) }

async function copyText(text){ try{await navigator.clipboard.writeText(text);toast('Copied to clipboard')}catch{toast('Copy unavailable')} }
document.querySelectorAll('[data-copy-target]').forEach(btn=>btn.onclick=()=>copyText($(btn.dataset.copyTarget).value))
$('copy-response').onclick=()=>copyText($('response-json').textContent)
$('clear-log').onclick=()=>{$('log-list').innerHTML=''}
document.querySelectorAll('.tab').forEach(tab=>tab.onclick=()=>{document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.response-view').forEach(x=>x.classList.remove('active'));tab.classList.add('active');$(`response-${tab.dataset.tab}`).classList.add('active')})
$('theme-toggle').onclick=()=>{const root=document.documentElement;root.dataset.theme=root.dataset.theme==='dark'?'light':'dark';localStorage.setItem('threads-theme',root.dataset.theme)}
;['app-id','redirect-uri','scope'].forEach(id=>$(id).addEventListener('input',validateConfig))

function inspectCallback(){const query=new URLSearchParams(location.search);const oauth=query.get('oauth');if(!oauth)return;if(oauth==='pass'){setBadge('auth-badge','PASS');setBadge('token-badge','PASS');$('authorization-result').textContent='PASS';$('code-result').textContent='RECEIVED';log('OAuth callback succeeded; authorization code was exchanged server-side.')}else{setBadge('auth-badge','FAIL');$('authorization-result').textContent='FAIL';$('code-result').textContent='NOT RECEIVED';const reason=query.get('reason')||'Authorization failed.';diagnostics({category:'AUTHORIZATION_FAILED',httpStatus:'—',metaCode:'—',metaMessage:reason,likelyCause:'Authorization or server-side token exchange was rejected.',recommendedAction:'Verify App ID, exact redirect URI, app secret, and OAuth configuration in Meta App Dashboard.'});log(`OAuth failed: ${reason}`)}history.replaceState({},'',location.pathname)}

async function init(){document.documentElement.dataset.theme=localStorage.getItem('threads-theme')||'dark';$('redirect-uri').value=`${location.origin}/oauth/callback`;$('state').value=randomState();addRow('params-list','fields','id,username,name,threads_profile_picture_url,threads_biography,is_verified');addRow('headers-list','Accept','application/json');renderChecklist();inspectCallback();await loadHealth();await Promise.all([loadConfig(),loadSession(),loadPresets()])}
init()
