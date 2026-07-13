/* Cookie-баннер + Google Consent Mode v2 для chudina.me
   Аналитика (GA4) грузится ТОЛЬКО после явного согласия.
   Чтобы включить аналитику — впиши GA4 Measurement ID в GA_ID ниже. */
(function () {
  var GA_ID = ''; // ← вставь сюда G-XXXXXXXXXX, тогда GA заработает после согласия
  var KEY = 'chudina_cookie_consent'; // 'granted' | 'denied'

  // Consent Mode: по умолчанию всё запрещено — до согласия ничего не трекается.
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  window.gtag = window.gtag || gtag;
  gtag('consent', 'default', {
    ad_storage: 'denied',
    analytics_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied'
  });

  function loadGA() {
    if (!GA_ID || document.getElementById('ga-src')) return;
    var s = document.createElement('script');
    s.id = 'ga-src';
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
    gtag('js', new Date());
    gtag('config', GA_ID);
  }

  var choice = null;
  try { choice = localStorage.getItem(KEY); } catch (e) {}

  if (choice === 'granted') {
    gtag('consent', 'update', { analytics_storage: 'granted' });
    loadGA();
  }
  if (choice) return; // выбор уже сделан — баннер не показываем

  function save(v) {
    try { localStorage.setItem(KEY, v); } catch (e) {}
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    if (v === 'granted') {
      gtag('consent', 'update', { analytics_storage: 'granted' });
      loadGA();
    }
  }

  var wrap = document.createElement('div');
  wrap.innerHTML =
    '<div role="dialog" aria-label="Cookies" style="position:fixed;left:16px;right:16px;bottom:16px;z-index:99999;max-width:560px;margin:0 auto;background:#1A1423;color:#fff;border-radius:14px;padding:16px 18px;box-shadow:0 12px 44px -10px rgba(0,0,0,.55);font-family:Inter,Arial,sans-serif;font-size:14px;line-height:1.5">' +
      '<div style="margin-bottom:12px">Мы используем только необходимые cookie. С вашего согласия — ещё аналитику (Google Analytics), чтобы улучшать сайт. Подробнее в <a href="/datenschutz" style="color:#E0B821;font-weight:700;text-decoration:none">политике конфиденциальности</a>.</div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap">' +
        '<button data-cc="accept" style="cursor:pointer;border:0;border-radius:9px;padding:10px 18px;font-weight:700;font-family:inherit;font-size:14px;background:#3DBF74;color:#fff">Принять</button>' +
        '<button data-cc="decline" style="cursor:pointer;border:1px solid rgba(255,255,255,.3);border-radius:9px;padding:10px 18px;font-weight:700;font-family:inherit;font-size:14px;background:transparent;color:#fff">Только необходимые</button>' +
      '</div>' +
    '</div>';
  var bar = wrap.firstElementChild;
  bar.querySelector('[data-cc="accept"]').addEventListener('click', function () { save('granted'); });
  bar.querySelector('[data-cc="decline"]').addEventListener('click', function () { save('denied'); });

  function mount() { document.body.appendChild(bar); }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
