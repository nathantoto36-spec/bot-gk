// ---------------------------------------------------------------------------
// Lecture des reels d'un compte Instagram.
//
// Principe : le cookie de session est un BONUS, jamais une dependance.
// Si Instagram refuse le cookie (401), on le desactive et on bascule
// immediatement en lecture PUBLIQUE (anonyme) pour le reste du cycle.
// Le bot continue donc de tourner meme avec un IG_SESSION_COOKIE mort.
//
// Deux points d'entree Instagram, essayes dans l'ordre :
//   1. /api/v1/feed/user/<username>/username/  (riche : play_count fiable)
//   2. /api/v1/users/web_profile_info/         (public : video_view_count)
// ---------------------------------------------------------------------------

const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const IG_APP_ID = '936619743392459'

// Etat du cookie, partage par tout le processus.
let cookieActif = true
let cookieRefuseA = null

const dodo = ms => new Promise(r => setTimeout(r, ms))

function cookieBrut() {
  return process.env.IG_SESSION_COOKIE || ''
}

export function etatCookie() {
  return {
    cookiePresent: !!cookieBrut(),
    cookieActif: cookieActif && !!cookieBrut(),
    cookieRefuseA,
    mode: (cookieActif && cookieBrut()) ? 'session' : 'public',
  }
}

// Appele au debut de chaque cycle : si Nathan a renouvele le cookie et
// redeploye, on lui redonne sa chance sans attendre.
export function reactiverCookie() {
  cookieActif = true
}

function headers(username, avecCookie) {
  const h = {
    'User-Agent': UA_WEB,
    'X-IG-App-ID': IG_APP_ID,
    'X-ASBD-ID': '129477',
    'X-Requested-With': 'XMLHttpRequest',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://www.instagram.com/' + username + '/',
  }
  const c = cookieBrut()
  if (avecCookie && c) h.Cookie = c
  return h
}

async function appel(url, username, avecCookie) {
  try {
    return await fetch(url, { headers: headers(username, avecCookie), signal: AbortSignal.timeout(20000) })
  } catch (e) {
    return { _reseau: String((e && e.message) || e) }
  }
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

// Normalise un node GraphQL (forme "web_profile_info").
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

// Une passe complete (strategie 1 puis 2) dans un mode donne.
// Retourne { reels } | { erreur }
async function passe(username, combien, avecCookie) {
  // --- Strategie 1 : feed app ---
  const r1 = await appel(
    'https://www.instagram.com/api/v1/feed/user/' + encodeURIComponent(username) + '/username/?count=' + combien,
    username, avecCookie
  )
  if (!r1._reseau) {
    if (r1.status === 401) return { erreur: 'cookie_invalide' }
    if (r1.status === 429) return { erreur: 'rate_limit' }
    if (r1.ok) {
      const j = await r1.json().catch(() => null)
      const items = (j && (j.items || (j.user && j.user.items))) || []
      if (items.length) {
        const reels = items.map(depuisFeedItem).filter(Boolean)
        if (reels.length) return { reels }
      }
    }
  }

  // --- Strategie 2 : profil public ---
  const r2 = await appel(
    'https://www.instagram.com/api/v1/users/web_profile_info/?username=' + encodeURIComponent(username),
    username, avecCookie
  )
  if (r2._reseau) return { erreur: 'reseau: ' + r2._reseau }
  if (r2.status === 401) return { erreur: 'cookie_invalide' }
  if (r2.status === 429) return { erreur: 'rate_limit' }
  if (r2.status === 404) return { erreur: 'compte_introuvable' }
  if (!r2.ok) return { erreur: 'http_' + r2.status }

  const j = await r2.json().catch(() => null)
  const user = j && j.data && j.data.user
  if (!user) return { erreur: 'reponse_vide' }
  const edges = (user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.edges) || []
  return { reels: edges.map(e => depuisEdge(e.node)).filter(Boolean) }
}

/**
 * Recupere les derniers reels d'un compte.
 * Bascule automatiquement en lecture publique si le cookie est refuse.
 * Retourne { reels: [...] } ou { erreur: "..." }.
 */
export async function reelsDuCompte(username, combien = 12) {
  const aUnCookie = !!cookieBrut()

  // Ordre des tentatives : avec cookie (s'il est encore juge valable), puis sans.
  const modes = (aUnCookie && cookieActif) ? [true, false] : [false]

  let derniere = 'inconnue'
  for (const avecCookie of modes) {
    let r = await passe(username, combien, avecCookie)

    // Instagram temporise : on souffle puis on retente UNE fois, au lieu d'abandonner.
    if (r.erreur === 'rate_limit') {
      console.warn('[insta] rate limit sur ' + username + ' -> pause 45 s puis nouvel essai')
      await dodo(45000)
      r = await passe(username, combien, avecCookie)
    }

    if (r.reels) return r

    if (r.erreur === 'cookie_invalide') {
      if (avecCookie) {
        // LE point important : le cookie est mort, on ne s'arrete pas pour autant.
        cookieActif = false
        cookieRefuseA = new Date().toISOString()
        console.warn('[insta] cookie refuse par Instagram -> desactive, on bascule en lecture publique')
        continue // on rejoue le meme compte sans cookie
      }
      // 401 meme sans cookie : c'est l'IP qui est refusee, pas le cookie.
      derniere = 'refus_ip'
      continue
    }

    // Inutile de retenter sans cookie : le compte n'existe pas.
    if (r.erreur === 'compte_introuvable') return r

    derniere = r.erreur
  }
  return { erreur: derniere }
}
