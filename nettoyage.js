// ---------------------------------------------------------------------------
// Nettoyage des salons : retire les messages des comptes qui n'existent PLUS
// dans GeeLark.
//
// Le piege : le nom affiche dans Discord est le pseudo INSTAGRAM, alors que
// GeeLark connait le nom du PROFIL. Les deux different des qu'un compte a ete
// renomme (profil "irislo.lo" -> pseudo "@irislopx"). Comparer les noms a
// l'identique ferait donc supprimer des comptes bien vivants.
//
// D'ou trois niveaux de reconnaissance, du plus sur au plus tolerant :
//   1. nom identique
//   2. nom identique une fois la ponctuation retiree (lola.foler = lolafoler)
//   3. nom a une ou deux lettres pres (irislopx ~ irislo.lo)
// Un compte n'est declare supprime que si AUCUN des trois ne matche.
//
// Et deux garde-fous, parce qu'une suppression Discord est irreversible :
//   - si la liste GeeLark est incomplete, on ne supprime rien du tout
//   - si la purge depasse une grosse part du salon, on s'arrete et on alerte
// ---------------------------------------------------------------------------

const simplifie = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

function distance(a, b) {
  const m = a.length, n = b.length
  if (!m) return n
  if (!n) return m
  if (Math.abs(m - n) > 2) return 99      // inutile de calculer
  let prec = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cour = [i]
    for (let j = 1; j <= n; j++) {
      cour[j] = Math.min(prec[j] + 1, cour[j - 1] + 1, prec[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prec = cour
  }
  return prec[n]
}

/**
 * Prepare l'index des comptes vivants a partir de la liste GeeLark complete.
 * @param items  [{ name }] renvoye par listAllPhones
 * @param alias  { pseudoInstagram: nomGeeLark } corrections deja connues
 */
export function indexVivants(items, alias = {}) {
  const exacts = new Set()
  const simples = new Set()
  for (const p of items || []) {
    const n = String(p.name || '').trim().toLowerCase()
    if (!n) continue
    exacts.add(n)
    simples.add(simplifie(n))
  }
  const aliasSimples = new Set()
  for (const [pseudo, profil] of Object.entries(alias || {})) {
    if (simples.has(simplifie(profil))) aliasSimples.add(simplifie(pseudo))
  }
  return { exacts, simples, aliasSimples, liste: [...simples] }
}

/** Ce pseudo correspond-il encore a un profil GeeLark ? */
export function estVivant(pseudo, idx) {
  if (!idx) return true                       // pas d'index -> on ne juge pas
  const p = String(pseudo || '').trim().toLowerCase()
  if (!p) return true
  const s = simplifie(p)
  if (idx.exacts.has(p) || idx.simples.has(s) || idx.aliasSimples.has(s)) return true
  for (const v of idx.liste) if (distance(s, v) <= 2) return true
  return false
}

// Pseudo porte par un message du bot : titre "· @xxx", sinon description `@xxx`.
export function pseudoDuMessage(m) {
  for (const e of (m.embeds || [])) {
    const t = /·\s*@([A-Za-z0-9._]{2,30})/.exec(e.title || '')
    if (t) return t[1]
    const d = /`@([A-Za-z0-9._]{2,30})`/.exec(e.description || '')
    if (d) return d[1]
  }
  const c = /`@([A-Za-z0-9._]{2,30})`/.exec(m.content || '')
  return c ? c[1] : null
}

// Seuls les messages portant un de ces pieds sont des fiches "un compte, un
// reel". Tout le reste (etat des compteurs, recapitulatifs, classements) est
// laisse tranquille.
const PIEDS = ['gk:', 'gk0:', 'gk5:', 'gkl:', 'gkt:']

function estFiche(m) {
  for (const e of (m.embeds || [])) {
    const f = (e.footer && e.footer.text) || ''
    if (PIEDS.some(p => f.startsWith(p))) return true
  }
  return false
}

/**
 * Supprime dans un salon les fiches des comptes disparus de GeeLark.
 * @returns { supprimes, examines, comptes:[...] }
 */
export async function purgerSalon({ discord, lireMessages, salon, nom, idx, moiId, pages = 3, pause = 400, partMax = 0.75, maxParCycle = 150 }) {
  if (!salon || !idx) return { supprimes: 0, examines: 0, comptes: [] }
  let msgs = []
  try { msgs = await lireMessages(salon, pages) }
  catch (e) { console.error('[nettoyage] ' + nom + ' : lecture impossible (' + e.message + ')'); return { supprimes: 0, examines: 0, comptes: [] } }

  const fiches = msgs.filter(m => (!moiId || (m.author && m.author.id === moiId)) && estFiche(m))
  const morts = []
  for (const m of fiches) {
    const u = pseudoDuMessage(m)
    if (u && !estVivant(u, idx)) morts.push({ m, u })
  }
  if (!morts.length) return { supprimes: 0, examines: fiches.length, comptes: [] }

  // Un salon presque entierement "mort" trahit une liste GeeLark cassee, pas un
  // vrai retard de menage : dans le doute on ne touche a rien.
  if (fiches.length >= 10 && morts.length > fiches.length * partMax) {
    console.warn('[nettoyage] ' + nom + ' : ' + morts.length + '/' + fiches.length +
                 ' messages seraient supprimes — anormal, on ne touche a rien.')
    return { supprimes: 0, examines: fiches.length, comptes: [], suspect: true }
  }

  // Gros retard : on en fait une partie par cycle, pour ne pas faire deborder
  // le temps d'execution. Le reste part au passage suivant.
  const lot = morts.slice(0, maxParCycle)
  if (morts.length > lot.length) {
    console.log('[nettoyage] ' + nom + ' : ' + morts.length + ' a retirer, ' + lot.length +
                ' ce cycle (suite au prochain passage)')
  }

  let n = 0
  const comptes = new Set()
  for (const { m, u } of lot) {
    try {
      await discord('DELETE', '/channels/' + salon + '/messages/' + m.id)
      n++
      comptes.add(u)
    } catch (e) { console.error('[nettoyage] ' + nom + ' : ' + e.message) }
    await new Promise(r => setTimeout(r, pause))
  }
  if (n) console.log('[nettoyage] ' + nom + ' : ' + n + ' message(s) retires — ' + [...comptes].join(', '))
  return { supprimes: n, examines: fiches.length, comptes: [...comptes] }
}
