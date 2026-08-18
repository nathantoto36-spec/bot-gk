// ---------------------------------------------------------------------------
// Bot Discord "SMS ROTATION" - version remise a zero (18/08/2026)
//
// Ce bot ne fait VOLONTAIREMENT rien d'automatique :
//   - aucune commande slash
//   - aucune tache planifiee
//   - aucun appel a Vercel, Gemini, Cloudflare, Sentry, Redis...
//
// Il se contente de :
//   1. se connecter a Discord (le bot apparait EN LIGNE)
//   2. exposer /health pour le keep-alive cron-job.org (evite la mise en veille)
//   3. afficher au demarrage le nom des 2 salons cibles, pour verification
//
// Les fonctions "stats GeeLark / Instagram" seront ajoutees ensuite, ici.
// ---------------------------------------------------------------------------

import { Client, GatewayIntentBits } from 'discord.js'
import express from 'express'

const TOKEN = process.env.DISCORD_BOT_TOKEN

// Les 2 salons cibles (fournis par Nathan)
const SALONS = [
  process.env.SALON_1 || '1539369975133765703',
  process.env.SALON_2 || '1539370313463111720',
]

if (!TOKEN) {
  console.error('[FATAL] Variable d\'environnement DISCORD_BOT_TOKEN absente.')
  process.exit(1)
}

// --- Serveur HTTP minimal (health check pour le keep-alive) ----------------

const app = express()
let botStatus = 'STARTING'
let salonsInfo = []

app.get('/', (_req, res) => res.send('bot-gk OK'))
app.get('/health', (_req, res) => {
  res.json({
    ok: botStatus === 'READY',
    botStatus,
    salons: salonsInfo,
    uptimeSec: Math.round(process.uptime()),
  })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`[http] /health ecoute sur le port ${PORT}`))

// --- Client Discord --------------------------------------------------------

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
})

client.once('clientReady', async () => {
  botStatus = 'READY'
  console.log(`[discord] connecte en tant que ${client.user.tag}`)

  // Resolution des 2 salons cibles : on affiche leur nom dans les logs Render
  salonsInfo = []
  for (const id of SALONS) {
    try {
      const ch = await client.channels.fetch(id)
      const info = {
        id,
        nom: ch?.name ?? '(inconnu)',
        serveur: ch?.guild?.name ?? '(hors serveur)',
      }
      salonsInfo.push(info)
      console.log(`[salon] ${id} -> #${info.nom}  (serveur : ${info.serveur})`)
    } catch (err) {
      salonsInfo.push({ id, nom: null, erreur: err.message })
      console.error(`[salon] ${id} -> INTROUVABLE : ${err.message}`)
    }
  }

  console.log('[discord] pret. Aucune tache planifiee, aucune commande active.')
})

client.on('error', (err) => console.error('[discord] erreur :', err))
process.on('unhandledRejection', (err) => console.error('[unhandled]', err))

client.login(TOKEN)
