// ---------------------------------------------------------------------------
// "Coût GeeLark du jour" - a la demande (bouton Discord).
//
// Declenche de 2 facons (comme le bouton classement) :
//   - repository_dispatch (clic bouton -> Worker Cloudflare -> GitHub) :
//       INTERACTION_TOKEN + APPLICATION_ID fournis -> on EDITE la reponse
//       differee (message EPHEMERE, visible par le cliqueur seul).
//   - workflow_dispatch (manuel) :
//       ACTION=panel -> (re)poste le message-bouton dans le salon.
//       ACTION=cout  -> calcule et poste le cout directement dans le salon.
//
// Source des chiffres : la facturation officielle GeeLark.
//   POST /open/v1/pay/wallet                 -> solde + minutes add-on restantes
//   POST /open/v1/billing/transaction/detail -> transactions du jour (amount,
//        usedTime en MINUTES, type, chargeType, createdTime, envId...)
// ---------------------------------------------------------------------------

import crypto from 'node:crypto'

const TOKEN = process.env.DISCORD_BOT_TOKEN
const API = 'https://discord.com/api/v10'
const dodo = ms => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Client GeeLark billing (inline - meme signature que geelark.js).
// Auth : 5 en-tetes -> appId, traceId, ts, nonce, sign
//        sign = SHA256(appId + traceId + ts + nonce + apiKey) en HEX MAJUSCULE
// ---------------------------------------------------------------------------
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

// Solde du portefeuille GeeLark + minutes add-on restantes.
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

// Transactions de facturation (l'API ne garde que ~3 jours). startAt/endAt en ms.
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

const SALON = process.env.SALON_COUT_GEELARK || ''
const SALON_NOM = process.env.SALON_COUT_GEELARK_NOM || 'cout-de-geelark'
const ACTION = (process.env.ACTION || 'cout').toLowerCase()
const INTERACTION_TOKEN = process.env.INTERACTION_TOKEN || ''
const APPLICATION_ID = process.env.APPLICATION_ID || ''
const CUSTOM_ID = process.env.COUT_BOUTON_ID || 'cout_geelark_jour'
const ABO_MENSUEL = parseFloat(process.env.COUT_ABONNEMENT_MENSUEL || '269')
const PRIX_MINUTE = parseFloat(process.env.COUT_PRIX_MINUTE || '0') // prix d'1 min add-on (0 = ne pas convertir en $)
const DEVISE = process.env.COUT_DEVISE || '$'

// --- Utilitaires -----------------------------------------------------------
function argent(n) {
  return DEVISE + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// createdTime GeeLark peut etre en secondes ou en millisecondes -> on normalise en ms.
function versMs(t) {
  const n = Number(t) || 0
  return n > 1e12 ? n : n * 1000
}

// Debut de journee (00:00) dans le fuseau Europe/Paris, renvoye en ms epoch.
function debutJourParis(decalageJours = 0) {
  const maintenant = new Date()
  // Date "Paris" sous forme AAAA-MM-JJ
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(maintenant)
  const base = new Date(p + 'T00:00:00')
  // Decalage Paris (CET/CEST) : on lit l'offset courant via une astuce.
  const offMin = decalageParisMinutes(maintenant)
  const utcMs = base.getTime() - offMin * 60000
  return utcMs - decalageJours * 86400000
}

// Offset de Paris (minutes) au moment donne : +120 en ete, +60 en hiver.
function decalageParisMinutes(d) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', timeZoneName: 'shortOffset' }).format(d)
  const m = s.match(/GMT([+-]\d+)(?::(\d+))?/)
  if (!m) return 120
  return parseInt(m[1], 10) * 60 + (m[1].startsWith('-') ? -1 : 1) * parseInt(m[2] || '0', 10)
}

function horodatage() {
  return new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
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

// Retrouve l'ID du salon par son nom (pas besoin du mode developpeur cote Nathan).
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

// --- Le message-bouton (panneau) -------------------------------------------
function panneauPayload() {
  return {
    embeds: [{
      color: 0x2ecc71,
      title: '💸 Coût GeeLark du jour',
      description: 'Appuie sur le bouton pour voir, **à la demande**, combien GeeLark t\'a coûté **aujourd\'hui** ' +
        '(facturation en direct : montant facturé, temps cloud consommé, solde restant).' +
        String.fromCharCode(10) + String.fromCharCode(10) + '_Réponse privée, visible par toi seul._',
      footer: { text: 'gkpanel:cout' },
    }],
    components: [{ type: 1, components: [{ type: 2, style: 3, label: 'Voir le coût du jour', emoji: { name: '💸' }, custom_id: CUSTOM_ID }] }],
  }
}

async function panneauExiste(salon) {
  try {
    const msgs = await discord('GET', '/channels/' + salon + '/messages?limit=50')
    return (msgs || []).some(m => (m.embeds || []).some(e => e.footer && e.footer.text === 'gkpanel:cout'))
  } catch { return false }
}

// --- Calcul du cout du jour ------------------------------------------------
function classer(txs, debut, fin) {
  let net = 0, positifs = 0, negatifs = 0, secondes = 0
  const parType = {}
  const envs = new Set()
  let n = 0
  for (const t of txs) {
    const c = versMs(t.createdTime != null ? t.createdTime : (t.createTime != null ? t.createTime : t.time))
    if (c < debut || c > fin) continue
    n++
    const a = Number(t.amount || 0)
    net += a
    if (a >= 0) positifs += a; else negatifs += a
    secondes += Number(t.usedTime || 0)
    if (t.envId) envs.add(t.envId)
    const cle = String(t.chargeType || t.type || 'autre')
    parType[cle] = (parType[cle] || 0) + a
  }
  // usedTime GeeLark est deja en MINUTES (verifie via le registre reel) -> pas de /60.
  return { n, net, positifs, negatifs, secondes, minutes: Math.round(secondes), envs: envs.size, parType }
}

function construireEmbed(jour, hier, wallet, note) {
  const coutJour = Math.abs(jour.net)
  const partAbo = ABO_MENSUEL > 0 ? ABO_MENSUEL / joursDansMoisParis() : 0

  const lignes = []

  // 1) HEBERGEMENT (abonnement fixe, lisse par jour) -- separe des minutes.
  if (partAbo > 0) {
    lignes.push('🖥️ **Hébergement** : ~' + argent(partAbo) + '/jour  _(abonnement ' + argent(ABO_MENSUEL) + '/mois)_')
  }

  // 2) MINUTES cloud consommees = le vrai cout variable (prepaye, add-on).
  const valMin = PRIX_MINUTE > 0 ? '  ≈ ' + argent(jour.minutes * PRIX_MINUTE) : ''
  lignes.push('⏱️ **Minutes consommées** : **' + jour.minutes.toLocaleString('fr-FR') + ' min** aujourd\'hui · ' +
    jour.envs + ' appareil' + (jour.envs > 1 ? 's' : '') + valMin)
  lignes.push('   ↳ hier : ' + hier.minutes.toLocaleString('fr-FR') + ' min' + (PRIX_MINUTE > 0 ? '  ≈ ' + argent(hier.minutes * PRIX_MINUTE) : ''))

  // 3) ADD-ON restant + autonomie estimee (au rythme de la veille).
  if (wallet && !wallet.error) {
    const rythme = hier.minutes > 0 ? hier.minutes : jour.minutes
    const jours = rythme > 0 ? wallet.availableTimeAddOn / rythme : null
    lignes.push('📉 **Add-on restant** : ' + wallet.availableTimeAddOn.toLocaleString('fr-FR') + ' min' +
      (jours ? '  → autonomie ~**' + (Math.round(jours * 10) / 10).toLocaleString('fr-FR') + ' jours** à ce rythme' : ''))
  }

  // 4) DEPENSE CASH reelle du jour (recharges / achats) -- souvent 0 en prepaye.
  lignes.push(String.fromCharCode(10) + '💵 **Dépensé cash aujourd\'hui** : ' + argent(coutJour) +
    (coutJour < 0.005 ? '  _(rien débité — tu consommes tes minutes prépayées)_' : ''))
  const cles = Object.keys(jour.parType).filter(k => Math.abs(jour.parType[k]) > 0.0001)
  if (cles.length) {
    const detail = cles.map(k => '• ' + libelleType(k) + ' : ' + argent(Math.abs(jour.parType[k]))).join(String.fromCharCode(10))
    lignes.push('__Détail des dépenses :__' + String.fromCharCode(10) + detail)
  }

  // 5) SOLDE + PROMOTION (bonus).
  if (wallet && !wallet.error) {
    lignes.push('💰 **Solde wallet** : ' + argent(wallet.balance) + ' · 🎁 bonus : ' + argent(wallet.giftMoney))
  } else if (wallet && wallet.error) {
    lignes.push('💰 Solde : indisponible (' + wallet.error + ')')
  }

  if (note) lignes.push(String.fromCharCode(10) + '_' + note + '_')
  lignes.push('_maj ' + horodatage() + '_')

  return {
    color: 0x2ecc71,
    title: '💸 Coût GeeLark · aujourd\'hui',
    description: lignes.join(String.fromCharCode(10)).slice(0, 4000),
    footer: { text: 'Source : facturation GeeLark' },
  }
}

function libelleType(k) {
  const map = {
    consume: 'Temps cloud consommé', consumption: 'Temps cloud consommé', time: 'Temps cloud',
    recharge: 'Recharge', addon: 'Add-on temps', add_on: 'Add-on temps', subscribe: 'Abonnement',
    subscription: 'Abonnement', renew: 'Renouvellement', proxy: 'Proxy', gift: 'Bonus',
  }
  return map[String(k).toLowerCase()] || k
}

function joursDansMoisParis() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).format(new Date())
  const [y, m] = p.split('-').map(Number)
  return new Date(y, m, 0).getDate()
}

// --- Programme principal ---------------------------------------------------
async function main() {
  if (!TOKEN) { console.error('[FATAL] DISCORD_BOT_TOKEN absent'); process.exit(1) }

  // Mode panneau : (re)poste le message-bouton.
  if (ACTION === 'panel' && !INTERACTION_TOKEN) {
    const salon = await trouverSalon()
    if (!salon) { console.error('[panel] salon "' + SALON_NOM + '" introuvable'); process.exit(1) }
    if (await panneauExiste(salon)) { console.log('[panel] déjà présent, rien à faire'); return }
    await discord('POST', '/channels/' + salon + '/messages', panneauPayload())
    console.log('[panel] message-bouton posté dans le salon ' + salon)
    return
  }

  // Calcul.
  const maintenant = Date.now()
  const debutJour = debutJourParis(0)
  const debutHier = debutJourParis(1)

  const res = await transactionsRecentes({ startAt: debutHier, endAt: maintenant, limit: 1000 })
  let note = ''
  let jour, hier
  let wallet = null

  if (res.error) {
    console.error('[cout] transactions KO : ' + res.error + ' ' + (res.msg || '') + ' ' + (res.body || ''))
    note = 'Facturation GeeLark momentanément indisponible (' + res.error + ').'
    jour = { n: 0, net: 0, minutes: 0, envs: 0, parType: {} }
    hier = { n: 0, net: 0, minutes: 0, parType: {} }
  } else {
    const txs = res.list || []
    console.log('[cout] ' + txs.length + ' transaction(s) reçues (fenêtre 2 jours)')
    if (txs[0]) console.log('[cout] échantillon brut : ' + JSON.stringify(txs[0]).slice(0, 400))
    jour = classer(txs, debutJour, maintenant)
    hier = classer(txs, debutHier, debutJour - 1)
    console.log('[cout] AUJOURD-HUI net=' + jour.net + ' pos=' + jour.positifs + ' neg=' + jour.negatifs + ' min=' + jour.minutes + ' env=' + jour.envs + ' n=' + jour.n)
    console.log('[cout] HIER net=' + hier.net + ' min=' + hier.minutes + ' n=' + hier.n)
  }

  wallet = await soldeWallet().catch(e => ({ error: 'exception:' + (e && e.message) }))
  if (wallet && wallet.error) console.error('[cout] wallet KO : ' + wallet.error + ' ' + (wallet.msg || ''))
  else console.log('[cout] wallet balance=' + (wallet && wallet.balance) + ' addon=' + (wallet && wallet.availableTimeAddOn))

  const embed = construireEmbed(jour, hier, wallet, note)

  if (INTERACTION_TOKEN && APPLICATION_ID) {
    await editerInteraction({ embeds: [embed] })
    console.log('[cout] réponse interaction éditée (éphémère)')
  } else {
    const salon = await trouverSalon()
    if (!salon) { console.error('[cout] salon introuvable pour poster'); process.exit(1) }
    await discord('POST', '/channels/' + salon + '/messages', { embeds: [embed] })
    console.log('[cout] posté dans le salon ' + salon)
  }
}

main().then(() => { console.log('[cout] terminé'); process.exit(0) })
  .catch(e => { console.error('[cout] erreur fatale : ' + (e && e.stack ? e.stack : e)); process.exit(1) })
