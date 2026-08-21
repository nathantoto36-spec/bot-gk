// ---------------------------------------------------------------------------
// Worker Cloudflare = point d'entree des interactions Discord (le "bouton").
//
// Role : recevoir le clic sur le bouton, verifier la signature Discord,
// repondre tout de suite "je reflechis..." (reponse differee), puis declencher
// le workflow GitHub qui calcule le classement et edite ce message.
//
// Variables a definir dans Cloudflare (Settings -> Variables and Secrets) :
//   DISCORD_PUBLIC_KEY  (Public Key de l'application, portail dev Discord)  [secret]
//   GH_TOKEN            (token GitHub fine-grained, droit "Contents: write") [secret]
//   GH_OWNER           = nathantoto36-spec        (variable simple, optionnel)
//   GH_REPO            = bot-gk                     (variable simple, optionnel)
//   BOUTON_ID          = classement_sans_legende   (variable simple, optionnel)
// ---------------------------------------------------------------------------

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

async function verifierSignature(publicKeyHex, signatureHex, timestamp, body) {
  try {
    const key = await crypto.subtle.importKey('raw', hexToBytes(publicKeyHex), { name: 'Ed25519', namedCurve: 'Ed25519' }, false, ['verify'])
    const message = new TextEncoder().encode(timestamp + body)
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, hexToBytes(signatureHex), message)
  } catch (e) {
    return false
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
}

async function declencherGitHub(env, interaction) {
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
        event_type: 'classement_legende',
        client_payload: {
          action: 'classement',
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
    if (request.method === 'GET') return new Response('bot-gk interactions endpoint OK', { status: 200 })
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

    // 3 = clic sur un composant (bouton)
    const boutonId = env.BOUTON_ID || 'classement_sans_legende'
    if (interaction.type === 3 && interaction.data && interaction.data.custom_id === boutonId) {
      // On declenche le calcul en tache de fond puis on repond "je reflechis..."
      ctx.waitUntil(declencherGitHub(env, interaction))
      // type 5 = reponse differee publique : Discord affiche "réfléchit...",
      // le workflow GitHub editera ce message avec le classement.
      return json({ type: 5 })
    }

    // Tout le reste : reponse ephemere discrete.
    return json({ type: 4, data: { content: 'Interaction non reconnue.', flags: 64 } })
  },
}
