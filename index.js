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
import { reelsDuCompte } from './instagram.js'

// --- Configuration ---------------------------------------------------------

const TOKEN = process.env.DISCORD_BOT_TOKEN
const SALON_REELS = process.env.SALON_REELS || '1539369975133765703'
const SALON_CLASSEMENT = process.env.SALON_CLASSEMENT || '1539370313463111720'
const GROUPE_GEELARK = process.env.GEELARK_GROUP || 'tkanuya account'

// Paliers d'age (en heures) auxquels un reel recoit un message.
const PALIERS = (process.env.PALIERS || '1,2,6,12,24')
  .split(',').map(x => parseInt(x.trim(), 10)).filter(n => n > 0).sort((a, b) => a - b)

const PALIER_MAX_H = PALIERS[PALIERS.length - 1] || 24
const PAUSE_INSTA_MS = parseInt(process.env.PAUSE_INSTA_MS || '2500', 10) // entre 2 comptes
const PAUSE_DISCORD_MS = 1200                                            // entre 2 messages
const MAX_MESSAGES_PAR_CYCLE = parseInt(process.env.MAX_MESSAGES || '120', 10)
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

function embedsClassement(classement, horodatage) {
  const lignes = classement.map((c, i) => {
    const rang = i + 1
    const medaille = rang === 1 ? '🥇' : rang === 2 ? '🥈' : rang === 3 ? '🥉' : '`#' + String(rang).padStart(2, ' ') + '`'
    const delta = c.delta > 0 ? ' (+' + nombre(c.delta) + ')' : ''
    return medaille + ' `@' + c.username + '` — **' + nombre(c.vues) + '** vues' + delta +
           ' · ' + c.reels + ' reel' + (c.reels > 1 ? 's' : '')
  })

  const blocs = []
  let courant = []
  let taille = 0
  for (const l of lignes) {
    if (taille + l.length + 1 > 3800) { blocs.push(courant); courant = []; taille = 0 }
    courant.push(l); taille += l.length + 1
  }
  if (courant.length) blocs.push(courant)

  const total = classement.reduce((s, c) => s + c.vues, 0)
  return blocs.map((bloc, i) => new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle(i === 0
      ? '🏆 Classement des comptes · ' + horodatage
      : '🏆 Classement (suite ' + (i + 1) + ')')
    .setDescription(bloc.join('\n'))
    .setFooter({ text: i === blocs.length - 1
      ? classement.length + ' comptes · ' + nombre(total) + ' vues cumulées sur ' + PALIER_MAX_H + 'h'
      : '…' }))
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
  console.log('[cycle] demarrage')

  try {
    const salonReels = await client.channels.fetch(SALON_REELS).catch(() => null)
    const salonClassement = await client.channels.fetch(SALON_CLASSEMENT).catch(() => null)
    if (!salonReels) { console.error('[cycle] salon reels introuvable'); return }

    // 1. Comptes du groupe GeeLark
    const g = await listPhonesInGroup(GROUPE_GEELARK)
    if (g.error) {
      console.error('[geelark] erreur : ' + g.error + ' ' + (g.msg || g.body || ''))
      return
    }
    const { ok: comptes, rejetes } = nomsValides(g.items)
    console.log('[geelark] groupe "' + GROUPE_GEELARK + '" : ' + comptes.length + ' comptes exploitables' +
                (rejetes.length ? ' (' + rejetes.length + ' noms ignores : ' + rejetes.slice(0, 5).join(', ') + ')' : ''))
    if (!comptes.length) return

    // 2. Instagram, compte par compte (espace pour ne pas se faire bloquer)
    const maintenant = Date.now()
    const aPoster = []
    const classement = []
    let erreursInsta = 0
    let alerteCookie = null

    for (const c of comptes) {
      const res = await reelsDuCompte(c.username)
      if (res.erreur) {
        erreursInsta++
        if (res.erreur === 'cookie_invalide' || res.erreur === 'rate_limit') alerteCookie = res.erreur
        console.warn('[insta] ' + c.username + ' -> ' + res.erreur)
        if (alerteCookie === 'cookie_invalide') break // inutile de continuer
        await dodo(PAUSE_INSTA_MS)
        continue
      }

      const recents = res.reels.filter(r => r.posteA && (maintenant - r.posteA) <= PALIER_MAX_H * 3600e3)
      const vuesTotales = recents.reduce((s, r) => s + (r.vues || 0), 0)
      if (recents.length) {
        const avant = totauxPrecedents.get(c.username)
        classement.push({
          username: c.username,
          vues: vuesTotales,
          reels: recents.length,
          delta: typeof avant === 'number' ? Math.max(0, vuesTotales - avant) : 0,
        })
        totauxPrecedents.set(c.username, vuesTotales)
      }

      for (const r of recents) {
        if (!r.code) continue
        const ageH = (maintenant - r.posteA) / 3600e3
        // On ne poste QUE le dernier palier franchi, jamais l'historique :
        // sinon un reel decouvert a 10h d'age declencherait 1h + 2h + 6h d'un coup.
        const franchis = PALIERS.filter(p => ageH >= p)
        if (!franchis.length) continue
        const dernier = franchis[franchis.length - 1]
        // Les paliers precedents sont consideres comme traites (rattrapage silencieux).
        for (const p of franchis) if (p !== dernier) dejaPoste.add(r.code + ':' + p)
        if (!dejaPoste.has(r.code + ':' + dernier)) {
          aPoster.push({ username: c.username, reel: r, palier: dernier })
        }
      }
      await dodo(PAUSE_INSTA_MS)
    }

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
      for (const emb of embedsClassement(classement, heure)) {
        try { await salonClassement.send({ embeds: [emb] }) } catch (e) {
          console.error('[discord] classement echoue : ' + e.message)
        }
        await dodo(PAUSE_DISCORD_MS)
      }
    }

    // 5. Alerte si Instagram nous ferme la porte
    if (alerteCookie) {
      const texte = alerteCookie === 'cookie_invalide'
        ? '⚠️ Instagram refuse la session : la variable `IG_SESSION_COOKIE` est expirée ou invalide. Aucune statistique ne peut être lue tant qu\'elle n\'est pas renouvelée.'
        : '⚠️ Instagram limite les requêtes (rate limit). Les statistiques de ce cycle sont incomplètes ; espacer davantage (`PAUSE_INSTA_MS`) ou passer par un proxy.'
      try { await salonReels.send(texte) } catch { /* tant pis */ }
    }

    dernierCycle = {
      a: new Date().toISOString(),
      comptes: comptes.length,
      feedbacksPostes: postes,
      enAttente: Math.max(0, aPoster.length - postes),
      comptesClasses: classement.length,
      erreursInsta,
      dureeSec: Math.round((Date.now() - t0) / 1000),
    }
    console.log('[cycle] termine : ' + JSON.stringify(dernierCycle))
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
