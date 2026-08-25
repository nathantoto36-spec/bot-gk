// ---------------------------------------------------------------------------
// Suivi des comptes "en teste" (videos teste1 -> teste5).
//
// Le planning des posts programmes sur GeeLark est stocke dans
// planning-teste.json. A partir de l'heure de publication d'un reel, on
// retrouve le creneau programme le plus proche, donc QUELLE video a ete
// postee. Sans ca, impossible de savoir laquelle des 5 a genere les vues :
// la legende est identique pour toutes.
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Tolerance entre l'heure programmee et l'heure reelle de publication.
// Un post GeeLark demarre a l'heure prevue mais le flow met 2 a 4 min,
// et peut etre retarde si le telephone met du temps a booter.
const TOLERANCE_MS = parseInt(process.env.TESTE_TOLERANCE_MIN || '45', 10) * 60 * 1000

const norm = s => String(s || '').trim().toLowerCase().replace(/[._-]+/g, '_')

let planning = { comptes: {}, groupeVideoPropre: [] }
try {
  planning = JSON.parse(fs.readFileSync(path.join(__dirname, 'planning-teste.json'), 'utf8'))
} catch (e) {
  console.warn('[teste] planning-teste.json illisible : ' + e.message + ' — suivi teste desactive')
}

const COMPTES = new Set(Object.keys(planning.comptes || {}))
const VIDEO_PROPRE = new Set((planning.groupeVideoPropre || []).map(norm))

/** Ce compte fait-il partie du suivi teste ? */
export function estEnTeste(username) {
  return COMPTES.has(norm(username))
}

export function nbComptesTeste() {
  return COMPTES.size
}

/**
 * Liste des VRAIS pseudos Instagram a surveiller.
 * Les cles de `comptes` sont normalisees (points remplaces par des underscores) :
 * il faut passer par la table `pseudos` pour retrouver "emilyml.x" a partir de
 * "emilyml_x", sinon on interroge un compte qui n'existe pas.
 */
export function comptesSuivis() {
  const ps = planning.pseudos || {}
  return Object.keys(planning.comptes || {}).map(k => ps[k] || k)
}

/** Groupe GeeLark d'un compte, pour l'afficher dans l'embed. */
export function groupeDe(username) {
  return (planning.groupes || {})[norm(username)] || '(inconnu)'
}

/**
 * Retrouve la video programmee correspondant a un reel publie.
 * Retourne { video, ecartMin, prevuA } ou null si aucun creneau ne colle.
 */
// Un post ne peut pas paraitre AVANT son heure programmee : le flow met 2 a 4
// min, plus le boot du telephone. On n'accepte donc qu'une petite avance
// (horloges pas parfaitement synchro) et on privilegie les creneaux anterieurs.
const AVANCE_TOLEREE_MS = 5 * 60 * 1000
// En dessous de cet ecart entre deux creneaux candidats, on ne peut pas trancher.
const AMBIGU_MS = 12 * 60 * 1000

export function videoDuReel(username, posteA) {
  const creneaux = (planning.comptes || {})[norm(username)]
  if (!creneaux || !creneaux.length || !posteA) return null

  const candidats = []
  for (const c of creneaux) {
    const retard = posteA - c.epoch * 1000       // > 0 : publie apres l'heure prevue
    if (retard < -AVANCE_TOLEREE_MS) continue    // creneau encore a venir
    if (retard > TOLERANCE_MS) continue          // creneau trop ancien
    candidats.push({ retard: Math.abs(retard), c })
  }
  if (!candidats.length) return null
  candidats.sort((a, b) => a.retard - b.retard)

  const meilleur = candidats[0]
  // Deux creneaux tres proches avec des videos differentes : on ne devine pas.
  const rival = candidats.find(x => x.c.video !== meilleur.c.video &&
                                    Math.abs(x.retard - meilleur.retard) <= AMBIGU_MS)
  return {
    video: meilleur.c.video,
    prevuA: meilleur.c.epoch * 1000,
    ecartMin: Math.round(meilleur.retard / 60000),
    ambigu: rival ? rival.c.video : null,
  }
}

/** Libelle lisible pour l'embed. */
export function libelleVideo(username, posteA) {
  const m = videoDuReel(username, posteA)
  if (m) {
    const retard = m.ecartMin >= 5 ? ' · publie ' + m.ecartMin + ' min apres l\'heure prevue' : ''
    if (m.ambigu) {
      return {
        texte: '`' + m.video + '` ou `' + m.ambigu + '` ⚠️ deux creneaux trop proches pour trancher' + retard,
        video: m.video,
      }
    }
    return { texte: '`' + m.video + '`' + retard, video: m.video }
  }
  if (VIDEO_PROPRE.has(norm(username))) return { texte: '`video propre` (hors planning)', video: null }
  return { texte: '`video inconnue` — aucun creneau programme ne correspond', video: null }
}
