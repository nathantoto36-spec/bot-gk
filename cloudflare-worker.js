// ---------------------------------------------------------------------------
// Worker Cloudflare = point d'entree des interactions Discord (le "bouton").
//
// Role : recevoir le clic sur le bouton, verifier la signature Discord,
// repondre tout de suite "je reflechis..." (reponse differee), puis declencher
// le workflow GitHub qui calcule le classement et edite ce message.
//
// Variables a definir dans Cloudflare (Settings -> Variables and Secrets) :
//   DISCORD_PUBLIC_KEY  (Public Key de l'application, portail dev Discord)  [texte]
//   GH_TOKEN            (token GitHub fine-grained, droit "Contents: write") [secret]
//   GH_OWNER           = nathantoto36-spec        (variable simple, optionnel)
//   GH_REPO            = bot-gk                     (variable simple, optionnel)
//   BOUTON_ID          = classement_sans_legende   (variable simple, optionnel)
// ---------------------------------------------------------------------------

function hexToBytes(hex) {
  const s = String(hex || '')
  const out = new Uint8Array(Math.floor(s.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16)
  return out
}

// Cloudflare a 2 noms possibles pour Ed25519 selon la version du runtime :
// "Ed25519" (recent) et "NODE-ED25519" (ancien). On essaie les deux.
const VARIANTES_ED = [
  { name: 'Ed25519' },
  { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' },
]

async function verifierSignature(publicKeyHex, signatureHex, timestamp, body) {
  if (!publicKeyHex || !signatureHex || !timestamp) return false
  const keyBytes = hexToBytes(publicKeyHex)
  const sig = hexToBytes(signatureHex)
  const message = new TextEncoder().encode(timestamp + body)
  for (const algo of VARIANTES_ED) {
    try {
      const key = await crypto.subtle.importKey('raw', keyBytes, algo, false, ['verify'])
      const ok = await crypto.subtle.verify(algo.name, key, sig, message)
      return ok
    } catch (e) {
      // Cet algo n'est pas supporte ici -> on tente le suivant.
    }
  }
  return false
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
}

// Routage generique custom_id -> (event_type GitHub + action).
// Un bouton dont le custom_id n'est PAS liste ci-dessous declenche
// event_type = custom_id (action 'auto'). Donc pour ajouter un NOUVEAU bouton,
// il suffit de creer un workflow qui ecoute repository_dispatch [ce custom_id] :
// PLUS BESOIN de retoucher ce worker.
const ROUTES = {
  // Le bouton classement existe avant ce systeme : son event GitHub
  // ('classement_legende') differe de son custom_id -> alias explicite.
  classement_sans_legende: { event: 'classement_legende', action: 'classement' },
}

async function declencherGitHub(env, interaction, route) {
  const owner = env.GH_OWNER || 'nathantoto36-spec'
  const repo = env.GH_REPO || 'bot-gk'
  const url = 'https://api.github.com/repos/' + owner + '/' + repo + '/dispatches'
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.GH_TOKEN,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'bot-gk-worker',
      },
      body: JSON.stringify({
        event_type: route.event,
        client_payload: {
          action: route.action,
          custom_id: interaction.data && interaction.data.custom_id,
          token: interaction.token,
          application_id: interaction.application_id,
          channel_id: interaction.channel_id,
        },
      }),
    })
    if (!r.ok) console.log('GitHub dispatch KO : ' + r.status + ' ' + (await r.text()).slice(0, 200))
  } catch (e) {
    console.log('GitHub dispatch erreur : ' + e.message)
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') {
      const u = new URL(request.url)
      // Diagnostic : GET ...?debug=1 -> etat des variables + algo Ed25519 dispo.
      if (u.searchParams.get('debug') === '1') {
        let algoOk = null
        for (const algo of VARIANTES_ED) {
          try {
            await crypto.subtle.importKey('raw', hexToBytes(env.DISCORD_PUBLIC_KEY || '00'), algo, false, ['verify'])
            algoOk = algo.name; break
          } catch (e) { /* suivant */ }
        }
        return json({
          hasKey: !!env.DISCORD_PUBLIC_KEY,
          keyLen: String(env.DISCORD_PUBLIC_KEY || '').length,
          hasToken: !!env.GH_TOKEN,
          algoOk,
        })
      }
      return new Response('bot-gk interactions endpoint OK', { status: 200 })
    }
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })

    const signature = request.headers.get('X-Signature-Ed25519')
    const timestamp = request.headers.get('X-Signature-Timestamp')
    const body = await request.text()
    if (!signature || !timestamp) return new Response('Signature manquante', { status: 401 })

    const ok = await verifierSignature(env.DISCORD_PUBLIC_KEY, signature, timestamp, body)
    if (!ok) return new Response('Signature invalide', { status: 401 })

    let interaction
    try { interaction = JSON.parse(body) } catch { return new Response('Bad body', { status: 400 }) }

    // 1 = PING (validation de l'endpoint par Discord)
    if (interaction.type === 1) return json({ type: 1 })

    // 3 = clic sur un composant (bouton) -> routage generique par custom_id.
    if (interaction.type === 3 && interaction.data && interaction.data.custom_id) {
      const cid = interaction.data.custom_id
      const route = ROUTES[cid] || { event: cid, action: 'auto' }
      ctx.waitUntil(declencherGitHub(env, interaction, route))
      // type 5 = reponse differee EPHEMERE : Discord affiche "réfléchit...",
      // le workflow GitHub editera ce message (visible par le cliqueur seul).
      return json({ type: 5, data: { flags: 64 } }) // 64 = ephemere
    }

    return json({ type: 4, data: { content: 'Interaction non reconnue.', flags: 64 } })
  },
}
