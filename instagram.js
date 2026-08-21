// ---------------------------------------------------------------------------
// Lecture des reels d'un compte Instagram.
//
// Principe : le cookie de session est un BONUS, jamais une dependance.
// Si Instagram refuse le cookie (401), on le desactive et on bascule
// immediatement en lecture PUBLIQUE (anonyme) pour le reste du cycle.
//
// Contre le blocage d'IP datacenter (Render), trois defenses :
//   1. empreinte tournante  : User-Agent / app-id / plateforme changent a chaque appel
//   2. plusieurs portes     : 3 points d'entree Instagram essayes dans l'ordre
//   3. proxy optionnel      : INSTA_PROXY_URL (une ou plusieurs URLs separees par
//      des virgules) route les appels par un proxy residentiel si un jour on en a un.
// ---------------------------------------------------------------------------

const IG_APP_IDS = ['936619743392459', '1217981644879628']

const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
]

// Etat du cookie, partage par tout le processus.
let cookieActif = true
let cookieRefuseA = null
let cookieEchecs = 0            // refus consecutifs de la session
let lecturesAvecCookie = 0      // comptes sauves grace a la session
let lecturesConnexionRequise = 0 // comptes qu'Instagram cache aux deconnectes

// Proxy(s) optionnels. Charges paresseusement : si undici n'est pas dispo ou si
// aucune URL n'est fournie, on part en direct, exactement comme avant.
const PROXIES = (process.env.INSTA_PROXY_URL || '')
  .split(',').map(s => s.trim()).filter(Boolean)
let agents = null
let proxyIdx = 0

async function dispatcher() {
  if (!PROXIES.length) return undefined
  if (!agents) {
    try {
      const { ProxyAgent } = await import('undici')
      agents = PROXIES.map(u => new ProxyAgent(u))
      console.log('[insta] ' + agents.length + ' proxy(s) actifs')
    } catch (e) {
      console.warn('[insta] proxy inutilisable (' + e.message + ') -> appels directs')
      agents = []
    }
  }
  if (!agents.length) return undefined
  return agents[(proxyIdx++) % agents.length]
}

const dodo = ms => new Promise(r => setTimeout(r, ms))
const pioche = a => a[Math.floor(Math.random() * a.length)]

// Attente apres un 429 avant l'unique retry en ligne. Volontairement COURTE :
// une pause longue par compte, multipliee par tous les comptes rate-limites,
// consommait tout le budget de temps du cycle et bloquait la lecture du groupe.
const RL_BACKOFF_MS = parseInt(process.env.IG_RL_BACKOFF_MS || '4000', 10)

function cookieBrut() {
  return process.env.IG_SESSION_COOKIE || ''
}

export function etatCookie() {
  return {
    cookiePresent: !!cookieBrut(),
    cookieActif: cookieActif && !!cookieBrut(),
    cookieRefuseA,
    mode: cookieBrut() ? (cookieActif ? 'public + session en secours' : 'public seul (session refusee)') : 'public seul (aucune session)',
    lecturesAvecCookie,
    lecturesConnexionRequise,
    proxies: PROXIES.length,
  }
}

// Appele au debut de chaque cycle : si Nathan a renouvele le cookie et
// redeploye, on lui redonne sa chance sans attendre.
export function reactiverCookie() {
  cookieActif = true
  cookieEchecs = 0
  lecturesAvecCookie = 0
  lecturesConnexionRequise = 0
}

// Empreinte tournante : deux requetes de suite ne se ressemblent pas.
function headers(username, avecCookie) {
  const ua = pioche(UAS)
  const chrome = /Chrome\/(\d+)/.exec(ua)
  const h = {
    'User-Agent': ua,
    'X-IG-App-ID': pioche(IG_APP_IDS),
    'X-ASBD-ID': pioche(['129477', '198387', '359341']),
    'X-Requested-With': 'XMLHttpRequest',
    Accept: '*/*',
    'Accept-Language': pioche(['en-US,en;q=0.9', 'fr-FR,fr;q=0.9,en-US;q=0.8', 'en-GB,en;q=0.9']),
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    Referer: 'https://www.instagram.com/' + username + '/',
    Origin: 'https://www.instagram.com',
  }
  if (chrome) {
    h['Sec-CH-UA'] = '"Chromium";v="' + chrome[1] + '", "Not-A.Brand";v="24"'
    h['Sec-CH-UA-Mobile'] = '?0'
    h['Sec-CH-UA-Platform'] = ua.includes('Mac') ? '"macOS"' : ua.includes('Linux') ? '"Linux"' : '"Windows"'
  }
  const c = cookieBrut()
  if (avecCookie && c) h.Cookie = c
  return h
}

async function appel(url, username, avecCookie) {
  try {
    const opts = { headers: headers(username, avecCookie), signal: AbortSignal.timeout(20000) }
    const d = await dispatcher()
    if (d) opts.dispatcher = d
    return await fetch(url, opts)
  } catch (e) {
    return { _reseau: String((e && e.message) || e) }
  }
}

// Traduit un status HTTP en erreur metier.
function versErreur(status) {
  if (status === 401 || status === 403) return 'cookie_invalide'
  if (status === 429) return 'rate_limit'
  if (status === 404) return 'compte_introuvable'
  return 'http_' + status
}

// Normalise un media Instagram (forme "app").
function depuisFeedItem(it) {
  const estReel = it.media_type === 2 || it.product_type === 'clips' || !!it.clips_metadata
  if (!estReel) return null
  return {
    code: it.code || '',
    posteA: (it.taken_at ? it.taken_at * 1000 : 0),
    vues: it.play_count || it.ig_play_count || it.view_count || 0,
    likes: it.like_count || 0,
    commentaires: it.comment_count || 0,
  }
}

// Normalise un node GraphQL (forme "web_profile_info" / "?__a=1").
function depuisEdge(node) {
  if (!node || !node.is_video) return null
  return {
    code: node.shortcode || '',
    posteA: (node.taken_at_timestamp ? node.taken_at_timestamp * 1000 : 0),
    vues: node.video_view_count || node.video_play_count || 0,
    likes: (node.edge_liked_by && node.edge_liked_by.count) ||
           (node.edge_media_preview_like && node.edge_media_preview_like.count) || 0,
    commentaires: (node.edge_media_to_comment && node.edge_media_to_comment.count) || 0,
  }
}

function reelsDepuisUser(user) {
  const edges = (user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.edges) || []
  return edges.map(e => depuisEdge(e.node)).filter(Boolean)
}

function nbPostsUser(user) {
  return (user && user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.count) || 0
}

// Une passe complete (3 portes) dans un mode donne.
// Retourne { reels } | { erreur }
//
// REGLE ANTI-"faux 0 reel" : une porte n'est consideree comme faisant foi que
// si elle renvoie des posts. Un profil qui repond mais dont la liste de posts
// arrive vide (reponse incomplete d'Instagram, frequente sur les comptes
// signales lus depuis un datacenter) N'EST PAS traite comme "0 reel" : on
// essaie la porte suivante, et si tout revient vide on renvoie une erreur douce
// pour retenter au cycle suivant, au lieu de figer le compte a 0.
async function passe(username, combien, avecCookie) {
  const u = encodeURIComponent(username)
  let derniere = 'reponse_vide'

  // --- Porte 1 : feed app (la plus riche : play_count fiable) ---
  const r1 = await appel(
    'https://www.instagram.com/api/v1/feed/user/' + u + '/username/?count=' + combien,
    username, avecCookie
  )
  if (r1._reseau) derniere = 'reseau: ' + r1._reseau
  else if (r1.ok) {
    const j = await r1.json().catch(() => null)
    const items = (j && (j.items || (j.user && j.user.items))) || []
    if (items.length) return { reels: items.map(depuisFeedItem).filter(Boolean) }
  } else {
    derniere = versErreur(r1.status)
    if (derniere === 'compte_introuvable') return { erreur: derniere }
  }

  // --- Porte 2 : profil public sur www ---
  const r2 = await appel(
    'https://www.instagram.com/api/v1/users/web_profile_info/?username=' + u,
    username, avecCookie
  )
  if (r2._reseau) derniere = 'reseau: ' + r2._reseau
  else if (r2.ok) {
    const j = await r2.json().catch(() => null)
    const user = j && j.data && j.data.user
    if (user) {
      const reels = reelsDepuisUser(user)
      if (reels.length || nbPostsUser(user) === 0) return { reels }
    }
  } else {
    derniere = versErreur(r2.status)
    if (derniere === 'compte_introuvable') return { erreur: derniere }
  }

  // --- Porte 3 : meme donnee servie par i.instagram.com (autre front, autre quota) ---
  const r3 = await appel(
    'https://i.instagram.com/api/v1/users/web_profile_info/?username=' + u,
    username, avecCookie
  )
  if (r3._reseau) derniere = 'reseau: ' + r3._reseau
  else if (!r3.ok) {
    derniere = versErreur(r3.status)
    if (derniere === 'compte_introuvable') return { erreur: derniere }
  } else {
    const j3 = await r3.json().catch(() => null)
    const user3 = j3 && j3.data && j3.data.user
    if (user3) {
      const reels = reelsDepuisUser(user3)
      if (reels.length || nbPostsUser(user3) === 0) return { reels }
    }
  }

  // Le profil existe mais aucune porte n'a pu lister ses posts : reponse
  // incomplete -> erreur douce, on retentera au cycle suivant.
  return { erreur: derniere }
}

/**
 * Recupere les derniers reels d'un compte.
 *
 * ORDRE : ANONYME D'ABORD. Les lectures publiques sont BEAUCOUP plus tolerees
 * par Instagram que les requetes authentifiees venant d'un datacenter (une
 * session utilisee en masse depuis Render se fait rate-limiter tres vite).
 * La session ne sert donc qu'en DERNIER RECOURS, pour la poignee de comptes
 * signales qu'un visiteur deconnecte ne peut pas voir. Version allegee : on ne
 * fait plus de double-essai anonyme, donc un compte ferme coute 2 lectures au
 * lieu de ~3, ce qui limite le rate_limit.
 *
 * Retourne { reels: [...] } ou { erreur: "..." }.
 */

// Comptes appris comme "fermes" (Instagram exige une session pour les voir).
// Cette liste PERSISTE entre les cycles : une fois qu'on sait qu'un compte est
// ferme, on va DIRECTEMENT a la session pour lui (1 requete authentifiee ciblee)
// au lieu de gaspiller un 401 anonyme a chaque cycle. La session n'est donc
// utilisee que pour cette poignee de comptes -> pas de rate_limit de masse.
const comptesFermes = new Set()

async function lireSession(username, combien) {
  const rc = await passe(username, combien, true)
  // Backoff COURT (pas 45 s) : un worker bloque 45 s par compte epuisait tout
  // le budget de temps quand la moitie du groupe se faisait rate-limiter.
  if (rc.erreur === 'rate_limit') { await dodo(RL_BACKOFF_MS); return await passe(username, combien, true) }
  return rc
}

// Traite le resultat d'une lecture session (compteurs + gestion cookie).
function apresSession(rc) {
  if (rc.reels) { cookieEchecs = 0; lecturesAvecCookie++; return rc }
  if (rc.erreur === 'compte_introuvable') return rc
  if (rc.erreur === 'cookie_invalide') {
    cookieEchecs++
    if (cookieEchecs >= 5) {
      cookieActif = false
      cookieRefuseA = new Date().toISOString()
      console.warn('[insta] session refusee ' + cookieEchecs + 'x -> renouvelle IG_SESSION_COOKIE')
    }
    return { erreur: 'cookie_refuse' }
  }
  return { erreur: rc.erreur || 'connexion_requise' }
}

async function lire(username, combien) {
  const sessionDispo = !!cookieBrut() && cookieActif

  // --- 0. Compte DEJA connu comme ferme : session directe (pas de 401 gaspille) ---
  if (comptesFermes.has(username) && sessionDispo) {
    const res = apresSession(await lireSession(username, combien))
    if (res.reels) return res
    if (res.erreur === 'compte_introuvable') { comptesFermes.delete(username); return res }
    if (res.erreur !== 'cookie_refuse') return res
  }

  // --- 1. Lecture publique (anonyme) ---
  let r = await passe(username, combien, false)
  // Backoff COURT sur 429 : on ne bloque plus le worker 45 s. Les comptes encore
  // rate-limites seront repris par la passe de rattrapage du cycle (et au cycle
  // suivant sur une IP fraiche), ce qui laisse lire beaucoup plus de comptes.
  if (r.erreur === 'rate_limit') { await dodo(RL_BACKOFF_MS); r = await passe(username, combien, false) }
  if (r.reels) { comptesFermes.delete(username); return r } // lisible en public -> plus ferme
  if (r.erreur === 'compte_introuvable') return r
  if (r.erreur !== 'cookie_invalide') return r // reseau, http_5xx, reponse_vide

  // --- 2. 401 anonyme : ce compte exige une session connectee ---
  comptesFermes.add(username)
  lecturesConnexionRequise++
  if (!sessionDispo) {
    return { erreur: cookieBrut() ? 'cookie_refuse' : 'connexion_requise' }
  }
  return apresSession(await lireSession(username, combien))
}

// ---------------------------------------------------------------------------
// Resolution des pseudos : le nom du profil GeeLark n'est pas toujours le vrai
// pseudo Instagram (compte renomme, point en trop...). Exemple reel :
// GeeLark dit "alissa.keit", Instagram repond 404, et le compte vit sous
// "alisskkeit". Plutot que de perdre la ligne dans le classement, on retrouve
// le bon pseudo tout seul et on le garde en memoire pour les cycles suivants.
// ---------------------------------------------------------------------------

// Corrections manuelles, prioritaires sur tout le reste.
// Valeurs par defaut connues (comptes renommes cote Instagram) + surcharge par
// la variable ALIAS_COMPTES="nom_geelark:vrai_pseudo,autre:autre_vrai".
const ALIAS = {
  'alissa.keit': 'alisskkeit',
  'joana.keit': 'joanakeit',
}
for (const paire of (process.env.ALIAS_COMPTES || '').split(',')) {
  const [de, vers] = paire.split(':').map(s => (s || '').trim().toLowerCase())
  if (de && vers) ALIAS[de] = vers
}

const resolus = new Map() // nom GeeLark -> vrai pseudo Instagram

const simplifie = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')

// Distance de Levenshtein, pour ne jamais accepter un homonyme lointain.
function distance(a, b) {
  const m = a.length, n = b.length
  if (!m) return n
  if (!n) return m
  let prec = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cour = [i]
    for (let j = 1; j <= n; j++) {
      cour[j] = Math.min(
        prec[j] + 1,
        cour[j - 1] + 1,
        prec[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      )
    }
    prec = cour
  }
  return prec[n]
}

// Variantes evidentes, testees avant toute recherche : "joana.keit" -> "joanakeit".
function variantes(username) {
  const v = new Set([
    username.replace(/\./g, ''),
    username.replace(/_/g, ''),
    username.replace(/\./g, '_'),
    username.replace(/_/g, '.'),
  ])
  v.delete(username)
  return [...v]
}

// Recherche Instagram : renvoie les pseudos candidats.
// Plusieurs formulations, parce que le moteur d'Instagram ne fait pas le lien
// entre "alissa.keit" et "alisskkeit" ; en revanche il le fait sur "alissa".
async function candidats(username) {
  const requetes = [...new Set([
    username,
    simplifie(username),
    username.split(/[._]/)[0],
  ])].filter(q => q.length >= 3)

  const vus = new Set()
  for (const q of requetes) {
    const url = 'https://www.instagram.com/api/v1/web/search/topsearch/?context=blended&query=' +
                encodeURIComponent(q)
    const r = await appel(url, username, cookieActif && !!cookieBrut())
    if (r._reseau || !r.ok) continue
    const j = await r.json().catch(() => null)
    for (const u of (j && j.users) || []) {
      const nom = (u.user && u.user.username) || ''
      if (nom) vus.add(nom)
    }
    await dodo(1500)
  }
  return [...vus]
}

// Retourne { username, resultat } si on retrouve le compte, sinon null.
async function retrouver(username, combien) {
  const attendu = simplifie(username)

  for (const v of variantes(username)) {
    const r = await lire(v, combien)
    if (r.reels) return { username: v, resultat: r }
  }

  for (const c of await candidats(username)) {
    if (distance(attendu, simplifie(c)) > 2) continue
    const r = await lire(c, combien)
    if (r.reels) return { username: c, resultat: r }
  }
  return null
}

/**
 * Point d'entree public : lit les reels du compte, en retrouvant le vrai
 * pseudo Instagram si le nom du profil GeeLark ne correspond plus.
 */
export async function reelsDuCompte(username, combien = 12) {
  const cible = resolus.get(username) || ALIAS[username] || username

  const r = await lire(cible, combien)
  if (r.erreur !== 'compte_introuvable') return r

  const trouve = await retrouver(username, combien)
  if (!trouve) return { erreur: 'compte_introuvable' }

  resolus.set(username, trouve.username)
  console.warn('[insta] "' + username + '" introuvable -> lu sous "' + trouve.username +
               '" (pense a renommer le profil GeeLark)')
  return trouve.resultat
}

// Pour le journal de fin de cycle.
export function pseudosCorriges() {
  return [...resolus.entries()].map(([de, vers]) => de + ' -> ' + vers)
}
