// ======================================================================
// Cloudflare Pages Function — Canlı Instagram akışı / tek paylaşım çözücü
// URL: /api/igfeed?username=ades.media
//
// ORTAK MİMARİ: Tek kaynak "content.json" içindeki "igfeed" listesidir.
// Admin panelden her kareye istersen bir Instagram paylaşım linki girersin
// (link alanı). Bu fonksiyon, linkteki gönderinin gerçek görselini
// Instagram'ın resmî /media/?size= uç noktası üzerinden otomatik çeker ve
// beğeni/yorum sayılarını da (varsa) ekleyip ön yüze döndürür.
//
// Akış:
//   1) content.json'daki "igfeed" listesini oku (aynı reponun dosyası).
//   2) Her madde için:
//        - "link" varsa  -> gönderi görselini otomatik çöz (kayıt başına)
//        - "image" varsa -> yedek görsel olarak kullan
//   3) Liste boşsa ve Cloudflare'da IG_ACCESS_TOKEN ayarlıysa:
//        resmî Instagram Graph API ile hesabın son gönderilerini çek.
//   4) Hiçbiri olmazsa { ok:false } döner; ön yüz statik içeriğe düşer.
// ======================================================================

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function extractShortcode(postUrl) {
  const u = String(postUrl || '');
  let m = /instagram\.com\/(?:p|reel|reels|tv|share)\/([A-Za-z0-9_\-]+)/i.exec(u);
  if (!m) m = /instagram\.com\/p\/([A-Za-z0-9_\-]+)/i.exec(u);
  if (!m) m = /\/p\/([A-Za-z0-9_\-]+)/i.exec(u);
  return m ? m[1] : null;
}

// Tek paylaşım linkinin gerçek görsel URL'sini döndürür (oturumsuz).
async function resolvePostImage(postUrl) {
  const code = extractShortcode(postUrl);
  if (!code) throw new Error('Geçersiz Instagram linki');
  const res = await fetch(`https://www.instagram.com/p/${code}/media/?size=m`, {
    redirect: 'manual',
    headers: { 'user-agent': UA, 'accept': 'image/*' },
  });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') || '';
    if (/fbcdn|cdninstagram/i.test(loc)) return loc;
  }
  throw new Error('Görsel çözülemedi (HTTP ' + res.status + ')');
}

// content.json'daki "igfeed" listesini okuyup linkleri görsele çevirir.
async function buildFromConfig(context) {
  let items = [];
  try {
    const assets = context.env && context.env.ASSETS;
    if (assets && assets.fetch) {
      const r = await assets.fetch(new URL('/content.json', context.request.url));
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j.igfeed)) items = j.igfeed;
      }
    }
  } catch (e) { /* dene: origin üzerinden */ }
  if (!items.length) {
    try {
      const r = await fetch(new URL('/content.json', context.request.url));
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j.igfeed)) items = j.igfeed;
      }
    } catch (e) { /* yok */ }
  }

  const out = [];
  for (const it of items.slice(0, 12)) {
    const link = String(it.link || '').trim();
    let image = '';
    if (link) {
      try { image = await resolvePostImage(link); } catch (e) { image = ''; }
    }
    if (!image && it.image) image = String(it.image);
    const likes = String(it.likes != null ? it.likes : '0');
    const comments = String(it.comments != null ? it.comments : '0');
    if (!image) continue;
    out.push({
      url: link || (it.url || ''),
      image,
      thumb: image,
      likes,
      comments,
      caption: String(it.caption || ''),
    });
  }
  return out;
}

// Resmî Instagram Graph API (token ayarlıysa, hesabın son gönderileri)
async function fetchGraph(token, userId) {
  const fields = 'id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count,thumbnail_url';
  let igUserId = userId;
  if (!igUserId) {
    const me = await fetch(
      `https://graph.instagram.com/v21.0/me?fields=id,username&access_token=${encodeURIComponent(token)}`
    ).then(r => r.json());
    igUserId = me && me.id;
    if (!igUserId) throw new Error('IG_USER_ID çözülemedi');
  }
  const url =
    `https://graph.instagram.com/v21.0/${igUserId}/media?` +
    `fields=${encodeURIComponent(fields)}&limit=12&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('graph ' + res.status);
  const json = await res.json();
  if (!json.data || !json.data.length) throw new Error('graph veri yok');
  return (json.data || []).map(m => {
    const img = m.thumbnail_url || m.media_url || '';
    return {
      url: m.permalink || '',
      image: img,
      thumb: img,
      likes: String(m.like_count || 0),
      comments: String(m.comments_count || 0),
      caption: m.caption || '',
    };
  }).filter(p => p.image && p.image.indexOf('http') === 0);
}

// Son çare: herkese açık profil kazıma (genellikle engellenir)
async function fetchPublic(username) {
  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      'accept': '*/*',
      'accept-language': 'tr-TR,tr;q=0.9,en;q=0.8',
      'x-ig-app-id': '936619743392459',
      'x-requested-with': 'XMLHttpRequest',
    },
  });
  if (!res.ok) throw new Error('ig ' + res.status);
  const j = await res.json();
  const user = j && j.data && j.data.user;
  if (!user) throw new Error('ig kullanıcı yok');
  const edges = (user.edge_owner_to_timeline_media && user.edge_owner_to_timeline_media.edges) || [];
  if (!edges.length) throw new Error('ig gönderi yok');
  return edges.slice(0, 12).map(e => {
    const n = e.node || {};
    const thumbs = n.thumbnail_resources || [];
    const thumb = thumbs.length ? thumbs[thumbs.length - 1].src : (n.display_url || '');
    const capNode =
      n.edge_media_to_caption && n.edge_media_to_caption.edges &&
      n.edge_media_to_caption.edges[0] && n.edge_media_to_caption.edges[0].node;
    return {
      url: n.shortcode ? `https://www.instagram.com/p/${n.shortcode}/` : '',
      image: n.display_url || '',
      thumb,
      likes: String((n.edge_liked_by && n.edge_liked_by.count) || 0),
      comments: String((n.edge_media_to_comment && n.edge_media_to_comment.count) || 0),
      caption: capNode ? capNode.text : '',
    };
  }).filter(p => p.image && p.image.indexOf('http') === 0);
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const username = (url.searchParams.get('username') || 'ades.media')
    .replace(/[^a-zA-Z0-9._]/g, '').toLowerCase();
  const env = context.env || {};
  const token = env.IG_ACCESS_TOKEN || '';
  const userId = env.IG_USER_ID || '';

  const cacheKey = `igfeed:${username}:${token ? 1 : 0}`;
  const cache = caches.default;
  const cached = await cache.match(cacheKey).catch(() => null);
  if (cached) return cached;

  let posts = null;
  let source = 'config';
  try {
    posts = await buildFromConfig(context);
  } catch (e) {
    posts = null;
  }
  if (!posts || !posts.length) {
    source = 'instagram-graph';
    try {
      if (token) { posts = await fetchGraph(token, userId); }
      else posts = null;
    } catch (e) { posts = null; }
  }
  if (!posts || !posts.length) {
    source = 'instagram-public';
    try { posts = await fetchPublic(username); } catch (e) { posts = null; }
  }

  const body = JSON.stringify({
    ok: !!posts && posts.length > 0,
    username,
    source,
    updated_at: Date.now(),
    posts: posts || [],
  });
  const resp = new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
    },
  });

  if (posts && context.waitUntil) {
    context.waitUntil(cache.put(cacheKey, resp.clone()).catch(() => {}));
  } else if (posts) {
    cache.put(cacheKey, resp.clone()).catch(() => {});
  }
  return resp;
}