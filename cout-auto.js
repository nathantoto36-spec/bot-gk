// ---------------------------------------------------------------------------
// Minutes consommees par TON AUTOMATISATION, et elles seules.
//
// GeeLark facture des minutes de cloud phone sans dire d'ou elles viennent :
// un telephone ouvert a la main coute pareil qu'un post programme. Pour ne
// compter que l'automatisation, on rapproche chaque ligne de facturation de
// l'historique des taches : si une tache programmee a demarre sur le MEME
// telephone dans la demi-heure qui precede, la consommation lui est imputee.
// Sinon elle est classee "hors automatisation".
//
//   POST /open/v1/billing/transaction/detail -> envId, usedTime (MINUTES), createdTime
//   POST /open/v1/task/historyRecords        -> envId, serialName, scheduleAt, status
//
// GeeLark ne garde que ~3 jours de facturation : "semaine" et "mois" se
// construisent donc jour apres jour dans data/cout-auto-historique.json,
// alimente par un passage quotidien (ACTION=record).
//
// Declenchement :
//   - repository_dispatch depuis le worker Cloudflare (clic sur un bouton) ;
//     client_payload.custom_id donne la periode, INTERACTION_TOKEN permet de
//     repondre en message ephemere.
//   - workflow_dispatch : ACTION = panel | cout | record.
//   - schedule quotidien : ACTION=record.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const TOKEN = process.env.DISCORD_BOT_TOKEN
const API = 'https://discord.com/api/v10'
const dodo = ms => new Promise(r => setTimeout(r, ms))

const GL_BASE = (process.env.GEELARK_BASE_URL || 'https://openapi.geelark.com').replace(/\/+$/, '')
const GL_APP_ID = (process.env.GEELARK_APP_ID || '').trim()
const GL_API_KEY = (process.env.GEELARK_API_KEY || '').trim()

const SALON = process.env.SALON_COUT_AUTO || '1541618144173498408'
const ACTION = (process.env.ACTION || 'cout').toLowerCase()
const CUSTOM_ID = process.env.CUSTOM_ID || 'cout_auto_jour'
const INTERACTION_TOKEN = process.env.INTERACTION_TOKEN || ''
const APPLICATION_ID = process.env.APPLICATION_ID || ''
const FICHIER = process.env.FICHIER_COUT_AUTO || 'data/cout-auto-historique.json'
// Delai max entre le lancement d'une tache et la ligne de facturation qui en
// decoule. 30 min : large, mais un post GeeLark depasse rarement 10 min.
const FENETRE = parseInt(process.env.FENETRE_MIN || '30', 10) * 60
const PRIX_MINUTE = parseFloat(process.env.PRIX_MINUTE || '0') // $/min, 0 = masque

if (!TOKEN) { console.error('[FATAL] DISCORD_BOT_TOKEN absente.'); process.exit(1) }
if (!GL_API_KEY) { console.error('[FATAL] GEELARK_API_KEY absente.'); process.exit(1) }

// --- GeeLark ---------------------------------------------------------------
function glAuth() {
  const ts = String(Date.now())
  const traceId = crypto.randomUUID()
  const n = traceId.slice(0, 6)
  const sign = crypto.createHash('sha256').update(GL_APP_ID + traceId + ts + n + GL_API_KEY).digest('hex').toUpperCase()
  return { 'Content-Type': 'application/json', appId: GL_APP_ID, traceId, ts, nonce: n, sign }
}
async function glPost(chemin, corps = {}) {
  for (let essai = 0; essai < 3; essai++) {
    try {
      const r = await fetch(GL_BASE + chemin, { method: 'POST', headers: glAuth(), body: JSON.stringify(corps), signal: AbortSignal.timeout(30000) })
      const t = await r.text()
      let j = null; try { j = JSON.parse(t) } catch { /* pas du json */ }
      if (j && Number(j.code) === 0) return j
      if (essai === 2) return { error: 'api', code: j && j.code, msg: j && j.msg }
    } catch (e) { if (essai === 2) return { error: String(e.message || e) } }
    await dodo(1200)
  }
}

// --- Discord ---------------------------------------------------------------
async function discord(methode, chemin, corps) {
  for (let essai = 0; essai < 5; essai++) {
    const r = await fetch(API + chemin, {
      method: methode,
      headers: { Authorization: 'Bot ' + TOKEN, 'Content-Type': 'application/json' },
      body: corps ? JSON.stringify(corps) : undefined,
    })
    if (r.status === 429) { const j = await r.json().catch(() => ({})); await dodo(Math.min((j.retry_after || 1) * 1000 + 300, 15000)); continue }
    if (r.status >= 500) { await dodo(1500); continue }
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + methode + ' ' + chemin + ' ' + (await r.text().catch(() => '')).slice(0, 200))
    if (r.status === 204) return null
    return r.json().catch(() => null)
  }
  throw new Error('discord: trop de tentatives')
}
async function repondreBouton(payload) {
  if (!INTERACTION_TOKEN || !APPLICATION_ID) return false
  const url = API + '/webhooks/' + APPLICATION_ID + '/' + INTERACTION_TOKEN + '/messages/@original'
  const r = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  if (!r.ok) console.error('[interaction] HTTP ' + r.status + ' ' + (await r.text().catch(() => '')).slice(0, 200))
  return r.ok
}

// --- Dates (Paris) ---------------------------------------------------------
const fmtJour = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' })
const jourDe = ts => fmtJour.format(new Date(ts * 1000))            // 'AAAA-MM-JJ'
function joursAvant(n) {
  const out = []
  for (let i = n - 1; i >= 0; i--) out.push(jourDe(Math.floor(Date.now() / 1000) - i * 86400))
  return out
}

// --- Mesure ----------------------------------------------------------------
async function transactions(debut, fin) {
  const PAS = 6 * 3600
  const vus = new Set(); const out = []
  for (let a = debut; a < fin; a += PAS) {
    const b = Math.min(a + PAS, fin)
    const r = await glPost('/open/v1/billing/transaction/detail', { limit: 1000, startAt: Math.floor(a), endAt: Math.floor(b) })
    if (r && r.error) { console.error('[geelark] transactions : ' + JSON.stringify(r)); continue }
    const l = (r.data && r.data.list) || []
    for (const x of l) if (!vus.has(x.id)) { vus.add(x.id); out.push(x) }
    if (l.length >= 1000) console.warn('[geelark] tranche saturee, des lignes peuvent manquer')
  }
  return out
}
async function taches() {
  const out = []; let lastId
  for (let i = 0; i < 400; i++) {
    const b = { size: 100 }; if (lastId) b.lastId = lastId
    const r = await glPost('/open/v1/task/historyRecords', b)
    if (r && r.error) break
    const l = (r.data && (r.data.items || r.data.list)) || []
    out.push(...l)
    if (l.length < 100) break
    lastId = l[l.length - 1] && l[l.length - 1].id
    if (!lastId) break
  }
  return out
}

/** Repartit les minutes entre automatisation et reste, par jour. */
function repartir(tx, tk) {
  const parEnv = new Map()
  for (const t of tk) {
    if (!t.envId) continue
    if (![2, 3, 4].includes(Number(t.status))) continue   // lancee : en cours, reussie, echouee
    if (!parEnv.has(t.envId)) parEnv.set(t.envId, [])
    parEnv.get(t.envId).push({ at: Number(t.scheduleAt), nom: t.serialName || '?' })
  }
  for (const v of parEnv.values()) v.sort((a, b) => a.at - b.at)

  // Une tache genere plusieurs lignes de facturation : on compte les taches
  // distinctes (telephone + heure de lancement), pas les lignes.
  const jours = {}
  const vues = {}
  for (const t of tx) {
    const j = jourDe(Number(t.createdTime))
    if (!jours[j]) { jours[j] = { auto: 0, autre: 0, posts: 0, comptes: {} }; vues[j] = new Set() }
    const min = Number(t.usedTime || 0)
    const c = (parEnv.get(t.envId) || []).filter(x => x.at <= Number(t.createdTime) && Number(t.createdTime) - x.at <= FENETRE)
    if (c.length) {
      const d = c[c.length - 1]
      jours[j].auto += min
      const cle = t.envId + '@' + d.at
      if (!vues[j].has(cle)) { vues[j].add(cle); jours[j].posts++ }
      jours[j].comptes[d.nom] = (jours[j].comptes[d.nom] || 0) + min
    } else jours[j].autre += min
  }
  return jours
}

// --- Historique ------------------------------------------------------------
function lireHisto() { try { return JSON.parse(fs.readFileSync(FICHIER, 'utf8')) } catch { return { jours: {} } } }
function ecrireHisto(h) {
  fs.mkdirSync(path.dirname(FICHIER), { recursive: true })
  fs.writeFileSync(FICHIER, JSON.stringify(h, null, 2))
}

// --- Presentation ----------------------------------------------------------
const nb = n => Number(n || 0).toLocaleString('fr-FR')
const duree = m => {
  m = Math.round(m || 0)
  const h = Math.floor(m / 60), r = m % 60
  return h ? h + ' h ' + String(r).padStart(2, '0') : r + ' min'
}
const PERIODES = {
  cout_auto_jour: { titre: "Aujourd'hui", jours: () => [jourDe(Math.floor(Date.now() / 1000))] },
  cout_auto_hier: { titre: 'Hier', jours: () => [jourDe(Math.floor(Date.now() / 1000) - 86400)] },
  cout_auto_semaine: { titre: '7 derniers jours', jours: () => joursAvant(7) },
  cout_auto_mois: { titre: '30 derniers jours', jours: () => joursAvant(30) },
}

function embedResultat(cle, jours, source) {
  const P = PERIODES[cle] || PERIODES.cout_auto_jour
  let auto = 0, autre = 0, posts = 0, connus = 0
  const comptes = {}
  for (const j of P.jours()) {
    const r = jours[j]
    if (!r) continue
    connus++
    auto += r.auto; autre += r.autre; posts += r.posts
    for (const [c, m] of Object.entries(r.comptes || {})) comptes[c] = (comptes[c] || 0) + m
  }
  const total = auto + autre
  const part = total ? Math.round(100 * auto / total) : 0
  const L = []
  L.push('⏱️ **Minutes de mon automatisation** : **' + nb(Math.round(auto)) + ' min**  _(' + duree(auto) + ')_')
  if (posts) L.push('📤 **' + nb(posts) + '** posts declenches · ' + (auto / posts).toFixed(1) + ' min par post en moyenne')
  L.push('')
  L.push('🖐️ Hors automatisation : ' + nb(Math.round(autre)) + ' min _(telephones ouverts a la main)_')
  L.push('📊 Part automatisation : **' + part + ' %** du total (' + nb(Math.round(total)) + ' min)')
  if (PRIX_MINUTE > 0) L.push('💵 Coût de l\'automatisation : **≈ ' + (auto * PRIX_MINUTE).toFixed(2) + ' $**')
  const top = Object.entries(comptes).filter(([c]) => c && c !== '?').sort((a, b) => b[1] - a[1]).slice(0, 10)
  if (top.length) {
    L.push('')
    L.push('**Comptes les plus gourmands**')
    top.forEach(([c, m], i) => L.push('`' + String(i + 1).padStart(2) + '.` `' + c + '` — ' + nb(Math.round(m)) + ' min'))
  }
  const manque = P.jours().length - connus
  if (manque > 0) L.push('\n_' + manque + ' jour(s) sans donnée : l\'historique se construit au fil des jours._')
  return {
    color: 0x9b59b6,
    title: '💻 Automatisation · ' + P.titre,
    description: L.join('\n'),
    footer: { text: 'source : ' + source + ' · fenêtre d\'imputation ' + (FENETRE / 60) + ' min' },
    timestamp: new Date().toISOString(),
  }
}

function panneau() {
  return {
    embeds: [{
      color: 0x9b59b6,
      title: '💻 Temps passé par mon automatisation',
      description: 'Choisis une période pour voir **les minutes consommées par tes posts programmés uniquement** (réponse privée) :\n' +
        '📅 Aujourd\'hui · 🌙 Hier · 🗓️ 7 jours · 📆 30 jours\n\n' +
        '_Une minute est comptée comme « automatisation » si une tâche programmée a démarré sur le même téléphone dans la demi-heure qui précède. Le reste, c\'est toi qui ouvres un téléphone à la main._',
      footer: { text: 'gkpanel:cout-auto' },
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 3, label: "Aujourd'hui", emoji: { name: '📅' }, custom_id: 'cout_auto_jour' },
        { type: 2, style: 1, label: 'Hier', emoji: { name: '🌙' }, custom_id: 'cout_auto_hier' },
        { type: 2, style: 1, label: '7 jours', emoji: { name: '🗓️' }, custom_id: 'cout_auto_semaine' },
        { type: 2, style: 1, label: '30 jours', emoji: { name: '📆' }, custom_id: 'cout_auto_mois' },
      ],
    }],
  }
}

// --- Programme -------------------------------------------------------------
async function main() {
  const moi = await discord('GET', '/users/@me')
  console.log('[cout-auto] connecte en tant que ' + moi.username)

  if (ACTION === 'panel') {
    const anciens = (await discord('GET', '/channels/' + SALON + '/messages?limit=50')) || []
    const existant = anciens.find(m => m.author && m.author.id === moi.id &&
      (m.embeds || []).some(e => e.footer && e.footer.text === 'gkpanel:cout-auto'))
    if (existant) { await discord('PATCH', '/channels/' + SALON + '/messages/' + existant.id, panneau()); console.log('[panel] mis a jour') }
    else { await discord('POST', '/channels/' + SALON + '/messages', panneau()); console.log('[panel] poste') }
    return
  }

  const maintenant = Math.floor(Date.now() / 1000)
  const tx = await transactions(maintenant - 3 * 86400, maintenant)
  const tk = await taches()
  const frais = repartir(tx, tk)
  console.log('[cout-auto] ' + tx.length + ' lignes de facturation, ' + tk.length + ' taches, ' + Object.keys(frais).length + ' jour(s)')

  const histo = lireHisto()

  if (ACTION === 'record') {
    // on n'enregistre que les jours COMPLETS (pas aujourd'hui)
    const aujourdhui = jourDe(maintenant)
    let n = 0
    for (const [j, r] of Object.entries(frais)) {
      if (j >= aujourdhui) continue
      histo.jours[j] = r
      n++
    }
    histo.maj = new Date().toISOString()
    ecrireHisto(histo)
    console.log('[record] ' + n + ' jour(s) enregistre(s) — historique : ' + Object.keys(histo.jours).length + ' jours')
    return
  }

  // ACTION=cout : le frais prime sur l'historique (plus a jour)
  const jours = { ...histo.jours, ...frais }
  const emb = embedResultat(CUSTOM_ID, jours, tx.length + ' lignes GeeLark')
  if (INTERACTION_TOKEN) {
    const ok = await repondreBouton({ embeds: [emb] })
    console.log('[cout-auto] reponse au bouton : ' + (ok ? 'ok' : 'echec'))
  } else {
    await discord('POST', '/channels/' + SALON + '/messages', { embeds: [emb] })
    console.log('[cout-auto] poste dans le salon')
  }
}

main().then(() => process.exit(0)).catch(e => { console.error('[cout-auto] ' + (e && e.stack || e)); process.exit(1) })
