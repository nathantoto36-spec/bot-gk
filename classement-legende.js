// ---------------------------------------------------------------------------
// Classement "comptes sans legende" - a la demande (bouton Discord).
//
// Declenche de 2 facons :
//   - repository_dispatch (clic sur le bouton -> Worker Cloudflare -> GitHub) :
//       INTERACTION_TOKEN + APPLICATION_ID fournis -> on EDITE la reponse
//       differee de l'interaction (message public dans le salon).
//   - workflow_dispatch (manuel) :
//       ACTION=panel      -> (re)poste le message-bouton dans le salon.
//       ACTION=classement -> calcule et poste le classement directement.
//
// Le classement : pour chaque compte des 2 groupes, nombre de reels publies
// SANS legende sur les 24 dernieres heures, du plus eleve au plus faible.
// ---------------------------------------------------------------------------

import { listPhonesInGroup, nomsValides } from './geelark.js'
import { reelsDuCompte } from './instagram.js'

const TOKEN = process.env.DISCORD_BOT_TOKEN
const API = 'https://discord.com/api/v10'
const dodo = ms => new Promise(r => setTimeout(r, ms))

const SALON = process.env.SALON_CLASSEMENT_LEGENDE || ''
const ACTION = (process.env.ACTION || 'classement').toLowerCase()
const INTERACTION_TOKEN = process.env.INTERACTION_TOKEN || ''
const APPLICATION_ID = process.env.APPLICATION_ID || ''
const FENETRE_H = parseInt(process.env.LEGENDE_FENETRE_H || '24', 10)
const CONCURRENCE = parseInt(process.env.INSTA_CONCURRENCE || '5', 10)
const CUSTOM_ID = process.env.LEGENDE_BOUTON_ID || 'classement_sans_legende'

// Les 2 groupes GeeLark (nom + mode brut, comme dans bot.yml / bot2.yml).
const GROUPES = [
  { label: 'tkanuya account', nom: 'tkanuya account', raw: false },
  { label: 'tkanuya account 2', nom: 'tkanuya account 2', raw: true },
]

function nombre(n) {
  return Number(n || 0).toLocaleString('fr-FR').replace(/ /g, ' ')
}

// --- Discord REST (avec le token du bot) -----------------------------------
async function discord(methode, chemin, corps) {
  const entetes = {
    Authorization: 'Bot ' + TOKEN,
    'Content-Type': 'application/json',
    'User-Agent': 'bot-gk-legende (github-actions, 1.0)',
  }
  for (let essai = 0; essai < 5; essai++) {
    let r
    try {
      r = await fetch(API + chemin, { method: methode, headers: entetes, body: corps ? JSON.stringify(corps) : undefined })
    } catch (e) {
      if (essai === 4) throw e
      await dodo(1500); continue
    }
    if (r.status === 429) {
      const j = await r.json().catch(() => ({}))
      await dodo(Math.min((j.retry_after || 1) * 1000 + 300, 15000)); continue
    }
    if (r.status >= 500) { await dodo(1500); continue }
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('HTTP ' + r.status + ' ' + methode + ' ' + chemin + ' ' + t.slice(0, 200)) }
    if (r.status === 204) return null
    return r.json().catch(() => null)
  }
  throw new Error('discord: trop de tentatives sur ' + chemin)
}

// Edite la reponse differee d'une interaction (pas besoin du token du bot).
async function editerInteraction(payload) {
  const url = API + '/webhooks/' + APPLICATION_ID + '/' + INTERACTION_TOKEN + '/messages/@original'
  for (let essai = 0; essai < 5; essai++) {
    let r
    try {
      r = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'User-Agent': 'bot-gk-legende' }, body: JSON.stringify(payload) })
    } catch (e) { if (essai === 4) throw e; await dodo(1500); continue }
    if (r.status === 429) { const j = await r.json().catch(() => ({})); await dodo(Math.min((j.retry_after || 1) * 1000 + 300, 15000)); continue }
    if (r.status >= 500) { await dodo(1500); continue }
    if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('HTTP ' + r.status + ' PATCH interaction ' + t.slice(0, 200)) }
    return r.json().catch(() => null)
  }
  throw new Error('interaction: trop de tentatives')
}

// --- Lecture Instagram (pool de concurrence) -------------------------------
async function poolMap(items, taille, fn) {
  const resultats = new Array(items.length)
  let i = 0
  async function worker() {
    while (i < items.length) {
      const k = i++
      resultats[k] = await fn(items[k])
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(taille, items.length)) }, worker))
  return resultats
}

// --- Comptes des 2 groupes -------------------------------------------------
async function listerTousLesComptes() {
  const vus = new Set()
  const comptes = []
  for (const gr of GROUPES) {
    process.env.GEELARK_GROUP_RAW = gr.raw ? 'true' : 'false'
    let g
    try { g = await listPhonesInGroup(gr.nom) } catch (e) { console.error('[geelark] ' + gr.label + ' : ' + e.message); continue }
    if (!g || g.error) { console.error('[geelark] ' + gr.label + ' : ' + ((g && g.error) || 'inconnu')); continue }
    const v = nomsValides(g.items)
    for (const c of v.ok) {
      if (vus.has(c.username)) continue
      vus.add(c.username)
      comptes.push({ username: c.username, groupe: gr.label })
    }
    console.log('[geelark] ' + gr.label + ' : ' + v.ok.length + ' comptes')
  }
  return comptes
}

// --- Construction du classement --------------------------------------------
function construireEmbeds(rangs, lus, total, illisibles) {
  const horod = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

  const lignes = rangs.map((c, i) => {
    const rang = i + 1
    const medaille = rang === 1 ? '🥇' : rang === 2 ? '🥈' : rang === 3 ? '🥉' : '`#' + String(rang).padStart(3, ' ') + '`'
    const lien = 'https://www.instagram.com/' + c.username + '/'
    return medaille + ' [@' + c.username + '](' + lien + ') — **' + c.sansLegende + '** reel' + (c.sansLegende > 1 ? 's' : '') +
           ' sans légende · ' + c.groupe
  })

  const blocs = []
  let courant = []
  let taille = 0
  for (const l of lignes) {
    if (courant.length && taille + l.length + 1 > 3000) { blocs.push(courant); courant = []; taille = 0 }
    courant.push(l); taille += l.length + 1
  }
  if (courant.length) blocs.push(courant)
  if (!blocs.length) blocs.push(['✅ Aucun compte sans légende sur ' + FENETRE_H + 'h. Tout le monde a mis une légende !'])

  const totalSansLeg = rangs.reduce((s, c) => s + c.sansLegende, 0)
  const entete = '🚫 Reels **sans légende** sur ' + FENETRE_H + 'h · **' + rangs.length +
    '** compte(s) concerné(s) · **' + totalSansLeg + '** reel(s) sans légende au total' +
    String.fromCharCode(10) + '_' + lus + '/' + total + ' comptes lus' +
    (illisibles ? ' · ' + illisibles + ' non lus ce cycle' : '') + ' · maj ' + horod + '_'

  return blocs.map((bloc, i) => ({
    color: 0xed4245,
    title: i === 0 ? '🚫 Classement · comptes sans légende (' + FENETRE_H + 'h)' : '🚫 Classement (suite ' + (i + 1) + '/' + blocs.length + ')',
    description: (i === 0 ? entete + String.fromCharCode(10) + String.fromCharCode(10) : '') + bloc.join(String.fromCharCode(10)).slice(0, 3900),
    footer: { text: i === blocs.length - 1 ? 'Classement à la demande · appuie sur le bouton pour actualiser' : 'suite…' },
  }))
}

// --- Le message-bouton (panneau) -------------------------------------------
function panneauPayload() {
  return {
    embeds: [{
      color: 0x5865f2,
      title: '📊 Classement des comptes sans légende',
      description: 'Appuie sur le bouton ci-dessous pour afficher, **à la demande**, le classement des comptes ' +
        'ayant publié des reels **sans légende** sur les ' + FENETRE_H + ' dernières heures (les 2 groupes réunis).' +
        String.fromCharCode(10) + String.fromCharCode(10) + '_Le calcul prend ~1 à 3 min (lecture Instagram en direct)._',
      footer: { text: 'gkpanel:legende' },
    }],
    components: [{
      type: 1,
      components: [{ type: 2, style: 1, label: 'Voir le classement', emoji: { name: '📊' }, custom_id: CUSTOM_ID }],
    }],
  }
}

// Cherche un panneau existant (footer gkpanel:legende) pour ne pas dupliquer.
async function panneauExiste() {
  try {
    const msgs = await discord('GET', '/channels/' + SALON + '/messages?limit=50')
    return (msgs || []).some(m => (m.embeds || []).some(e => e.footer && e.footer.text === 'gkpanel:legende'))
  } catch { return false }
}

// --- Programme principal ----------------------------------------------------
async function main() {
  if (!TOKEN) { console.error('[FATAL] DISCORD_BOT_TOKEN absent'); process.exit(1) }
  if (!SALON) { console.error('[FATAL] SALON_CLASSEMENT_LEGENDE absent'); process.exit(1) }

  // Mode "panneau" : on (re)poste le message-bouton une seule fois.
  if (ACTION === 'panel' && !INTERACTION_TOKEN) {
    if (await panneauExiste()) { console.log('[panel] déjà présent, rien à faire'); return }
    await discord('POST', '/channels/' + SALON + '/messages', panneauPayload())
    console.log('[panel] message-bouton posté dans le salon')
    return
  }

  // Calcul du classement.
  const comptes = await listerTousLesComptes()
  console.log('[classement] ' + comptes.length + ' comptes à lire (2 groupes)')
  if (!comptes.length) {
    const payload = { embeds: [{ color: 0xed4245, title: '🚫 Classement · comptes sans légende', description: '⚠️ Aucun compte récupéré depuis GeeLark. Réessaie plus tard.' }] }
    if (INTERACTION_TOKEN) await editerInteraction(payload); else await discord('POST', '/channels/' + SALON + '/messages', payload)
    return
  }

  const t0 = Date.now()
  const lectures = await poolMap(comptes, CONCURRENCE, async (c) => {
    const res = await reelsDuCompte(c.username).catch(e => ({ erreur: 'reseau:' + (e && e.message) }))
    return { c, res }
  })

  const maintenant = Date.now()
  const rangs = []
  let lus = 0
  let illisibles = 0
  for (const { c, res } of lectures) {
    if (!res || res.erreur) { illisibles++; continue }
    lus++
    const recents = (res.reels || []).filter(r => r.posteA && (maintenant - r.posteA) <= FENETRE_H * 3600e3)
    const sansLeg = recents.filter(r => String(r.legende || '').trim() === '').length
    if (sansLeg > 0) rangs.push({ username: c.username, groupe: c.groupe, sansLegende: sansLeg })
  }
  rangs.sort((a, b) => b.sansLegende - a.sansLegende || a.username.localeCompare(b.username))
  console.log('[classement] ' + rangs.length + ' comptes avec reels sans légende · ' + lus + '/' + comptes.length +
              ' lus · ' + illisibles + ' non lus · ' + Math.round((Date.now() - t0) / 1000) + 's')

  const embeds = construireEmbeds(rangs, lus, comptes.length, illisibles)

  // On envoie : soit on edite la reponse de l'interaction, soit on poste dans le salon.
  if (INTERACTION_TOKEN && APPLICATION_ID) {
    // Reponse EPHEMERE (visible par le cliqueur seul) : tout dans le message @original.
    // Discord accepte jusqu'a 10 embeds par message ; le classement tient largement dedans.
    await editerInteraction({ embeds: embeds.slice(0, 10) })
    console.log('[classement] réponse interaction éditée (éphémère, ' + Math.min(embeds.length, 10) + ' embed(s))')
  } else {
    for (const emb of embeds) { await discord('POST', '/channels/' + SALON + '/messages', { embeds: [emb] }); await dodo(600) }
    console.log('[classement] posté dans le salon (' + embeds.length + ' embed(s))')
  }
}

main().then(() => { console.log('[legende] terminé'); process.exit(0) })
  .catch(e => { console.error('[legende] erreur fatale : ' + (e && e.stack ? e.stack : e)) ; process.exit(1) })
