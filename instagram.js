// ---------------------------------------------------------------------------
// Lecture des reels d'un compte Instagram.
// Deux strategies, dans l'ordre :
//   1. /api/v1/feed/user/<username>/username/  (riche : play_count fiable)
//   2. /api/v1/users/web_profile_info/         (repli : video_view_count)
// Le cookie de session (IG_SESSION_COOKIE) est envoye s'il est defini.
// ---------------------------------------------------------------------------

const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const IG_APP_ID = '936619743392459'

function cookie() {
  return process.env.IG_SESSION_COOKIE || ''
}

function headers(username) {
  const h = {
    'User-Agent': UA_WEB,
    'X-IG-App-ID': IG_APP_ID,
    'X-ASBD-ID': '129477',
    'X-Requested-With': 'XMLHttpRequest',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: 'https://www.instagram.com/' + username + '/',
  }
  const c = cookie()
  if (c) h.Cookie = c
  return h
}

async function fetchRetry(url, opts, essais = 2) {
  let derniere = null
  for (let i = 0; i < essais; i++) {
    try {
      const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(20000) })
      if (r.ok) return r
      if (r.status === 404) return r
      derniere = 'HTTP ' + r.status
      if (r.status === 401 || r.status === 429) return r // inutile d'insister
      await new Promise(rs => setTimeout(rs, 500 + Math.random() * 700))
    } catch (e) {
      derniere = e.message
      await new Promise(rs => setTimeout(rs, 500))
    }
  }
  throw new Error(derniere || 'echec fetch')
}

// Normalise un media Instagram (forme "app") vers notre forme interne.
function depuisFeedItem(it) {
  const estReel = it.media_type === 2 || it.product_type === 'clips' || !!it.clips_metadata
  if (!estReel) return null
  return {
    code: it.code || '',
    posteA: (it.taken_at ? it.taken_at * 1000 : 0),
    vues: it.play_count || it.ig_play_count || it.view_count || 0,
    likes: it.like_count || 0,
    commentaires: it.comment_count || 0,
    legende: (it.caption && it.caption.text) || '',
  }
}

// Normalise un node GraphQL (forme "web_profile_info").
function depuisEdge(node) {
  if (!node || !node.is_video) return null
  return {
    code: node.shortcode || '',
    posteA: (node.taken_at_timestamp ? node.taken_at_timestamp * 1000 : 0),
    vues: node.video_view_count || node.video_play_count || 0,
    likes: (node.edge_liked_by && node.edge_liked_by.count) || (node.edge_media_preview_like && node.edge_media_preview_like.count) || 0,
    commentaires: (node.edge_media_to_comment && node.edge_media_to_comment.count) || 0,
    legende: (node.edge_media_to_caption && node.edge_media_to_caption.edges[0] && node.edge_media_to_caption.edges[0].node.text) || '',
  }
}

/**
 * Recupere les derniers reels d'un compte.
 * Retourne { reels: [...] } ou { erreur: "..." }.
 */
export async function reelsDuCompte(username, combien = 12) {
  // --- Strategie 1 : feed app ---
  try {
    const r = await fetchRetry(
      'https://www.instagram.com/api/v1/feed/user/' + encodeURIComponent(username) + '/username/?count=' + combien,
      { headers: headers(username) }
    )
    if (r.status === 401) return { erreur: 'cookie_invalide' }
    if (r.status === 429) return { erreur: 'rate_limit' }
    if (r.ok) {
      const j = await r.json().catch(() => null)
      const items = (j && (j.items || (j.user && j.user.items))) || []
      if (items.length) {
        const reels = items.map(depuisFeedItem).filter(Boolean)
        if (reels.length) return { reels }
      }
    }
  } catch (e) {
    // on tente la strategie 2
  }

  // --- Strategie 2 : web_profile_info ---
  try {
    const r = await fetchRetry(
      'https://www.instagram.com/api/v1/users/web_profile_info/?username=' + encodeURIComponent(username),
      { headers: headers(username) }
    )
    if (r.status === 401) return { erreur: 'cookie_invalide' }
    if (r.status === 429) return { erreur: 'rate_limit' }
    if (r.status === 404) return { erreur: 'compte_introuvable' }
    if (!r.ok) return { erreur: 'http_' + r.status }
    const j = await r.json().catch(() => null)
    const user = j && j.data && j.data.user
    if (!user) return { erreur: 'reponse_vide' }
    const edges = (user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.edges) || []
    const reels = edges.map(e => depuisEdge(e.node)).filter(Boolean)
    return { reels }
  } catch (e) {
    return { erreur: String((e && e.message) || e) }
  }
}
