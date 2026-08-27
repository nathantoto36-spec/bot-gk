// ---------------------------------------------------------------------------
// Coupe les taches GeeLark qui s'eternisent.
//
// Constat : quand un flow leve une exception (« IG ne s'ouvre pas »), GeeLark
// met encore 8 a 10 minutes a relacher le telephone. Ces minutes sont
// facturees et le flow ne peut rien y faire : la decision est prise en une
// minute, le reste est du rangement cote GeeLark.
//
// Le seul levier reel est d'annuler la tache depuis l'exterieur. L'API
// l'autorise sur une tache « en cours » (doc GeeLark, Cancel_task).
//
// Seuil : 6 min. Sur 5 798 publications reussies, la plus longue a mis 5 min
// et 99 % sont passees sous 2 min 54. Aucune reussite n'est donc coupee.
//
// Tourne en boucle pendant toute la duree du job (une verification par
// minute), plutot que de dependre d'un cron que GitHub retarde beaucoup.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto'

const TOKEN = process.env.DISCORD_BOT_TOKEN
const API = 'https://discord.com/api/v10'
const SALON = process.env.SALON_CHIEN_DE_GARDE || process.env.SALON_COUT_AUTO || '1541618144173498408'

const GL_BASE = (process.env.GEELARK_BASE_URL || 'https://openapi.geelark.com').replace(/\/+$/, '')
const GL_APP_ID = (process.env.GEELARK_APP_ID || '').trim()
const GL_API_KEY = (process.env.GEELARK_API_KEY || '').trim()

const LIMITE = parseInt(process.env.LIMITE_MIN || '6', 10) * 60
const PAS = parseInt(process.env.PAS_SEC || '60', 10) * 1000
const DUREE = parseInt(process.env.DUREE_MIN || '340', 10) * 60 * 1000
const PREFIXE = process.env.PREFIXE_TACHE || 'Reel '
const SEC = process.env.A_BLANC === '1'

if (!GL_API_KEY) { console.error('[FATAL] GEELARK_API_KEY absente.'); process.exit(1) }

const dodo = ms => new Promise(r => setTimeout(r, ms))
const heure = e => new Date(e * 1000).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })

function glAuth() {
  const ts = String(Date.now())
  const traceId = crypto.randomUUID()
  const n = traceId.slice(0, 6)
  const sign = crypto.createHash('sha256').update(GL_APP_ID + traceId + ts + n + GL_API_KEY).digest('hex').toUpperCase()
  return { 'Content-Type': 'application/json', appId: GL_APP_ID, traceId, ts, nonce: n, sign }
}
async function gl(chemin, corps = {}) {
  for (let essai = 0; essai < 3; essai++) {
    try {
      const r = await fetch(GL_BASE + chemin, { method: 'POST', headers: glAuth(), body: JSON.stringify(corps), signal: AbortSignal.timeout(30000) })
      const j = await r.json()
      if (Number(j.code) === 0) return j
      if (essai === 2) return { error: 'api', code: j.code, msg: j.msg }
    } catch (e) { if (essai === 2) return { error: String(e.message || e) } }
    await dodo(1200)
  }
}
async function discord(chemin, corps) {
  if (!TOKEN) return
  try {
    await fetch(API + chemin, { method: 'POST', headers: { Authorization: 'Bot ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(corps) })
  } catch { /* le rapport Discord n'est pas critique */ }
}

/** Les taches actuellement EN COURS, avec leur duree depuis le lancement. */
async function enCours() {
  const out = []; let lastId
  for (let i = 0; i < 60; i++) {
    const b = { size: 100 }; if (lastId) b.lastId = lastId
    const r = await gl('/open/v1/task/historyRecords', b)
    if (!r || r.error) break
    const l = (r.data && (r.data.items || r.data.list)) || []
    out.push(...l)
    // l'historique est trie du plus recent au plus ancien : une fois qu'on est
    // loin dans le passe, plus rien ne peut etre « en cours »
    const vieux = l.every(t => Number(t.scheduleAt) < Math.floor(Date.now() / 1000) - 6 * 3600)
    if (l.length < 100 || vieux) break
    lastId = l[l.length - 1] && l[l.length - 1].id
    if (!lastId) break
  }
  const now = Math.floor(Date.now() / 1000)
  return out.filter(t => Number(t.status) === 2 && String(t.planName || '').startsWith(PREFIXE))
            .map(t => ({ ...t, depuis: now - Number(t.scheduleAt) }))
}

async function passe() {
  const l = await enCours()
  const trop = l.filter(t => t.depuis > LIMITE)
  if (!trop.length) return { vues: l.length, coupees: 0 }
  const ids = trop.map(t => String(t.id))
  let ok = 0
  if (!SEC) {
    for (let i = 0; i < ids.length; i += 50) {
      const r = await gl('/open/v1/task/cancel', { ids: ids.slice(i, i + 50) })
      if (r && !r.error) ok += (r.data && r.data.successAmount) || 0
    }
  }
  const lignes = trop.map(t => '`' + String(t.serialName || '?') + '` — ' + Math.round(t.depuis / 60) + ' min (prevue ' + heure(t.scheduleAt) + ')')
  console.log('[chien] ' + trop.length + ' tache(s) au-dela de ' + (LIMITE / 60) + ' min' + (SEC ? ' (a blanc)' : ', ' + ok + ' annulee(s)'))
  for (const x of lignes) console.log('   ' + x.replace(/`/g, ''))
  await discord('/channels/' + SALON + '/messages', {
    embeds: [{
      color: 0xe67e22,
      title: '⏹️ ' + trop.length + ' tâche(s) coupée(s) au-delà de ' + (LIMITE / 60) + ' min',
      description: lignes.slice(0, 15).join('\n') +
        (trop.length > 15 ? '\n_… et ' + (trop.length - 15) + ' autre(s)_' : '') +
        '\n\n_Minutes récupérées : environ **' + trop.reduce((a, b) => a + Math.max(0, Math.round((b.depuis - LIMITE) / 60)), 0) + '**._',
      footer: { text: 'gk:chien-de-garde' },
      timestamp: new Date().toISOString(),
    }],
  })
  return { vues: l.length, coupees: ok }
}

const fin = Date.now() + DUREE
console.log('[chien] demarrage — seuil ' + (LIMITE / 60) + ' min, verification toutes les ' + (PAS / 1000) + ' s, jusqu a ' + new Date(fin).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }) + (SEC ? ' [A BLANC]' : ''))
let tours = 0, total = 0
while (Date.now() < fin) {
  try { const r = await passe(); total += r.coupees; tours++ }
  catch (e) { console.error('[chien] passe en echec : ' + (e && e.message || e)) }
  if (tours % 30 === 0) console.log('[chien] ' + tours + ' verifications, ' + total + ' tache(s) coupee(s) au total')
  await dodo(PAS)
}
console.log('[chien] fin — ' + tours + ' verifications, ' + total + ' tache(s) coupee(s)')
