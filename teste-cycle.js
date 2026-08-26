// ---------------------------------------------------------------------------
// TESTE — suivi des videos teste1 -> teste5 sur les comptes a faible vue.
//
// Meme forme que index.js : UN cycle puis sortie, lance par GitHub Actions
// (.github/workflows/teste.yml). Pas de gateway Discord — tout passe par
// l'API REST, comme le bot principal.
//
// Ce qu'il fait, a chaque passage :
//   1. lit les comptes suivis dans teste/planning-teste.json
//   2. releve les vues de leurs reels sur Instagram
//   3. compare au releve precedent (data/vues-teste.json) pour savoir si le
//      reel MONTE ou stagne — c'est la seule facon d'avoir une tendance quand
//      le script n'a pas de memoire entre deux executions
//   4. poste un feedback par palier franchi (1h, 3h, 6h, 10h) dans SALON_TESTE
//   5. liste dans SALON_FAIBLE les comptes encore sous 100 vues apres 6h
//   6. reecrit SALON_CLASSEMENT : classement de tous les comptes en teste, par
//      moyenne de vues, avec les vues de chacun de leurs postes teste
//   7. reecrit data/vues-teste.json et data/historique-teste.json (commit par
//      le workflow)
//
// Il n'annonce QUE les reels rattachables a un creneau programme portant une
// video teste : sans ce rattachement on ne saurait pas quelle video a produit
// les vues, la legende etant identique pour les cinq.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { reelsDuCompte } from './instagram.js'

// --- Configuration ---------------------------------------------------------

const TOKEN = process.env.DISCORD_BOT_TOKEN_TESTE || process.env.DISCORD_BOT_TOKEN
const SALON_TESTE = process.env.SALON_TESTE || '1541707020413968444'
const SALON_FAIBLE = process.env.SALON_FAIBLE || '1541844783193129081'
// Salon des comptes qui ont franchi le seuil, quel que soit le temps mis.
const SALON_FORT = process.env.SALON_FORT || '1541883607478702261'
// Salon du classement : reecrit a chaque passage, il montre l'etat courant de
// tous les comptes en teste (moyenne + vues de chaque poste teste).
const SALON_CLASSEMENT = process.env.SALON_CLASSEMENT || '1541918389876957184'

const PALIERS = (process.env.PALIERS_TESTE || '1,3,6,10')
  .split(',').map(x => parseFloat(x.trim())).filter(n => n > 0).sort((a, b) => a - b)
const PALIER_MAX_H = PALIERS[PALIERS.length - 1] || 10

const SEUIL = parseInt(process.env.SEUIL_VUES || '200', 10)
const SEUIL_FAIBLE = parseInt(process.env.SEUIL_FAIBLE || '100', 10)
const PALIER_FAIBLE = parseFloat(process.env.PALIER_FAIBLE || '6')

// Mise au point : ne toucher qu'au salon classement, sans reposter de feedback
// ni de signalement. Sert a verifier un rendu sans polluer les autres salons.
const CLASSEMENT_SEUL = process.env.CLASSEMENT_SEUL === '1'

const PAUSE_INSTA_MS = parseInt(process.env.PAUSE_INSTA_MS || '1800', 10)
const PAUSE_DISCORD_MS = 900
const PAGES_HISTO = 3
// Profondeur maximale dans le fil Instagram quand il manque des postes teste.
const PAGES_INSTA_MAX = parseInt(process.env.PAGES_INSTA_MAX || '3', 10)
// Combien de comptes au maximum font cette remontee profonde par passage.
const DEEP_MAX = parseInt(process.env.DEEP_MAX || '8', 10)
// Budget de temps pour le releve Instagram, avant de passer a la publication.
// Doit rester nettement sous le timeout du job GitHub.
const BUDGET_MS = parseInt(process.env.BUDGET_MIN || '8', 10) * 60 * 1000

// Tolerance entre l'heure programmee et la publication reelle : un flow GeeLark
// met 2 a 4 min, plus le temps de demarrage du telephone.
const TOLERANCE_MS = parseInt(process.env.TESTE_TOLERANCE_MIN || '45', 10) * 60 * 1000
// Un post ne peut pas paraitre avant son heure : on n'accepte qu'une petite avance.
const AVANCE_MS = 5 * 60 * 1000
// En dessous de cet ecart entre deux creneaux candidats, on ne tranche pas.
const AMBIGU_MS = 12 * 60 * 1000

const FICHIER_ETAT = process.env.FICHIER_ETAT || 'data/vues-teste.json'
// Memoire longue : tous les postes teste jamais vus, avec leur meilleur releve
// de vues. C'est la base du classement — sans ca on perdrait les postes sortis
// de la fenetre des 12h.
const FICHIER_HISTO = process.env.FICHIER_HISTO || 'data/historique-teste.json'
const PLANNING = process.env.FICHIER_PLANNING || 'teste/planning-teste.json'

if (!TOKEN) {
  console.error('[FATAL] DISCORD_BOT_TOKEN_TESTE ou DISCORD_BOT_TOKEN absente.')
  process.exit(1)
}

const API = 'https://discord.com/api/v10'
const ENTETES = { Authorization: 'Bot ' + TOKEN, 'Content-Type': 'application/json' }
const dodo = ms => new Promise(r => setTimeout(r, ms))
const nombre = n => Number(n || 0).toLocaleString('fr-FR')
const norm = s => String(s || '').trim().toLowerCase().replace(/[._-]+/g, '_')

// --- Discord REST ----------------------------------------------------------

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
      await dodo(Math.min((j.retry_after || 1) * 1000 + 300, 15000))
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

async function lireMessages(salon, pages = PAGES_HISTO) {
  const tout = []
  let avant = null
  for (let p = 0; p < pages; p++) {
    const q = '/channels/' + salon + '/messages?limit=100' + (avant ? '&before=' + avant : '')
    const lot = await discord('GET', q)
    if (!lot || !lot.length) break
    tout.push(...lot)
    avant = lot[lot.length - 1].id
    if (lot.length < 100) break
  }
  return tout
}

// --- Planning : quelle video pour quel reel ? ------------------------------

let planning = { comptes: {}, pseudos: {}, groupes: {} }
try {
  planning = JSON.parse(fs.readFileSync(PLANNING, 'utf8'))
} catch (e) {
  console.error('[FATAL] ' + PLANNING + ' illisible : ' + e.message)
  process.exit(1)
}

/** Les VRAIS pseudos Instagram : les cles de `comptes` sont normalisees. */
function comptesSuivis() {
  const ps = planning.pseudos || {}
  return Object.keys(planning.comptes || {}).map(k => ps[k] || k)
}
function groupeDe(u) { return (planning.groupes || {})[norm(u)] || '(inconnu)' }

/**
 * Attribue les reels d'un compte a ses creneaux, UN reel par creneau.
 *
 * videoDuReel() pris reel par reel peut donner le meme creneau a deux reels
 * differents (un ancien poste qui traine a moins de 45 min d'un creneau teste
 * vole la place du vrai). On resout donc le compte entier d'un coup : on classe
 * toutes les paires (reel, creneau) par ecart croissant et on sert la plus
 * proche d'abord, chaque creneau et chaque reel n'etant servis qu'une fois.
 *
 * @returns Map code -> { video, ecartMin, ambigu }
 */
function attribuerVideos(username, reels) {
  const creneaux = (planning.comptes || {})[norm(username)] || []
  const paires = []
  for (const reel of reels) {
    if (!reel.code || !reel.posteA) continue
    for (let i = 0; i < creneaux.length; i++) {
      const retard = reel.posteA - creneaux[i].epoch * 1000
      if (retard < -AVANCE_MS || retard > TOLERANCE_MS) continue
      paires.push({ code: reel.code, i, ecart: Math.abs(retard) })
    }
  }
  paires.sort((a, b) => a.ecart - b.ecart)

  const prisReel = new Set()
  const prisCreneau = new Set()
  const res = new Map()
  for (const p of paires) {
    if (prisReel.has(p.code) || prisCreneau.has(p.i)) continue
    prisReel.add(p.code); prisCreneau.add(p.i)
    // Ambiguite : un autre creneau LIBRE, portant une autre video, est presque
    // aussi proche. On le signale plutot que de trancher au hasard.
    const rival = paires.find(x => x.code === p.code && x.i !== p.i &&
                                   !prisCreneau.has(x.i) &&
                                   creneaux[x.i].video !== creneaux[p.i].video &&
                                   Math.abs(x.ecart - p.ecart) <= AMBIGU_MS)
    res.set(p.code, {
      video: creneaux[p.i].video,
      ecartMin: Math.round(p.ecart / 60000),
      ambigu: rival ? creneaux[rival.i].video : null,
    })
  }
  return res
}

function libelleVideo(m) {
  const retard = m.ecartMin >= 5 ? ' · publie ' + m.ecartMin + ' min apres l\'heure prevue' : ''
  if (m.ambigu) {
    return '`' + m.video + '` ou `' + m.ambigu + '` ⚠️ deux creneaux trop proches pour trancher' + retard
  }
  return '`' + m.video + '`' + retard
}

// --- Etat : les vues du passage precedent ----------------------------------

let etat = { releves: {} }
try {
  etat = JSON.parse(fs.readFileSync(FICHIER_ETAT, 'utf8'))
  if (!etat.releves) etat.releves = {}
} catch { /* premier passage : pas de fichier */ }

// --- Historique long : tous les postes teste, meme anciens -----------------

let histo = { postes: {} }
try {
  histo = JSON.parse(fs.readFileSync(FICHIER_HISTO, 'utf8'))
  if (!histo.postes) histo.postes = {}
} catch { /* premier passage */ }

// Un compte supprime de GeeLark disparait du planning : il doit aussi sortir du
// classement, sinon il y resterait indefiniment avec ses anciennes vues.
for (const [code, p] of Object.entries(histo.postes)) {
  if (!p || !p.u || !(planning.comptes || {})[norm(p.u)]) delete histo.postes[code]
}

/**
 * Enregistre (ou rafraichit) un poste teste dans l'historique.
 * Les vues ne peuvent que monter : si Instagram renvoie une valeur plus basse
 * (reponse partielle, cache), on garde l'ancienne pour ne pas fausser le
 * classement.
 */
function memoriser(username, reel, video, maintenant) {
  const ancien = histo.postes[reel.code]
  histo.postes[reel.code] = {
    u: username,
    video,
    vues: Math.max((ancien && ancien.vues) || 0, reel.vues || 0),
    likes: Math.max((ancien && ancien.likes) || 0, reel.likes || 0),
    commentaires: Math.max((ancien && ancien.commentaires) || 0, reel.commentaires || 0),
    posteA: reel.posteA,
    maj: maintenant,
  }
}

function tendance(code, vues, maintenant) {
  if ((vues || 0) === 0) {
    return {
      couleur: 0x9b59b6, emoji: '🟣',
      texte: '**0 vue** — le reel n\'est pas distribué du tout. À regarder en priorité : proxy, shadowban ou compte limité.',
    }
  }
  const prec = etat.releves[code]
  if (!prec || !prec.t) {
    return {
      couleur: 0x95a5a6, emoji: '⚪',
      texte: 'Tendance inconnue — pas encore de relevé précédent pour comparer.',
    }
  }
  const minutes = Math.round((maintenant - prec.t) / 60000)
  // Le bot passe une fois par heure : on dit "la derniere heure" plutot que
  // "les 60 dernieres minutes", et on donne l'ecart reel s'il a derape.
  const depuis = minutes < 90
    ? (minutes >= 50 ? 'la dernière heure' : 'les ' + minutes + ' dernières minutes')
    : 'les ' + (minutes / 60).toFixed(1).replace('.0', '') + ' dernières heures'
  const delta = (vues || 0) - (prec.vues || 0)
  if (delta > 0) {
    return {
      couleur: 0x2ecc71, emoji: '🟢',
      texte: '**+' + nombre(delta) + ' vues** sur ' + depuis + ' — ça monte.',
    }
  }
  return {
    couleur: 0xe74c3c, emoji: '🔴',
    texte: 'Aucune vue gagnée sur ' + depuis + ' — ça ne monte pas.',
  }
}

function verdict(vues) {
  if (vues >= 5000) return { emoji: '💥', label: 'VIRAL', conseil: 'Ce reel explose. Reposte le meme format sur les autres comptes, et enchaine vite un 2e post pendant que la portee est haute.' }
  if (vues >= 1000) return { emoji: '🚀', label: 'CA MONTE', conseil: 'Bonne dynamique. Garde ce hook et ce son, et republie a la meme heure demain.' }
  if (vues >= 100) return { emoji: '🔥', label: 'BON DEBUT', conseil: 'Le contenu accroche deja. Reponds aux commentaires pour pousser encore la portee.' }
  return { emoji: '🌱', label: 'DEMARRAGE', conseil: 'Ca demarre doucement. Pour le prochain : hook plus fort des la 1re seconde, son tendance, et poste a ta meilleure heure.' }
}

function embedTeste(username, reel, palier, m, maintenant, ageH) {
  const v = verdict(reel.vues)
  const t = tendance(reel.code, reel.vues, maintenant)
  const atteint = (reel.vues || 0) >= SEUIL
  const inter = (reel.likes || 0) + (reel.commentaires || 0)
  const taux = reel.vues > 0 ? ((inter / reel.vues) * 100).toFixed(1) : '0.0'
  const lienPost = 'https://www.instagram.com/reel/' + reel.code + '/'
  const lienCompte = 'https://www.instagram.com/' + username + '/'

  const l = []
  l.push('[Voir le post ↗](' + lienPost + ') · [Ouvrir le compte ↗](' + lienCompte + ')')
  // Pseudo en bloc de code : un clic le selectionne. Sans le "@", pour qu'il se
  // colle tel quel dans la recherche Instagram.
  l.push('`' + username + '`')
  l.push('👁️ **' + nombre(reel.vues) + '** vues · ❤️ ' + nombre(reel.likes) +
         ' · 💬 ' + nombre(reel.commentaires) + ' · 📊 ' + taux + '%')
  // Le bot passe une fois par heure : le palier peut etre releve un peu apres
  // l'heure pile. On affiche l'age reel quand il s'ecarte du palier.
  const ageReel = ageH == null ? null : Math.round(ageH * 10) / 10
  const precision = (ageReel != null && Math.abs(ageReel - palier) >= 0.3)
    ? ' _(relevé à ' + String(ageReel).replace('.', ',') + 'h)_' : ''
  l.push('🕒 Palier **' + palier + 'h**' + precision + ' · publié le ' +
         new Date(reel.posteA).toLocaleString('fr-FR', {
           timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit',
           hour: '2-digit', minute: '2-digit',
         }))
  l.push(t.emoji + ' ' + t.texte)
  l.push('🎬 Vidéo testée : ' + libelleVideo(m))
  l.push('🏷️ Groupe : **' + groupeDe(username) + '**')
  l.push(atteint
    ? '✅ **Seuil des ' + SEUIL + ' vues ATTEINT** — cette vidéo peut être attribuée définitivement au compte.'
    : '❌ **Seuil des ' + SEUIL + ' vues NON atteint** — il manque ' +
      nombre(Math.max(0, SEUIL - (reel.vues || 0))) + ' vues. La vidéo n\'est pas attribuée au compte.')
  l.push('')
  l.push('💡 ' + v.conseil)

  return {
    // La couleur porte la TENDANCE : c'est ce qui se voit le plus vite.
    color: t.couleur,
    author: { name: '@' + username, url: lienCompte },
    title: t.emoji + ' ' + v.emoji + ' Teste ' + palier + 'h · ' + v.label +
           ' · ' + (atteint ? SEUIL + '+ ✅' : '<' + SEUIL + ' ❌'),
    url: lienPost,
    description: l.join('\n'),
    footer: { text: 'gkt:' + reel.code + ':' + palier },
  }
}

// --- Classement ------------------------------------------------------------

const MAX_MSG = 1900   // marge sous la limite Discord de 2000 caracteres

function medaille(rang) {
  if (rang === 1) return '🥇'
  if (rang === 2) return '🥈'
  if (rang === 3) return '🥉'
  return '**' + rang + '.**'
}

/** Nombre de creneaux teste deja passes pour un compte (ce qui aurait du sortir). */
function creneauxPasses(username, maintenant) {
  return ((planning.comptes || {})[norm(username)] || [])
    .filter(c => /^teste\d+$/i.test(c.video) && c.epoch * 1000 <= maintenant - TOLERANCE_MS).length
}

/** Regroupe l'historique par compte et trie par moyenne de vues decroissante. */
function construireClassement(maintenant) {
  const par = new Map()
  for (const [code, p] of Object.entries(histo.postes || {})) {
    if (!p || !p.u) continue
    if (!par.has(p.u)) par.set(p.u, [])
    par.get(p.u).push({ code, ...p })
  }
  const lignes = []
  for (const [u, postes] of par) {
    postes.sort((a, b) => a.posteA - b.posteA)
    const total = postes.reduce((s, p) => s + (p.vues || 0), 0)
    lignes.push({
      u,
      postes,
      total,
      moyenne: total / postes.length,
      meilleur: Math.max(...postes.map(p => p.vues || 0)),
      attendus: Math.max(postes.length, creneauxPasses(u, maintenant)),
    })
  }
  // Moyenne d'abord ; a moyenne egale, celui qui a le plus de postes derriere
  // lui a la mesure la plus solide, il passe devant.
  lignes.sort((a, b) => b.moyenne - a.moyenne ||
                        b.postes.length - a.postes.length ||
                        a.u.localeCompare(b.u))
  return lignes
}

/** Une entree du classement, en texte brut (2 lignes). */
function ligneClassement(rang, c) {
  const detail = c.postes
    .map(p => '`' + p.video + '` ' + nombre(p.vues))
    .join(' · ')
  const alerte = c.moyenne === 0 ? ' 🟣' : (c.moyenne >= SEUIL ? ' ✅' : '')
  return medaille(rang) + ' `' + c.u + '`' + alerte +
         ' — moyenne **' + nombre(Math.round(c.moyenne)) + '** ' +
         (Math.round(c.moyenne) > 1 ? 'vues' : 'vue') +
         ' · ' + c.postes.length + ' poste' + (c.postes.length > 1 ? 's' : '') +
         (c.attendus > c.postes.length
           ? ' ⚠️ (' + (c.attendus - c.postes.length) + ' non publié' + (c.attendus - c.postes.length > 1 ? 's' : '') + ')'
           : '') +
         ' · total ' + nombre(c.total) +
         ' · [profil](<https://www.instagram.com/' + c.u + '/>)\n' +
         '　└ ' + detail
}

/** Decoupe le classement en messages de moins de 2000 caracteres. */
function pagesClassement(lignes, maintenant, sansPoste, attendus) {
  const nbPostes = lignes.reduce((s, c) => s + c.postes.length, 0)
  const totalVues = lignes.reduce((s, c) => s + c.total, 0)
  const zeros = lignes.filter(c => c.total === 0).length
  const dessus = lignes.filter(c => c.moyenne >= SEUIL).length

  const entete =
    '# 🏆 Classement des comptes en teste\n' +
    'Mis à jour le ' + new Date(maintenant).toLocaleString('fr-FR', {
      timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }) + ' · **' + lignes.length + '** comptes · **' + nbPostes + '** postes teste · ' +
    nombre(totalVues) + ' vues cumulées\n' +
    '✅ ' + dessus + ' compte(s) au-dessus de ' + SEUIL + ' vues de moyenne · ' +
    '🟣 ' + zeros + ' compte(s) encore à 0 vue\n' +
    '🔎 Couverture : **' + nbPostes + '/' + attendus + '** publications teste attendues ont été retrouvées' +
    (attendus > nbPostes ? ' — les ' + (attendus - nbPostes) + ' manquantes sont détaillées en bas.' : ' — rien ne manque.') + '\n' +
    '_Classé par moyenne de vues. La 2e ligne donne les vues de chaque poste teste, du plus ancien au plus récent._'

  const pages = []
  let courant = entete
  lignes.forEach((c, i) => {
    const bloc = '\n\n' + ligneClassement(i + 1, c)
    if (courant.length + bloc.length > MAX_MSG) { pages.push(courant); courant = bloc.trimStart() }
    else courant += bloc
  })
  if (courant.trim()) pages.push(courant)

  // Rien ne doit disparaitre en silence : on distingue ce qui n'a pas encore
  // ete publie de ce qui aurait DU l'etre.
  const ajouterBloc = (titre, note, liste) => {
    if (!liste.length) return
    let bloc = titre + '\n' + note + '\n'
    for (const t of liste) {
      const bout = t + ' '
      if (bloc.length + bout.length > MAX_MSG) { pages.push(bloc); bloc = '' }
      bloc += bout
    }
    if (bloc.trim()) pages.push(bloc)
  }

  ajouterBloc(
    '### ❌ ' + sansPoste.rates.length + ' compte(s) : créneau teste passé, aucune publication trouvée',
    '_Le créneau est passé depuis plus de 45 min et rien n\'est sorti : flow GeeLark en échec, ' +
    'téléphone ou proxy KO. À vérifier dans GeeLark._',
    sansPoste.rates.map(x => '`' + x.u + '`(' + x.passes + ')'))

  ajouterBloc(
    '### ⏳ ' + sansPoste.attente.length + ' compte(s) en teste, publication pas encore passée',
    '_Rien d\'anormal : leur premier créneau teste est encore à venir._',
    sansPoste.attente.map(x => '`' + x.u + '`'))

  return pages
}

/**
 * Reecrit le salon classement : on MODIFIE les messages deja publies plutot
 * que de tout supprimer et republier. Le salon reste donc a la meme place,
 * sans notification a chaque passage, et affiche toujours l'etat courant.
 */
async function publierClassement(maintenant, comptes) {
  if (!SALON_CLASSEMENT) return 0
  const lignes = construireClassement(maintenant)
  if (!lignes.length) { console.log('[classement] aucun poste teste connu, rien a publier'); return 0 }
  const classes = new Set(lignes.map(c => norm(c.u)))
  // Les comptes qui repostent leur propre video ne font pas partie du test :
  // les citer comme "sans poste teste" serait trompeur.
  const propre = new Set((planning.groupeVideoPropre || []).map(norm))
  const sansPoste = { rates: [], attente: [] }
  for (const u of (comptes || []).slice().sort()) {
    if (classes.has(norm(u)) || propre.has(norm(u))) continue
    const passes = ((planning.comptes || {})[norm(u)] || [])
      .filter(c => /^teste\d+$/i.test(c.video) && c.epoch * 1000 <= maintenant - TOLERANCE_MS).length
    if (passes > 0) sansPoste.rates.push({ u, passes })
    else sansPoste.attente.push({ u })
  }
  // Combien de publications teste auraient deja du sortir, tous comptes suivis
  // confondus : c'est l'etalon qui dit si le classement est complet.
  let attendus = 0
  for (const u of (comptes || [])) {
    if (propre.has(norm(u))) continue
    const c = lignes.find(x => norm(x.u) === norm(u))
    attendus += c ? c.attendus : creneauxPasses(u, maintenant)
  }
  const pages = pagesClassement(lignes, maintenant, sansPoste, attendus)

  // Les messages du bot, du plus ancien au plus recent : c'est l'ordre d'affichage.
  const anciens = (await lireMessages(SALON_CLASSEMENT, 2))
    .filter(m => m.author && m.author.id === MOI)
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))

  for (let i = 0; i < pages.length; i++) {
    const corps = { content: pages[i], allowed_mentions: { parse: [] } }
    try {
      if (anciens[i]) {
        if (anciens[i].content !== pages[i]) {
          await discord('PATCH', '/channels/' + SALON_CLASSEMENT + '/messages/' + anciens[i].id, corps)
        }
      } else {
        await discord('POST', '/channels/' + SALON_CLASSEMENT + '/messages', corps)
      }
    } catch (e) {
      console.error('[classement] page ' + (i + 1) + ' : ' + e.message)
    }
    await dodo(PAUSE_DISCORD_MS)
  }
  // Le classement a raccourci : on retire les messages devenus inutiles.
  for (let i = pages.length; i < anciens.length; i++) {
    try { await discord('DELETE', '/channels/' + SALON_CLASSEMENT + '/messages/' + anciens[i].id) }
    catch (e) { console.error('[classement] suppression : ' + e.message) }
    await dodo(PAUSE_DISCORD_MS)
  }
  return pages.length
}

// --- Cycle -----------------------------------------------------------------

let MOI = ''

async function cycle() {
  console.log('[teste] demarrage (GitHub Actions, one-shot)')
  const moi = await discord('GET', '/users/@me')
  MOI = moi.id
  console.log('[teste] connecte en tant que ' + moi.username + ' (' + moi.id + ')')

  // Ce qui a deja ete poste : on relit les salons, comme le bot principal.
  const dejaPoste = new Set()
  for (const m of await lireMessages(SALON_TESTE)) {
    for (const e of (m.embeds || [])) {
      const f = e.footer && e.footer.text
      if (f && f.startsWith('gkt:')) dejaPoste.add(f.slice(4))
    }
  }
  // Le salon faible liste un post par ligne : on dedoublonne sur le code du reel,
  // qu'on relit dans le lien present dans le message.
  const dejaFaible = new Set()
  if (SALON_FAIBLE) {
    for (const m of await lireMessages(SALON_FAIBLE, 2)) {
      const mm = (m.content || '').match(/\/reel\/([A-Za-z0-9_-]+)/)
      if (mm) dejaFaible.add(mm[1])
    }
  }
  const dejaFort = new Set()
  if (SALON_FORT) {
    for (const m of await lireMessages(SALON_FORT, 2)) {
      const mm = (m.content || '').match(/\/reel\/([A-Za-z0-9_-]+)/)
      if (mm) dejaFort.add(mm[1])
    }
  }
  console.log('[teste] deja postes : ' + dejaPoste.size + ' feedbacks · ' +
              dejaFaible.size + ' comptes faibles')

  const comptes = comptesSuivis()
  const maintenant = Date.now()
  const aPoster = []
  const faibles = []
  const forts = []
  const nouveauxReleves = {}
  let erreurs = 0

  // Combien de creneaux teste sont deja passes, et depuis quand : c'est ce qui
  // dit jusqu'ou remonter dans le fil de chaque compte.
  const parCompte = new Map()
  for (const p of Object.values(histo.postes || {})) {
    parCompte.set(norm(p.u), (parCompte.get(norm(p.u)) || 0) + 1)
  }

  // Le job GitHub est coupe net a timeout-minutes. Un cycle qui depasse est
  // ANNULE : rien n'est publie, rien n'est commite, et le salon parait fige.
  // On se donne donc un budget et on s'arrete proprement avant la coupe.
  const debutCycle = Date.now()
  let scannes = 0
  let profonds = 0
  let interrompu = false

  for (const u of comptes) {
    if (Date.now() - debutCycle > BUDGET_MS) {
      interrompu = true
      console.warn('[teste] budget de ' + Math.round(BUDGET_MS / 60000) + ' min atteint apres ' +
                   scannes + '/' + comptes.length + ' comptes — on publie ce quon a.')
      break
    }
    // Creneaux teste deja passes pour ce compte.
    const creneaux = (planning.comptes || {})[norm(u)] || []
    const passes = creneaux
      .filter(c => /^teste\d+$/i.test(c.video) && c.epoch * 1000 <= maintenant - 10 * 60 * 1000)
      .map(c => c.epoch * 1000)
      .sort((a, b) => a - b)
    const connus = parCompte.get(norm(u)) || 0
    // Il manque des postes : on remonte le fil jusqu'au plus ancien creneau
    // passe. Sinon une seule page suffit — c'est le cas courant, et ca evite
    // de matraquer Instagram toutes les 10 minutes.
    // La remontee profonde coute plusieurs pages Instagram : on la reserve a
    // quelques comptes par passage, les autres seront repris a l'heure suivante.
    const manque = passes.length > connus && profonds < DEEP_MAX
    if (manque) profonds++
    scannes++
    const r = await reelsDuCompte(u, 12, manque
      ? { jusquA: passes[0] - TOLERANCE_MS, maxPages: PAGES_INSTA_MAX, pausePageMs: PAUSE_INSTA_MS }
      : {})
    if (r.erreur) {
      erreurs++
      console.warn('[insta] ' + u + ' -> ' + r.erreur)
      // Rate limit : on ralentit franchement au lieu d'enchainer, Instagram
      // reouvre souvent la porte au bout de quelques dizaines de secondes.
      await dodo(r.erreur === 'rate_limit' ? Math.min(PAUSE_INSTA_MS * 4, 8000) : PAUSE_INSTA_MS)
      continue
    }
    const reelsVus = (r.reels || []).filter(x => x.code && x.posteA)
    const attribution = attribuerVideos(u, reelsVus)
    // Auto-correction : tout ce qu'on a memorise dans la fenetre qu'on vient de
    // relire et qui n'est plus attribue a une video teste sort de l'historique.
    // Sans ca, une mauvaise attribution d'un ancien passage resterait a vie.
    const plusVieuxVu = reelsVus.length ? Math.min(...reelsVus.map(x => x.posteA)) : null
    if (plusVieuxVu !== null) {
      for (const [code, p] of Object.entries(histo.postes || {})) {
        if (norm(p.u) !== norm(u) || p.posteA < plusVieuxVu) continue
        const a = attribution.get(code)
        if (!a || !/^teste\d+$/i.test(a.video)) delete histo.postes[code]
      }
    }

    for (const reel of reelsVus) {
      const ageH = (maintenant - reel.posteA) / 3600e3

      const m = attribution.get(reel.code)
      // Uniquement les videos teste1 -> teste5 : les videos propres ne font pas
      // partie du test, et un reel hors planning n'est rattachable a rien.
      if (!m || !/^teste\d+$/i.test(m.video)) continue

      // Le classement compte TOUS les postes teste, y compris ceux sortis de la
      // fenetre de suivi : on memorise avant la coupure d'age.
      memoriser(u, reel, m.video, maintenant)
      if (ageH > PALIER_MAX_H + 2) continue

      // On garde le releve AVANT de comparer : la comparaison se fait contre
      // l'ancien fichier, le nouveau servira au passage suivant.
      nouveauxReleves[reel.code] = { t: maintenant, vues: reel.vues || 0 }

      for (const p of PALIERS) {
        if (ageH >= p && !dejaPoste.has(reel.code + ':' + p)) {
          aPoster.push({ u, reel, p, m, ageH })
        }
      }
      // Deux raisons d'atterrir dans le salon des comptes faibles :
      //  - 0 vue : c'est grave et il faut le voir tout de suite, des le 1er palier
      //  - moins de 100 vues alors que le reel a eu plusieurs heures pour decoller
      // Seuil franchi : on l'annonce une seule fois, peu importe le temps mis.
      // Pas de palier ici — des que les 200 vues sont la, la video est validee.
      if (SALON_FORT && (reel.vues || 0) >= SEUIL && !dejaFort.has(reel.code)) {
        forts.push({ u, reel, m, ageH })
        dejaFort.add(reel.code)
      }
      if (SALON_FAIBLE && !dejaFaible.has(reel.code)) {
        // Des le premier palier : Nathan veut la liste complete des comptes sous
        // 100 vues, pas seulement ceux qui ont deja eu plusieurs heures.
        // Contrepartie assumee : un reel liste a 1h avec 80 vues peut monter
        // ensuite — il apparaitra alors dans le salon des 200+.
        const zero = (reel.vues || 0) === 0 && ageH >= PALIERS[0]
        const mou = (reel.vues || 0) < SEUIL_FAIBLE && ageH >= PALIERS[0]
        if (zero || mou) {
          faibles.push({ u, reel, m, ageH, zero })
          dejaFaible.add(reel.code)
        }
      }
    }
    await dodo(PAUSE_INSTA_MS)
  }

  // Instagram limite parfois le runner GitHub (HTTP 429) : le cycle ne voit
  // alors rien, et ecraser l'etat avec du vide ferait perdre la tendance ET le
  // classement. On sort sans rien toucher : le passage suivant reprendra.
  if (scannes > 0 && erreurs >= Math.max(3, scannes * 0.4)) {
    console.warn('[teste] ' + erreurs + '/' + scannes + ' comptes en erreur Instagram ' +
                 '(rate limit ?) — rien nest publie ni ecrase, on garde letat precedent.')
    return
  }

  if (CLASSEMENT_SEUL) { aPoster.length = 0; faibles.length = 0; forts.length = 0 }

  aPoster.sort((a, b) => a.reel.posteA - b.reel.posteA || a.p - b.p)
  let postes = 0
  for (const it of aPoster) {
    try {
      await discord('POST', '/channels/' + SALON_TESTE + '/messages',
        { embeds: [embedTeste(it.u, it.reel, it.p, it.m, maintenant, it.ageH)] })
      postes++
    } catch (e) {
      console.error('[discord] envoi echoue (' + it.u + ') : ' + e.message)
    }
    await dodo(PAUSE_DISCORD_MS)
  }

  let signales = 0
  faibles.sort((a, b) => (b.zero ? 1 : 0) - (a.zero ? 1 : 0) || a.reel.posteA - b.reel.posteA)
  for (const f of faibles) {
    // Les liens sont entoures de < > : Discord ne deplie alors aucun apercu.
    // Sans ca chaque message traine une carte "Login · Instagram" inutile.
    const heures = f.ageH < 1.5 ? '1h' : Math.round(f.ageH) + 'h'
    const etat = f.zero
      ? '🟣 **0 vue** après ' + heures
      : '⚠️ **' + nombre(f.reel.vues) + ' vues** après ' + heures
    const contenu =
      '`' + f.u + '` · <https://www.instagram.com/' + f.u + '/>\n' +
      etat + ' · vidéo `' + f.m.video + '` · ' +
      '[voir le post](<https://www.instagram.com/reel/' + f.reel.code + '/>)'
    try {
      await discord('POST', '/channels/' + SALON_FAIBLE + '/messages', { content: contenu })
      signales++
    } catch (e) {
      console.error('[discord] salon faibles echoue (' + f.u + ') : ' + e.message)
    }
    await dodo(PAUSE_DISCORD_MS)
  }

  // Fusion plutot que remplacement : un compte que ce passage n'a pas pu lire
  // garde son dernier releve connu. On purge seulement ce qui est sorti de la
  // fenetre de suivi, pour que le fichier ne gonfle pas.
  const limite = maintenant - (PALIER_MAX_H + 4) * 3600e3
  const releves = {}
  for (const [code, r] of Object.entries(etat.releves || {})) {
    if (r && r.t && r.t >= limite) releves[code] = r
  }
  Object.assign(releves, nouveauxReleves)
  etat = { maj: new Date().toISOString(), releves }
  fs.mkdirSync(path.dirname(FICHIER_ETAT), { recursive: true })
  fs.writeFileSync(FICHIER_ETAT, JSON.stringify(etat, null, 2))

  let valides = 0
  forts.sort((a, b) => b.reel.vues - a.reel.vues)
  for (const f of forts) {
    const heures = f.ageH < 1.5 ? '1h' : Math.round(f.ageH) + 'h'
    const contenu =
      '`' + f.u + '` · <https://www.instagram.com/' + f.u + '/>\n' +
      '✅ **' + nombre(f.reel.vues) + ' vues** en ' + heures + ' · vidéo `' + f.m.video + '` · ' +
      '[voir le post](<https://www.instagram.com/reel/' + f.reel.code + '/>)'
    try {
      await discord('POST', '/channels/' + SALON_FORT + '/messages', { content: contenu })
      valides++
    } catch (e) {
      console.error('[discord] salon 200+ echoue (' + f.u + ') : ' + e.message)
    }
    await dodo(PAUSE_DISCORD_MS)
  }

  // Historique long puis classement : le fichier est ecrit meme si Discord
  // refuse, pour ne jamais perdre un releve.
  histo = { maj: new Date().toISOString(), postes: histo.postes }
  fs.mkdirSync(path.dirname(FICHIER_HISTO), { recursive: true })
  fs.writeFileSync(FICHIER_HISTO, JSON.stringify(histo, null, 2))

  const pagesRang = await publierClassement(maintenant, comptes)

  console.log('[teste] ' + scannes + '/' + comptes.length + ' comptes scannes' +
              (interrompu ? ' (budget atteint)' : '') + ' · ' +
              profonds + ' remontee(s) profonde(s) · ' +
              Math.round((Date.now() - debutCycle) / 1000) + 's · ' + postes + ' feedback(s) · ' +
              signales + ' faible(s) · ' + valides + ' au-dessus de ' + SEUIL + ' vues · ' +
              Object.keys(nouveauxReleves).length + ' releve(s) · ' +
              Object.keys(histo.postes).length + ' poste(s) au classement (' + pagesRang + ' message(s)) · ' +
              erreurs + ' erreur(s) Instagram')
}

cycle()
  .then(() => { console.log('[teste] cycle OK, sortie.'); process.exit(0) })
  .catch(e => { console.error('[teste] erreur fatale : ' + (e && e.stack ? e.stack : e)); process.exit(1) })
