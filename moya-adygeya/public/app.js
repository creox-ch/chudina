'use strict';

// ───────── утилиты ─────────
const $ = (sel) => document.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const rub = (n) => `${Number(n || 0).toLocaleString('ru-RU')} ₽`;
const bon = (n) => `${Number(n || 0).toLocaleString('ru-RU')}`;
const pct = (bp) => `${(Number(bp || 0) / 100).toLocaleString('ru-RU')}%`;
const fmtDate = (s) => (s ? new Date(s).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const safeUrl = (u) => (/^https?:\/\//.test(String(u || '')) ? u : '');
const field = (form, name) => (form.elements[name] ? form.elements[name].value.trim() : '');
const toBp = (percent) => Math.round(Number(String(percent).replace(',', '.')) * 100);

const TOKEN_KEY = { guest: 'ma_guest', partner: 'ma_partner', admin: 'ma_admin' };
const tokens = {
  get(role) {
    try { return localStorage.getItem(TOKEN_KEY[role]); } catch { return null; }
  },
  set(role, value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY[role], value);
      else localStorage.removeItem(TOKEN_KEY[role]);
    } catch { /* приватный режим: работаем без сохранения */ }
  },
};

async function api(method, path, { body, role, key } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = role ? tokens.get(role) : null;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['X-Terminal-Key'] = key;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Ошибка ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let CONFIG = null;
async function config() {
  if (!CONFIG) CONFIG = await api('GET', '/api/config');
  return CONFIG;
}

// Одно сообщение на следующую отрисовку (успех или ошибка).
let pendingFlash = null;
function toast(msg, kind = 'ok') {
  pendingFlash = { msg, kind };
}
function flashHtml() {
  if (!pendingFlash) return '';
  const html = `<div class="flash ${pendingFlash.kind}">${esc(pendingFlash.msg)}</div>`;
  pendingFlash = null;
  return html;
}

function render(html) {
  $('#app').innerHTML = `${flashHtml()}${html}`;
}

// ───────── маршруты ─────────
const routes = [
  ['/', home],
  ['/catalog', catalog],
  ['/partner', partnerPage],
  ['/reference', reference],
  ['/account', account],
  ['/cabinet', partnerCabinet],
  ['/admin', adminPage],
  ['/about', about],
];

async function route() {
  const [path, qs] = (location.hash || '#/').slice(1).split('?');
  const normalized = path.replace(/\/$/, '') || '/';
  const query = new URLSearchParams(qs || '');
  const hit = routes.find(([p]) => normalized === p || (p === '/partner' && normalized.startsWith('/partner/')));
  try {
    if (!hit) return render('<h1>Страница не найдена</h1><p><a href="#/">На главную</a></p>');
    await hit[1]({ id: normalized.split('/')[2] || null, query });
  } catch (err) {
    render(`<div class="flash error">${esc(err.message)}</div>`);
  }
  window.scrollTo(0, 0);
}

// ───────── главная ─────────
async function home() {
  const news = await api('GET', '/api/news');
  render(`
    <section class="hero">
      <h1>Моя Адыгея</h1>
      <p>Единая коалиционная программа лояльности, каталог бизнеса, справочник туриста и доставка Республики Адыгея.</p>
      <p>Копите бонусы у партнёров и списывайте их у любого участника программы. 1 бонус = 1 ₽ скидки.</p>
      <a class="btn" href="#/account">Стать участником</a>
      <a class="btn secondary" style="background:#fff;color:var(--green-dark);border-color:#fff" href="#/catalog">Каталог бизнеса</a>
    </section>
    <div class="grid">
      <a class="card" href="#/catalog"><h3>Каталог бизнеса</h3><p class="muted">Адреса, телефоны и акции партнёров программы</p></a>
      <a class="card" href="#/reference"><h3>Справочник туриста</h3><p class="muted">Гостиницы, кемпинги, достопримечательности и аудиогид</p></a>
      <a class="card" href="#/account"><h3>Личный кабинет</h3><p class="muted">Баланс, карта участника, заказы и бронирования</p></a>
      <a class="card" href="#/cabinet"><h3>Кабинет партнёра</h3><p class="muted">Операции, взаиморасчёты, заказы и кампании</p></a>
    </div>
    <h2>Новости и события</h2>
    ${news.length ? news.map((n) => `<article class="card"><h3>${esc(n.title)}</h3><p>${esc(n.body)}</p><p class="small muted">${fmtDate(n.createdAt)}</p></article>`).join('') : '<p class="muted">Новостей пока нет.</p>'}
  `);
}

// ───────── каталог бизнеса ─────────
async function catalog({ query }) {
  const cfg = await config();
  const q = query.get('q') || '';
  const category = query.get('category') || '';
  const partners = await api('GET', `/api/partners?${new URLSearchParams({ q, category })}`);
  render(`
    <h1>Каталог бизнеса</h1>
    <form data-form="catalog-filter" class="inline card">
      <label style="flex:2 1 200px">Поиск<input name="q" value="${esc(q)}" placeholder="Название, адрес, описание"></label>
      <label style="flex:1 1 200px">Категория
        <select name="category">
          <option value="">Все категории</option>
          ${cfg.categories.map((c) => `<option ${c === category ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
      </label>
      <button class="btn">Найти</button>
    </form>
    ${partners.length
      ? `<div class="grid">${partners.map((p) => `
          <a class="card" href="#/partner/${esc(p.id)}" style="text-decoration:none;color:inherit">
            <h3>${esc(p.name)}</h3>
            <p class="small muted">${esc(p.category)}</p>
            <p class="small">${esc(p.address)}</p>
            <span class="pill ok">бонусы до ${esc(p.bonusRatePercent)}%</span>
          </a>`).join('')}</div>`
      : '<p class="muted">По вашему запросу партнёров не найдено.</p>'}
  `);
}

// ───────── карточка партнёра и заказ ─────────
let cart = { partnerId: null, qty: {} };

async function partnerPage({ id }) {
  const p = await api('GET', `/api/partners/${encodeURIComponent(id)}`);
  const guest = tokens.get('guest') ? await api('GET', '/api/guest/me', { role: 'guest' }).catch(() => null) : null;
  if (cart.partnerId !== p.id) cart = { partnerId: p.id, qty: {} };
  const lines = p.items.filter((i) => cart.qty[i.id]);
  const total = lines.reduce((s, i) => s + i.price * cart.qty[i.id], 0);
  render(`
    <p><a href="#/catalog">← Каталог</a></p>
    <h1>${esc(p.name)}</h1>
    <p class="muted">${esc(p.category)} · ${esc(p.address)}</p>
    <p>${esc(p.description)}</p>
    <p>${p.phone ? `Телефон: ${esc(p.phone)}<br>` : ''}${p.site ? `Сайт: <a href="${esc(safeUrl(p.site))}" target="_blank" rel="noopener">${esc(p.site)}</a>` : ''}</p>
    <p><span class="pill ok">бонусы до ${esc(p.bonusRatePercent)}% от покупки</span> <span class="pill">1 бонус = 1 ₽</span></p>
    ${p.campaigns.length ? `<div class="notice"><strong>Акции:</strong> ${p.campaigns.map((c) => esc(c.title)).join(' · ')}</div>` : ''}

    <h2>Позиции и заказ</h2>
    ${p.items.length ? `
      <div class="grid">${p.items.map((i) => `
        <div class="card">
          <h3>${esc(i.title)}</h3>
          <p class="small muted">${i.kind === 'service' ? 'Услуга' : 'Товар'} ${i.category ? `· ${esc(i.category)}` : ''}</p>
          <p>${esc(i.description)}</p>
          <p><strong>${rub(i.price)}</strong></p>
          <button class="btn small" data-action="cart-add" data-id="${esc(i.id)}">В заказ</button>
          ${cart.qty[i.id] ? `<span class="small">× ${cart.qty[i.id]}</span> <button class="btn small secondary" data-action="cart-remove" data-id="${esc(i.id)}">−</button>` : ''}
        </div>`).join('')}
      </div>
      ${lines.length ? `
        <form data-form="order" class="card">
          <p>Итого: <strong>${rub(total)}</strong></p>
          ${guest
            ? `<label>Списать бонусов (баланс ${bon(guest.balance)})
                 <input name="bonus" type="number" min="0" max="${Math.min(guest.balance, total)}" value="0">
               </label>
               ${guest.phoneVerified ? '' : '<p class="small error">Для списания бонусов подтвердите телефон в кабинете.</p>'}`
            : '<p class="small muted">Чтобы оформить заказ и списать бонусы, <a href="#/account">войдите в кабинет</a>.</p>'}
          <label>Дата и время (для бронирования, необязательно)<input name="bookingAt" type="datetime-local"></label>
          <button class="btn" ${guest ? '' : 'disabled'}>Оформить заказ</button>
          <p class="small muted">Оплата наличными или картой — при получении у партнёра. Бонусы спишутся, когда партнёр подтвердит выполнение.</p>
        </form>` : ''}` : '<p class="muted">У партнёра пока нет опубликованных позиций.</p>'}

    <h2>Отзывы</h2>
    ${p.reviews.length ? p.reviews.map((r) => `<div class="card"><strong>${'★'.repeat(r.rating)}</strong><p>${esc(r.text)}</p><p class="small muted">${fmtDate(r.createdAt)}</p></div>`).join('') : '<p class="muted">Отзывов пока нет.</p>'}
    ${guest ? `
      <form data-form="review" class="card">
        <label>Оценка<select name="rating">${[5, 4, 3, 2, 1].map((n) => `<option value="${n}">${n}</option>`).join('')}</select></label>
        <label>Отзыв<textarea name="text" required minlength="3" maxlength="2000"></textarea></label>
        <input type="hidden" name="partnerId" value="${esc(p.id)}">
        <button class="btn secondary">Оставить отзыв</button>
      </form>` : ''}
  `);
}

// ───────── справочник и аудиогид ─────────
async function reference({ query }) {
  const cfg = await config();
  const q = query.get('q') || '';
  const category = query.get('category') || '';
  const places = await api('GET', `/api/places?${new URLSearchParams({ q, category })}`);
  const audio = await api('GET', '/api/audio');
  const placeCats = [...new Set(places.map((p) => p.category).filter(Boolean))];
  render(`
    <h1>Справочник туриста</h1>
    <p class="muted">Гостиницы, кемпинги, маршруты и экскурсии. Бронирование услуг партнёров — в их карточках в каталоге.</p>
    <form data-form="catalog-filter" class="inline card">
      <label style="flex:2 1 200px">Поиск<input name="q" value="${esc(q)}" placeholder="Гостиница, кемпинг, достопримечательность"></label>
      <label style="flex:1 1 200px">Категория
        <select name="category"><option value="">Все</option>${placeCats.map((c) => `<option ${c === category ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      </label>
      <button class="btn">Найти</button>
    </form>
    ${places.length ? `<div class="grid">${places.map((p) => `
      <div class="card"><h3>${esc(p.name)}</h3><p class="small muted">${esc(p.category)}</p><p>${esc(p.description)}</p>
      <p class="small">${esc(p.address)} ${p.phone ? `· ${esc(p.phone)}` : ''}</p></div>`).join('')}</div>`
      : '<p class="muted">Записей пока нет. Оператор добавит объекты справочника.</p>'}

    <h2>Аудиогид</h2>
    ${audio.map((a) => `
      <div class="card">
        <h3>${esc(a.title)} ${a.status === 'ready' ? '' : '<span class="pill warn">в разработке</span>'}</h3>
        <p class="small muted">${esc(a.place)} ${a.duration ? `· ${esc(a.duration)}` : ''}</p>
        <p>${esc(a.description)}</p>
        ${safeUrl(a.url) ? `<audio controls preload="none" src="${esc(safeUrl(a.url))}" style="width:100%"></audio>` : ''}
      </div>`).join('')}
  `);
}

// ───────── личный кабинет гостя ─────────
async function account({ query }) {
  const token = tokens.get('guest');
  let guest = null;
  if (token) {
    try {
      guest = await api('GET', '/api/guest/me', { role: 'guest' });
    } catch {
      tokens.set('guest', null);
    }
  }
  if (!guest) return renderAuth(query.get('ref') || '');

  const [orders, txs, cfg] = await Promise.all([
    api('GET', '/api/guest/orders', { role: 'guest' }),
    api('GET', '/api/guest/transactions', { role: 'guest' }),
    config(),
  ]);
  const shareText = `Присоединяйтесь к «Моя Адыгея»: ${location.origin}/#/account?ref=${guest.referralCode}`;
  render(`
    <h1>Личный кабинет</h1>
    <div class="card">
      <p class="muted">${esc(guest.name || 'Участник программы')}</p>
      <div class="balance">${bon(guest.balance)} <span class="small muted">бонусов = ${rub(guest.balance)} скидки</span></div>
      <p>Карта: <span class="card-number">${esc(guest.cardNumber)}</span></p>
      <p class="small">Реферальный код: <strong>${esc(guest.referralCode)}</strong> · приглашено: ${guest.referrals}</p>
      <p class="small muted">${esc(shareText)}</p>
      <button class="btn secondary small" data-action="logout" data-role="guest">Выйти</button>
    </div>

    ${guest.phoneVerified ? '' : `
      <div class="card">
        <h3>Активируйте карту</h3>
        <p class="muted">Начисление работает сразу. Списание бонусов доступно после подтверждения телефона кодом из SMS.</p>
        <form data-form="verify" class="inline">
          <label>Код из SMS<input name="code" inputmode="numeric" maxlength="4" required></label>
          <button class="btn">Подтвердить</button>
        </form>
        <button class="btn secondary small" data-action="resend-code">Отправить код ещё раз</button>
      </div>`}

    <h2>Заказы</h2>
    ${orders.length ? `<div class="table-wrap"><table><tr><th>Партнёр</th><th>Сумма</th><th>Статус</th><th></th></tr>
      ${orders.map((o) => `<tr>
        <td>${esc(o.lines.map((l) => `${l.title} × ${l.qty}`).join(', '))}${o.bookingAt ? `<br><span class="small muted">${fmtDate(o.bookingAt)}</span>` : ''}</td>
        <td>${rub(o.total)}${o.bonusUsed ? `<br><span class="small">бонусами: ${bon(o.bonusUsed)}</span>` : ''}</td>
        <td>${esc(orderStatus(o.status))}</td>
        <td>${['new', 'confirmed'].includes(o.status) ? `<button class="btn small secondary" data-action="order-cancel" data-id="${esc(o.id)}">Отменить</button>` : ''}</td>
      </tr>`).join('')}</table></div>` : '<p class="muted">Заказов пока нет.</p>'}

    <h2>История бонусов</h2>
    ${txs.length ? `<div class="table-wrap"><table><tr><th>Дата</th><th>Операция</th><th>Партнёр</th><th>Чек</th><th>Бонусы</th></tr>
      ${txs.map((t) => `<tr><td>${fmtDate(t.createdAt)}</td><td>${esc(txLabel(t.type))}</td><td>${esc(t.partner)}</td><td>${t.checkAmount ? rub(t.checkAmount) : '—'}</td><td>${t.bonus > 0 && t.type !== 'redeem' ? '+' : ''}${t.type === 'redeem' ? '−' : ''}${bon(Math.abs(t.bonus))}</td></tr>`).join('')}
    </table></div>` : '<p class="muted">Операций пока нет.</p>'}

    <h2>Обращение в центр поддержки</h2>
    <form data-form="guest-feedback" class="card">
      <label>Тип<select name="kind"><option value="proposal">Предложение</option><option value="complaint">Жалоба</option></select></label>
      <label>Текст<textarea name="text" required minlength="3" maxlength="2000"></textarea></label>
      <button class="btn">Отправить</button>
    </form>
    <p class="small muted">${esc(cfg.categories.length ? 'Отзывы о партнёрах оставляйте в их карточках в каталоге.' : '')}</p>
  `);
}

function orderStatus(s) {
  return { new: 'Новый', confirmed: 'Подтверждён', completed: 'Выполнен', cancelled: 'Отменён' }[s] || s;
}
function txLabel(t) {
  return { accrual: 'Начисление', redeem: 'Списание', referral: 'Реферальный бонус', expiry: 'Аннулирование' }[t] || t;
}

function renderAuth(ref = '') {
  render(`
    <h1>Вход и регистрация</h1>
    <div class="tabs">
      <button data-action="auth-tab" data-tab="login" class="active" id="tab-login">Вход</button>
      <button data-action="auth-tab" data-tab="register" id="tab-register">Регистрация</button>
    </div>
    <form data-form="guest-login" class="card" id="form-login">
      <label>Телефон<input name="phone" type="tel" required placeholder="+7 900 000-00-00"></label>
      <label>Пароль<input name="password" type="password" required></label>
      <button class="btn">Войти</button>
    </form>
    <form data-form="guest-register" class="card" id="form-register" style="display:none">
      <label>Телефон<input name="phone" type="tel" required placeholder="+7 900 000-00-00"></label>
      <label>Пароль (от 6 символов)<input name="password" type="password" minlength="6" required></label>
      <label>Имя<input name="name" maxlength="80"></label>
      <label>Дата рождения (для поздравлений)<input name="birthDate" type="date"></label>
      <label>Реферальный код (если есть)<input name="referralCode" maxlength="12" value="${esc(ref)}"></label>
      <label class="check"><input type="checkbox" required> Согласен с Условиями участия и на обработку персональных данных</label>
      <button class="btn">Зарегистрироваться</button>
      <p class="small muted">Карта участника выдаётся сразу. Для списания бонусов подтвердите телефон кодом из SMS.</p>
    </form>
  `);
}

// ───────── кабинет партнёра ─────────
let partnerTab = 'overview';
const PARTNER_TABS = [['overview', 'Обзор'], ['transactions', 'Операции'], ['orders', 'Заказы'], ['items', 'Позиции'], ['campaigns', 'Кампании'], ['news', 'Новости']];

async function partnerCabinet() {
  if (!tokens.get('partner')) {
    return render(`
      <h1>Кабинет партнёра</h1>
      <form data-form="partner-login" class="card">
        <label>Логин<input name="login" required></label>
        <label>Пароль<input name="password" type="password" required></label>
        <button class="btn">Войти</button>
      </form>
      <p class="small muted">Логин и пароль выдаёт оператор программы при подключении.</p>`);
  }
  let me;
  try {
    me = await api('GET', '/api/partner/me', { role: 'partner' });
  } catch {
    tokens.set('partner', null);
    return partnerCabinet();
  }
  const tabHtml = PARTNER_TABS.map(([k, t]) => `<button data-action="partner-tab" data-tab="${k}" class="${k === partnerTab ? 'active' : ''}">${t}</button>`).join('');
  render(`
    <h1>${esc(me.name)}</h1>
    <p class="muted">${esc(me.category)} · статус: ${esc(me.status === 'active' ? 'подключён' : 'на подключении')} · ставка начисления ${pct(me.bonusRateBp)}</p>
    <button class="btn secondary small" data-action="logout" data-role="partner">Выйти</button>
    <div class="tabs">${tabHtml}</div>
    <div id="tab"><p class="muted">Загрузка…</p></div>
  `);
  await renderPartnerTab();
}

async function renderPartnerTab() {
  const el = $('#tab');
  if (!el) return;
  const t = partnerTab;
  if (t === 'overview') {
    const s = await api('GET', '/api/partner/settlements', { role: 'partner' });
    el.innerHTML = `
      <div class="stats">
        <div class="card"><div class="stat">${bon(s.issued)}</div><div class="stat-label">бонусов выпущено (списано у других)</div></div>
        <div class="card"><div class="stat">${rub(s.fees)}</div><div class="stat-label">комиссия оператора</div></div>
        <div class="card"><div class="stat">${rub(s.accepted)}</div><div class="stat-label">возмещено оператором за принятые бонусы</div></div>
        <div class="card"><div class="stat">${rub(s.netToOperator)}</div><div class="stat-label">сальдо к оплате оператору</div></div>
        <div class="card"><div class="stat">${bon(s.outstandingBonuses)}</div><div class="stat-label">непогашенные бонусы участников</div></div>
      </div>
      <p class="small muted">Расчёт: партнёр платит оператору выпущенные бонусы и комиссию, оператор возмещает партнёру принятые к оплате бонусы.</p>`;
  } else if (t === 'transactions') {
    const rows = await api('GET', '/api/partner/transactions', { role: 'partner' });
    el.innerHTML = rows.length ? `<div class="table-wrap"><table><tr><th>Дата</th><th>Операция</th><th>Чек</th><th>Бонусы</th><th>Комиссия</th></tr>
      ${rows.map((r) => `<tr><td>${fmtDate(r.createdAt)}</td><td>${esc(txLabel(r.type))}</td><td>${rub(r.checkAmount)}</td><td>${bon(r.bonus)}</td><td>${r.fee ? rub(r.fee) : '—'}</td></tr>`).join('')}
    </table></div>` : '<p class="muted">Операций пока нет.</p>';
  } else if (t === 'orders') {
    const rows = await api('GET', '/api/partner/orders', { role: 'partner' });
    const next = { new: [['confirmed', 'Подтвердить'], ['cancelled', 'Отменить']], confirmed: [['completed', 'Выполнен, начислить'], ['cancelled', 'Отменить']] };
    el.innerHTML = rows.length ? `<div class="table-wrap"><table><tr><th>Заказ</th><th>Сумма</th><th>Статус</th><th>Действия</th></tr>
      ${rows.map((o) => `<tr><td>${esc(o.lines.map((l) => `${l.title} × ${l.qty}`).join(', '))}<br><span class="small muted">${fmtDate(o.createdAt)}${o.bookingAt ? ` · бронь ${fmtDate(o.bookingAt)}` : ''}</span></td>
        <td>${rub(o.total)}${o.bonusReserved ? `<br><span class="small">бонусов к списанию: ${bon(o.bonusReserved)}</span>` : ''}</td>
        <td>${esc(orderStatus(o.status))}</td>
        <td>${(next[o.status] || []).map(([s, label]) => `<button class="btn small ${s === 'cancelled' ? 'secondary' : ''}" data-action="partner-order" data-id="${esc(o.id)}" data-status="${s}">${label}</button>`).join(' ')}</td>
      </tr>`).join('')}</table></div>` : '<p class="muted">Заказов пока нет.</p>';
  } else if (t === 'items') {
    const rows = await api('GET', '/api/partner/items', { role: 'partner' });
    el.innerHTML = `
      <form data-form="partner-item" class="card">
        <h3>Новая позиция</h3>
        <div class="inline">
          <label>Название<input name="title" required minlength="2"></label>
          <label>Цена, ₽<input name="price" type="number" min="0" required></label>
          <label>Тип<select name="kind"><option value="product">Товар</option><option value="service">Услуга</option></select></label>
        </div>
        <label>Категория<input name="category"></label>
        <label>Описание<textarea name="description"></textarea></label>
        <button class="btn">Добавить</button>
      </form>
      ${rows.length ? `<div class="table-wrap"><table><tr><th>Позиция</th><th>Цена</th><th>Статус</th><th></th></tr>
        ${rows.map((i) => `<tr><td>${esc(i.title)}</td><td>${rub(i.price)}</td><td>${i.active ? '<span class="pill ok">в каталоге</span>' : '<span class="pill">скрыта</span>'}</td>
        <td><button class="btn small secondary" data-action="partner-item-toggle" data-id="${esc(i.id)}" data-active="${!i.active}">${i.active ? 'Скрыть' : 'Показать'}</button></td></tr>`).join('')}</table></div>` : ''}`;
  } else if (t === 'campaigns') {
    const [rows, items, cfg] = await Promise.all([
      api('GET', '/api/partner/campaigns', { role: 'partner' }),
      api('GET', '/api/partner/items', { role: 'partner' }),
      config(),
    ]);
    el.innerHTML = `
      <form data-form="partner-campaign" class="card">
        <h3>Новая кампания</h3>
        <div class="inline">
          <label>Механика<select name="type">${Object.entries(cfg.campaignTypes).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
          <label>Название<input name="title" required minlength="2"></label>
          <label>Бонус в подарок, бонусов<input name="bonus" type="number" min="0" required value="100"></label>
        </div>
        <div class="inline">
          <label>Позиция (для «покупка товара»)<select name="itemId"><option value="">—</option>${items.map((i) => `<option value="${esc(i.id)}">${esc(i.title)}</option>`).join('')}</select></label>
          <label>Порог: сумма чека или номер покупки<input name="threshold" type="number" min="1"></label>
          <label>Дни (день рождения: число; дни недели: 0–6 через запятую)<input name="days"></label>
        </div>
        <button class="btn">Создать</button>
        <p class="small muted">Бонус начисляется сверх обычной ставки. Кампании не действуют на товары с особыми предложениями (Правила 5.14).</p>
      </form>
      ${rows.length ? `<div class="table-wrap"><table><tr><th>Название</th><th>Механика</th><th>Бонус</th><th>Статус</th><th></th></tr>
        ${rows.map((c) => `<tr><td>${esc(c.title)}</td><td>${esc(cfg.campaignTypes[c.type] || c.type)}</td><td>${bon(c.bonus)}</td>
        <td>${c.active ? '<span class="pill ok">активна</span>' : '<span class="pill">выключена</span>'}</td>
        <td><button class="btn small secondary" data-action="partner-campaign-toggle" data-id="${esc(c.id)}" data-active="${!c.active}">${c.active ? 'Выключить' : 'Включить'}</button></td></tr>`).join('')}</table></div>` : ''}`;
  } else if (t === 'news') {
    el.innerHTML = `
      <form data-form="partner-news" class="card">
        <h3>Новость о вашем бизнесе</h3>
        <label>Заголовок<input name="title" required minlength="3"></label>
        <label>Текст<textarea name="body" required minlength="3"></textarea></label>
        <button class="btn">Отправить на публикацию</button>
        <p class="small muted">Публикуется после проверки оператором.</p>
      </form>`;
  }
}

// ───────── кабинет оператора ─────────
let adminTab = 'overview';
const ADMIN_TABS = [['overview', 'Обзор'], ['partners', 'Партнёры'], ['settlements', 'Взаиморасчёты'], ['feedback', 'Обращения'], ['content', 'Контент'], ['outbox', 'Уведомления']];

async function adminPage() {
  if (!tokens.get('admin')) {
    return render(`
      <h1>Кабинет оператора</h1>
      <form data-form="admin-login" class="card">
        <label>Логин<input name="login" required value="operator"></label>
        <label>Пароль<input name="password" type="password" required></label>
        <button class="btn">Войти</button>
      </form>`);
  }
  const tabHtml = ADMIN_TABS.map(([k, t]) => `<button data-action="admin-tab" data-tab="${k}" class="${k === adminTab ? 'active' : ''}">${t}</button>`).join('');
  render(`
    <h1>Оператор программы</h1>
    <button class="btn secondary small" data-action="logout" data-role="admin">Выйти</button>
    <div class="tabs">${tabHtml}</div>
    <div id="tab"><p class="muted">Загрузка…</p></div>
  `);
  await renderAdminTab();
}

async function renderAdminTab() {
  const el = $('#tab');
  if (!el) return;
  const t = adminTab;
  const cfg = await config();
  if (t === 'overview') {
    const o = await api('GET', '/api/admin/overview', { role: 'admin' });
    el.innerHTML = `
      <div class="stats">
        <div class="card"><div class="stat">${o.guests}</div><div class="stat-label">участников (подтверждено ${o.verifiedGuests})</div></div>
        <div class="card"><div class="stat">${o.partnersActive}</div><div class="stat-label">партнёров подключено</div></div>
        <div class="card"><div class="stat">${bon(o.accrued)}</div><div class="stat-label">бонусов начислено</div></div>
        <div class="card"><div class="stat">${bon(o.redeemed)}</div><div class="stat-label">бонусов списано</div></div>
        <div class="card"><div class="stat">${bon(o.outstandingBonuses)}</div><div class="stat-label">непогашенные бонусы</div></div>
        <div class="card"><div class="stat">${rub(o.feesTotal)}</div><div class="stat-label">комиссии оператора</div></div>
        <div class="card"><div class="stat">${o.newFeedback}</div><div class="stat-label">новых обращений</div></div>
      </div>
      <h2>Воронка подключения</h2>
      <div class="stats">${cfg.onboarding.map((s) => `<div class="card"><div class="stat">${o.partnersByStage[s.stage] || 0}</div><div class="stat-label">${esc(s.title)}</div></div>`).join('')}</div>
      <h2>Калькулятор абонентской платы</h2>
      <form data-form="admin-quote" class="card inline">
        <label>Тариф<select name="planId">${cfg.plans.map((p) => `<option value="${p.id}">${esc(p.title)}</option>`).join('')}</select></label>
        <label>Партнёров в договоре<input name="partners" type="number" min="1" value="1"></label>
        <label class="check" style="flex:0 0 auto"><input type="checkbox" name="catalog" checked> Каталог</label>
        <label class="check" style="flex:0 0 auto"><input type="checkbox" name="loyalty" checked> Программа лояльности</label>
        <button class="btn">Посчитать</button>
      </form>
      <div id="quote"></div>
      <form data-form="admin-expire" class="card">
        <p class="small muted">Аннулирование бонусов неактивных участников (более года без использования карты, Правила 2.11).</p>
        <button class="btn secondary">Запустить аннулирование</button>
      </form>`;
  } else if (t === 'partners') {
    const rows = await api('GET', '/api/admin/partners', { role: 'admin' });
    el.innerHTML = `
      <form data-form="admin-partner-create" class="card">
        <h3>Новый партнёр (этап 1: переговоры)</h3>
        <div class="inline">
          <label>Название<input name="name" required minlength="2"></label>
          <label>Категория<select name="category">${cfg.categories.map((c) => `<option>${esc(c)}</option>`).join('')}</select></label>
          <label>Адрес<input name="address"></label>
        </div>
        <div class="inline">
          <label>Телефон<input name="phone"></label>
          <label>Сайт<input name="site"></label>
          <label>Логин партнёра<input name="login" required minlength="3"></label>
          <label>Пароль партнёра<input name="password" type="password" required minlength="6"></label>
        </div>
        <label>Описание<textarea name="description"></textarea></label>
        <button class="btn">Добавить</button>
      </form>
      ${rows.map((p) => partnerCard(p, cfg)).join('') || '<p class="muted">Партнёров пока нет.</p>'}`;
  } else if (t === 'settlements') {
    const s = await api('GET', '/api/admin/settlements', { role: 'admin' });
    el.innerHTML = `
      <p class="muted">Комиссии оператора: ${rub(s.feesTotal)}. Бонусы за счёт оператора (акции): ${bon(s.operatorFunded)}.</p>
      <div class="table-wrap"><table><tr><th>Партнёр</th><th>Выпущено бонусов</th><th>Комиссия</th><th>Возмещено</th><th>Сальдо к оплате</th><th>Непогашенные бонусы</th></tr>
      ${s.partners.map((p) => `<tr><td>${esc(p.name)}</td><td>${bon(p.issued)}</td><td>${rub(p.fees)}</td><td>${rub(p.accepted)}</td><td><strong>${rub(p.netToOperator)}</strong></td><td>${bon(p.outstandingBonuses)}</td></tr>`).join('')}
      </table></div>`;
  } else if (t === 'feedback') {
    const rows = await api('GET', '/api/admin/feedback', { role: 'admin' });
    el.innerHTML = rows.length ? rows.map((f) => `
      <form data-form="admin-feedback" data-id="${esc(f.id)}" class="card">
        <p><span class="pill">${esc({ review: 'отзыв', proposal: 'предложение', complaint: 'жалоба' }[f.kind] || f.kind)}</span>
        ${f.rating ? `<span class="pill">${f.rating}★</span>` : ''} <span class="small muted">${fmtDate(f.createdAt)}</span></p>
        <p>${esc(f.text)}</p>
        ${f.contact ? `<p class="small muted">Контакт: ${esc(f.contact)}</p>` : ''}
        <div class="inline">
          <label>Статус<select name="status">${['new', 'in_progress', 'answered'].map((s) => `<option value="${s}" ${s === f.status ? 'selected' : ''}>${{ new: 'новое', in_progress: 'в работе', answered: 'отвечено' }[s]}</option>`).join('')}</select></label>
          <label class="check"><input type="checkbox" name="hidden" ${f.hidden ? 'checked' : ''}> Скрыть от публики</label>
        </div>
        <label>Ответ<textarea name="reply">${esc(f.reply)}</textarea></label>
        <button class="btn small">Сохранить</button>
      </form>`).join('') : '<p class="muted">Обращений пока нет.</p>';
  } else if (t === 'content') {
    const news = await api('GET', '/api/admin/news', { role: 'admin' });
    el.innerHTML = `
      ${news.map((n) => `<div class="card"><strong>${esc(n.title)}</strong> ${n.partnerId ? '<span class="pill warn">от партнёра</span>' : ''} ${n.published ? '<span class="pill ok">опубликована</span>' : '<span class="pill">черновик</span>'}
        <p class="small">${esc(n.body)}</p>
        <button class="btn small secondary" data-action="admin-news-toggle" data-id="${esc(n.id)}" data-published="${!n.published}">${n.published ? 'Снять с публикации' : 'Опубликовать'}</button></div>`).join('')}
      <form data-form="admin-news" class="card">
        <h3>Новость</h3>
        <label>Заголовок<input name="title" required minlength="3"></label>
        <label>Текст<textarea name="body" required minlength="3"></textarea></label>
        <label class="check"><input type="checkbox" name="published" checked> Опубликовать сразу</label>
        <button class="btn">Добавить</button>
      </form>
      <form data-form="admin-place" class="card">
        <h3>Объект справочника</h3>
        <div class="inline">
          <label>Название<input name="name" required minlength="2"></label>
          <label>Категория<input name="category"></label>
          <label>Адрес<input name="address"></label>
          <label>Телефон<input name="phone"></label>
        </div>
        <label>Описание<textarea name="description"></textarea></label>
        <button class="btn">Добавить</button>
      </form>
      <form data-form="admin-audio" class="card">
        <h3>Аудиогид</h3>
        <div class="inline">
          <label>Название<input name="title" required minlength="2"></label>
          <label>Место<input name="place"></label>
          <label>Длительность<input name="duration" placeholder="12:30"></label>
          <label>Ссылка на аудио (https)<input name="url"></label>
        </div>
        <label>Описание<textarea name="description"></textarea></label>
        <button class="btn">Добавить</button>
      </form>
      `;
  } else if (t === 'outbox') {
    const rows = await api('GET', '/api/admin/outbox', { role: 'admin' });
    el.innerHTML = `<p class="muted small">Очередь уведомлений. Отправка через SMS/e-mail провайдера не подключена; здесь видно, что было бы отправлено.</p>
      ${rows.length ? `<div class="table-wrap"><table><tr><th>Время</th><th>Канал</th><th>Адрес</th><th>Текст</th></tr>
      ${rows.map((r) => `<tr><td>${fmtDate(r.createdAt)}</td><td>${esc(r.channel)}</td><td>${esc(r.to)}</td><td>${esc(r.text)}</td></tr>`).join('')}</table></div>` : '<p class="muted">Очередь пуста.</p>'}`;
  }
}

function partnerCard(p, cfg) {
  const stageIdx = cfg.onboarding.findIndex((s) => s.stage === p.stage);
  const stageTitle = p.stage === 'active' ? 'Подключён' : cfg.onboarding[stageIdx].title;
  const checklist = cfg.onboarding.map((s) => `
    <h3>${esc(s.title)}</h3>
    ${Object.entries(s.items).map(([key, label]) => `
      <label class="check"><input type="checkbox" data-checklist="${esc(key)}" ${p.checklist[key] ? 'checked' : ''}> ${esc(label)}</label>`).join('')}`).join('');
  return `
    <div class="card" data-partner="${esc(p.id)}">
      <h2 style="margin-top:0">${esc(p.name)}</h2>
      <p class="small muted">${esc(p.category)} · логин: ${esc(p.login)} · ${esc(p.address)}</p>
      <p><span class="pill ${p.status === 'active' ? 'ok' : 'warn'}">${esc(stageTitle)}</span>
        ${p.hasTerminalKey ? '<span class="pill ok">терминал выдан</span>' : ''}
        <span class="pill">комиссия ${pct(p.feeBp)}</span>
        <span class="pill">нетто к оплате ${rub(p.summary.net)}</span></p>
      <details><summary>Чек-лист подключения</summary>
        <div style="margin-top:8px">${checklist}</div>
        <button class="btn small secondary" data-action="admin-save-checklist" data-id="${esc(p.id)}">Сохранить чек-лист</button>
      </details>
      <form data-form="admin-terms" data-id="${esc(p.id)}" class="inline" style="margin-top:12px">
        <label>Тариф<select name="planId"><option value="">—</option>${cfg.plans.map((x) => `<option value="${x.id}" ${x.id === p.planId ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</select></label>
        <label>Ставка начисления, %<input name="bonusPercent" type="number" step="0.1" min="2" max="20" value="${p.bonusRateBp / 100}"></label>
        <label>Возмещение за принятые бонусы, %<input name="reimbursementPercent" type="number" step="0.1" min="0.01" max="100" value="${p.reimbursementBp / 100}"></label>
        <button class="btn small">Сохранить условия</button>
      </form>
      <div style="margin-top:10px">
        ${p.stage !== 'active' ? `<button class="btn small" data-action="admin-advance" data-id="${esc(p.id)}">Перевести на следующий этап</button>` : ''}
        ${p.status === 'active' ? `<button class="btn small secondary" data-action="admin-terminal-key" data-id="${esc(p.id)}">Новый ключ терминала</button>
          <button class="btn small danger" data-action="admin-status" data-id="${esc(p.id)}" data-status="suspended">Приостановить</button>` : ''}
        ${p.status === 'suspended' ? `<button class="btn small" data-action="admin-status" data-id="${esc(p.id)}" data-status="active">Возобновить</button>` : ''}
      </div>
    </div>`;
}

// ───────── О проекте ─────────
async function about() {
  const cfg = await config();
  render(`
    <h1>О проекте «Моя Адыгея»</h1>
    <p class="muted">Уникальный социально-туристический проект региональной направленности. Оператор: ООО «АМОССО».</p>
    <div class="card">
      <h2 style="margin-top:0">Миссия</h2>
      <p>Объединить городской и туристический бизнес Адыгеи с жителями и гостями Республики на базе простой программы лояльности. Сделать туризм в Адыгее доступным и запоминающимся, чтобы гости хотели возвращаться снова и снова.</p>
    </div>
    <div class="grid">
      <div class="card"><h3>Для гостей и жителей</h3><ul><li>Реальная экономия: до 20% стоимости покупок возвращается бонусами</li><li>Списание у любого партнёра программы: 1 бонус = 1 ₽</li><li>Каталог бизнеса, справочник туриста, аудиогид</li><li>Доставка, бронирование услуг и экскурсий</li></ul></div>
      <div class="card"><h3>Для партнёров</h3><ul><li>Привлечение и удержание гостей</li><li>Аналитика по покупателям и кампаниям</li><li>Оплата только за подключённые услуги, агрегатор с оплатой после транзакций</li><li>Интеграция, процессинг и маркетинг за счёт оператора</li></ul></div>
    </div>
    <h2>Как подключиться партнёру</h2>
    <ol class="timeline">${cfg.onboarding.map((s) => `<li><strong>${esc(s.title)}</strong><br><span class="small muted">${Object.values(s.items).map(esc).join(' · ')}</span></li>`).join('')}</ol>
    <h2>Тарифы</h2>
    <div class="table-wrap"><table><tr><th>Период</th><th>Каталог, ₽</th><th>Программа лояльности, ₽</th><th>Комиссия оператора</th></tr>
      ${cfg.plans.map((p) => `<tr><td>${esc(p.title)}</td><td>${rub(p.catalogFee)}</td><td>${rub(p.loyaltyFee)}</td><td>${pct(p.feeBp)} от чеков</td></tr>`).join('')}
    </table></div>
    <p class="small muted">При подключении нескольких партнёров по договору скидка: 3 партнёра −10%, от 4 партнёров −20%.</p>
    <h2>Бонусы участника</h2>
    <p>Начисление — процент от полной суммы покупки, который задаёт партнёр (от 2% до 20%). Бонус = 1 ₽ скидки. Бонусы не имеют денежного выражения и не выплачиваются наличными. Бонусы, накопленные у одного партнёра, можно списать у другого.</p>
    <h2>Контакты</h2>
    <p>Вопросы и предложения — через форму в <a href="#/account">личном кабинете</a> или на странице каталога.</p>
  `);
}

// ───────── обработчики кнопок ─────────
const actions = {
  logout: async ({ role }) => {
    tokens.set(role, null);
    toast('Вы вышли из кабинета');
    location.hash = { guest: '#/account', partner: '#/cabinet', admin: '#/admin' }[role];
    await route();
  },
  'auth-tab': async ({ tab }) => {
    $('#form-login').style.display = tab === 'login' ? '' : 'none';
    $('#form-register').style.display = tab === 'register' ? '' : 'none';
    $('#tab-login').classList.toggle('active', tab === 'login');
    $('#tab-register').classList.toggle('active', tab === 'register');
  },
  'cart-add': async ({ id }) => {
    cart.qty[id] = (cart.qty[id] || 0) + 1;
    await route();
  },
  'cart-remove': async ({ id }) => {
    cart.qty[id] = Math.max(0, (cart.qty[id] || 0) - 1);
    if (!cart.qty[id]) delete cart.qty[id];
    await route();
  },
  'order-cancel': async ({ id }) => {
    await api('POST', `/api/guest/orders/${encodeURIComponent(id)}/cancel`, { role: 'guest' });
    toast('Заказ отменён');
    await route();
  },
  'resend-code': async () => {
    await api('POST', '/api/guest/resend-code', { role: 'guest' });
    toast('Код отправлен по SMS');
    await route();
  },
  'partner-tab': async ({ tab }) => {
    partnerTab = tab;
    document.querySelectorAll('[data-action="partner-tab"]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    await renderPartnerTab();
  },
  'partner-order': async ({ id, status }) => {
    await api('PATCH', `/api/partner/orders/${encodeURIComponent(id)}`, { role: 'partner', body: { status } });
    toast('Статус заказа обновлён');
    await route();
  },
  'partner-item-toggle': async ({ id, active }) => {
    await api('PATCH', `/api/partner/items/${encodeURIComponent(id)}`, { role: 'partner', body: { active: active === 'true' } });
    toast('Позиция обновлена');
    await route();
  },
  'partner-campaign-toggle': async ({ id, active }) => {
    await api('PATCH', `/api/partner/campaigns/${encodeURIComponent(id)}`, { role: 'partner', body: { active: active === 'true' } });
    toast('Кампания обновлена');
    await route();
  },
  'admin-tab': async ({ tab }) => {
    adminTab = tab;
    document.querySelectorAll('[data-action="admin-tab"]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    await renderAdminTab();
  },
  'admin-save-checklist': async ({ id }) => {
    const checklist = {};
    document.querySelectorAll(`[data-partner="${CSS.escape(id)}"] [data-checklist]`).forEach((c) => { checklist[c.dataset.checklist] = c.checked; });
    await api('PATCH', `/api/admin/partners/${encodeURIComponent(id)}`, { role: 'admin', body: { checklist } });
    toast('Чек-лист сохранён');
    await route();
  },
  'admin-advance': async ({ id }) => {
    const res = await api('POST', `/api/admin/partners/${encodeURIComponent(id)}/advance`, { role: 'admin' });
    toast(res.terminalKey ? `Партнёр подключён. Ключ терминала (покажется один раз): ${res.terminalKey}` : 'Этап пройден, партнёр переведён дальше');
    await route();
  },
  'admin-terminal-key': async ({ id }) => {
    const res = await api('POST', `/api/admin/partners/${encodeURIComponent(id)}/terminal-key`, { role: 'admin' });
    toast(`Новый ключ терминала (покажется один раз): ${res.terminalKey}`);
    await route();
  },
  'admin-news-toggle': async ({ id, published }) => {
    await api('PATCH', `/api/admin/news/${encodeURIComponent(id)}`, { role: 'admin', body: { published: published === 'true' } });
    toast('Публикация новости обновлена');
    await route();
  },
  'admin-status': async ({ id, status }) => {
    await api('PATCH', `/api/admin/partners/${encodeURIComponent(id)}`, { role: 'admin', body: { status } });
    toast(status === 'active' ? 'Партнёр возобновлён' : 'Партнёр приостановлен');
    await route();
  },
};

const forms = {
  'catalog-filter': async (form) => {
    const q = new URLSearchParams({ q: field(form, 'q'), category: field(form, 'category') });
    location.hash = `#/${location.hash.slice(2).split('?')[0] === 'reference' ? 'reference' : 'catalog'}?${q}`;
  },
  order: async (form) => {
    const guest = await api('GET', '/api/guest/me', { role: 'guest' });
    const lines = Object.entries(cart.qty).map(([itemId, qty]) => ({ itemId, qty }));
    const body = {
      partnerId: cart.partnerId,
      lines,
      bonusRequested: Number(field(form, 'bonus') || 0),
      bookingAt: field(form, 'bookingAt') ? new Date(field(form, 'bookingAt')).toISOString() : null,
    };
    if (!guest) throw new Error('Войдите в кабинет, чтобы оформить заказ');
    await api('POST', '/api/guest/orders', { role: 'guest', body });
    cart = { partnerId: null, qty: {} };
    toast('Заказ оформлен. Партнёр подтвердит его в ближайшее время.');
    location.hash = '#/account';
    await route();
  },
  review: async (form) => {
    await api('POST', '/api/guest/feedback', {
      role: 'guest',
      body: { kind: 'review', partnerId: field(form, 'partnerId'), rating: Number(field(form, 'rating')), text: field(form, 'text') },
    });
    toast('Спасибо за отзыв! Он появится после проверки.');
    await route();
  },
  verify: async (form) => {
    await api('POST', '/api/guest/verify', { role: 'guest', body: { code: field(form, 'code') } });
    toast('Телефон подтверждён, списание бонусов доступно');
    await route();
  },
  'guest-feedback': async (form) => {
    await api('POST', '/api/guest/feedback', { role: 'guest', body: { kind: field(form, 'kind'), text: field(form, 'text') } });
    toast('Обращение отправлено. Спасибо!');
    await route();
  },
  'guest-login': async (form) => {
    const res = await api('POST', '/api/guest/login', { body: { phone: field(form, 'phone'), password: form.elements.password.value } });
    tokens.set('guest', res.token);
    await route();
  },
  'guest-register': async (form) => {
    const body = {
      phone: field(form, 'phone'),
      password: form.elements.password.value,
      name: field(form, 'name'),
      birthDate: field(form, 'birthDate') || null,
      referralCode: field(form, 'referralCode') || null,
    };
    const res = await api('POST', '/api/guest/register', { body });
    tokens.set('guest', res.token);
    toast('Регистрация прошла. Подтвердите телефон кодом из SMS, чтобы списывать бонусы.');
    await route();
  },
  'partner-login': async (form) => {
    const res = await api('POST', '/api/partner/login', { body: { login: field(form, 'login'), password: form.elements.password.value } });
    tokens.set('partner', res.token);
    await route();
  },
  'partner-item': async (form) => {
    await api('POST', '/api/partner/items', {
      role: 'partner',
      body: { title: field(form, 'title'), price: Number(field(form, 'price')), kind: field(form, 'kind'), category: field(form, 'category'), description: field(form, 'description') },
    });
    toast('Позиция добавлена');
    await route();
  },
  'partner-campaign': async (form) => {
    const type = field(form, 'type');
    const threshold = Number(field(form, 'threshold'));
    const daysRaw = field(form, 'days');
    const body = { type, title: field(form, 'title'), bonus: Number(field(form, 'bonus')) };
    if (type === 'product') body.itemId = field(form, 'itemId');
    if (type === 'avg_check' || type === 'frequency') body.threshold = threshold;
    if (type === 'birthday') body.days = Number(daysRaw || 7);
    if (type === 'weekday') body.days = daysRaw.split(',').map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x));
    await api('POST', '/api/partner/campaigns', { role: 'partner', body });
    toast('Кампания создана');
    await route();
  },
  'partner-news': async (form) => {
    await api('POST', '/api/partner/news', { role: 'partner', body: { title: field(form, 'title'), body: field(form, 'body') } });
    toast('Новость отправлена на публикацию');
    await route();
  },
  'admin-login': async (form) => {
    const res = await api('POST', '/api/admin/login', { body: { login: field(form, 'login'), password: form.elements.password.value } });
    tokens.set('admin', res.token);
    await route();
  },
  'admin-quote': async (form) => {
    const q = new URLSearchParams({
      planId: field(form, 'planId'),
      partners: field(form, 'partners') || '1',
      catalog: form.elements.catalog.checked ? '1' : '0',
      loyalty: form.elements.loyalty.checked ? '1' : '0',
    });
    const r = await api('GET', `/api/admin/quote?${q}`, { role: 'admin' });
    $('#quote').innerHTML = `<div class="card"><p>Базовая сумма: ${rub(r.base)} · скидка пакета: ${pct(r.discountBp)}</p><p><strong>Итого за период: ${rub(r.total)}</strong> · комиссия ${pct(r.feeBp)} от чеков</p></div>`;
  },
  'admin-expire': async () => {
    const r = await api('POST', '/api/admin/expire', { role: 'admin' });
    toast(`Аннулировано бонусов: ${bon(r.expired)}`);
    await route();
  },
  'admin-partner-create': async (form) => {
    await api('POST', '/api/admin/partners', {
      role: 'admin',
      body: {
        name: field(form, 'name'), category: field(form, 'category'), address: field(form, 'address'), phone: field(form, 'phone'),
        site: field(form, 'site'), login: field(form, 'login'), password: form.elements.password.value, description: field(form, 'description'),
      },
    });
    toast('Партнёр добавлен, этап 1 — переговоры');
    await route();
  },
  'admin-terms': async (form) => {
    const body = { planId: field(form, 'planId') || undefined, bonusRateBp: toBp(field(form, 'bonusPercent')), reimbursementBp: toBp(field(form, 'reimbursementPercent')) };
    await api('PATCH', `/api/admin/partners/${encodeURIComponent(form.dataset.id)}`, { role: 'admin', body });
    toast('Условия сохранены');
    await route();
  },
  'admin-feedback': async (form) => {
    await api('PATCH', `/api/admin/feedback/${encodeURIComponent(form.dataset.id)}`, {
      role: 'admin',
      body: { status: field(form, 'status'), reply: field(form, 'reply'), hidden: form.elements.hidden.checked },
    });
    toast('Обращение сохранено');
    await route();
  },
  'admin-news': async (form) => {
    await api('POST', '/api/admin/news', { role: 'admin', body: { title: field(form, 'title'), body: field(form, 'body'), published: form.elements.published.checked } });
    toast('Новость добавлена');
    await route();
  },
  'admin-place': async (form) => {
    await api('POST', '/api/admin/places', { role: 'admin', body: { name: field(form, 'name'), category: field(form, 'category'), address: field(form, 'address'), phone: field(form, 'phone'), description: field(form, 'description') } });
    toast('Объект добавлен в справочник');
    await route();
  },
  'admin-audio': async (form) => {
    await api('POST', '/api/admin/audio', { role: 'admin', body: { title: field(form, 'title'), place: field(form, 'place'), duration: field(form, 'duration'), url: field(form, 'url'), description: field(form, 'description') } });
    toast('Аудиогид добавлен');
    await route();
  },
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  e.preventDefault();
  try {
    await actions[el.dataset.action](el.dataset, el);
  } catch (err) {
    toast(err.message, 'error');
    await route();
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form || !forms[form.dataset.form]) return;
  e.preventDefault();
  try {
    await forms[form.dataset.form](form);
  } catch (err) {
    toast(err.message, 'error');
    await route();
  }
});

window.addEventListener('hashchange', route);
route();
