// ======================================================================
// Cloudflare Pages Function — Form gönderimi (Rezervasyon & Ekibe Katıl)
// URL: /api/submit  (sadece POST)
//
// Tarayıcı formları doğrudan formsubmit.co'ya fetch ediyorsa CORS yüzünden
// başarısız oluyordu. Bu fonksiyon, form verisini alıp SUNUCU TARAFINDA
// FormSubmit AJAX ucu üzerinden e-posta olarak iletir. Böylece CORS engeli
// kalkar ve başvurular/rezervasyonlar maile düşer.
//
// Opsiyonel ortam değişkeni:
//   CONTACT_EMAIL → e-postaların gideceği adres (varsayılan: iletisim.adesmedia@gmail.com)
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
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) return json({ ok:true });
    let msg = 'FormSubmit HTTP ' + res.status;
    try { const j = await res.json(); if (j && j.message) msg = j.message; } catch (e) {}
    return json({ ok:false, error:msg }, 502);
  } catch (e) {
    return json({ ok:false, error:String(e && e.message || e) }, 502);
  }
}
