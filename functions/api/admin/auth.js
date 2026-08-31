// ======================================================================
// Cloudflare Pages — Admin giriş doğrulaması
// URL: /api/admin/auth  (sadece POST)
//
// Şifre artık sunucu tarafında saklanır: env.ADMIN_PASSWORD (Cloudflare
// Dashboard → Pages → proje → Settings → Environment Variables). Değişken
// yoksa varsayılan "iu1818iu" kullanılır.
// ======================================================================

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return json({ ok: false, error: 'Sadece POST kullanılır.' }, 405);
  }

  let body;
  try { body = await context.request.json(); }
  catch (e) { return json({ ok: false, error: 'Geçersiz JSON isteği.' }, 400); }

  const correctPassword = (context.env && context.env.ADMIN_PASSWORD) || 'iu1818iu';
  const password = body && body.password;

  if (password === correctPassword) {
    return json({ ok: true, token: 'admin-authenticated' });
  }

  const ip = context.request.headers.get('CF-Connecting-IP') ||
             context.request.headers.get('X-Forwarded-For') || 'unknown';
  console.warn(`[ADMIN AUTH FAILED] IP: ${ip}, Time: ${new Date().toISOString()}`);
  return json({ ok: false, error: 'Şifre hatalı!' }, 401);
}
