// ======================================================================
// Cloudflare Pages Function — Form gönderimi (Rezervasyon & Ekibe Katıl)
// URL: /api/submit  (sadece POST)
//
// Not: Canlı dağıtım Worker (src/index.js) üzerinden çalışır; bu dosya
// Pages Functions modunda da aynı davranışı sergilemesi için eşlenir.
//
// E-posta teslimatı FormSubmit'e doğrudan bağlı değil artık:
//   1) Her başvuru KV'ya yazılır (asla kaybolmaz; admin panel "Başvurular").
//   2) Cloudflare Email Service/Email Routing binding'i (SEND_EMAIL) varsa
//      önce oradan gönderilir.
//   3) Aksi halde FormSubmit AJAX ucu denenir.
//   4) E-posta gitmese bile kullanıcıya hata gösterilmez; veri güvende.
//
// Opsiyonel ortam değişkenleri:
//   CONTACT_EMAIL → e-postaların gideceği adres (varsayılan: iletisim.adesmedia@gmail.com)
//   CONTACT_FROM  → Cloudflare e-posta kanalı için gönderen adres (örn. forms@adesmedia.com.tr)
//   ADMIN_TOKEN   → /api/applications okuma şifresi (varsayılan: ades2026)
// ======================================================================

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/\n/g, '<br>');
}

function buildHtmlTable(subject, fields) {
  let body = '';
  for (const [k, v] of Object.entries(fields)) {
    if (v === '' || v == null) continue;
    body += '<tr><td style="background:#f2f2f2;padding:6px 10px;border:1px solid #ddd;font-weight:600">' +
      esc(k) + '</td><td style="padding:6px 10px;border:1px solid #ddd">' + esc(v) + '</td></tr>';
  }
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px">' +
    '<h2 style="margin:0 0 8px">' + esc(subject) + '</h2>' +
    '<table style="border-collapse:collapse;min-width:420px">' + body + '</table>' +
    '<p style="color:#777;margin-top:14px;font-size:12px">Bu e-posta adesmedia.com.tr formlarından gönderildi.</p></div>';
}

function buildMime(subject, html) {
  const boundary = 'ADES-' + Date.now().toString(36) + '-b';
  return 'Subject: ' + subject + '\r\n' +
    'MIME-Version: 1.0\r\n' +
    'Content-Type: multipart/alternative; boundary="' + boundary + '"\r\n' +
    'X-Auto-Response-Suppress: All\r\n\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n' +
    subject + '\r\n(Bu e-postayı okuyamıyorsan HTML görünümünü aç.)\r\n\r\n' +
    '--' + boundary + '\r\n' +
    'Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n' +
    html + '\r\n\r\n' +
    '--' + boundary + '--\r\n';
}

async function sendViaCloudflareEmail(env, toEmail, subject, fields) {
  if (!env || !env.SEND_EMAIL) {
    return { ok:false, skipped:true };
  }
  try {
    const fromEmail = env.CONTACT_FROM || 'forms@adesmedia.com.tr';
    const html = buildHtmlTable(subject, fields);
    const mime = buildMime(subject, html);
    const Ctor = (typeof globalThis !== 'undefined' && globalThis.EmailMessage)
      || (await import('cloudflare:email')).EmailMessage;
    const msg = new Ctor(fromEmail, toEmail, null);
    msg.setFrom(fromEmail);
    msg.setTo(toEmail);
    msg.setRaw(mime);
    await env.SEND_EMAIL.send(msg);
    return { ok:true, skipped:false };
  } catch (e) {
    return { ok:false, skipped:false, error:String(e && e.message || e) };
  }
}

async function sendViaFormSubmit(subject, fields, toEmail, origin) {
  const payload = {
    board: toEmail,
    _subject: subject,
    _template: 'table',
    _captcha: 'false',
    _honey: '',
    _datatable: fields,
  };
  try {
    const res = await fetch(`https://formsubmit.co/ajax/${toEmail}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': origin,
        'Referer': origin + '/',
        'User-Agent': 'Mozilla/5.0 (ADES-Worker)',
      },
      body: JSON.stringify(payload),
    });
    let ok = res.status >= 200 && res.status < 300;
    let msg = '';
    try {
      const j = await res.json();
      if (j) {
        if (j.success === false || j.success === 'false') ok = false;
        if (j.message) msg = j.message;
      }
    } catch (e) { /* boş gövde */ }
    return { ok, error: ok ? '' : (msg || ('FormSubmit HTTP ' + res.status)) };
  } catch (e) {
    return { ok:false, error:String(e && e.message || e) };
  }
}

async function attemptDelivery(env, toEmail, subject, fields, origin) {
  if (env && env.SEND_EMAIL) {
    const r = await sendViaCloudflareEmail(env, toEmail, subject, fields);
    if (r.ok) return { method:'cloudflare', ...r };
  }
  const r2 = await sendViaFormSubmit(subject, fields, toEmail, origin);
  return { method:'formsubmit', ...r2 };
}

function submissionId() {
  return 's' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

async function saveSubmission(env, rec) {
  if (!env || !env.CONTENT) return false;
  try {
    await env.CONTENT.put('subm:' + rec.id, JSON.stringify(rec));
    let list = [];
    try {
      const prev = await env.CONTENT.get('subm:index');
      list = prev ? JSON.parse(prev) : [];
    } catch (e) { /* bozuk index */ }
    if (!Array.isArray(list)) list = [];
    list.unshift(rec.id);
    if (list.length > 250) list = list.slice(0, 250);
    await env.CONTENT.put('subm:index', JSON.stringify(list));
    return true;
  } catch (e) {
    return false;
  }
}

async function readSubmissions(env, limit) {
  if (!env || !env.CONTENT) return [];
  let ids = [];
  try {
    const raw = await env.CONTENT.get('subm:index');
    ids = raw ? JSON.parse(raw) : [];
  } catch (e) { /* yok */ }
  if (!Array.isArray(ids)) ids = [];
  const out = [];
  for (const id of ids.slice(0, limit || 150)) {
    try {
      const s = await env.CONTENT.get('subm:' + id);
      if (s) out.push(JSON.parse(s));
    } catch (e) { /* bozuksa atla */ }
  }
  return out;
}

export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return json({ ok:false, error:'Sadece POST kullanılır.' }, 405);
  }

  const env = context.env || {};
  const toEmail = env.CONTACT_EMAIL || 'iletisim.adesmedia@gmail.com';

  let data;
  try { data = await context.request.formData(); }
  catch (e) { return json({ ok:false, error:'Geçersiz form isteği.' }, 400); }

  const honey = String((data.get('_honey') || '').trim());
  if (honey) return json({ ok:true, spam:true }); // bot tuzağı

  const ip = context.request.headers.get('CF-Connecting-IP') || '';
  if (env.CONTENT && ip) {
    let last = 0;
    try { last = parseInt(await env.CONTENT.get('subm:gate:' + ip), 10) || 0; } catch (e) { /* yok */ }
    if (Date.now() - last < 15000) {
      return json({ ok:true, spam:true });
    }
    try { await env.CONTENT.put('subm:gate:' + ip, String(Date.now())); } catch (e) { /* yok */ }
  }

  const type = String(data.get('_type') || '');
  const labels = {
    rezervasyon: 'Ades Medya - Rezervasyon Talebi',
    basvuru: 'Ades Medya - Yeni Ekip Başvurusu',
  };
  const subject = String(data.get('_subject') || labels[type] || 'Ades Medya - Yeni Form');

  const fields = {};
  const skip = new Set(['_subject','_template','_captcha','_honey','_type','_next','_autoresponse','_replyto']);
  for (const [k, v] of data.entries()) {
    if (skip.has(k)) continue;
    fields[k] = typeof v === 'string' ? v : '';
  }

  const rec = {
    id: submissionId(),
    type,
    subject,
    fields,
    created_at: Date.now(),
    email_status: 'pending',
    email_error: '',
  };
  const saved = await saveSubmission(env, rec);

  const origin = new URL(context.request.url).origin;
  const delivery = await attemptDelivery(env, toEmail, subject, fields, origin);
  rec.email_status = delivery.ok ? 'delivered' : 'failed';
  rec.email_method = delivery.method;
  if (!delivery.ok) rec.email_error = delivery.error || '';
  if (saved) {
    try { await env.CONTENT.put('subm:' + rec.id, JSON.stringify(rec)); } catch (e) { /* yok */ }
  }

  if (!delivery.ok && typeof context.waitUntil === 'function') {
    context.waitUntil((async () => {
      await new Promise(r => setTimeout(r, 90000));
      const retry = await attemptDelivery(env, toEmail, subject, fields, origin);
      if (retry.ok) {
        rec.email_status = 'delivered';
        rec.email_method = retry.method;
        rec.email_error = '';
      }
      if (saved) {
        try { await env.CONTENT.put('subm:' + rec.id, JSON.stringify(rec)); } catch (e) { /* yok */ }
      }
    })());
  }

  return json({
    ok: true,
    saved,
    email: delivery.ok ? 'sent' : 'queued',
    email_method: delivery.method,
  });
}