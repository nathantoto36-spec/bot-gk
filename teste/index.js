// ---------------------------------------------------------------------------
// bot-teste — bot Discord INDEPENDANT, dedie au suivi des videos "teste".
//
// Volontairement separe de bot-gk : token propre (appli "TAKA"), process propre,
// salon propre. Si celui-ci plante ou se fait rate-limiter par Instagram, le bot
// principal n'est pas affecte — et inversement.
//
// Il poste un feedback par reel a chaque palier franchi (1h, 3h, 6h, 10h) dans
// SALON_TESTE, avec :
//   - la video teste concernee (retrouvee via planning-teste.json)
//   - le seuil des 200 vues, atteint ou non
//   - la TENDANCE : le reel a-t-il pris des vues sur les ~10 dernieres minutes ?
//     vert = ca monte, jaune = ca stagne.
//
// Pour connaitre la tendance il faut deux mesures espacees. Le bot tourne donc
// toutes les 5 minutes, mais ne rappelle Instagram que pour les comptes dont un
// reel approche d'un palier — un balayage complet par heure suffit a decouvrir
// les nouveaux reels. Sans ca, interroger 28 comptes toutes les 5 min ferait
// bloquer le compte Instagram en quelques heures.
//
// Variables d'environnement :
//   DISCORD_BOT_TOKEN  (obligatoire) token du bot TAKA
//   SALON_TESTE        (defaut 1541707020413968444)
//   IG_SESSION_COOKIE  (fortement conseille) sinon Instagram limite tres vite
//   PALIERS            (defaut "1,3,6,10") ages en heures
//   SEUIL_VUES         (defaut 200)
//   PAUSE_INSTA_MS     (defaut 2500) pause entre deux comptes
// ---------------------------------------------------------------------------

import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js'
import express from 'express'
import { reelsDuCompte } from './instagram.js'
import { comptesSuivis, libelleVideo, videoDuReel, groupeDe, nbComptesTeste } from './teste.js'

// Token : on prend DISCORD_BOT_TOKEN_TESTE s'il existe (le bot TAKA, pour que
// les messages de teste soient bien identifiables), sinon on retombe sur le
// token du service — les messages sortiront alors sous le bot principal.
// Nommer la variable differemment evite le conflit "Duplicate key" de Render.
const TOKEN = process.env.DISCORD_BOT_TOKEN_TESTE || process.env.DISCORD_BOT_TOKEN
const SALON_TESTE = process.env.SALON_TESTE || '1541707020413968444'
const SEUIL = parseInt(process.env.SEUIL_VUES || '200', 10)
// Salon "comptes faibles" : juste le pseudo + le lien vers le profil, rien d'autre.
const SALON_FAIBLE = process.env.SALON_FAIBLE || '1541844783193129081'
const SEUIL_FAIBLE = parseInt(process.env.SEUIL_FAIBLE || '100', 10)
// Palier auquel on juge qu'un reel a eu "plusieurs heures" pour decoller.
const PALIER_FAIBLE = parseFloat(process.env.PALIER_FAIBLE || '6')
const PAUSE_INSTA_MS = parseInt(process.env.PAUSE_INSTA_MS || '2500', 10)
const PAUSE_DISCORD_MS = 1200

const PALIERS = (process.env.PALIERS || '1,3,6,10')
  .split(',').map(x => parseFloat(x.trim())).filter(n => n > 0).sort((a, b) => a - b)
const PALIER_MAX_H = PALIERS[PALIERS.length - 1] || 10

const TICK_MS = parseInt(process.env.TICK_MIN || '5', 10) * 60 * 1000
const DECOUVERTE_MS = 60 * 60 * 1000          // balayage complet : 1 fois par heure
const AVANT_PALIER_MS = 15 * 60 * 1000        // on commence a sonder 15 min avant un palier
// Fenetre acceptable pour la mesure "d'il y a 10 minutes".
const ECART_MIN_MS = 6 * 60 * 1000
const ECART_MAX_MS = 25 * 60 * 1000

if (!TOKEN) {
  console.error('[FATAL] Aucun token : definis DISCORD_BOT_TOKEN_TESTE (ou DISCORD_BOT_TOKEN).')
  process.exit(1)
}

const dodo = ms => new Promise(r => setTimeout(r, ms))
const nombre = n => Number(n || 0).toLocaleString('fr-FR')

// --- Etat ------------------------------------------------------------------

let botStatus = 'STARTING'
let dernierTick = null
let tickEnCours = false
let dernierScanComplet = 0
const dejaPoste = new Set()   // "<code>:<palier>"
// Ce salon liste des COMPTES faibles, pas des posts : on dedoublonne par pseudo.
const dejaFaible = new Set()  // "<username>"
const reels = new Map()       // code -> { username, posteA, vues, likes, commentaires, samples:[{t,vues}] }

// --- Serveur HTTP (keep-alive Render) --------------------------------------

// Quand ce bot tourne dans le meme service que bot-gk (lance par start-all.js),
// c'est bot-gk qui sert /health sur $PORT. Ouvrir le meme port ferait tomber les
// deux : on n'ouvre donc rien si TESTE_NO_HTTP est defini.
if (!process.env.TESTE_NO_HTTP) {
  const app = express()
  app.get('/', (_q, s) => s.send('bot-teste OK'))
  app.get('/health', (_q, s) => s.json({
    ok: botStatus === 'READY',
    botStatus,
    dernierTick,
    tickEnCours,
    paliers: PALIERS,
    comptesSuivis: nbComptesTeste(),
    reelsEnMemoire: reels.size,
    feedbacksPostes: dejaPoste.size,
    salon: SALON_TESTE,
    uptimeSec: Math.round(process.uptime()),
  }))
  const port = process.env.PORT_TESTE || process.env.PORT || 3000
  app.listen(port, () => console.log('[http] /health ecoute sur le port ' + port))
} else {
  console.log('[http] serveur desactive (TESTE_NO_HTTP) — bot-gk sert deja /health')
}

// --- Verdict et tendance ---------------------------------------------------

function verdict(vues) {
  if (vues >= 5000) return { emoji: '💥', label: 'VIRAL', conseil: 'Ce reel explose. Reposte le meme format sur les autres comptes, et enchaine vite un 2e post pendant que la portee est haute.' }
  if (vues >= 1000) return { emoji: '🚀', label: 'CA MONTE', conseil: 'Bonne dynamique. Garde ce hook et ce son, et republie a la meme heure demain.' }
  if (vues >= 100) return { emoji: '🔥', label: 'BON DEBUT', conseil: 'Le contenu accroche deja. Reponds aux commentaires pour pousser encore la portee.' }
  return { emoji: '🌱', label: 'DEMARRAGE', conseil: 'Ca demarre doucement. Pour le prochain : hook plus fort des la 1re seconde, son tendance, et poste a ta meilleure heure.' }
}

/**
 * Le reel a-t-il pris des vues sur les ~10 dernieres minutes ?
 * On cherche la mesure la plus recente prise entre 6 et 25 min avant maintenant.
 * Retourne { couleur, emoji, texte } — gris si aucune mesure exploitable.
 */
function tendance(entree, maintenant) {
  // Cas grave : le reel est en ligne mais n'a AUCUNE vue. Ce n'est pas une
  // question de tendance — le post n'a pas ete distribue du tout (shadowban,
  // proxy mort, compte limite). Violet, pour que ca saute aux yeux.
  if ((entree.vues || 0) === 0) {
    return {
      couleur: 0x9b59b6, emoji: '🟣',
      texte: '**0 vue** — le reel n\'est pas distribué du tout. À regarder en priorité : proxy, shadowban ou compte limité.',
      grave: true,
    }
  }

  const ech = (entree.samples || [])
    .filter(s => {
      const age = maintenant - s.t
      return age >= ECART_MIN_MS && age <= ECART_MAX_MS
    })
    .sort((a, b) => b.t - a.t)[0]

  if (!ech) {
    return {
      couleur: 0x95a5a6, emoji: '⚪',
      texte: 'Tendance inconnue — pas encore de mesure precedente pour comparer.',
    }
  }
  const delta = (entree.vues || 0) - (ech.vues || 0)
  const minutes = Math.round((maintenant - ech.t) / 60000)
  if (delta > 0) {
    return {
      couleur: 0x2ecc71, emoji: '🟢',
      texte: '**+' + nombre(delta) + ' vues** sur les ' + minutes + ' dernières minutes — ça monte.',
    }
  }
  return {
    couleur: 0xe74c3c, emoji: '🔴',
    texte: 'Aucune vue gagnée sur les ' + minutes + ' dernières minutes — ça ne monte pas.',
  }
}

function embedTeste(username, entree, palier, maintenant) {
  const reel = entree
  const v = verdict(reel.vues)
  const lib = libelleVideo(username, reel.posteA)
  const t = tendance(entree, maintenant)
  const atteint = (reel.vues || 0) >= SEUIL

  const interactions = (reel.likes || 0) + (reel.commentaires || 0)
  const taux = reel.vues > 0 ? ((interactions / reel.vues) * 100).toFixed(1) : '0.0'
  const lienPost = reel.code ? 'https://www.instagram.com/reel/' + reel.code + '/' : null
  const lienCompte = 'https://www.instagram.com/' + username + '/'

  const lignes = []
  const liens = []
  if (lienPost) liens.push('[Voir le post ↗](' + lienPost + ')')
  liens.push('[Ouvrir le compte ↗](' + lienCompte + ')')
  lignes.push(liens.join(' · '))
  // Pseudo en bloc de code : un clic le selectionne entierement. Sans le "@",
  // pour qu'il se colle tel quel dans la recherche Instagram.
  lignes.push('`' + username + '`')
  lignes.push('👁️ **' + nombre(reel.vues) + '** vues · ❤️ ' + nombre(reel.likes) +
              ' · 💬 ' + nombre(reel.commentaires) + ' · 📊 ' + taux + '%')
  lignes.push('🕒 Publié **il y a ' + palier + 'h** · ' +
              new Date(reel.posteA).toLocaleString('fr-FR', {
                timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit',
                hour: '2-digit', minute: '2-digit',
              }))
  lignes.push(t.emoji + ' ' + t.texte)
  lignes.push('🎬 Vidéo testée : ' + lib.texte)
  lignes.push('🏷️ Groupe : **' + groupeDe(username) + '**')
  lignes.push(atteint
    ? '✅ **Seuil des ' + SEUIL + ' vues ATTEINT** — cette vidéo peut être attribuée définitivement au compte.'
    : '❌ **Seuil des ' + SEUIL + ' vues NON atteint** — il manque ' +
      nombre(Math.max(0, SEUIL - (reel.vues || 0))) + ' vues. La vidéo n\'est pas attribuée au compte.')
  lignes.push('')
  lignes.push('💡 ' + v.conseil)

  return new EmbedBuilder()
    // La couleur porte la TENDANCE (vert = monte, jaune = stagne) : c'est ce qui
    // se voit le plus vite. Le seuil des 200 est dans le titre et en clair.
    .setColor(t.couleur)
    .setAuthor({ name: '@' + username, url: lienCompte })
    .setTitle(t.emoji + ' ' + v.emoji + ' Teste ' + palier + 'h · ' + v.label +
              ' · ' + (atteint ? SEUIL + '+ ✅' : '<' + SEUIL + ' ❌'))
    .setURL(lienPost || lienCompte)
    .setDescription(lignes.join('\n'))
    .setFooter({ text: 'gkt:' + reel.code + ':' + palier })
}

// --- Etat relu depuis l'historique du salon (pas de disque sur Render) ------

async function rechargerEtat(salon, moiId) {
  let avant, lus = 0
  for (let page = 0; page < 3; page++) {
    const msgs = await salon.messages.fetch({ limit: 100, ...(avant ? { before: avant } : {}) })
    if (!msgs.size) break
    for (const m of msgs.values()) {
      if (m.author.id !== moiId) continue
      for (const e of m.embeds) {
        const f = e.footer && e.footer.text
        if (f && f.startsWith('gkt:')) dejaPoste.add(f.slice(4))
      }
      lus++
    }
    avant = msgs.last().id
  }
  console.log('[etat] ' + dejaPoste.size + ' feedbacks deja postes retrouves dans ' + lus + ' messages')
}

// --- Lecture Instagram -----------------------------------------------------

async function scanner(username, maintenant) {
  const res = await reelsDuCompte(username)
  if (res.erreur) return res.erreur
  for (const r of res.reels) {
    if (!r.code || !r.posteA) continue
    if ((maintenant - r.posteA) > (PALIER_MAX_H + 2) * 3600e3) continue // trop vieux
    const e = reels.get(r.code) || { username, posteA: r.posteA, code: r.code, samples: [] }
    e.username = username
    e.code = r.code
    e.posteA = r.posteA
    e.vues = r.vues
    e.likes = r.likes
    e.commentaires = r.commentaires
    e.samples.push({ t: maintenant, vues: r.vues })
    if (e.samples.length > 12) e.samples = e.samples.slice(-12)
    reels.set(r.code, e)
  }
  return null
}

/** Comptes a rafraichir maintenant : ceux dont un reel approche d'un palier. */
function comptesAsonder(maintenant) {
  const s = new Set()
  for (const e of reels.values()) {
    const age = maintenant - e.posteA
    for (const p of PALIERS) {
      const cible = p * 3600e3
      if (age >= cible - AVANT_PALIER_MS && age <= cible + 60 * 60e3 &&
          !dejaPoste.has(e.code + ':' + p)) {
        s.add(e.username)
        break
      }
    }
  }
  return [...s]
}

// --- Cycle -----------------------------------------------------------------

async function tick(client) {
  if (tickEnCours) return
  tickEnCours = true
  const t0 = Date.now()

  try {
    const salon = await client.channels.fetch(SALON_TESTE).catch(() => null)
    if (!salon) {
      console.error('[tick] salon ' + SALON_TESTE + ' introuvable — le bot y a-t-il acces ?')
      return
    }

    const maintenant = Date.now()
    const complet = (maintenant - dernierScanComplet) >= DECOUVERTE_MS
    const cibles = complet ? comptesSuivis() : comptesAsonder(maintenant)
    if (complet) dernierScanComplet = maintenant

    let erreurs = 0, alerte = null
    for (const username of cibles) {
      const err = await scanner(username, Date.now())
      if (err) {
        erreurs++
        if (err === 'cookie_invalide' || err === 'rate_limit') alerte = err
        console.warn('[insta] ' + username + ' -> ' + err)
        if (alerte === 'cookie_invalide') break
      }
      await dodo(PAUSE_INSTA_MS)
    }

    // Paliers franchis.
    // On ne poste QUE les reels qu'on peut rattacher a un creneau programme :
    // ce sont ceux mis en teste. Un compte suivi peut avoir d'anciens reels
    // (postes avant la mise en teste, ou a la main) — on les ignore, sinon on
    // annoncerait un resultat sans savoir quelle video l'a produit.
    const apres = Date.now()
    const aPoster = []
    let ignores = 0
    for (const e of reels.values()) {
      const ageH = (apres - e.posteA) / 3600e3
      const planifie = videoDuReel(e.username, e.posteA)
      // Uniquement les videos teste1 -> teste5. Les videos propres (xxxdef) sont
      // rattachables au planning mais ne font pas partie du test.
      const estTeste = planifie && /^teste\d+$/i.test(planifie.video)
      for (const p of PALIERS) {
        if (ageH < p || dejaPoste.has(e.code + ':' + p)) continue
        if (!planifie || !estTeste) {
          // hors planning : on marque comme traite pour ne pas le reexaminer
          dejaPoste.add(e.code + ':' + p)
          ignores++
          continue
        }
        aPoster.push({ e, p })
      }
    }
    if (ignores) console.log('[tick] ' + ignores + ' reel(s) hors planning ignore(s)')
    aPoster.sort((a, b) => a.e.posteA - b.e.posteA || a.p - b.p)

    let postes = 0
    for (const it of aPoster) {
      try {
        await salon.send({ embeds: [embedTeste(it.e.username, it.e, it.p, apres)] })
        dejaPoste.add(it.e.code + ':' + it.p)
        postes++
      } catch (err) {
        console.error('[discord] envoi echoue (' + it.e.username + ') : ' + err.message)
      }
      await dodo(PAUSE_DISCORD_MS)
    }

    // Salon "moins de 100 vues" : un reel qui a eu plusieurs heures pour decoller
    // et qui reste sous le seuil. Message minimal — le pseudo et son profil.
    let faibles = 0
    const salonFaible = await client.channels.fetch(SALON_FAIBLE).catch(() => null)
    if (salonFaible) {
      for (const e of reels.values()) {
        if (dejaFaible.has(e.username)) continue
        const ageH = (apres - e.posteA) / 3600e3
        if (ageH < PALIER_FAIBLE) continue
        const pl = videoDuReel(e.username, e.posteA)
        if (!pl || !/^teste\d+$/i.test(pl.video)) continue
        if ((e.vues || 0) >= SEUIL_FAIBLE) continue
        try {
          await salonFaible.send('`' + e.username + '` · https://www.instagram.com/' + e.username + '/')
          dejaFaible.add(e.username)
          faibles++
        } catch (err) {
          console.error('[discord] salon faibles echoue (' + e.username + ') : ' + err.message)
        }
        await dodo(PAUSE_DISCORD_MS)
      }
    } else {
      console.warn('[tick] salon faibles ' + SALON_FAIBLE + ' introuvable')
    }

    // Menage : on oublie les reels trop vieux pour tous les paliers
    for (const [code, e] of reels) {
      if ((apres - e.posteA) > (PALIER_MAX_H + 2) * 3600e3) reels.delete(code)
    }

    if (alerte) {
      const texte = alerte === 'cookie_invalide'
        ? '⚠️ Instagram refuse la session : `IG_SESSION_COOKIE` est expirée ou invalide. Aucune statistique ne peut être lue tant qu\'elle n\'est pas renouvelée.'
        : '⚠️ Instagram limite les requêtes (rate limit). Les mesures de ce cycle sont incomplètes ; augmenter `PAUSE_INSTA_MS` ou `TICK_MIN`.'
      try { await salon.send(texte) } catch { /* tant pis */ }
    }

    dernierTick = {
      a: new Date().toISOString(),
      type: complet ? 'balayage complet' : 'sondage cible',
      comptesInterroges: cibles.length,
      reelsEnMemoire: reels.size,
      feedbacksPostes: postes,
      comptesFaiblesSignales: faibles,
      horsPlanningIgnores: ignores,
      erreurs,
      dureeSec: Math.round((Date.now() - t0) / 1000),
    }
    console.log('[tick] ' + JSON.stringify(dernierTick))
  } catch (e) {
    console.error('[tick] erreur inattendue : ' + (e && e.stack ? e.stack : e))
  } finally {
    tickEnCours = false
  }
}

// --- Client Discord --------------------------------------------------------

const client = new Client({ intents: [GatewayIntentBits.Guilds] })

client.once('clientReady', async () => {
  botStatus = 'READY'
  console.log('[discord] connecte en tant que ' + client.user.tag)

  const salon = await client.channels.fetch(SALON_TESTE).catch(e => {
    console.error('[salon] ' + SALON_TESTE + ' INTROUVABLE : ' + e.message)
    console.error('        -> le bot est-il invite ET ajoute aux autorisations du salon prive ?')
    return null
  })
  if (salon) {
    console.log('[salon] teste = #' + salon.name + ' (' + SALON_TESTE + ')')
    await rechargerEtat(salon, client.user.id).catch(e => console.error('[etat] ' + e.message))
  }

  const salonFaible = await client.channels.fetch(SALON_FAIBLE).catch(e => {
    console.error('[salon] faibles ' + SALON_FAIBLE + ' INTROUVABLE : ' + e.message)
    return null
  })
  if (salonFaible) {
    console.log('[salon] faibles = #' + salonFaible.name + ' (' + SALON_FAIBLE + ')')
    try {
      const msgs = await salonFaible.messages.fetch({ limit: 100 })
      for (const m of msgs.values()) {
        if (m.author.id !== client.user.id) continue
        const mm = m.content.match(/^`([a-z0-9._]+)`/i)
        if (mm) dejaFaible.add(mm[1])
      }
      console.log('[etat] ' + dejaFaible.size + ' compte(s) faible(s) deja signale(s)')
    } catch (e) { console.error('[etat faibles] ' + e.message) }
  }

  if (!process.env.IG_SESSION_COOKIE_TESTE && !process.env.IG_SESSION_COOKIE) {
    console.warn('[insta] IG_SESSION_COOKIE_TESTE / IG_SESSION_COOKIE absentes — Instagram va limiter les requetes tres vite.')
  }

  console.log('[bot] ' + nbComptesTeste() + ' comptes · paliers ' + PALIERS.join('h, ') + 'h · seuil ' +
              SEUIL + ' vues · tick ' + Math.round(TICK_MS / 60000) + ' min')
  tick(client)
  setInterval(() => tick(client), TICK_MS)
})

client.on('error', e => console.error('[discord] erreur :', e))
process.on('unhandledRejection', e => console.error('[unhandled]', e))

client.login(TOKEN)
