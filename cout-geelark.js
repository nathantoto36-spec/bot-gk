// ---------------------------------------------------------------------------
// "Cout GeeLark" - a la demande (boutons Discord), sur 4 periodes :
//   Aujourd'hui (0h -> maintenant) · Hier (jour complet) · Cette semaine
//   (depuis lundi) · Ce mois (depuis le 1er).
//
// Contrainte GeeLark : l'API de facturation ne garde que ~3 jours. Donc pour
// "semaine" et "mois" on ACCUMULE : un job quotidien (ACTION=record) enregistre
// le total de chaque jour complet dans data/cout-historique.json (commite par
// le workflow). Les boutons semaine/mois additionnent cet historique + les jours
// encore presents dans l'API (les 3 derniers) + aujourd'hui en direct.
//
// Declenche :
//   - repository_dispatch (clic bouton -> Worker Cloudflare -> GitHub) :
//       client_payload.custom_id donne la periode ; INTERACTION_TOKEN present
//       -> on EDITE la reponse differee (message EPHEMERE).
//   - workflow_dispatch (manuel) : ACTION = panel | cout | record.
//   - schedule (cron quotidien) : ACTION=record (enregistre les jours complets).
//
// Sources GeeLark :
//   POST /open/v1/pay/wallet                 -> solde + minutes add-on restantes
//   POST /open/v1/billing/transaction/detail -> transactions (amount, usedTime
//        en MINUTES, type, chargeType, createdTime, envId...) sur ~3 jours max.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto'
import fs from 'node:fs'

const TOKEN = process.env.DISCORD_BOT_TOKEN
const API = 'https://discord.com/api/v10'
const dodo = ms => new Promise(r => setTimeout(r, ms))

// --- Client GeeLark billing (inline) ---------------------------------------
const GL_BASE = (process.env.GEELARK_BASE_URL || 'https://openapi.geelark.com').replace(/\/+$/, '')
const GL_APP_ID = (process.env.GEELARK_APP_ID || 'RTJBTN1C5Y05AAYU68G4XFDQSG').trim()
const GL_API_KEY = (process.env.GEELARK_API_KEY || '').trim()

function glAuth(appId, apiKey) {
  const ts = String(Date.now())
  const traceId = crypto.randomUUID()
  const n = traceId.slice(0, 6)
  const sign = crypto.createHash('sha256').update(appId + traceId + ts + n + apiKey).digest('hex').toUpperCase()
  return { 'Content-Type': 'application/json', appId, traceId, ts, nonce: n, sign }
}

async function glPost(pathname, body = {}, timeoutMs = 15000) {
  if (!GL_API_KEY) return { error: 'GEELARK_API_KEY absente' }
  const DEF = 'RTJBTN1C5Y05AAYU68G4XFDQSG'
  const paires = [[GL_APP_ID, GL_API_KEY], [DEF, GL_API_KEY], [GL_API_KEY, GL_APP_ID], [DEF, GL_APP_ID]]
    .filter((p, i, a) => p[0] && p[1] && a.findIndex(q => q[0] === p[0] && q[1] === p[1]) === i)
  let dernier = null
  for (let i = 0; i < paires.length; i++) {
    let r
    try {
      r = await fetch(GL_BASE + pathname, { method: 'POST', headers: glAuth(paires[i][0], paires[i][1]), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) { return { error: 'fetch_failed', body: String((e && e.message) || e) } }
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

async function soldeWallet() {
  const res = await glPost('/open/v1/pay/wallet', {})
  if (res && res.error) return res
  const d = (res && (res.data || res.result || res)) || {}
  return {
    balance: Number(d.balance || 0),
    giftMoney: Number(d.giftMoney || d.gift || 0),
    availableTimeAddOn: Number(d.availableTimeAddOn || d.timeAddOn || 0),
  }
}

// Transactions des ~3 derniers jours (max autorise par GeeLark). startAt/endAt en ms.
async function transactionsRecentes({ startAt, endAt, limit = 1000 } = {}) {
  const out = []
  let lastFlowId
  for (let i = 0; i < 20; i++) {
    const body = { limit }
    if (startAt) body.startAt = Math.floor(startAt / 1000)
    if (endAt) body.endAt = Math.floor(endAt / 1000)
    if (lastFlowId) body.lastFlowId = lastFlowId
    const res = await glPost('/open/v1/billing/transaction/detail', body)
    if (res && res.error) return { error: res.error, msg: res.msg, body: res.body, partiel: out }
    const d = (res && (res.data || res.result || res)) || {}
    const items = d.list || d.records || d.items || d.rows || []
    out.push(...items)
    lastFlowId = d.lastFlowId
    if (!lastFlowId || items.length < limit) break
  }
  return { list: out }
}

// Taches / programmations planifiees des ~7 derniers jours (RPA). cost = secondes.
async function tachesRecentes() {
  const out = []
  let lastId
  for (let i = 0; i < 40; i++) {
    const body = { size: 100 }
    if (lastId) body.lastId = lastId
    const res = await glPost('/open/v1/task/historyRecords', body)
    if (res && res.error) return { error: res.error, msg: res.msg, body: res.body, partiel: out }
    const d = (res && (res.data || res.result || res)) || {}
    const items = d.items || d.list || d.records || []
    out.push(...items)
    lastId = d.lastId || (items.length ? items[items.length - 1].id : null)
    if (!items.length || items.length < 100) break
  }
  return { list: out }
}

// --- Config ----------------------------------------------------------------
const SALON = process.env.SALON_COUT_GEELARK || ''
const SALON_NOM = process.env.SALON_COUT_GEELARK_NOM || 'cout-de-geelark'
const ACTION = (process.env.ACTION || 'cout').toLowerCase()
const INTERACTION_TOKEN = process.env.INTERACTION_TOKEN || ''
const APPLICATION_ID = process.env.APPLICATION_ID || ''
const CUSTOM_ID = process.env.CUSTOM_ID || process.env.COUT_BOUTON_ID || 'cout_geelark_jour'
const ABO_MENSUEL = parseFloat(process.env.COUT_ABONNEMENT_MENSUEL || '269')
// Prix reel d'1 min add-on GeeLark : pack 50 000 min = $315 (remise -10% incluse) => $0.0063/min.
const PRIX_MINUTE = parseFloat(process.env.COUT_PRIX_MINUTE || '0.0063') // 0 = pas de conversion $
const DEVISE = process.env.COUT_DEVISE || '$'
const FICHIER_HIST = process.env.COUT_HIST_FICHIER || 'data/cout-historique.json'

// Les 4 periodes (custom_id du bouton -> periode).
const PERIODES = {
  cout_geelark_jour: { cle: 'jour', label: "aujourd'hui", emoji: '📅' },
  cout_geelark_hier: { cle: 'hier', label: 'hier', emoji: '🌙' },
  cout_geelark_semaine: { cle: 'semaine', label: 'cette semaine', emoji: '🗓️' },
  cout_geelark_mois: { cle: 'mois', label: 'ce mois', emoji: '📆' },
}

// --- Utilitaires -----------------------------------------------------------
function argent(n) {
  return DEVISE + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
function nb(n) { return Math.round(Number(n) || 0).toLocaleString('fr-FR') }

// createdTime GeeLark : secondes ou millisecondes -> normalise en ms.
function versMs(t) { const n = Number(t) || 0; return n > 1e12 ? n : n * 1000 }

// Date "Paris" AAAA-MM-JJ pour un instant ms.
function dateParis(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
}
// Offset Paris (minutes) : +120 ete, +60 hiver.
function decalageParisMinutes(d) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', timeZoneName: 'shortOffset' }).format(d)
  const m = s.match(/GMT([+-]\d+)(?::(\d+))?/)
  if (!m) return 120
  return parseInt(m[1], 10) * 60 + (m[1].startsWith('-') ? -1 : 1) * parseInt(m[2] || '0', 10)
}
// 00:00 Paris (en ms) d'aujourd'hui moins N jours.
function debutJourParis(decalageJours = 0) {
  const maintenant = new Date()
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(maintenant)
  const base = new Date(p + 'T00:00:00')
  const utcMs = base.getTime() - decalageParisMinutes(maintenant) * 60000
  return utcMs - decalageJours * 86400000
}
// Lundi 00:00 Paris de la semaine en cours (ms).
function debutSemaineParis() {
  const j = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', weekday: 'short' }).format(new Date())
  const idx = ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 })[j]
  return debutJourParis(idx == null ? 0 : idx)
}
// 1er du mois 00:00 Paris (ms).
function debutMoisParis() {
  const jourDuMois = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', day: '2-digit' }).format(new Date()))
  return debutJourParis(jourDuMois - 1)
}
function joursDansMoisParis() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).format(new Date())
  const [y, m] = p.split('-').map(Number)
  return new Date(y, m, 0).getDate()
}
function horodatage() {
  return new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
// Liste des dates "Paris" (AAAA-MM-JJ) entre debutMs et finMs inclus.
function datesPeriode(debutMs, finMs) {
  const debutD = dateParis(debutMs)
  const set = new Set()
  for (let i = 0; i < 45; i++) {
    const d = dateParis(finMs - i * 86400000)
    if (d < debutD) break
    set.add(d)
  }
  return [...set]
}

// --- Historique (fichier commite par le workflow) --------------------------
function lireHistorique() {
  try { return JSON.parse(fs.readFileSync(FICHIER_HIST, 'utf8')) } catch { return {} }
}
function ecrireHistorique(h) {
  try { fs.mkdirSync('data', { recursive: true }) } catch { /* deja la */ }
  fs.writeFileSync(FICHIER_HIST, JSON.stringify(h) + '\n')
}

// --- Discord REST ----------------------------------------------------------
async function discord(methode, chemin, corps) {
  const entetes = { Authorization: 'Bot ' + TOKEN, 'Content-Type': 'application/json', 'User-Agent': 'bot-gk-cout (github-actions, 1.0)' }
  for (let essai = 0; essai < 5; essai++) {
    let r
    try {
      r = await fetch(API + chemin, { method: methode, headers: entetes, body: corps ? JSON.stringify(corps) : undefined })
    } catch (e) { if (essai === 4) throw e; await dodo(1500); continue }
    if (r.status === 429) { const j = await r.json().catch(() => ({})); await dodo(Math.min((j.retry_after || 1) * 1000 + 300, 15000)); continue }
    if (r.status >= 500) { await dodo(1500); continue }
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('HTTP ' + r.status + ' ' + methode + ' ' + chemin + ' ' + t.slice(0, 200)) }
    if (r.status === 204) return null
    return r.json().catch(() => null)
  }
  throw new Error('discord: trop de tentatives sur ' + chemin)
}

async function editerInteraction(payload) {
  const url = API + '/webhooks/' + APPLICATION_ID + '/' + INTERACTION_TOKEN + '/messages/@original'
  for (let essai = 0; essai < 5; essai++) {
    let r
    try { r = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'User-Agent': 'bot-gk-cout' }, body: JSON.stringify(payload) }) }
    catch (e) { if (essai === 4) throw e; await dodo(1500); continue }
    if (r.status === 429) { const j = await r.json().catch(() => ({})); await dodo(Math.min((j.retry_after || 1) * 1000 + 300, 15000)); continue }
    if (r.status >= 500) { await dodo(1500); continue }
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('HTTP ' + r.status + ' PATCH interaction ' + t.slice(0, 200)) }
    return r.json().catch(() => null)
  }
  throw new Error('interaction: trop de tentatives')
}

// Retrouve l'ID du salon par son nom (pas besoin du mode developpeur).
async function trouverSalon() {
  if (SALON) return SALON
  const cible = SALON_NOM.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const guildes = await discord('GET', '/users/@me/guilds').catch(() => [])
  for (const g of guildes || []) {
    const chans = await discord('GET', '/guilds/' + g.id + '/channels').catch(() => [])
    for (const c of chans || []) {
      const n = String(c.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
      if (c.type === 0 && n.includes(cible)) return c.id
    }
  }
  return ''
}

// --- Le message-bouton (panneau, 4 boutons) --------------------------------
function panneauPayload() {
  return {
    embeds: [{
      color: 0x2ecc71,
      title: '💸 Coût GeeLark',
      description: 'Choisis une période pour voir le coût **à la demande** (réponse privée) :' +
        String.fromCharCode(10) + '📅 Aujourd\'hui · 🌙 Hier · 🗓️ Cette semaine · 📆 Ce mois' +
        String.fromCharCode(10) + String.fromCharCode(10) +
        '_Minutes cloud consommées, hébergement, dépenses cash et solde restant. ' +
        'Semaine/mois se construisent jour après jour (historique auto)._',
      footer: { text: 'gkpanel:cout' },
    }],
    components: [{
      type: 1,
      components: [
        { type: 2, style: 3, label: 'Aujourd\'hui', emoji: { name: '📅' }, custom_id: 'cout_geelark_jour' },
        { type: 2, style: 1, label: 'Hier', emoji: { name: '🌙' }, custom_id: 'cout_geelark_hier' },
        { type: 2, style: 1, label: 'Semaine', emoji: { name: '🗓️' }, custom_id: 'cout_geelark_semaine' },
        { type: 2, style: 1, label: 'Mois', emoji: { name: '📆' }, custom_id: 'cout_geelark_mois' },
      ],
    }],
  }
}

// Trouve le message-panneau existant (footer gkpanel:cout).
async function trouverPanneau(salon) {
  try {
    const msgs = await discord('GET', '/channels/' + salon + '/messages?limit=50')
    return (msgs || []).find(m => (m.embeds || []).some(e => e.footer && e.footer.text === 'gkpanel:cout'))
  } catch { return null }
}

// --- Agregation ------------------------------------------------------------
// Regroupe les transactions par date "Paris" -> { 'AAAA-MM-JJ': {minutes,cash,n,envs} }.
function bucketParJour(txs) {
  const m = {}
  for (const t of txs) {
    const c = versMs(t.createdTime != null ? t.createdTime : (t.createTime != null ? t.createTime : t.time))
    const d = dateParis(c)
    if (!m[d]) m[d] = { minutes: 0, cash: 0, n: 0, envs: new Set() }
    m[d].minutes += Number(t.usedTime || 0) // usedTime est en MINUTES
    m[d].cash += Number(t.amount || 0)
    m[d].n++
    if (t.envId) m[d].envs.add(t.envId)
  }
  const out = {}
  for (const d in m) out[d] = { minutes: Math.round(m[d].minutes), cash: m[d].cash, n: m[d].n, envs: m[d].envs.size }
  return out
}

// Somme sur une liste de dates : live (API, 3 jours) prioritaire, sinon historique.
function sommePeriode(dates, bucketLive, hist) {
  const auj = dateParis(Date.now())
  let minutes = 0, cash = 0, envs = 0, n = 0, joursConnus = 0, joursManquants = 0
  for (const d of dates) {
    const rec = bucketLive[d] || hist[d]
    if (rec) { minutes += rec.minutes || 0; cash += rec.cash || 0; n += rec.n || 0; envs = Math.max(envs, rec.envs || 0); joursConnus++ }
    else if (d < auj) joursManquants++ // jour passe sans donnee (hors fenetre API + pas encore dans l'historique)
  }
  return { minutes: Math.round(minutes), cash, envs, n, joursConnus, joursManquants, joursTotal: dates.length }
}

// --- Construction de l'embed -----------------------------------------------
function construireEmbed(P, s, wallet, rythme, note) {
  const estJourUnique = (P.cle === 'jour' || P.cle === 'hier')
  const partAbo = ABO_MENSUEL > 0 ? ABO_MENSUEL / joursDansMoisParis() : 0
  const abo = partAbo * s.joursTotal
  const lignes = []

  // Minutes consommees converties en argent reel (cout variable, prepaye via add-on).
  const coutMin = PRIX_MINUTE > 0 ? s.minutes * PRIX_MINUTE : 0
  const valMin = PRIX_MINUTE > 0 ? '  →  **≈ ' + argent(coutMin) + '**' : ''
  lignes.push('⏱️ **Minutes consommées** : ' + nb(s.minutes) + ' min' + valMin +
    (estJourUnique && s.envs ? '  ·  ' + s.envs + ' appareil' + (s.envs > 1 ? 's' : '') : ''))
  if (PRIX_MINUTE > 0) lignes.push('_(valeur add-on : ' + argent(PRIX_MINUTE) + '/min · pack 50 000 min = ' + argent(PRIX_MINUTE * 50000) + ')_')

  // Hebergement (abonnement lisse) sur la periode.
  if (partAbo > 0) {
    lignes.push(String.fromCharCode(10) + '🖥️ **Hébergement** : ' + (estJourUnique ? '~' + argent(partAbo) + '/jour' : argent(abo) + ' sur ' + s.joursTotal + ' j') +
      '  _(' + argent(ABO_MENSUEL) + '/mois)_')
  }

  // Cout total estime = minutes (variable) + hebergement (fixe prorata).
  if (PRIX_MINUTE > 0 || partAbo > 0) {
    lignes.push('🧮 **Coût total estimé** : **≈ ' + argent(coutMin + abo) + '**  _(' + argent(coutMin) + ' minutes + ' + argent(abo) + ' hébergement)_')
  }

  // Depense cash reelle (recharges/achats) - souvent 0 en prepaye.
  lignes.push(String.fromCharCode(10) + '💵 **Dépensé cash** : ' + argent(Math.abs(s.cash)) +
    (Math.abs(s.cash) < 0.005 ? '  _(rien débité — déjà payé d\'avance)_' : ''))

  // Solde + add-on restant + autonomie.
  if (wallet && !wallet.error) {
    const jours = rythme > 0 ? wallet.availableTimeAddOn / rythme : null
    lignes.push(String.fromCharCode(10) + '📉 **Add-on restant** : ' + nb(wallet.availableTimeAddOn) + ' min' +
      (jours ? '  → autonomie ~**' + (Math.round(jours * 10) / 10).toLocaleString('fr-FR') + ' j** (au rythme d\'hier)' : ''))
    lignes.push('💰 **Solde** : ' + argent(wallet.balance) + '  ·  🎁 bonus : ' + argent(wallet.giftMoney))
  } else if (wallet && wallet.error) {
    lignes.push(String.fromCharCode(10) + '💰 Solde : indisponible (' + wallet.error + ')')
  }

  // Note historique partiel pour semaine/mois.
  if (!estJourUnique && s.joursManquants > 0) {
    lignes.push(String.fromCharCode(10) + '_ℹ️ Historique en cours de constitution : ' + s.joursConnus + '/' + s.joursTotal +
      ' jours connus (les jours manquants s\'ajouteront automatiquement).' + '_')
  }
  if (note) lignes.push(String.fromCharCode(10) + '_' + note + '_')
  lignes.push('_maj ' + horodatage() + '_')

  return {
    color: 0x2ecc71,
    title: P.emoji + ' Coût GeeLark · ' + P.label,
    description: lignes.join(String.fromCharCode(10)).slice(0, 4000),
    footer: { text: 'Source : facturation GeeLark' },
  }
}

// --- Programme principal ---------------------------------------------------
async function main() {
  if (!TOKEN) { console.error('[FATAL] DISCORD_BOT_TOKEN absent'); process.exit(1) }

  // Mode panneau : (re)poste OU met a jour le message-bouton (4 boutons).
  if (ACTION === 'panel' && !INTERACTION_TOKEN) {
    const salon = await trouverSalon()
    if (!salon) { console.error('[panel] salon "' + SALON_NOM + '" introuvable'); process.exit(1) }
    const existant = await trouverPanneau(salon)
    if (existant) {
      await discord('PATCH', '/channels/' + salon + '/messages/' + existant.id, panneauPayload())
      console.log('[panel] message-bouton mis a jour (4 boutons) dans ' + salon)
    } else {
      await discord('POST', '/channels/' + salon + '/messages', panneauPayload())
      console.log('[panel] message-bouton poste dans ' + salon)
    }
    return
  }

  // Lecture des transactions des ~3 derniers jours (max API).
  const now = Date.now()
  const res = await transactionsRecentes({ startAt: now - 3 * 86400000 + 3600000, endAt: now, limit: 1000 })
  let bucketLive = {}
  let note = ''
  if (res.error) {
    console.error('[cout] transactions KO : ' + res.error + ' ' + (res.msg || '') + ' ' + (res.body || ''))
    note = 'Facturation GeeLark momentanément indisponible (' + res.error + ').'
  } else {
    const txs = res.list || []
    console.log('[cout] ' + txs.length + ' transaction(s) reçues (3 jours)')
    if (txs[0]) console.log('[cout] échantillon : ' + JSON.stringify(txs[0]).slice(0, 300))
    bucketLive = bucketParJour(txs)
    console.log('[cout] par jour : ' + JSON.stringify(bucketLive))
  }

  const hist = lireHistorique()

  // Mode record : enregistre tous les jours COMPLETS (tout sauf aujourd'hui) dans l'historique.
  if (ACTION === 'record') {
    const auj = dateParis(now)
    let maj = 0
    for (const d in bucketLive) {
      if (d < auj) { hist[d] = bucketLive[d]; maj++ }
    }
    ecrireHistorique(hist)
    console.log('[record] ' + maj + ' jour(s) complet(s) enregistré(s) dans ' + FICHIER_HIST)
    return
  }

  // Mode snapshot : releve le solde add-on a minuit (Paris) pour "aujourd'hui" en temps reel.
  if (ACTION === 'snapshot') {
    const hParis = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }).format(new Date()))
    if (hParis !== 0) { console.log('[snapshot] pas minuit Paris (' + hParis + 'h) -> ignore'); return }
    const w = await soldeWallet().catch(e => ({ error: 'exception:' + (e && e.message) }))
    if (!w || w.error) { console.error('[snapshot] wallet KO : ' + (w && w.error)); return }
    const aujD = dateParis(now)
    if (!hist._midnight) hist._midnight = {}
    hist._midnight[aujD] = Math.round(w.availableTimeAddOn)
    const cles = Object.keys(hist._midnight).sort()
    while (cles.length > 40) { delete hist._midnight[cles.shift()] }
    ecrireHistorique(hist)
    console.log('[snapshot] solde add-on minuit ' + aujD + ' = ' + hist._midnight[aujD])
    return
  }

  // Diagnostic taches (declenche via custom_id=diag_taches) : liste les programmations 7 jours.
  if (CUSTOM_ID === 'diag_taches') {
    const t = await tachesRecentes()
    if (t.error) { console.log('[diag] KO ' + JSON.stringify(t)); return }
    const parType = {}, parPlan = {}, envs = new Set()
    let totalSec = 0
    for (const x of t.list) {
      const sec = Number(x.cost || 0); totalSec += sec
      const kt = 'type' + x.taskType; if (!parType[kt]) parType[kt] = { n: 0, min: 0 }; parType[kt].n++; parType[kt].min += sec / 60
      const kp = (x.planName || '(sans nom)') + ' [t' + x.taskType + ']'; if (!parPlan[kp]) parPlan[kp] = { n: 0, min: 0 }; parPlan[kp].n++; parPlan[kp].min += sec / 60
      if (x.envId) envs.add(x.envId)
    }
    for (const k in parType) parType[k].min = Math.round(parType[k].min)
    for (const k in parPlan) parPlan[k].min = Math.round(parPlan[k].min)
    console.log('[diag] total_taches=' + t.list.length + ' total_min=' + Math.round(totalSec / 60) + ' nb_envs=' + envs.size)
    console.log('[diag] parType=' + JSON.stringify(parType))
    console.log('[diag] parPlan=' + JSON.stringify(parPlan))
    console.log('[diag] sample=' + JSON.stringify(t.list.slice(0, 6)))
    return
  }

  // Determine la periode depuis le custom_id du bouton.
  const P = PERIODES[CUSTOM_ID] || PERIODES.cout_geelark_jour
  let debutMs, finMs
  if (P.cle === 'jour') { debutMs = debutJourParis(0); finMs = now }
  else if (P.cle === 'hier') { debutMs = debutJourParis(1); finMs = debutJourParis(0) - 1 }
  else if (P.cle === 'semaine') { debutMs = debutSemaineParis(); finMs = now }
  else { debutMs = debutMoisParis(); finMs = now }

  const dates = datesPeriode(debutMs, finMs)
  const somme = sommePeriode(dates, bucketLive, hist)

  // Rythme pour l'autonomie = minutes d'hier (jour complet).
  const hierD = dateParis(debutJourParis(0) - 1)
  const rythme = (bucketLive[hierD] && bucketLive[hierD].minutes) || (hist[hierD] && hist[hierD].minutes) || somme.minutes

  const wallet = await soldeWallet().catch(e => ({ error: 'exception:' + (e && e.message) }))
  if (wallet && wallet.error) console.error('[cout] wallet KO : ' + wallet.error + ' ' + (wallet.msg || ''))
  else console.log('[cout] wallet balance=' + (wallet && wallet.balance) + ' addon=' + (wallet && wallet.availableTimeAddOn))
  // "Aujourd'hui" en temps reel : (solde add-on a minuit) - (solde maintenant).
  // Capte meme les sessions en cours (la facturation par transaction est en retard).
  if (P.cle === 'jour' && wallet && !wallet.error && hist._midnight) {
    const mid = hist._midnight[dateParis(now)]
    if (mid != null) {
      somme.minutes = Math.max(0, Math.round(mid - wallet.availableTimeAddOn))
      note = (note ? note + ' · ' : '') + '⚡ aujourd\'hui en temps réel (solde add-on)'
    }
  }
  console.log('[cout] periode=' + P.cle + ' minutes=' + somme.minutes + ' cash=' + somme.cash + ' jours=' + somme.joursConnus + '/' + somme.joursTotal)

  const embed = construireEmbed(P, somme, wallet, rythme, note)

  if (INTERACTION_TOKEN && APPLICATION_ID) {
    await editerInteraction({ embeds: [embed] })
    console.log('[cout] réponse interaction éditée (éphémère) · ' + P.cle)
  } else {
    const salon = await trouverSalon()
    if (!salon) { console.error('[cout] salon introuvable pour poster'); process.exit(1) }
    await discord('POST', '/channels/' + salon + '/messages', { embeds: [embed] })
    console.log('[cout] posté dans le salon ' + salon + ' · ' + P.cle)
  }
}

main().then(() => { console.log('[cout] terminé'); process.exit(0) })
  .catch(e => { console.error('[cout] erreur fatale : ' + (e && e.stack ? e.stack : e)); process.exit(1) })
