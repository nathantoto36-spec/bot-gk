// ---------------------------------------------------------------------------
// GeeLark Open API - recuperation des profils d'un groupe.
// Auth : 5 headers sur chaque requete -> appId, traceId, ts, nonce, sign
//        sign = SHA256(appId + traceId + ts + nonce + apiKey) en HEX MAJUSCULE
// ---------------------------------------------------------------------------

import crypto from 'node:crypto'

const BASE = (process.env.GEELARK_BASE_URL || 'https://openapi.geelark.com').replace(/\/+$/, '')
const APP_ID = process.env.GEELARK_APP_ID || 'RTJBTN1C5Y05AAYU68G4XFDQSG'

function nonce(len = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

function authHeaders() {
  const apiKey = process.env.GEELARK_API_KEY
  if (!apiKey) return { _error: 'GEELARK_API_KEY absente' }
  const ts = String(Date.now())
  const n = nonce(6)
  const traceId = crypto.randomUUID()
  const sign = crypto.createHash('sha256')
    .update(APP_ID + traceId + ts + n + apiKey)
    .digest('hex').toUpperCase()
  return { 'Content-Type': 'application/json', appId: APP_ID, traceId, ts, nonce: n, sign }
}

async function post(pathname, body = {}, timeoutMs = 15000) {
  const headers = authHeaders()
  if (headers._error) return { error: headers._error }
  let r
  try {
    r = await fetch(BASE + pathname, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    return { error: 'fetch_failed', body: String((e && e.message) || e) }
  }
  const text = await r.text().catch(() => '')
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* pas du json */ }
  if (!r.ok) return { error: 'http_' + r.status, status: r.status, body: text.slice(0, 300) }
  if (json && typeof json.code !== 'undefined' && Number(json.code) !== 0) {
    return { error: 'api_code_' + json.code, msg: json.msg }
  }
  return json
}

function normalize(p = {}) {
  const name = p.serialName || p.name || p.profileName || p.envName || p.remark || ''
  const id = p.id || p.envId || p.profileId || p.equipmentId || ''
  const groupName = (p.group && (p.group.name || p.group.groupName)) || p.groupName || ''
  const groupId = String((p.group && p.group.id) || p.groupId || '')
  return { id: String(id), name: String(name).trim(), groupName: String(groupName), groupId }
}

// Pagine tous les profils du compte GeeLark (garde-fou 30 pages).
export async function listAllPhones({ pageSize = 100 } = {}) {
  let page = 1
  let all = []
  for (let i = 0; i < 30; i++) {
    const res = await post('/open/v1/phone/list', { page, pageSize })
    if (res && res.error) return { error: res.error, msg: res.msg, body: res.body }
    const data = (res && (res.data || res.result || res)) || {}
    const items = data.items || data.list || data.records || data.rows || []
    all = all.concat(items.map(normalize))
    if (items.length < pageSize) break
    page++
  }
  return { items: all }
}

// Normalise un nom de groupe : minuscules, emojis/coches/ponctuation retires.
// "✔️tkanuya account" -> "tkanuya account"   |   "tkanuya account 2" -> "tkanuya account 2"
function normGroupe(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// Retourne les profils du groupe demande.
// Par defaut la comparaison est EXACTE (apres normalisation) : "tkanuya account"
// ne ramene donc PAS "tkanuya account 2". Mettre GEELARK_GROUP_EXACT=false pour
// revenir a une comparaison "contient".
export async function listPhonesInGroup(groupe) {
  const r = await listAllPhones()
  if (r.error) return r

  // Inventaire des groupes trouves, utile pour les logs.
  const groupes = {}
  for (const p of r.items) {
    const n = p.groupName || '(sans groupe)'
    groupes[n] = (groupes[n] || 0) + 1
  }

  const cible = normGroupe(groupe)
  if (!cible) return { items: r.items, totalCompte: r.items.length, groupes }

  const exact = String(process.env.GEELARK_GROUP_EXACT || 'true') !== 'false'
  const items = r.items.filter(p => {
    const n = normGroupe(p.groupName)
    return exact ? n === cible : n.includes(cible)
  })
  return { items, totalCompte: r.items.length, groupes }
}

// Un nom de profil GeeLark est reputé être le pseudo Instagram.
// On ne garde que ceux qui ressemblent vraiment a un pseudo valide.
export function nomsValides(items) {
  const ok = []
  const rejetes = []
  for (const p of items) {
    const u = p.name.toLowerCase().replace(/^@/, '').trim()
    if (/^[a-z0-9._]{1,30}$/.test(u)) ok.push({ username: u, phoneId: p.id })
    else rejetes.push(p.name)
  }
  return { ok, rejetes }
}
