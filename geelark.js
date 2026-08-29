// ---------------------------------------------------------------------------
// GeeLark Open API - recuperation des profils d'un groupe.
// Auth : 5 headers sur chaque requete -> appId, traceId, ts, nonce, sign
//        sign = SHA256(appId + traceId + ts + nonce + apiKey) en HEX MAJUSCULE
// ---------------------------------------------------------------------------

import crypto from 'node:crypto'

const BASE = (process.env.GEELARK_BASE_URL || 'https://openapi.geelark.com').replace(/\/+$/, '')
const APP_ID = (process.env.GEELARK_APP_ID || 'RTJBTN1C5Y05AAYU68G4XFDQSG').trim()

function nonce(len = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

function authHeaders(appId, apiKey) {
  const ts = String(Date.now())
  const traceId = crypto.randomUUID()
  const n = traceId.slice(0, 6)
  const sign = crypto.createHash('sha256')
    .update(appId + traceId + ts + n + apiKey)
    .digest('hex').toUpperCase()
  return { 'Content-Type': 'application/json', appId, traceId, ts, nonce: n, sign }
}

const API_KEY = (process.env.GEELARK_API_KEY || '').trim()

async function post(pathname, body = {}, timeoutMs = 15000) {
  if (!API_KEY) return { error: 'GEELARK_API_KEY absente' }
  const DEF = 'RTJBTN1C5Y05AAYU68G4XFDQSG'
  const paires = [[APP_ID, API_KEY], [DEF, API_KEY], [API_KEY, APP_ID], [DEF, APP_ID]]
    .filter((p, i, a) => p[0] && p[1] && a.findIndex(q => q[0] === p[0] && q[1] === p[1]) === i)
  console.log('[geelark] diag: appIdLen=' + APP_ID.length + ' apiKeyLen=' + API_KEY.length + ' candidats=' + paires.length)
  let dernier = null
  for (let i = 0; i < paires.length; i++) {
    const headers = authHeaders(paires[i][0], paires[i][1])
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
    if (!r.ok) { dernier = { error: 'http_' + r.status, status: r.status, body: text.slice(0, 300) }; continue }
    if (json && typeof json.code !== 'undefined' && Number(json.code) !== 0) {
      dernier = { error: 'api_code_' + json.code, msg: json.msg }
      if (Number(json.code) === 40003 && i < paires.length - 1) continue
      return dernier
    }
    return json
  }
  return dernier
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
  let total = null
  for (let i = 0; i < 30; i++) {
    const res = await post('/open/v1/phone/list', { page, pageSize })
    if (res && res.error) return { error: res.error, msg: res.msg, body: res.body }
    const data = (res && (res.data || res.result || res)) || {}
    const items = data.items || data.list || data.records || data.rows || []
    if (total == null && Number.isFinite(Number(data.total))) total = Number(data.total)
    all = all.concat(items.map(normalize))
    // On ne s'arrete PAS sur une page courte : GeeLark en renvoie parfois une
    // au milieu de la liste, et on croyait alors que les profils suivants
    // avaient ete supprimes. C'est le compteur "total" qui fait foi.
    if (!items.length) break
    if (total != null && all.length >= total) break
    if (total == null && items.length < pageSize) break
    page++
  }
  // complet = on a bien tout ce que GeeLark annonce. Sans cette garantie, on
  // ne doit JAMAIS conclure qu'un compte absent de la liste a ete supprime.
  const complet = total == null ? null : all.length >= total
  if (total != null && !complet) {
    console.warn('[geelark] liste incomplete : ' + all.length + '/' + total + ' profils')
  }
  return { items: all, total, complet }
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

  // Mouchard : affiche le groupe EXACT renvoye par GeeLark pour des comptes
  // surveilles (GEELARK_WATCH="jalinewayness,autre"). Prouve qu'un compte est
  // filtre selon son vrai groupe GeeLark, pas selon un tag.
  const watch = (process.env.GEELARK_WATCH || '').split(',').map(s => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean)
  if (watch.length) {
    for (const p of r.items) {
      const nom = String(p.name || '').toLowerCase().replace(/^@/, '')
      if (watch.includes(nom)) {
        console.log('[geelark] WATCH "' + p.name + '" -> groupe GeeLark="' + p.groupName + '" (normalise: "' + normGroupe(p.groupName) + '")')
      }
    }
  }

  // On accepte PLUSIEURS groupes separes par une virgule (ex.
  // "tkanuya account 3,tkanuya account 5") : un compte est retenu s'il
  // appartient a AU MOINS UN des groupes cibles. Un seul nom (sans virgule)
  // se comporte exactement comme avant.

  // MODE BRUT (GEELARK_GROUP_RAW=true) : comparaison sur le nom EXACT renvoye par
  // GeeLark (minuscules + trim), SANS enlever la coche/emoji. Indispensable quand
  // deux groupes ne different QUE par la coche, ex "tkanuya account 2" (89) vs
  // "✔️tkanuya account 2" (101) : le mode normalise les fusionnerait a tort.
  const raw = String(process.env.GEELARK_GROUP_RAW || 'false') === 'true'
  if (raw) {
    const ciblesRaw = String(groupe || '').split(',').map(s => s.toLowerCase().trim()).filter(Boolean)
    const items = r.items.filter(p => ciblesRaw.includes(String(p.groupName || '').toLowerCase().trim()))
    console.log('[geelark] mode BRUT : cibles exactes ' + JSON.stringify(ciblesRaw) + ' -> ' + items.length + ' comptes')
    return { items, totalCompte: r.items.length, groupes, tous: r.items, complet: r.complet }
  }

  const cibles = String(groupe || '').split(',').map(s => normGroupe(s)).filter(Boolean)
  if (!cibles.length) return { items: r.items, totalCompte: r.items.length, groupes, tous: r.items, complet: r.complet }

  const exact = String(process.env.GEELARK_GROUP_EXACT || 'true') !== 'false'
  const items = r.items.filter(p => {
    const n = normGroupe(p.groupName)
    return exact ? cibles.includes(n) : cibles.some(c => n.includes(c))
  })
  console.log('[geelark] cibles ' + JSON.stringify(cibles) + ' -> ' + items.length + ' comptes')
  return { items, totalCompte: r.items.length, groupes, tous: r.items, complet: r.complet }
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
