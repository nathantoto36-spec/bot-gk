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
//   6. reecrit data/vues-teste.json (le workflow le commit)
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

const PALIERS = (process.env.PALIERS_TESTE || '1,3,6,10')
  .split(',').map(x => parseFloat(x.trim())).filter(n => n > 0).sort((a, b) => a - b)
const PALIER_MAX_H = PALIERS[PALIERS.length - 1] || 10

const SEUIL = parseInt(process.env.SEUIL_VUES || '200', 10)
const SEUIL_FAIBLE = parseInt(process.env.SEUIL_FAIBLE || '100', 10)
const PALIER_FAIBLE = parseFloat(process.env.PALIER_FAIBLE || '6')

const PAUSE_INSTA_MS = parseInt(process.env.PAUSE_INSTA_MS || '1800', 10)
const PAUSE_DISCORD_MS = 900
const PAGES_HISTO = 3

// Tolerance entre l'heure programmee et la publication reelle : un flow GeeLark
// met 2 a 4 min, plus le temps de demarrage du telephone.
const TOLERANCE_MS = parseInt(process.env.TESTE_TOLERANCE_MIN || '45', 10) * 60 * 1000
// Un post ne peut pas paraitre avant son heure : on n'accepte qu'une petite avance.
const AVANCE_MS = 5 * 60 * 1000
// En dessous de cet ecart entre deux creneaux candidats, on ne tranche pas.
const AMBIGU_MS = 12 * 60 * 1000

const FICHIER_ETAT = process.env.FICHIER_ETAT || 'data/vues-teste.json'
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

function videoDuReel(username, posteA) {
  const creneaux = (planning.comptes || {})[norm(username)]
  if (!creneaux || !creneaux.length || !posteA) return null
  const candidats = []
  for (const c of creneaux) {
    const retard = posteA - c.epoch * 1000
    if (retard < -AVANCE_MS || retard > TOLERANCE_MS) continue
    candidats.push({ retard: Math.abs(retard), c })
  }
  if (!candidats.length) return null
  candidats.sort((a, b) => a.retard - b.retard)
  const meilleur = candidats[0]
  const rival = candidats.find(x => x.c.video !== meilleur.c.video &&
                                    Math.abs(x.retard - meilleur.retard) <= AMBIGU_MS)
  return {
    video: meilleur.c.video,
    ecartMin: Math.round(meilleur.retard / 60000),
    ambigu: rival ? rival.c.video : null,
  }
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
  const delta = (vues || 0) - (prec.vues || 0)
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

function verdict(vues) {
  if (vues >= 5000) return { emoji: '💥', label: 'VIRAL', conseil: 'Ce reel explose. Reposte le meme format sur les autres comptes, et enchaine vite un 2e post pendant que la portee est haute.' }
  if (vues >= 1000) return { emoji: '🚀', label: 'CA MONTE', conseil: 'Bonne dynamique. Garde ce hook et ce son, et republie a la meme heure demain.' }
  if (vues >= 100) return { emoji: '🔥', label: 'BON DEBUT', conseil: 'Le contenu accroche deja. Reponds aux commentaires pour pousser encore la portee.' }
  return { emoji: '🌱', label: 'DEMARRAGE', conseil: 'Ca demarre doucement. Pour le prochain : hook plus fort des la 1re seconde, son tendance, et poste a ta meilleure heure.' }
}

function embedTeste(username, reel, palier, m, maintenant) {
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
  l.push('🕒 Publié **il y a ' + palier + 'h** · ' +
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

// --- Cycle -----------------------------------------------------------------

async function cycle() {
  console.log('[teste] demarrage (GitHub Actions, one-shot)')
  const moi = await discord('GET', '/users/@me')
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

  for (const u of comptes) {
    const r = await reelsDuCompte(u)
    if (r.erreur) {
      erreurs++
      console.warn('[insta] ' + u + ' -> ' + r.erreur)
      await dodo(PAUSE_INSTA_MS)
      continue
    }
    for (const reel of (r.reels || [])) {
      if (!reel.code || !reel.posteA) continue
      const ageH = (maintenant - reel.posteA) / 3600e3
      if (ageH > PALIER_MAX_H + 2) continue

      const m = videoDuReel(u, reel.posteA)
      // Uniquement les videos teste1 -> teste5 : les videos propres ne font pas
      // partie du test, et un reel hors planning n'est rattachable a rien.
      if (!m || !/^teste\d+$/i.test(m.video)) continue

      // On garde le releve AVANT de comparer : la comparaison se fait contre
      // l'ancien fichier, le nouveau servira au passage suivant.
      nouveauxReleves[reel.code] = { t: maintenant, vues: reel.vues || 0 }

      for (const p of PALIERS) {
        if (ageH >= p && !dejaPoste.has(reel.code + ':' + p)) {
          aPoster.push({ u, reel, p, m })
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

  aPoster.sort((a, b) => a.reel.posteA - b.reel.posteA || a.p - b.p)
  let postes = 0
  for (const it of aPoster) {
    try {
      await discord('POST', '/channels/' + SALON_TESTE + '/messages',
        { embeds: [embedTeste(it.u, it.reel, it.p, it.m, maintenant)] })
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

  // On ne garde que les reels encore dans la fenetre : le fichier ne gonfle pas.
  etat = { maj: new Date().toISOString(), releves: nouveauxReleves }
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

  console.log('[teste] ' + comptes.length + ' comptes · ' + postes + ' feedback(s) · ' +
              signales + ' faible(s) · ' + valides + ' au-dessus de ' + SEUIL + ' vues · ' +
              Object.keys(nouveauxReleves).length + ' releve(s) · ' + erreurs + ' erreur(s) Instagram')
}

cycle()
  .then(() => { console.log('[teste] cycle OK, sortie.'); process.exit(0) })
  .catch(e => { console.error('[teste] erreur fatale : ' + (e && e.stack ? e.stack : e)); process.exit(1) })
