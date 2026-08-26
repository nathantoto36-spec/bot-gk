// ---------------------------------------------------------------------------
// Bot Discord "SMS ROTATION" - suivi des reels des comptes GeeLark
//
// Version GitHub Actions : le script fait UN cycle puis se termine.
//   1. recupere les profils du groupe GeeLark (le nom du profil = pseudo IG)
//   2. lit les derniers reels de chaque compte sur Instagram
//   3. poste UN message par reel dans #resultats-reels, aux paliers d'age
//      (1h, 2h, 6h, 12h, 24h apres publication)
//   4. poste le classement des comptes dans #classement-comptes
//
// Pas de gateway Discord (l'IP datacenter etait bloquee) : tout passe par
// l'API REST de Discord. L'etat (feedbacks deja postes, totaux precedents)
// est reconstruit a chaque execution depuis l'historique des salons.
// ---------------------------------------------------------------------------

import { listPhonesInGroup, nomsValides } from './geelark.js'
import { reelsDuCompte, etatCookie, reactiverCookie, pseudosCorriges } from './instagram.js'
import { indexVivants, purgerSalon } from './nettoyage.js'

// --- Configuration ---------------------------------------------------------

const TOKEN = process.env.DISCORD_BOT_TOKEN
const SALON_REELS = process.env.SALON_REELS || '1539369975133765703'
const SALON_CLASSEMENT = process.env.SALON_CLASSEMENT || '1539370313463111720'
const GROUPE_GEELARK = process.env.GEELARK_GROUP || 'tkanuya account'

const COMPTES_MANUELS = (process.env.COMPTES_MANUELS || '')
  .split(',').map(x => x.trim().toLowerCase().replace(/^@/, ''))
  .filter(x => /^[a-z0-9._]{1,30}$/.test(x))

const PALIERS = (process.env.PALIERS || '1,2,6,12,24')
  .split(',').map(x => parseInt(x.trim(), 10)).filter(n => n > 0).sort((a, b) => a - b)

const PALIER_MAX_H = PALIERS[PALIERS.length - 1] || 24
const PAUSE_DISCORD_MS = parseInt(process.env.PAUSE_DISCORD_MS || '1200', 10)
const MAX_MESSAGES_PAR_CYCLE = parseInt(process.env.MAX_MESSAGES || '120', 10)
// IP GitHub Actions propre : on peut lire en parallele (petit pool) sans se
// faire bloquer comme sur Render. On garde une retentative pour les a-coups.
const CONCURRENCE = parseInt(process.env.INSTA_CONCURRENCE || '5', 10)
const REPOS_MS = parseInt(process.env.REPOS_MS || '15000', 10)
const RETENTATIVES = parseInt(process.env.RETENTATIVES || '1', 10)
// Budget de temps : passe ce delai on POSTE ce qu'on a (garde-fou minutes Actions).
const BUDGET_MS = parseInt(process.env.BUDGET_MS || '480000', 10) // 8 min
// Combien de pages d'historique relire (100 msg/page) pour reconstruire l'etat.
const PAGES_HISTO = parseInt(process.env.PAGES_HISTO || '15', 10)
// Mouchard Instagram : comptes surveilles (IG_WATCH="pseudo1,pseudo2") dont on
// journalise les reels bruts + leur age, pour diagnostiquer un faux "0 reel".
const IG_WATCH = (process.env.IG_WATCH || '').split(',').map(x => x.trim().toLowerCase().replace(/^@/, '')).filter(Boolean)
// Salon dedie aux comptes illisibles (non lus). Trouve par NOM si l'ID n'est pas fourni.
const SALON_ILLISIBLE = process.env.SALON_ILLISIBLE || ''
const SALON_ILLISIBLE_NOM = process.env.SALON_ILLISIBLE_NOM || 'comptes-illisible'
const SALON_BANS = process.env.SALON_BANS || ''
// Salon dedie aux reels encore a 0 vue apres ZERO_PALIER_H heures (defaut 1h).
const SALON_ZERO = process.env.SALON_ZERO || ''
const ZERO_PALIER_H = parseInt(process.env.ZERO_PALIER_H || '1', 10)
const zeroVus = new Set()          // reels deja signales a 0 vue (par code)
// Salon dedie au classement par MOYENNE de vues/reel (un salon par groupe).
const SALON_MOYENNE = process.env.SALON_MOYENNE || ''
// NETTOYER=off desactive le menage des comptes disparus de GeeLark.
const NETTOYER = process.env.NETTOYER || 'on'
// Suivi bans : nb de cycles d'illisibilite consecutive avant de classer un compte "ban probable".
const SEUIL_BAN_CYCLES = parseInt(process.env.SEUIL_BAN_CYCLES || '12', 10)
const banStreaks = new Map()   // username -> cycles illisibles consecutifs
let banStateMsgId = null       // id du message d'etat (compteurs) dans SALON_BANS
// Salon dedie aux reels qui depassent VUES_MIN_500 vues (entre 1h et 24h).
const SALON_500 = process.env.SALON_500 || ''
const VUES_MIN_500 = parseInt(process.env.VUES_MIN_500 || '500', 10)
const cinqCentVus = new Set()  // reels deja signales 500+ vues (par code)
// Salon dedie aux reels postes SANS legende (caption vide).
const SALON_LEGENDE = process.env.SALON_LEGENDE || ''
const sansLegendeVus = new Set()  // reels deja signales sans legende (par code)

if (!TOKEN) {
  console.error("[FATAL] Variable d'environnement DISCORD_BOT_TOKEN absente.")
  process.exit(1)
}

const dodo = ms => new Promise(r => setTimeout(r, ms))
const t0 = Date.now()

// --- Etat (reconstruit a chaque execution) ---------------------------------

const dejaPoste = new Set()          // "<code>:<palier>"
const totauxPrecedents = new Map()   // username -> vues totales du cycle precedent
let premierCycle = false             // vrai seulement si aucun historique retrouve

// --- API REST Discord ------------------------------------------------------

const API = 'https://discord.com/api/v10'
const ENTETES = {
  Authorization: 'Bot ' + TOKEN,
  'Content-Type': 'application/json',
  'User-Agent': 'bot-gk (github-actions, 1.0)',
}

async function discord(methode, chemin, corps) {
  for (let essai = 0; essai < 5; essai++) {
    let r
    try {
      r = await fetch(API + chemin, {
        method: methode,
        headers: ENTETES,
        body: corps ? JSON.stringify(corps) : undefined,
      })
    } catch (e) {
      if (essai === 4) throw e
      await dodo(1500)
      continue
    }
    if (r.status === 429) {
      const j = await r.json().catch(() => ({}))
      const attente = Math.min((j.retry_after || 1) * 1000 + 300, 15000)
      console.warn('[discord] 429 sur ' + chemin + ' -> pause ' + Math.round(attente) + ' ms')
      await dodo(attente)
      continue
    }
    if (r.status >= 500) { await dodo(1500); continue }
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      throw new Error('HTTP ' + r.status + ' ' + methode + ' ' + chemin + ' ' + t.slice(0, 200))
    }
    if (r.status === 204) return null
    return r.json().catch(() => null)
  }
  throw new Error('discord: trop de tentatives sur ' + chemin)
}

async function lireMessages(chId, pages) {
  const out = []
  let avant
  for (let p = 0; p < pages; p++) {
    const q = '?limit=100' + (avant ? '&before=' + avant : '')
    const msgs = await discord('GET', '/channels/' + chId + '/messages' + q)
    if (!msgs || !msgs.length) break
    out.push(...msgs)
    avant = msgs[msgs.length - 1].id
    await dodo(350)
  }
  return out
}

function poster(chId, payload) {
  return discord('POST', '/channels/' + chId + '/messages', payload)
}

// Signature stable d'un embed (compteurs + comptes par raison), en IGNORANT l'horodatage.
// Permet de ne pas reposter un message identique au cycle precedent (anti-spam).
function signatureEmbed(emb) {
  if (!emb) return 'null'
  const champs = (emb.fields || []).map(function (f) {
    const raison = (String(f.name || '').match(/[a-zA-Z_]+/g) || []).join('_')
    const noms = String(f.value || '').replace(/`/g, '').split(String.fromCharCode(10)).map(function (x) { return x.trim() }).filter(Boolean).sort()
    return raison + ':' + noms.join(',')
  }).sort()
  const d = String(emb.description || '')
  const mm = d.match(/(\d+)\s*\/\s*(\d+)/)
  const compteurs = mm ? mm[1] + '/' + mm[2] : ''
  const vide = /tous les comptes ont/.test(d) ? 'ok' : 'ko'
  return compteurs + '|' + vide + '|' + champs.join('|')
}

// true si le dernier message du MEME groupe (meme titre) dans ce salon a la meme signature.
async function memeQueDernier(chId, moiId, emb) {
  try {
    const titre = String(emb.title || '')
    const msgs = await lireMessages(chId, 1)
    const dernier = (msgs || []).find(function (m) {
      if (moiId && !(m.author && m.author.id === moiId)) return false
      const e0 = m.embeds && m.embeds[0]
      return e0 && String(e0.title || '') === titre
    })
    if (!dernier) return false
    return signatureEmbed(dernier.embeds[0]) === signatureEmbed(emb)
  } catch (e) { return false }
}

// --- Mise en forme ---------------------------------------------------------

function nombre(n) {
  return Number(n || 0).toLocaleString('fr-FR')
}

function verdict(vues) {
  if (vues >= 5000) return { emoji: '💥', label: 'VIRAL', couleur: 0x9b59b6, conseil: 'Ce reel explose. Reposte le meme format sur les autres comptes, et enchaine vite un 2e post pendant que la portee est haute.' }
  if (vues >= 1000) return { emoji: '🚀', label: 'CA MONTE', couleur: 0x3498db, conseil: 'Bonne dynamique. Garde ce hook et ce son, et republie a la meme heure demain.' }
  if (vues >= 100) return { emoji: '🔥', label: 'BON DEBUT', couleur: 0xe67e22, conseil: "Le contenu accroche deja. Reponds aux commentaires pour pousser encore la portee." }
  return { emoji: '🌱', label: 'DEMARRAGE', couleur: 0x95a5a6, conseil: 'Ca demarre doucement. Pour le prochain : hook plus fort des la 1re seconde, son tendance, et poste a ta meilleure heure.' }
}

function embedSansLegende(username, reel) {
  const ageH = reel.posteA ? ((Date.now() - reel.posteA) / 3600e3).toFixed(1) : '?'
  const lien = reel.code ? 'https://www.instagram.com/reel/' + reel.code + '/' : null
  const lignes = []
  if (lien) lignes.push('[Voir le post ↗](' + lien + ')')
  lignes.push('`@' + username + '`')
  lignes.push('⚠️ **Aucune légende** sur ce reel (posté il y a ' + ageH + 'h)')
  lignes.push('🏷️ Groupe : **' + GROUPE_GEELARK + '**')
  return {
    color: 0xe67e22,
    title: '⚠️ Reel sans légende · @' + username,
    description: lignes.join('\n'),
    footer: { text: 'gkl:' + reel.code },
  }
}

function embedCinqCent(username, reel) {
  const ageH = reel.posteA ? ((Date.now() - reel.posteA) / 3600e3).toFixed(1) : '?'
  const lien = reel.code ? 'https://www.instagram.com/reel/' + reel.code + '/' : null
  const lignes = []
  if (lien) lignes.push('[Voir le post ↗](' + lien + ')')
  lignes.push('`@' + username + '`')
  lignes.push('🚀 **' + nombre(reel.vues) + '** vues après ' + ageH + 'h')
  lignes.push('🏷️ Groupe : **' + GROUPE_GEELARK + '**')
  return {
    color: 0x2ecc71,
    title: '🚀 500+ vues · @' + username,
    description: lignes.join('\n'),
    footer: { text: 'gk5:' + reel.code },
  }
}

function embedZeroVue(username, reel) {
  const ageH = reel.posteA ? ((Date.now() - reel.posteA) / 3600e3).toFixed(1) : '?'
  const lien = reel.code ? 'https://www.instagram.com/reel/' + reel.code + '/' : null
  const lignes = []
  if (lien) lignes.push('[Voir le post ↗](' + lien + ')')
  lignes.push('`@' + username + '`')
  lignes.push('⚠️ **0 vue** après ' + ageH + 'h')
  lignes.push('🏷️ Groupe : **' + GROUPE_GEELARK + '**')
  return {
    color: 0x992d22,
    title: '⬇️ Reel à 0 vue · @' + username,
    description: lignes.join('\n'),
    footer: { text: 'gk0:' + reel.code },
  }
}

function embedReel(username, reel, palier) {
  const v = verdict(reel.vues)
  const interactions = (reel.likes || 0) + (reel.commentaires || 0)
  const taux = reel.vues > 0 ? ((interactions / reel.vues) * 100).toFixed(1) : '0.0'
  const lien = reel.code ? 'https://www.instagram.com/reel/' + reel.code + '/' : null

  const lignes = []
  if (lien) lignes.push('[Voir le post ↗](' + lien + ')')
  lignes.push('`@' + username + '`')
  lignes.push('👁️ **' + nombre(reel.vues) + '** vues · ❤️ ' + nombre(reel.likes) +
              ' · 💬 ' + nombre(reel.commentaires) + ' · 📊 ' + taux + '%')
  lignes.push('📈 ' + nombre(reel.vues) + ' vues après ' + palier + 'h')
  lignes.push('')
  lignes.push('💡 ' + v.conseil)

  return {
    color: v.couleur,
    title: v.emoji + ' Feedback ' + palier + 'h · ' + v.label,
    description: lignes.join('\n'),
    footer: { text: 'gk:' + reel.code + ':' + palier },
  }
}

function embedsClassement(classement, horodatage, bilan) {
  const lignes = classement.map((c, i) => {
    const rang = i + 1
    const medaille = rang === 1 ? '🥇' : rang === 2 ? '🥈' : rang === 3 ? '🥉'
      : '`#' + String(rang).padStart(3, ' ') + '`'
    if (!c.reels) {
      return medaille + ' `@' + c.username + '` — aucun reel sur ' + PALIER_MAX_H + 'h'
    }
    const delta = c.delta > 0 ? ' (+' + nombre(c.delta) + ')' : ''
    return medaille + ' `@' + c.username + '` — **' + nombre(c.vues) + '** vues' + delta +
           ' · ' + c.reels + ' reel' + (c.reels > 1 ? 's' : '')
  })

  const blocs = []
  let courant = []
  let taille = 0
  for (const l of lignes) {
    if (courant.length && taille + l.length + 1 > 3000) { blocs.push(courant); courant = []; taille = 0 }
    courant.push(l); taille += l.length + 1
  }
  if (courant.length) blocs.push(courant)

  const total = classement.reduce((s, c) => s + c.vues, 0)
  const totalReels = classement.reduce((s, c) => s + (c.reels || 0), 0)
  const avecReels = classement.filter(c => c.reels > 0).length
  const sansReel = classement.length - avecReels

  // En-tete affiche EN HAUT du classement : nombre total de reels comptabilises
  // (tous comptes confondus) et total des vues cumulees.
  const entete = '📊 **' + nombre(totalReels) + '** reels comptabilisés · 👁️ **' +
    nombre(total) + '** vues cumulées sur ' + PALIER_MAX_H + 'h'

  const pied = [
    classement.length + ' comptes lus',
    sansReel ? sansReel + ' sans reel' : null,
    bilan && bilan.connexion ? bilan.connexion + ' nécessitent une session Instagram' : null,
    bilan && (bilan.illisibles - (bilan.connexion || 0)) > 0
      ? (bilan.illisibles - bilan.connexion) + ' illisibles' : null,
    bilan && bilan.cibles ? 'sur ' + bilan.cibles + ' du groupe' : null,
    nombre(total) + ' vues cumulées sur ' + PALIER_MAX_H + 'h',
  ].filter(Boolean).join(' · ')

  return blocs.map((bloc, i) => ({
    color: 0xf1c40f,
    title: i === 0
      ? '🏆 Classement des comptes · ' + horodatage
      : '🏆 Classement (suite ' + (i + 1) + '/' + blocs.length + ')',
    description: (i === 0 ? entete + '\n\n' : '') + bloc.join('\n').slice(0, 3800),
    footer: { text: i === blocs.length - 1 ? pied : 'suite…' },
  }))
}

function embedsMoyenne(classement, horodatage) {
  const actifs = classement.filter(c => c.reels > 0)
    .map(c => ({ username: c.username, vues: c.vues, reels: c.reels, moyenne: Math.round(c.vues / c.reels) }))
    .sort((a, b) => b.moyenne - a.moyenne)
  const lignes = actifs.map((c, i) => {
    const rang = i + 1
    const medaille = rang === 1 ? '🥇' : rang === 2 ? '🥈' : rang === 3 ? '🥉'
      : '`#' + String(rang).padStart(3, ' ') + '`'
    return medaille + ' `@' + c.username + '` — **' + nombre(c.moyenne) + '** vues/reel · ' +
           c.reels + ' reel' + (c.reels > 1 ? 's' : '') + ' · ' + nombre(c.vues) + ' vues'
  })

  const blocs = []
  let courant = []
  let taille = 0
  for (const l of lignes) {
    if (courant.length && taille + l.length + 1 > 3000) { blocs.push(courant); courant = []; taille = 0 }
    courant.push(l); taille += l.length + 1
  }
  if (courant.length) blocs.push(courant)
  if (!blocs.length) blocs.push(['Aucun compte avec reel sur ' + PALIER_MAX_H + 'h.'])

  const moyGlobale = actifs.length ? Math.round(actifs.reduce((s, c) => s + c.moyenne, 0) / actifs.length) : 0
  const entete = '📊 Moyenne de vues par reel sur ' + PALIER_MAX_H + 'h · **' + actifs.length +
    '** comptes actifs · moyenne globale **' + nombre(moyGlobale) + '** vues/reel'

  return blocs.map((bloc, i) => ({
    color: 0x5865f2,
    title: i === 0
      ? '📊 Classement moyenne · groupe "' + GROUPE_GEELARK + '" · ' + horodatage
      : '📊 Classement moyenne (suite ' + (i + 1) + '/' + blocs.length + ')',
    description: (i === 0 ? entete + '\n\n' : '') + bloc.join('\n').slice(0, 3800),
    footer: { text: i === blocs.length - 1 ? actifs.length + ' comptes classés · moyenne = vues ÷ reels' : 'suite…' },
  }))
}

// --- Reconstruction de l'etat depuis l'historique Discord -------------------

async function reconstruireEtat(moiId) {
  // #reels : recuperer les feedbacks deja postes (footer "gk:<code>:<palier>").
  let feedbacksVus = 0
  try {
    const msgs = await lireMessages(SALON_REELS, PAGES_HISTO)
    for (const m of msgs) {
      if (m.author && m.author.id !== moiId) continue
      for (const e of (m.embeds || [])) {
        const f = e.footer && e.footer.text
        if (f && f.startsWith('gk:')) { dejaPoste.add(f.slice(3)); feedbacksVus++ }
      }
    }
  } catch (e) {
    console.error('[etat] lecture #reels : ' + e.message)
  }
  // Premier cycle "a froid" seulement si on ne retrouve AUCUN feedback : sinon
  // on ne veut surtout pas re-marquer 24 h de reels d'un coup.
  premierCycle = dejaPoste.size === 0
  console.log('[etat] ' + dejaPoste.size + ' feedbacks deja postes retrouves (premierCycle=' + premierCycle + ')')

  // #0-vues : recuperer les reels deja signales (footer "gk0:<code>").
  if (SALON_ZERO) {
    try {
      const msgs = await lireMessages(SALON_ZERO, PAGES_HISTO)
      for (const m of msgs) {
        if (m.author && m.author.id !== moiId) continue
        for (const e of (m.embeds || [])) {
          const f = e.footer && e.footer.text
          if (f && f.startsWith('gk0:')) zeroVus.add(f.slice(4))
        }
      }
      console.log('[etat] ' + zeroVus.size + ' reels 0-vues deja signales')
    } catch (e) { console.error('[etat] lecture #0-vues : ' + e.message) }
  }

  // Suivi bans : recuperer les compteurs d'illisibilite consecutive (footer "gkstate:<groupe>").
  if (SALON_BANS) {
    try {
      const msgs = await lireMessages(SALON_BANS, 3)
      const cible = 'gkstate:' + GROUPE_GEELARK
      for (const m of msgs) {
        if (m.author && m.author.id !== moiId) continue
        const e0 = (m.embeds || [])[0]
        const f = e0 && e0.footer && e0.footer.text
        if (f === cible) {
          banStateMsgId = m.id
          try {
            const parts = String(e0.description || '').split('```')
            const obj = JSON.parse((parts[1] || '{}').trim() || '{}')
            for (const k of Object.keys(obj)) banStreaks.set(k, obj[k])
          } catch (x) { /* etat illisible, on repart de zero */ }
          break
        }
      }
      console.log('[etat] suivi bans : ' + banStreaks.size + ' compteurs (msg ' + (banStateMsgId ? 'trouve' : 'a creer') + ')')
    } catch (e) { console.error('[etat] lecture suivi bans : ' + e.message) }
  }

  // #500 : recuperer les reels 500+ deja signales (footer "gk5:<code>").
  if (SALON_500) {
    try {
      const msgs = await lireMessages(SALON_500, PAGES_HISTO)
      for (const m of msgs) {
        if (m.author && m.author.id !== moiId) continue
        for (const e of (m.embeds || [])) {
          const f = e.footer && e.footer.text
          if (f && f.startsWith('gk5:')) cinqCentVus.add(f.slice(4))
        }
      }
      console.log('[etat] ' + cinqCentVus.size + ' reels 500+ deja signales')
    } catch (e) { console.error('[etat] lecture #500 : ' + e.message) }
  }

  // #legende : recuperer les reels sans legende deja signales (footer "gkl:<code>").
  if (SALON_LEGENDE) {
    try {
      const msgs = await lireMessages(SALON_LEGENDE, PAGES_HISTO)
      for (const m of msgs) {
        if (m.author && m.author.id !== moiId) continue
        for (const e of (m.embeds || [])) {
          const f = e.footer && e.footer.text
          if (f && f.startsWith('gkl:')) sansLegendeVus.add(f.slice(4))
        }
      }
      console.log('[etat] ' + sansLegendeVus.size + ' reels sans legende deja signales')
    } catch (e) { console.error('[etat] lecture #legende : ' + e.message) }
  }

  // #classement : recuperer les totaux du dernier classement pour calculer le delta.
  try {
    const msgs = await lireMessages(SALON_CLASSEMENT, 2)
    const reLigne = /`@([a-z0-9._]+)`\s+—\s+\*\*([\d\s  .,]+)\*\*\s+vues/gi
    for (const m of msgs) {
      if (m.author && m.author.id !== moiId) continue
      for (const e of (m.embeds || [])) {
        const d = e.description || ''
        let mm
        while ((mm = reLigne.exec(d))) {
          const user = mm[1]
          const val = parseInt(mm[2].replace(/[^\d]/g, ''), 10)
          if (!totauxPrecedents.has(user) && Number.isFinite(val)) totauxPrecedents.set(user, val)
        }
      }
    }
    console.log('[etat] ' + totauxPrecedents.size + ' totaux precedents retrouves (pour le delta)')
  } catch (e) {
    console.error('[etat] lecture #classement : ' + e.message)
  }
}

// --- Lecture Instagram (pool de concurrence) -------------------------------

async function poolMap(items, taille, fn) {
  const resultats = new Array(items.length)
  let idx = 0
  async function worker() {
    while (idx < items.length) {
      const i = idx++
      if (Date.now() - t0 > BUDGET_MS) { resultats[i] = { c: items[i], res: { erreur: 'budget' } }; continue }
      resultats[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(taille, items.length)) }, worker))
  return resultats
}

// Un reel est-il dans la fenetre de suivi PALIER_MAX_H
const aUnRecent = (res) => !!(res && res.reels && res.reels.some(r => r.posteA && (Date.now() - r.posteA) <= PALIER_MAX_H * 3600e3))

const lireCompte = async (c) => {
  let res = await reelsDuCompte(c.username).catch(e => ({ erreur: 'reseau:' + (e && e.message) }))
  // Reprise underscore : profil GeeLark nomme maddyglasses alors que le vrai
  // compte Instagram est maddyglasses avec underscore. Si aucun reel recent,
  // on retente le pseudo + underscore et on adopte si cette version a un reel recent.
  if (res && res.reels && !aUnRecent(res) && !/[._]$/.test(c.username)) {
    const alt = await reelsDuCompte(c.username + '_').catch(() => null)
    if (alt && aUnRecent(alt)) { console.log('[fix-underscore] ' + c.username + ' -> ' + c.username + '_'); res = alt; c.username = c.username + '_' }
  }
  return { c, res }
}

// --- Cycle -----------------------------------------------------------------

async function cycle() {
  reactiverCookie()
  console.log('[cycle] demarrage (GitHub Actions, one-shot)')

  // 0. Qui suis-je ? (pour filtrer mes propres messages dans l'historique)
  const moi = await discord('GET', '/users/@me')
  const moiId = moi && moi.id
  console.log('[discord] connecte en tant que ' + (moi ? moi.username : '?') + ' (' + moiId + ')')

  await reconstruireEtat(moiId)

  // 1. Liste des comptes.
  let comptes, rejetes = [], g = {}
  if (COMPTES_MANUELS.length) {
    comptes = COMPTES_MANUELS.map(u => ({ username: u, phoneId: '' }))
    console.log('[comptes] liste manuelle : ' + comptes.length + ' comptes, GeeLark non sollicite')
  } else {
    g = await listPhonesInGroup(GROUPE_GEELARK)
    if (g.error) {
      console.error('[geelark] erreur : ' + g.error + ' ' + (g.msg || g.body || ''))
      const noms = [...totauxPrecedents.keys()]
      if (!noms.length) { console.error('[geelark] pas de repli (aucun classement precedent)'); return }
      comptes = noms.map(u => ({ username: u, phoneId: '' }))
      console.log('[geelark] REPLI : ' + comptes.length + ' comptes repris du dernier classement Discord')
    } else {
      const v = nomsValides(g.items)
      comptes = v.ok
      rejetes = v.rejetes
    }
  }
  if (g.groupes) {
    const inventaire = Object.entries(g.groupes).sort((a, b) => b[1] - a[1])
      .map(([n, c]) => n + ' (' + c + ')').join(' | ')
    console.log('[geelark] groupes du compte : ' + inventaire)
  }
  if (!COMPTES_MANUELS.length) {
    console.log('[geelark] groupe "' + GROUPE_GEELARK + '" : ' + comptes.length + ' comptes exploitables' +
                (rejetes.length ? ' (' + rejetes.length + ' noms ignores : ' + rejetes.slice(0, 5).join(', ') + ')' : ''))
  }
  if (!comptes.length) return

  // 2. Instagram (pool de concurrence + une passe de rattrapage)
  console.log('[insta] lecture de ' + comptes.length + ' comptes, concurrence ' + CONCURRENCE)
  let lectures = await poolMap(comptes, CONCURRENCE, lireCompte)

  const estAReprendre = (r) => r && r.erreur &&
    (r.erreur === 'rate_limit' || r.erreur === 'budget' || String(r.erreur).startsWith('reseau'))

  for (let essai = 1; essai <= RETENTATIVES; essai++) {
    const idxRetenter = []
    for (let i = 0; i < lectures.length; i++) if (estAReprendre(lectures[i].res)) idxRetenter.push(i)
    if (!idxRetenter.length) break
    if (Date.now() - t0 > BUDGET_MS) { console.warn('[insta] budget atteint -> on poste sans rattraper'); break }
    console.log('[insta] rattrapage ' + essai + '/' + RETENTATIVES + ' : ' + idxRetenter.length +
                ' comptes, pause ' + Math.round(REPOS_MS / 1000) + ' s')
    await dodo(REPOS_MS)
    const reReads = await poolMap(idxRetenter.map(i => lectures[i].c), Math.max(2, Math.floor(CONCURRENCE / 2)), lireCompte)
    idxRetenter.forEach((i, k) => { lectures[i] = reReads[k] })
  }

  // 3. Traitement des resultats -> classement + feedbacks a poster
  const maintenant = Date.now()
  const aPoster = []
  const zeroAPoster = []
  const cinqCentAPoster = []
  const sansLegendeAPoster = []
  const classement = []
  let comptesLus = 0
  const detailErreurs = {}
  const echecsDefinitifs = []
  const illisiblesDetail = []
  const besoinConnexion = []

  for (const { c, res } of lectures) {
    if (!res || res.erreur) {
      const err = (res && res.erreur) || 'inconnu'
      detailErreurs[err] = (detailErreurs[err] || 0) + 1
      echecsDefinitifs.push(c.username)
      illisiblesDetail.push({ u: c.username, err })
      if (err === 'connexion_requise' || err === 'cookie_refuse') besoinConnexion.push(c.username)
      continue
    }
    comptesLus++
    const recents = res.reels.filter(r => r.posteA && (maintenant - r.posteA) <= PALIER_MAX_H * 3600e3)
    if (IG_WATCH.includes(c.username)) {
      const detail = (res.reels || []).slice(0, 8).map(r =>
        'age=' + (r.posteA ? ((maintenant - r.posteA) / 3600e3).toFixed(1) + 'h' : 'NULL') + '/vues=' + (r.vues || 0)).join(' ; ')
      console.log('[ig-watch] ' + c.username + ' : reelsBruts=' + (res.reels || []).length +
        ' recents24h=' + recents.length + ' [' + detail + ']')
    }
    const vuesTotales = recents.reduce((s, r) => s + (r.vues || 0), 0)
    const avant = totauxPrecedents.get(c.username)
    classement.push({
      username: c.username,
      vues: vuesTotales,
      reels: recents.length,
      delta: typeof avant === 'number' ? Math.max(0, vuesTotales - avant) : 0,
    })

    for (const r of recents) {
      if (!r.code) continue
      const ageH = (maintenant - r.posteA) / 3600e3
      const franchis = PALIERS.filter(p => ageH >= p)
      // 500+ vues : signaler une fois par reel (a n'importe quel palier jusqu'a 24h).
      if (SALON_500 && (r.vues || 0) >= VUES_MIN_500 && !cinqCentVus.has(r.code)) { cinqCentAPoster.push({ username: c.username, reel: r }) }
      // Reel sans legende (caption vide) : signaler une fois par reel.
      if (SALON_LEGENDE && String(r.legende || '').trim() === '' && !sansLegendeVus.has(r.code)) { sansLegendeAPoster.push({ username: c.username, reel: r }) }
      if (!franchis.length) continue
      // Premier lancement a froid : on ne rejoue pas l'historique, on repart du flux.
      if (premierCycle && ageH > (parseInt(process.env.RATTRAPAGE_MAX_H || '3', 10))) {
        for (const p of PALIERS) dejaPoste.add(r.code + ':' + p)
        continue
      }
      const dernier = franchis[franchis.length - 1]
      for (const p of franchis) if (p !== dernier) dejaPoste.add(r.code + ':' + p)
      if (!dejaPoste.has(r.code + ':' + dernier)) {
        aPoster.push({ username: c.username, reel: r, palier: dernier })
      }
      // 0 vue apres ZERO_PALIER_H (1h) : signaler une fois par reel.
      if (SALON_ZERO && ageH >= ZERO_PALIER_H && (r.vues || 0) === 0 && !zeroVus.has(r.code)) {
        if (premierCycle && ageH > (parseInt(process.env.RATTRAPAGE_MAX_H || '3', 10))) { zeroVus.add(r.code) }
        else { zeroAPoster.push({ username: c.username, reel: r }) }
      }
    }
  }
  const erreursInsta = comptes.length - comptesLus

  // 4. Poster les feedbacks (du plus ancien au plus recent)
  aPoster.sort((a, b) => a.reel.posteA - b.reel.posteA || a.palier - b.palier)
  const tronque = aPoster.length > MAX_MESSAGES_PAR_CYCLE
  const lot = aPoster.slice(0, MAX_MESSAGES_PAR_CYCLE)
  if (tronque) {
    console.warn('[cycle] ' + aPoster.length + ' feedbacks en attente, seuls ' +
                 MAX_MESSAGES_PAR_CYCLE + ' postes ce cycle (le reste au prochain).')
  }
  let postes = 0
  for (const item of lot) {
    try {
      await poster(SALON_REELS, { embeds: [embedReel(item.username, item.reel, item.palier)] })
      dejaPoste.add(item.reel.code + ':' + item.palier)
      postes++
    } catch (e) {
      console.error('[discord] envoi echoue (' + item.username + ') : ' + e.message)
    }
    await dodo(PAUSE_DISCORD_MS)
  }

  // 4b. Reels encore a 0 vue apres 1h -> salon dedie (une fois par reel).
  if (SALON_ZERO && zeroAPoster.length) {
    zeroAPoster.sort((a, b) => a.reel.posteA - b.reel.posteA)
    const lotZero = zeroAPoster.slice(0, MAX_MESSAGES_PAR_CYCLE)
    let zpostes = 0
    for (const item of lotZero) {
      try {
        await poster(SALON_ZERO, { embeds: [embedZeroVue(item.username, item.reel)] })
        zeroVus.add(item.reel.code)
        zpostes++
      } catch (e) { console.error('[0-vues] envoi echoue (' + item.username + ') : ' + e.message) }
      await dodo(PAUSE_DISCORD_MS)
    }
    console.log('[0-vues] ' + zpostes + ' reel(s) signale(s) a 0 vue apres ' + ZERO_PALIER_H + 'h')
  }

  // 4c. Reels a 500+ vues -> salon dedie (une fois par reel, du plus vu au moins vu).
  if (SALON_500 && cinqCentAPoster.length) {
    cinqCentAPoster.sort((a, b) => (b.reel.vues || 0) - (a.reel.vues || 0))
    const lot500 = cinqCentAPoster.slice(0, MAX_MESSAGES_PAR_CYCLE)
    let c5 = 0
    for (const item of lot500) {
      try {
        await poster(SALON_500, { embeds: [embedCinqCent(item.username, item.reel)] })
        cinqCentVus.add(item.reel.code)
        c5++
      } catch (e) { console.error('[500] envoi echoue (' + item.username + ') : ' + e.message) }
      await dodo(PAUSE_DISCORD_MS)
    }
    console.log('[500] ' + c5 + ' reel(s) 500+ vues signale(s)')
  }

  // 4d. Reels sans legende -> salon dedie (une fois par reel).
  if (SALON_LEGENDE && sansLegendeAPoster.length) {
    sansLegendeAPoster.sort((a, b) => b.reel.posteA - a.reel.posteA)
    const lotL = sansLegendeAPoster.slice(0, MAX_MESSAGES_PAR_CYCLE)
    let cl = 0
    for (const item of lotL) {
      try {
        await poster(SALON_LEGENDE, { embeds: [embedSansLegende(item.username, item.reel)] })
        sansLegendeVus.add(item.reel.code)
        cl++
      } catch (e) { console.error('[legende] envoi echoue (' + item.username + ') : ' + e.message) }
      await dodo(PAUSE_DISCORD_MS)
    }
    console.log('[legende] ' + cl + ' reel(s) sans legende signale(s)')
  }

  // 5. Classement
  if (classement.length) {
    classement.sort((a, b) => b.vues - a.vues)
    const heure = new Date().toLocaleString('fr-FR', {
      timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    })
    const bilan = { illisibles: erreursInsta, connexion: besoinConnexion.length, cibles: comptes.length }
    for (const emb of embedsClassement(classement, heure, bilan)) {
      try { await poster(SALON_CLASSEMENT, { embeds: [emb] }) } catch (e) {
        console.error('[discord] classement echoue : ' + e.message)
      }
      await dodo(PAUSE_DISCORD_MS)
    }
  }

  // 5a. Classement par MOYENNE de vues/reel dans le salon dedie (un par groupe).
  if (SALON_MOYENNE && classement.length) {
    const heureM = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    for (const emb of embedsMoyenne(classement, heureM)) {
      try { await poster(SALON_MOYENNE, { embeds: [emb] }) } catch (e) { console.error('[moyenne] echoue : ' + e.message) }
      await dodo(PAUSE_DISCORD_MS)
    }
  }

  // 5b. Salon dedie : liste des comptes non lus (illisibles) + groupe, chaque cycle.
  try {
    let chId = SALON_ILLISIBLE
    if (!chId && SALON_ILLISIBLE_NOM) {
      const ch = await discord('GET', '/channels/' + SALON_CLASSEMENT)
      const gid = ch && ch.guild_id
      if (gid) {
        const salons = await discord('GET', '/guilds/' + gid + '/channels')
        const cible = SALON_ILLISIBLE_NOM.toLowerCase().replace(/[^a-z0-9]+/g, '')
        const tr = (salons || []).find(s => String(s.name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '').includes(cible))
        if (tr) chId = tr.id
      }
    }
    if (chId) {
      const parRaison = {}
      for (const it of illisiblesDetail) { (parRaison[it.err] = parRaison[it.err] || []).push(it.u) }
      const emo = { rate_limit: '⏳', connexion_requise: '🔒', cookie_refuse: '🔒', budget: '⌛', compte_introuvable: '❓', inconnu: '❓' }
      const champs = Object.entries(parRaison).map(function (e) { return { name: (emo[e[0]] || '•') + ' ' + e[0] + ' (' + e[1].length + ')', value: '```' + String.fromCharCode(10) + e[1].join(String.fromCharCode(10)).slice(0, 1000) + String.fromCharCode(10) + '```' } })
      const hIll = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      const embIll = illisiblesDetail.length
        ? { color: 0xe74c3c, title: '📒 Comptes non lus · groupe "' + GROUPE_GEELARK + '"', description: '**' + comptesLus + '/' + comptes.length + '** lus · **' + illisiblesDetail.length + '** non lus ce cycle — réessai automatique au prochain cycle.', fields: champs.slice(0, 25), footer: { text: hIll } }
        : { color: 0x2ecc71, title: '📒 Comptes non lus · groupe "' + GROUPE_GEELARK + '"', description: '✅ **' + comptesLus + '/' + comptes.length + '** — tous les comptes ont été lus ce cycle.', footer: { text: hIll } }
      if (await memeQueDernier(chId, moiId, embIll)) {
        console.log('[illisible] identique au dernier cycle -> pas de repost (anti-spam)')
      } else {
        await poster(chId, { embeds: [embIll] })
      }
    }
  } catch (e) { console.error('[illisible] post echoue : ' + e.message) }
  // 5c) Salon bannissement : 404 immediat + comptes illisibles depuis SEUIL_BAN_CYCLES cycles (ban probable).
  if (SALON_BANS) {
    try {
      const lusOk = new Set(classement.map(function (x) { return x.username }))
      const errParU = new Map(illisiblesDetail.map(function (it) { return [it.u, it.err] }))
      const introuvables = []
      const nouveauxIllisibles = []
      for (const c of comptes) {
        const u = c.username
        const err = errParU.get(u)
        if (lusOk.has(u)) { banStreaks.delete(u); continue }
        if (err === 'compte_introuvable') { introuvables.push(u); banStreaks.delete(u); continue }
        if (err === 'connexion_requise' || err === 'cookie_refuse') { banStreaks.delete(u); continue }
        if (err === 'budget') { continue }
        if (err) { const dejaVu = banStreaks.has(u); banStreaks.set(u, Math.min((banStreaks.get(u) || 0) + 1, SEUIL_BAN_CYCLES + 5)); if (!dejaVu) nouveauxIllisibles.push(u) }
      }
      const setComptes = new Set(comptes.map(function (c) { return c.username }))
      const etatCompteurs = {}
      for (const [u, n] of banStreaks) { if (setComptes.has(u) && n > 0) etatCompteurs[u] = n }
      const probables = Object.keys(etatCompteurs).filter(function (u) { return etatCompteurs[u] >= SEUIL_BAN_CYCLES })

      const champs = []
      if (introuvables.length) champs.push({ name: '🚫 Introuvables sur Instagram (404) — ' + introuvables.length, value: '```' + String.fromCharCode(10) + introuvables.join(String.fromCharCode(10)).slice(0, 1000) + String.fromCharCode(10) + '```' })
      if (probables.length) champs.push({ name: '⏳ Illisibles depuis ' + SEUIL_BAN_CYCLES + '+ cycles — ' + probables.length, value: '```' + String.fromCharCode(10) + probables.join(String.fromCharCode(10)).slice(0, 1000) + String.fromCharCode(10) + '```' })
      if (champs.length) {
        const hBan = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
        const total = introuvables.length + probables.length
        const embBan = { color: 0xc0392b, title: '❌ Possibilité de ban · groupe "' + GROUPE_GEELARK + '"', description: '**' + total + '** compte(s) à vérifier — bannis, supprimés ou renommés. (404 = introuvable confirmé ; illisible ' + SEUIL_BAN_CYCLES + '+ cycles = ban probable car jamais lisible.)', fields: champs, footer: { text: hBan } }
        if (await memeQueDernier(SALON_BANS, moiId, embBan)) {
          console.log('[bans] liste identique au dernier cycle -> pas de repost (anti-spam)')
        } else {
          await poster(SALON_BANS, { embeds: [embBan] })
          console.log('[bans] ' + total + ' comptes possibilite de ban (404=' + introuvables.length + ', streak=' + probables.length + ')')
        }
      }

      const etatEmbed = { color: 0x2c2f33, title: '🔧 Suivi bans (auto) · ' + GROUPE_GEELARK, description: 'Compteurs internes (illisibilité consécutive). Ne pas supprimer.' + String.fromCharCode(10) + '```' + JSON.stringify(etatCompteurs).slice(0, 3500) + '```', footer: { text: 'gkstate:' + GROUPE_GEELARK } }
      try {
        if (banStateMsgId) { await discord('PATCH', '/channels/' + SALON_BANS + '/messages/' + banStateMsgId, { embeds: [etatEmbed] }) }
        else { const mm = await poster(SALON_BANS, { embeds: [etatEmbed] }); if (mm && mm.id) banStateMsgId = mm.id }
      } catch (e) { console.error('[bans] etat non sauvegarde : ' + e.message) }

      // 5c-bis. Introduire chaque NOUVEAU compte illisible (un message par compte).
      if (nouveauxIllisibles.length) {
        const hNouv = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
        const lotN = nouveauxIllisibles.slice(0, 15)
        let cn = 0
        for (const u of lotN) {
          const embN = { color: 0xf39c12, title: '🔎 Nouveau compte illisible · @' + u, description: '`@' + u + '` vient de devenir illisible sur Instagram.' + String.fromCharCode(10) + '🏷️ Groupe : **' + GROUPE_GEELARK + '**' + String.fromCharCode(10) + '⏳ En surveillance (1/' + SEUIL_BAN_CYCLES + ' cycles avant « ban probable »).', footer: { text: hNouv } }
          try { await poster(SALON_BANS, { embeds: [embN] }); cn++ } catch (e) { console.error('[bans-new] envoi echoue (' + u + ') : ' + e.message) }
          await dodo(PAUSE_DISCORD_MS)
        }
        console.log('[bans-new] ' + cn + ' nouveau(x) compte(s) illisible(s) introduit(s)')
      }
    } catch (e) { console.error('[bans] post echoue : ' + e.message) }
  }

  // 6. Alerte uniquement si plus RIEN n'a pu etre lu (blocage total).
  if (comptesLus === 0) {
    try {
      await poster(SALON_REELS, {
        content: '⚠️ Instagram refuse toutes les lectures pour le moment. ' +
          'Le bot reessaiera au prochain cycle et reprendra automatiquement des que ca repasse.',
      })
    } catch { /* tant pis */ }
  }

  const sansReelNoms = classement.filter(x => x.reels === 0).map(x => x.username)
  if (sansReelNoms.length) console.log('[cycle] comptes SANS reel recent (' + sansReelNoms.length + ') : ' + sansReelNoms.join(', '))

  if (echecsDefinitifs.length) {
    console.warn('[insta] ' + echecsDefinitifs.length + ' comptes illisibles ce cycle : ' +
                 echecsDefinitifs.slice(0, 20).join(', '))
  }
  if (besoinConnexion.length) {
    console.warn('[insta] ' + besoinConnexion.length + ' comptes exigent une session connectee' +
                 (etatCookie().cookiePresent ? ' (IG_SESSION_COOKIE presente mais refusee)' : ' (IG_SESSION_COOKIE absente)') +
                 ' : ' + besoinConnexion.slice(0, 20).join(', '))
  }
  const corriges = pseudosCorriges()
  if (corriges.length) console.log('[insta] pseudos retrouves : ' + corriges.join(' | '))

  // --- Menage : retirer des salons les comptes disparus de GeeLark ----------
  // Les salons de logs gardent une fiche par reel. Quand un profil est
  // supprime cote GeeLark, ses fiches restaient la indefiniment et le compte
  // continuait d'apparaitre partout. On les retire ici.
  //
  // La liste GeeLark doit etre COMPLETE : si GeeLark n'a repondu qu'a moitie,
  // conclure "ce compte n'existe plus" reviendrait a effacer des comptes actifs.
  if (NETTOYER !== 'off' && g.tous && g.complet === true) {
    const alias = {}
    for (const ligne of corriges) {
      const [de, vers] = String(ligne).split(' -> ').map(s => (s || '').trim())
      if (de && vers) alias[vers] = de          // pseudo Instagram -> profil GeeLark
    }
    const idx = indexVivants(g.tous, alias)
    const salons = [
      [SALON_REELS, '#reels'],
      [SALON_ZERO, '#0-vue'],
      [SALON_500, '#500+'],
      [SALON_LEGENDE, '#sans-legende'],
    ].filter(([s]) => s)
    let retires = 0
    const vus = new Set()
    for (const [salon, nom] of salons) {
      const r = await purgerSalon({
        discord, lireMessages, salon, nom, idx, moiId,
        pages: PAGES_HISTO, pause: 400,
      })
      retires += r.supprimes
      for (const u of r.comptes) vus.add(u)
    }
    console.log('[nettoyage] ' + retires + ' message(s) de comptes supprimes retires' +
                (vus.size ? ' (' + [...vus].sort().join(', ') + ')' : ''))
  } else if (NETTOYER !== 'off') {
    console.warn('[nettoyage] liste GeeLark incomplete ou absente — aucun menage (par securite)')
  }

  console.log('[cycle] termine : ' + JSON.stringify({
    comptes: comptes.length,
    comptesLus,
    feedbacksPostes: postes,
    enAttente: Math.max(0, aPoster.length - postes),
    comptesClasses: classement.length,
    erreursInsta,
    besoinConnexion: besoinConnexion.length,
    detailErreurs,
    instagram: etatCookie(),
    dureeSec: Math.round((Date.now() - t0) / 1000),
  }))
}

cycle()
  .then(() => { console.log('[bot] cycle OK, sortie.'); process.exit(0) })
  .catch(e => { console.error('[bot] erreur fatale : ' + (e && e.stack ? e.stack : e)); process.exit(1) })
