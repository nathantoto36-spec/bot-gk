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

// Une passe complete (3 portes) dans un mode donne.
// Retourne { reels } | { erreur }
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
    const reels = items.map(depuisFeedItem).filter(Boolean)
    if (reels.length) return { reels }
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
    if (user) return { reels: reelsDepuisUser(user) }
  } else {
    derniere = versErreur(r2.status)
    if (derniere === 'compte_introuvable') return { erreur: derniere }
  }

  // --- Porte 3 : meme donnee servie par i.instagram.com (autre front, autre quota) ---
  const r3 = await appel(
    'https://i.instagram.com/api/v1/users/web_profile_info/?username=' + u,
    username, avecCookie
  )
  if (r3._reseau) return { erreur: 'reseau: ' + r3._reseau }
  if (!r3.ok) return { erreur: versErreur(r3.status) }
  const j3 = await r3.json().catch(() => null)
  const user3 = j3 && j3.data && j3.data.user
  if (user3) return { reels: reelsDepuisUser(user3) }

  return { erreur: derniere }
}

/**
 * Recupere les derniers reels d'un compte.
 *
 * ORDRE VOLONTAIRE : anonyme d'abord, cookie ENSUITE et seulement si besoin.
 * La majorite des comptes se lisent sans etre connecte ; on garde donc la
 * session pour la poignee de comptes qu'Instagram refuse de montrer aux
 * visiteurs deconnectes (comptes recents / signales). Moins la session est
 * utilisee, moins elle risque d'etre invalidee.
 *
 * Retourne { reels: [...] } ou { erreur: "..." }.
 */
export async function reelsDuCompte(username, combien = 12) {
  // --- 1. Lecture publique ---
  let r = await passe(username, combien, false)

  if (r.erreur === 'rate_limit') {
    await dodo(45000)
    r = await passe(username, combien, false)
  }
  if (r.reels) return r
  if (r.erreur === 'compte_introuvable') return r
  if (r.erreur !== 'cookie_invalide') return r // reseau, http_5xx, etc.

  // 401 en anonyme : deuxieme essai avec une empreinte totalement differente,
  // au cas ou ce serait juste un coup de semonce d'Instagram.
  await dodo(4000 + Math.floor(Math.random() * 4000))
  const r2 = await passe(username, combien, false)
  if (r2.reels) return r2
  if (r2.erreur === 'compte_introuvable') return r2

  // --- 2. Ce compte exige une session connectee ---
  lecturesConnexionRequise++
  if (!cookieBrut()) return { erreur: 'connexion_requise' }
  if (!cookieActif) return { erreur: 'cookie_refuse' }

  const r3 = await passe(username, combien, true)
  if (r3.reels) {
    cookieEchecs = 0
    lecturesAvecCookie++
    return r3
  }
  if (r3.erreur === 'compte_introuvable') return r3

  if (r3.erreur === 'cookie_invalide') {
    // On ne condamne PAS la session sur un seul refus : Instagram refuse
    // parfois une requete isolee. Trois refus d'affilee, la, c'est net.
    cookieEchecs++
    if (cookieEchecs >= 3) {
      cookieActif = false
      cookieRefuseA = new Date().toISOString()
      console.warn('[insta] session refusee 3 fois de suite -> IG_SESSION_COOKIE a renouveler')
    }
    return { erreur: 'cookie_refuse' }
  }
  return { erreur: r3.erreur || 'connexion_requise' }
}
