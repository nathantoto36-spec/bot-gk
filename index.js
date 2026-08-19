// ---------------------------------------------------------------------------
// Bot Discord "SMS ROTATION" - suivi des reels des comptes GeeLark
//
// Toutes les heures :
//   1. recupere les profils du groupe GeeLark (le nom du profil = pseudo Instagram)
//   2. lit les derniers reels de chaque compte sur Instagram
//   3. poste UN message par reel dans #resultats-reels, aux paliers d'age
//      (1h, 2h, 6h, 12h, 24h apres publication)
//   4. poste le classement des comptes dans #classement-comptes
//
// Aucune autre automatisation. Aucune commande slash. Aucun appel a Vercel.
// ---------------------------------------------------------------------------

import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js'
import express from 'express'
import { listPhonesInGroup, nomsValides } from './geelark.js'
import { reelsDuCompte, etatCookie, reactiverCookie, pseudosCorriges } from './instagram.js'

// --- Configuration ---------------------------------------------------------

const TOKEN = process.env.DISCORD_BOT_TOKEN
const SALON_REELS = process.env.SALON_REELS || '1539369975133765703'
const SALON_CLASSEMENT = process.env.SALON_CLASSEMENT || '1539370313463111720'
const GROUPE_GEELARK = process.env.GEELARK_GROUP || 'tkanuya account'

// Liste de pseudos Instagram separes par des virgules. Si elle est remplie,
// GeeLark n'est pas appele du tout (utile si on veut s'en passer completement).
const COMPTES_MANUELS = (process.env.COMPTES_MANUELS || '')
  .split(',').map(x => x.trim().toLowerCase().replace(/^@/, ''))
  .filter(x => /^[a-z0-9._]{1,30}$/.test(x))

// Paliers d'age (en heures) auxquels un reel recoit un message.
const PALIERS = (process.env.PALIERS || '1,2,6,12,24')
  .split(',').map(x => parseInt(x.trim(), 10)).filter(n => n > 0).sort((a, b) => a - b)

const PALIER_MAX_H = PALIERS[PALIERS.length - 1] || 24
const PAUSE_INSTA_MS = parseInt(process.env.PAUSE_INSTA_MS || '2500', 10) // entre 2 comptes
const PAUSE_DISCORD_MS = 1200                                            // entre 2 messages
const MAX_MESSAGES_PAR_CYCLE = parseInt(process.env.MAX_MESSAGES || '120', 10)
// Instagram refuse par a-coups depuis une IP de datacenter. On ne s'arrete plus :
// on ralentit (PAUSE_MAX_MS) puis on rejoue les comptes refuses apres une pause
// (RETENTATIVES passes, REPOS_MS de repos avant chacune).
const PAUSE_MAX_MS = parseInt(process.env.PAUSE_MAX_MS || '20000', 10)
const RETENTATIVES = parseInt(process.env.RETENTATIVES || '1', 10)
const REPOS_MS = parseInt(process.env.REPOS_MS || '90000', 10)
// Budget de temps du cycle : passe ce delai, on arrete de rattraper et on POSTE.
// Sans ce garde-fou, une poignee de comptes definitivement illisibles (comptes
// prives, supprimes, bannis) peut retarder les feedbacks de 30 minutes.
const BUDGET_MS = parseInt(process.env.BUDGET_MS || '1500000', 10) // 25 min
// Au tout premier cycle apres un demarrage, on ne rejoue PAS 24 h d'historique :
// seuls les reels de moins de N heures recoivent un feedback. Sinon le salon
// recevrait des centaines de messages sur des reels deja vieux.
const RATTRAPAGE_MAX_H = parseInt(process.env.RATTRAPAGE_MAX_H || '3', 10)
const PERIODE_MS = 60 * 60 * 1000

if (!TOKEN) {
  console.error("[FATAL] Variable d'environnement DISCORD_BOT_TOKEN absente.")
  process.exit(1)
}

const dodo = ms => new Promise(r => setTimeout(r, ms))

// --- Etat ------------------------------------------------------------------

let botStatus = 'STARTING'
let dernierCycle = null
let cycleEnCours = false
let derniereAlerte = null        // evite de repeter la meme alerte a chaque cycle
let premierCycle = true          // demarrage a froid : pas de rattrapage massif
const dejaPoste = new Set()      // "<code>:<palier>"
const totauxPrecedents = new Map() // username -> vues totales du cycle precedent

// --- Serveur HTTP (keep-alive) ---------------------------------------------

const app = express()
app.get('/', (_q, s) => s.send('bot-gk OK'))
app.get('/health', (_q, s) => s.json({
  ok: botStatus === 'READY',
  botStatus,
  dernierCycle,
  cycleEnCours,
  reelsSuivis: dejaPoste.size,
  comptesClasses: totauxPrecedents.size,
  instagram: etatCookie(),
  uptimeSec: Math.round(process.uptime()),
}))
const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log('[http] /health ecoute sur le port ' + PORT))

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

  return new EmbedBuilder()
    .setColor(v.couleur)
    .setTitle(v.emoji + ' Feedback ' + palier + 'h · ' + v.label)
    .setDescription(lignes.join('\n'))
    .setFooter({ text: 'gk:' + reel.code + ':' + palier })
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

  // Decoupage prudent : 3000 caracteres par bloc (la limite Discord est 4096),
  // et on tronque quand meme au cas ou, pour ne jamais perdre une ligne en silence.
  const blocs = []
  let courant = []
  let taille = 0
  for (const l of lignes) {
    if (courant.length && taille + l.length + 1 > 3000) { blocs.push(courant); courant = []; taille = 0 }
    courant.push(l); taille += l.length + 1
  }
  if (courant.length) blocs.push(courant)

  const total = classement.reduce((s, c) => s + c.vues, 0)
  const avecReels = classement.filter(c => c.reels > 0).length
  const sansReel = classement.length - avecReels

  const pied = [
    classement.length + ' comptes lus',
    sansReel ? sansReel + ' sans reel' : null,
    bilan && bilan.connexion ? bilan.connexion + ' nécessitent une session Instagram' : null,
    bilan && (bilan.illisibles - (bilan.connexion || 0)) > 0
      ? (bilan.illisibles - bilan.connexion) + ' illisibles' : null,
    bilan && bilan.cibles ? 'sur ' + bilan.cibles + ' du groupe' : null,
    nombre(total) + ' vues cumulées sur ' + PALIER_MAX_H + 'h',
  ].filter(Boolean).join(' · ')

  return blocs.map((bloc, i) => new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(i === 0
      ? '🏆 Classement des comptes · ' + horodatage
      : '🏆 Classement (suite ' + (i + 1) + '/' + blocs.length + ')')
    .setDescription(bloc.join('\n').slice(0, 4000))
    .setFooter({ text: i === blocs.length - 1 ? pied : 'suite…' }))
}

// --- Reconstruction de l'etat depuis l'historique Discord -------------------
// Render free tier n'a pas de disque : apres un redemarrage on relit les
// derniers messages du salon pour ne pas reposter les memes feedbacks.

async function rechargerEtat(salon, moiId) {
  let avant
  let lus = 0
  for (let page = 0; page < 3; page++) {
    const msgs = await salon.messages.fetch({ limit: 100, ...(avant ? { before: avant } : {}) })
    if (!msgs.size) break
    for (const m of msgs.values()) {
      if (m.author.id !== moiId) continue
      for (const e of m.embeds) {
        const f = e.footer && e.footer.text
        if (f && f.startsWith('gk:')) dejaPoste.add(f.slice(3))
      }
      lus++
    }
    avant = msgs.last().id
  }
  console.log('[etat] ' + dejaPoste.size + ' feedbacks deja postes retrouves dans ' + lus + ' messages')
}

// --- Cycle horaire ---------------------------------------------------------

async function cycle(client) {
  if (cycleEnCours) { console.log('[cycle] deja en cours, on saute'); return }
  cycleEnCours = true
  const t0 = Date.now()
  // Si le cookie a ete renouvele entre-temps, on lui redonne sa chance.
  reactiverCookie()
  console.log('[cycle] demarrage')

  try {
    const salonReels = await client.channels.fetch(SALON_REELS).catch(() => null)
    const salonClassement = await client.channels.fetch(SALON_CLASSEMENT).catch(() => null)
    if (!salonReels) { console.error('[cycle] salon reels introuvable'); return }

    // 1. Liste des comptes.
    // Echappatoire : si COMPTES_MANUELS est defini, on n'appelle PAS GeeLark du tout.
    let comptes, rejetes = [], g = {}
    if (COMPTES_MANUELS.length) {
      comptes = COMPTES_MANUELS.map(u => ({ username: u, phoneId: '' }))
      console.log('[comptes] liste manuelle (COMPTES_MANUELS) : ' + comptes.length + ' comptes, GeeLark non sollicite')
    } else {
      g = await listPhonesInGroup(GROUPE_GEELARK)
      if (g.error) {
        console.error('[geelark] erreur : ' + g.error + ' ' + (g.msg || g.body || ''))
        return
      }
      const v = nomsValides(g.items)
      comptes = v.ok
      rejetes = v.rejetes
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

    // 2. Instagram, compte par compte (espace pour ne pas se faire bloquer)
    const maintenant = Date.now()
    const aPoster = []
    const classement = []
    let erreursInsta = 0
    let refusConsecutifs = 0
    let comptesLus = 0
    const detailErreurs = {}
    const echecsDefinitifs = []
    const besoinConnexion = []   // comptes qu'Instagram cache aux visiteurs deconnectes

    // Traite une liste de comptes. Ne s'arrete JAMAIS sur un refus : Instagram
    // refuse par a-coups depuis une IP datacenter, donc on ralentit au lieu
    // d'abandonner (pause doublee a chaque refus, remise a zero des qu'un
    // compte passe). Retourne les comptes a retenter plus tard.
    async function traiterComptes(liste, pauseBase) {
      const aRetenter = []
      let pause = pauseBase
      for (const c of liste) {
        // Garde-fou : on ne laisse jamais un cycle deborder sur le suivant.
        if (Date.now() - t0 > BUDGET_MS) {
          console.warn('[insta] budget de temps atteint en cours de passe -> arret de la lecture')
          aRetenter.push(c)
          continue
        }
        const res = await reelsDuCompte(c.username)
        if (res.erreur) {
          detailErreurs[res.erreur] = (detailErreurs[res.erreur] || 0) + 1
          console.warn('[insta] ' + c.username + ' -> ' + res.erreur)
          // Seul un vrai coup de frein d'Instagram merite d'etre rejoue.
          // Un compte qui exige une session connectee echouera pareil dans
          // 2 minutes : on ne perd pas 20 minutes de cycle a le retenter.
          if (res.erreur === 'rate_limit' || String(res.erreur).startsWith('reseau')) {
            refusConsecutifs++
            aRetenter.push(c)
            // Freinage progressif : 2x la pause a chaque refus, plafonne.
            pause = Math.min(pause * 2, PAUSE_MAX_MS)
          } else {
            refusConsecutifs = 0
            echecsDefinitifs.push(c.username)
            if (res.erreur === 'connexion_requise' || res.erreur === 'cookie_refuse') {
              besoinConnexion.push(c.username)
            }
          }
          await dodo(pause)
          continue
        }
        refusConsecutifs = 0
        pause = pauseBase
        comptesLus++

        const recents = res.reels.filter(r => r.posteA && (maintenant - r.posteA) <= PALIER_MAX_H * 3600e3)
        const vuesTotales = recents.reduce((s, r) => s + (r.vues || 0), 0)
        // TOUT compte lu entre au classement, meme sans reel recent : sinon le
        // classement affiche 140 lignes pour 158 comptes et on ne sait pas pourquoi.
        const avant = totauxPrecedents.get(c.username)
        classement.push({
          username: c.username,
          vues: vuesTotales,
          reels: recents.length,
          delta: typeof avant === 'number' ? Math.max(0, vuesTotales - avant) : 0,
        })
        totauxPrecedents.set(c.username, vuesTotales)

        for (const r of recents) {
          if (!r.code) continue
          const ageH = (maintenant - r.posteA) / 3600e3
          // On ne poste QUE le dernier palier franchi, jamais l'historique :
          // sinon un reel decouvert a 10h d'age declencherait 1h + 2h + 6h d'un coup.
          const franchis = PALIERS.filter(p => ageH >= p)
          if (!franchis.length) continue
          // Demarrage a froid : les reels deja vieux sont marques comme traites,
          // sans message. On repart proprement sur le flux du moment.
          if (premierCycle && ageH > RATTRAPAGE_MAX_H) {
            for (const p of PALIERS) dejaPoste.add(r.code + ':' + p)
            continue
          }
          const dernier = franchis[franchis.length - 1]
          // Les paliers precedents sont consideres comme traites (rattrapage silencieux).
          for (const p of franchis) if (p !== dernier) dejaPoste.add(r.code + ':' + p)
          if (!dejaPoste.has(r.code + ':' + dernier)) {
            aPoster.push({ username: c.username, reel: r, palier: dernier })
          }
        }
        await dodo(pause)
      }
      return aRetenter
    }

    // Passe 1 : tous les comptes, rythme normal.
    let restants = await traiterComptes(comptes, PAUSE_INSTA_MS)

    // Passes de rattrapage : Instagram laisse passer au 2e ou 3e essai une fois
    // qu'on lui a laisse le temps de souffler. C'est ce qui recupere les comptes
    // qui finissaient "illisibles" a chaque cycle.
    for (let essai = 1; essai <= RETENTATIVES && restants.length; essai++) {
      if (Date.now() - t0 > BUDGET_MS) {
        console.warn('[insta] budget de temps atteint -> on poste sans rattraper les ' +
                     restants.length + ' comptes restants')
        break
      }
      const repos = REPOS_MS * essai
      console.log('[insta] rattrapage ' + essai + '/' + RETENTATIVES + ' : ' + restants.length +
                  ' comptes refuses, pause ' + Math.round(repos / 1000) + ' s avant de reessayer')
      await dodo(repos)
      restants = await traiterComptes(restants, PAUSE_INSTA_MS * 2)
    }

    // Ce qui resiste apres tous les essais.
    for (const c of restants) echecsDefinitifs.push(c.username)
    erreursInsta = comptes.length - comptesLus

    // 3. Messages, du plus ancien palier au plus recent
    aPoster.sort((a, b) => a.reel.posteA - b.reel.posteA || a.palier - b.palier)
    const tronque = aPoster.length > MAX_MESSAGES_PAR_CYCLE
    const lot = aPoster.slice(0, MAX_MESSAGES_PAR_CYCLE)
    if (tronque) {
      console.warn('[cycle] ' + aPoster.length + ' feedbacks en attente, seuls ' +
                   MAX_MESSAGES_PAR_CYCLE + ' seront postes ce cycle (le reste au prochain).')
    }

    let postes = 0
    for (const item of lot) {
      try {
        await salonReels.send({ embeds: [embedReel(item.username, item.reel, item.palier)] })
        dejaPoste.add(item.reel.code + ':' + item.palier)
        postes++
      } catch (e) {
        console.error('[discord] envoi echoue (' + item.username + ') : ' + e.message)
      }
      await dodo(PAUSE_DISCORD_MS)
    }

    // 4. Classement
    if (salonClassement && classement.length) {
      classement.sort((a, b) => b.vues - a.vues)
      const heure = new Date().toLocaleString('fr-FR', {
        timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      })
      const bilan = { illisibles: erreursInsta, connexion: besoinConnexion.length, cibles: comptes.length }
      for (const emb of embedsClassement(classement, heure, bilan)) {
        try { await salonClassement.send({ embeds: [emb] }) } catch (e) {
          console.error('[discord] classement echoue : ' + e.message)
        }
        await dodo(PAUSE_DISCORD_MS)
      }
    }

    // 5. Alerte : UNIQUEMENT si Instagram nous ferme vraiment la porte, c'est a
    //    dire si plus rien n'a pu etre lu. Quelques comptes refuses sur 158,
    //    c'est le fonctionnement normal : ils sont rattrapes au cycle suivant,
    //    inutile de polluer le salon avec une alerte.
    const etatBlocage = comptesLus === 0 ? 'bloque' : null
    if (etatBlocage && etatBlocage !== derniereAlerte) {
      try {
        await salonReels.send('⚠️ Instagram refuse toutes les lectures depuis le serveur pour le moment. ' +
          'Le bot continue d\'essayer à chaque cycle et reprendra automatiquement dès que ça repasse.')
      } catch { /* tant pis */ }
    }
    derniereAlerte = etatBlocage
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
    if (corriges.length) {
      console.log('[insta] pseudos retrouves automatiquement : ' + corriges.join(' | '))
    }

    dernierCycle = {
      a: new Date().toISOString(),
      pseudosCorriges: corriges,
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
    }
    console.log('[cycle] termine : ' + JSON.stringify(dernierCycle))
    premierCycle = false
  } catch (e) {
    console.error('[cycle] erreur inattendue : ' + (e && e.stack ? e.stack : e))
  } finally {
    cycleEnCours = false
  }
}

// --- Client Discord --------------------------------------------------------

const client = new Client({ intents: [GatewayIntentBits.Guilds] })

client.once('clientReady', async () => {
  botStatus = 'READY'
  console.log('[discord] connecte en tant que ' + client.user.tag)

  for (const [nom, id] of [['reels', SALON_REELS], ['classement', SALON_CLASSEMENT]]) {
    try {
      const ch = await client.channels.fetch(id)
      console.log('[salon] ' + nom + ' = #' + ch.name + ' (' + id + ')')
    } catch (e) {
      console.error('[salon] ' + nom + ' (' + id + ') INTROUVABLE : ' + e.message)
    }
  }

  const salonReels = await client.channels.fetch(SALON_REELS).catch(() => null)
  if (salonReels) await rechargerEtat(salonReels, client.user.id).catch(e => console.error('[etat] ' + e.message))

  console.log('[bot] paliers : ' + PALIERS.join('h, ') + 'h — cycle toutes les heures')
  cycle(client)
  setInterval(() => cycle(client), PERIODE_MS)
})

client.on('error', e => console.error('[discord] erreur :', e))
process.on('unhandledRejection', e => console.error('[unhandled]', e))

client.login(TOKEN)
