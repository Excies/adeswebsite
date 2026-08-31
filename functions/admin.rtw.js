// ======================================================================
// Cloudflare Pages — Gizli yönetici paneli
//
// Yalnızca /admin.rtw adresinden panele ulaşılır. admin.html'in içeriği
// burada servis edilir (URL /admin.rtw olarak kalır). /admin.html doğrudan
// _middleware.js tarafından engellenir.
// ======================================================================

export async function onRequest(context) {
  const { env, request } = context;
  const r = await env.ASSETS.fetch(new Request('/admin.html', request));
  return new Response(r.body, {
    status: r.status,
    headers: r.headers,
  });
}
