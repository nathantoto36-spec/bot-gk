// ---------------------------------------------------------------------------
// Superviseur : demarre bot-gk ET le bot teste dans le meme service Render.
//
// Un service Render n'execute qu'une seule commande. Ce fichier en lance deux,
// chacun dans son propre processus enfant. L'interet par rapport a tout mettre
// dans un seul processus : si le suivi teste plante (Instagram qui coupe, une
// erreur non geree), il est redemarre tout seul et bot-gk n'est pas touche.
//
// Start Command sur Render :  node start-all.js
// (Root Directory et Build Command restent inchanges.)
//
// bot-gk garde le serveur HTTP /health sur $PORT — c'est lui que ping le
// keep-alive. Le bot teste demarre avec TESTE_NO_HTTP=1 pour ne pas essayer
// d'ouvrir le meme port, ce qui ferait tomber les deux.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const ENFANTS = [
  {
    nom: 'bot-gk',
    script: path.join(__dirname, 'index.js'),
    env: {},
    // Si bot-gk meurt, le service entier doit repartir : Render le redemarrera
    // proprement, avec ses variables et son etat reconstruit depuis Discord.
    critique: true,
  },
  {
    nom: 'teste',
    script: path.join(__dirname, 'teste', 'index.js'),
    env: { TESTE_NO_HTTP: '1' },
    critique: false,
  },
]

const MAX_REDEMARRAGES = 10
const FENETRE_MS = 10 * 60 * 1000   // au-dela de 10 min sans crash, on remet le compteur a zero
const DELAI_MS = 15 * 1000

function demarrer(cfg, essai = 0, dernierCrash = 0) {
  const p = spawn(process.execPath, [cfg.script], {
    env: { ...process.env, ...cfg.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const prefixe = l => l.split(/\r?\n/).filter(Boolean).map(x => '[' + cfg.nom + '] ' + x).join('\n')
  p.stdout.on('data', d => console.log(prefixe(d.toString())))
  p.stderr.on('data', d => console.error(prefixe(d.toString())))

  p.on('exit', (code, signal) => {
    const raison = signal ? ('signal ' + signal) : ('code ' + code)
    console.error('[superviseur] ' + cfg.nom + ' s\'est arrete (' + raison + ')')

    if (cfg.critique) {
      console.error('[superviseur] ' + cfg.nom + ' est critique — on arrete le service, Render le relancera.')
      process.exit(code === null ? 1 : code)
    }

    const maintenant = Date.now()
    const compteur = (maintenant - dernierCrash) > FENETRE_MS ? 0 : essai + 1
    if (compteur >= MAX_REDEMARRAGES) {
      console.error('[superviseur] ' + cfg.nom + ' a plante ' + compteur + ' fois de suite — on abandonne. ' +
                    'bot-gk continue de tourner normalement.')
      return
    }
    console.error('[superviseur] redemarrage de ' + cfg.nom + ' dans ' + (DELAI_MS / 1000) + 's ' +
                  '(tentative ' + (compteur + 1) + '/' + MAX_REDEMARRAGES + ')')
    setTimeout(() => demarrer(cfg, compteur, maintenant), DELAI_MS)
  })

  return p
}

console.log('[superviseur] demarrage de ' + ENFANTS.map(c => c.nom).join(' et '))
const processus = ENFANTS.map(c => demarrer(c))

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log('[superviseur] ' + sig + ' recu, arret des enfants')
    for (const p of processus) { try { p.kill(sig) } catch { /* deja mort */ } }
    setTimeout(() => process.exit(0), 3000)
  })
}
