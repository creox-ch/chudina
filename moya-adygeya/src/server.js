'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomInt } = require('node:crypto');
const L = require('./ledger');
const C = require('./config');
const auth = require('./auth');
const { Store } = require('./store');
const { buildInitialData, emptyChecklist, id, now } = require('./seed');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const bad = (message) => new HttpError(400, message);

class Reply {
  constructor(status, body) {
    this.status = status;
    this.body = body;
  }
}

function str(value, { max = 200, min = 0, name = 'поле', optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional || min === 0) return '';
    throw bad(`Заполните: ${name}`);
  }
  const s = String(value).trim();
  if (s.length < min) throw bad(`Слишком коротко: ${name}`);
  if (s.length > max) throw bad(`Слишком длинно: ${name}`);
  return s;
}

function int(value, min, max, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`Некорректное значение: ${name}`);
  return n;
}

function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`;
  if (digits.length === 10) digits = `7${digits}`;
  if (digits.length < 11 || digits.length > 15) throw bad('Некорректный номер телефона');
  return digits;
}

const CARD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function uniqueCardNumber(db) {
  for (;;) {
    const digits = `9${Array.from({ length: 15 }, () => randomInt(10)).join('')}`;
    if (!db.guests.some((g) => g.cardNumber === digits)) return digits;
  }
}
function uniqueReferralCode(db) {
  for (;;) {
    const code = Array.from(randomBytes(6), (b) => CARD_ALPHABET[b % CARD_ALPHABET.length]).join('');
    if (!db.guests.some((g) => g.referralCode === code)) return code;
  }
}

const guestView = (db, g) => ({
  id: g.id,
  name: g.name || '',
  phone: g.phone,
  cardNumber: g.cardNumber,
  birthDate: g.birthDate || null,
  phoneVerified: !!g.phoneVerified,
  referralCode: g.referralCode,
  balance: L.balanceOf(g),
  referrals: db.guests.filter((x) => x.referredBy === g.id).length,
  lastActivityAt: g.lastActivityAt || null,
});

const partnerPublic = (p) => ({
  id: p.id,
  name: p.name,
  category: p.category,
  address: p.address,
  phone: p.phone,
  site: p.site,
  description: p.description,
  bonusRatePercent: p.bonusRateBp / 100,
  status: p.status,
});

function partnerAdminView(db, p) {
  const { passwordHash, terminalKeyHash, ...rest } = p;
  const summary = L.settlementSummary(db).partners.find((s) => s.partnerId === p.id) || {};
  return {
    ...rest,
    hasTerminalKey: !!terminalKeyHash,
    plan: p.planId || null,
    summary: { issued: summary.issued || 0, fees: summary.fees || 0, accepted: summary.accepted || 0, net: summary.netToOperator || 0, outstanding: summary.outstandingBonuses || 0 },
  };
}

function nextOpenStage(p) {
  const order = C.STAGE_ORDER;
  return order.find((s) => {
    const def = C.ONBOARDING.find((x) => x.stage === s);
    return Object.keys(def.items).some((k) => !p.checklist[k]);
  });
}

function missingItems(p, stage) {
  const def = C.ONBOARDING.find((x) => x.stage === stage);
  return Object.keys(def.items).filter((k) => !p.checklist[k]).map((k) => def.items[k]);
}

function createApp({ dataFile, secret, seedDemo = false, adminLogin = 'operator', adminPassword, log = console.log } = {}) {
  const store = new Store(dataFile);
  if (store.isEmpty) store.data = buildInitialData({ seedDemo });
  const secretKey = secret || process.env.APP_SECRET || randomBytes(32).toString('hex');

  // Оператор: пароль из ADMIN_PASSWORD; если не задан — создаётся один раз и печатается в лог.
  let createdAdminPassword = null;
  if (!store.data.admins.length || adminPassword) {
    const pw = adminPassword || randomBytes(9).toString('base64url');
    store.data.admins = [{ id: id('adm'), login: adminLogin, passwordHash: auth.hashPassword(pw), createdAt: now() }];
    if (!adminPassword) createdAdminPassword = pw;
  }
  for (const p of store.data.partners.filter((x) => x.status === 'active' && !x.terminalKeyHash)) {
    const key = randomBytes(16).toString('hex');
    p.terminalKeyHash = auth.sha256(key);
    log(`[seed] ключ терминала «${p.name}»: ${key}`);
  }
  if (createdAdminPassword) log(`[init] логин оператора: ${adminLogin}, пароль: ${createdAdminPassword}`);
  store.save();

  const reload = () => {
    if (fs.existsSync(store.file)) store.data = { ...store.data, ...JSON.parse(fs.readFileSync(store.file, 'utf8')) };
  };

  const routes = [];
  const route = (method, pattern, handler, role = null) => {
    const names = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)'))}$`);
    routes.push({ method, re, names, handler, role });
  };

  function authUser(req, roles) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const payload = auth.verifyToken(token, secretKey);
    if (!payload || (roles && !roles.includes(payload.role))) throw new HttpError(401, 'Нужна авторизация');
    return payload;
  }

  function terminalPartner(req) {
    const key = req.headers['x-terminal-key'];
    if (!key) throw new HttpError(401, 'Нужен ключ терминала');
    const hash = auth.sha256(key);
    const partner = store.data.partners.find((p) => p.terminalKeyHash === hash);
    if (!partner) throw new HttpError(401, 'Неверный ключ терминала');
    return partner;
  }

  const guestOf = (db, user) => db.guests.find((g) => g.id === user.sub) || (() => { throw new HttpError(401, 'Гость не найден'); })();
  const partnerOf = (db, user) => db.partners.find((p) => p.id === user.sub) || (() => { throw new HttpError(401, 'Партнёр не найден'); })();
  const requireVerified = (guest) => {
    if (!guest.phoneVerified) throw new HttpError(403, 'Активируйте карту: подтвердите телефон кодом из SMS (Правила 6.2)');
  };

  // ───────────── Публичные ─────────────
  route('GET', '/api/health', () => ({ ok: true }));

  route('GET', '/api/config', () => ({
    plans: Object.values(L.PLANS),
    categories: C.CATEGORIES,
    onboarding: C.ONBOARDING,
    campaignTypes: C.CAMPAIGN_TYPES,
    segmentRates: C.SEGMENT_RATES,
  }));

  route('GET', '/api/news', ({ db }) =>
    db.news.filter((n) => n.published).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));

  const matchText = (row, q) => !q || [row.name, row.title, row.description, row.address].join(' ').toLowerCase().includes(q.toLowerCase());

  route('GET', '/api/partners', ({ db, query }) =>
    db.partners
      .filter((p) => p.status === 'active')
      .filter((p) => !query.category || p.category === query.category)
      .filter((p) => matchText(p, query.q))
      .map(partnerPublic));

  route('GET', '/api/partners/:id', ({ db, params }) => {
    const p = db.partners.find((x) => x.id === params.id && x.status === 'active');
    if (!p) throw new HttpError(404, 'Партнёр не найден');
    return {
      ...partnerPublic(p),
      items: db.items.filter((i) => i.partnerId === p.id && i.active),
      campaigns: db.campaigns.filter((c) => c.partnerId === p.id && c.active).map((c) => ({ id: c.id, title: c.title, type: c.type })),
      reviews: db.feedback
        .filter((f) => f.kind === 'review' && f.partnerId === p.id && !f.hidden)
        .map((f) => ({ rating: f.rating, text: f.text, createdAt: f.createdAt })),
    };
  });

  route('GET', '/api/places', ({ db, query }) =>
    db.places.filter((x) => !query.category || x.category === query.category).filter((x) => matchText(x, query.q)));

  route('GET', '/api/audio', ({ db }) => db.audio);

  // ───────────── Гость ─────────────
  route('POST', '/api/guest/register', ({ db, body }) => {
    const phone = normalizePhone(body.phone);
    const password = str(body.password, { min: 6, max: 100, name: 'пароль (от 6 символов)' });
    if (db.guests.some((g) => g.phone === phone)) throw new HttpError(409, 'Этот телефон уже зарегистрирован');
    let referredBy = null;
    if (body.referralCode) {
      const ref = db.guests.find((g) => g.referralCode === String(body.referralCode).toUpperCase());
      if (!ref) throw bad('Реферальный код не найден');
      referredBy = ref.id;
    }
    const birthDate = body.birthDate ? str(body.birthDate, { max: 10, name: 'дата рождения' }) : null;
    if (birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) throw bad('Дата рождения в формате ГГГГ-ММ-ДД');
    const code = String(randomInt(1000, 10000));
    const guest = {
      id: id('g'),
      name: str(body.name, { max: 80, optional: true }),
      phone,
      passwordHash: auth.hashPassword(password),
      cardNumber: uniqueCardNumber(db),
      referralCode: uniqueReferralCode(db),
      referredBy,
      referralRewarded: false,
      birthDate,
      phoneVerified: false,
      verifyCode: code,
      lots: [],
      createdAt: now(),
      lastActivityAt: now(),
    };
    db.guests.push(guest);
    db.outbox.push({ id: id('sms'), channel: 'sms', to: phone, text: `Код подтверждения «Моя Адыгея»: ${code}`, createdAt: now() });
    return new Reply(201, { token: auth.signToken({ sub: guest.id, role: 'guest' }, secretKey), guest: guestView(db, guest) });
  });

  route('POST', '/api/guest/login', ({ db, body }) => {
    const phone = normalizePhone(body.phone);
    const guest = db.guests.find((g) => g.phone === phone);
    if (!guest || !auth.verifyPassword(body.password, guest.passwordHash)) throw new HttpError(401, 'Неверный телефон или пароль');
    return { token: auth.signToken({ sub: guest.id, role: 'guest' }, secretKey), guest: guestView(db, guest) };
  });

  route('POST', '/api/guest/verify', ({ db, user, body }) => {
    const guest = guestOf(db, user);
    if (String(body.code) !== guest.verifyCode) throw bad('Неверный код из SMS');
    guest.phoneVerified = true;
    guest.verifyCode = null;
    return guestView(db, guest);
  }, 'guest');

  route('POST', '/api/guest/resend-code', ({ db, user }) => {
    const guest = guestOf(db, user);
    guest.verifyCode = String(randomInt(1000, 10000));
    db.outbox.push({ id: id('sms'), channel: 'sms', to: guest.phone, text: `Код подтверждения «Моя Адыгея»: ${guest.verifyCode}`, createdAt: now() });
    return { ok: true };
  }, 'guest');

  route('GET', '/api/guest/me', ({ db, user }) => guestView(db, guestOf(db, user)), 'guest');

  route('GET', '/api/guest/transactions', ({ db, user }) => {
    const partnerName = (pid) => (pid === L.OPERATOR ? 'Оператор' : (db.partners.find((p) => p.id === pid) || {}).name || '—');
    return db.transactions
      .filter((t) => t.guestId === user.sub)
      .slice(-200)
      .reverse()
      .map((t) => ({ id: t.id, type: t.type, partner: partnerName(t.partnerId), checkAmount: t.checkAmount || null, bonus: t.bonus, createdAt: t.createdAt }));
  }, 'guest');

  route('GET', '/api/guest/orders', ({ db, user }) =>
    db.orders.filter((o) => o.guestId === user.sub).slice(-100).reverse(), 'guest');

  route('POST', '/api/guest/orders', ({ db, user, body }) => {
    const guest = guestOf(db, user);
    const partner = db.partners.find((p) => p.id === body.partnerId && p.status === 'active');
    if (!partner) throw new HttpError(404, 'Партнёр не найден');
    if (!Array.isArray(body.lines) || !body.lines.length) throw bad('Добавьте позиции в заказ');
    const lines = body.lines.map((l) => {
      const item = db.items.find((i) => i.id === l.itemId && i.partnerId === partner.id && i.active);
      if (!item) throw bad('Позиция недоступна');
      return { itemId: item.id, title: item.title, price: item.price, qty: int(l.qty || 1, 1, 50, 'количество') };
    });
    const bonusRequested = int(body.bonusRequested || 0, 0, 10_000_000, 'бонусы к списанию');
    if (bonusRequested > 0) requireVerified(guest);
    const order = L.createOrder(db, { guest, partner, lines, bonusRequested, bookingAt: body.bookingAt || null, now: new Date() });
    return new Reply(201, order);
  }, 'guest');

  route('POST', '/api/guest/orders/:id/cancel', ({ db, user, params }) => {
    const guest = guestOf(db, user);
    const order = db.orders.find((o) => o.id === params.id && o.guestId === guest.id);
    if (!order) throw new HttpError(404, 'Заказ не найден');
    const partner = db.partners.find((p) => p.id === order.partnerId);
    return L.transitionOrder(db, order, partner, guest, 'cancelled');
  }, 'guest');

  const submitFeedback = (db, body, guest) => {
    const kind = str(body.kind, { min: 1, max: 20, name: 'тип обращения' });
    if (!['review', 'proposal', 'complaint'].includes(kind)) throw bad('Тип обращения: review, proposal или complaint');
    const partnerId = body.partnerId ? String(body.partnerId) : null;
    if (partnerId && !db.partners.some((p) => p.id === partnerId)) throw bad('Партнёр не найден');
    if (kind === 'review') {
      if (!guest) throw new HttpError(401, 'Отзывы оставляют зарегистрированные участники');
      if (!partnerId) throw bad('Выберите партнёра для отзыва');
    }
    const row = {
      id: id('fb'),
      kind,
      partnerId,
      guestId: guest ? guest.id : null,
      contact: str(body.contact, { max: 120, optional: true }),
      rating: kind === 'review' ? int(body.rating, 1, 5, 'оценка') : null,
      text: str(body.text, { min: 3, max: 2000, name: 'текст' }),
      status: 'new',
      reply: '',
      hidden: false,
      createdAt: now(),
    };
    db.feedback.push(row);
    return new Reply(201, { id: row.id, status: row.status });
  };

  route('POST', '/api/guest/feedback', ({ db, user, body }) => submitFeedback(db, body, guestOf(db, user)), 'guest');
  route('POST', '/api/feedback', ({ db, body }) => submitFeedback(db, body, null));

  // ───────────── Партнёр (сотрудник) ─────────────
  route('POST', '/api/partner/login', ({ db, body }) => {
    const p = db.partners.find((x) => x.login === String(body.login || '').trim());
    if (!p || p.status === 'suspended' || !auth.verifyPassword(body.password, p.passwordHash)) {
      throw new HttpError(401, 'Неверный логин или пароль');
    }
    return { token: auth.signToken({ sub: p.id, role: 'partner' }, secretKey), partner: partnerAdminView(db, p) };
  });

  route('GET', '/api/partner/me', ({ db, user }) => partnerAdminView(db, partnerOf(db, user)), 'partner');

  route('GET', '/api/partner/transactions', ({ db, user }) =>
    db.transactions.filter((t) => t.partnerId === user.sub).slice(-300).reverse(), 'partner');

  route('GET', '/api/partner/settlements', ({ db, user }) => {
    const s = L.settlementSummary(db).partners.find((x) => x.partnerId === user.sub) || {};
    return {
      issued: s.issued || 0,
      fees: s.fees || 0,
      accepted: s.accepted || 0,
      netToOperator: s.netToOperator || 0,
      outstandingBonuses: s.outstandingBonuses || 0,
      rows: db.settlements.filter((x) => x.partnerId === user.sub).slice(-300).reverse(),
    };
  }, 'partner');

  route('GET', '/api/partner/orders', ({ db, user }) =>
    db.orders.filter((o) => o.partnerId === user.sub).slice(-200).reverse(), 'partner');

  route('PATCH', '/api/partner/orders/:id', ({ db, user, params, body }) => {
    const partner = partnerOf(db, user);
    const order = db.orders.find((o) => o.id === params.id && o.partnerId === partner.id);
    if (!order) throw new HttpError(404, 'Заказ не найден');
    const guest = db.guests.find((g) => g.id === order.guestId);
    return L.transitionOrder(db, order, partner, guest, str(body.status, { max: 20, name: 'статус' }));
  }, 'partner');

  route('POST', '/api/partner/items', ({ db, user, body }) => {
    const item = {
      id: id('i'),
      partnerId: user.sub,
      kind: ['product', 'service'].includes(body.kind) ? body.kind : 'product',
      title: str(body.title, { min: 2, max: 120, name: 'название' }),
      category: str(body.category, { max: 80, optional: true }),
      price: int(body.price, 0, 10_000_000, 'цена'),
      description: str(body.description, { max: 1000, optional: true }),
      active: body.active !== false,
    };
    db.items.push(item);
    return new Reply(201, item);
  }, 'partner');

  route('PATCH', '/api/partner/items/:id', ({ db, user, params, body }) => {
    const item = db.items.find((i) => i.id === params.id && i.partnerId === user.sub);
    if (!item) throw new HttpError(404, 'Позиция не найдена');
    if (body.title !== undefined) item.title = str(body.title, { min: 2, max: 120, name: 'название' });
    if (body.price !== undefined) item.price = int(body.price, 0, 10_000_000, 'цена');
    if (body.active !== undefined) item.active = !!body.active;
    if (body.description !== undefined) item.description = str(body.description, { max: 1000, optional: true });
    return item;
  }, 'partner');

  route('GET', '/api/partner/items', ({ db, user }) => db.items.filter((i) => i.partnerId === user.sub), 'partner');

  route('POST', '/api/partner/campaigns', ({ db, user, body }) => {
    const partner = partnerOf(db, user);
    const type = String(body.type || '');
    if (!C.CAMPAIGN_TYPES[type]) throw bad('Неизвестный тип кампании');
    const cond = {};
    if (type === 'product') {
      const item = db.items.find((i) => i.id === body.itemId && i.partnerId === partner.id);
      if (!item) throw bad('Выберите свою позицию для кампании');
      cond.itemId = item.id;
    }
    if (type === 'avg_check') cond.threshold = int(body.threshold, 1, 10_000_000, 'порог чека');
    if (type === 'frequency') cond.threshold = int(body.threshold, 2, 31, 'номер покупки в месяце');
    if (type === 'birthday') cond.days = int(body.days ?? 7, 1, 30, 'дней вокруг дня рождения');
    if (type === 'weekday') {
      if (!Array.isArray(body.days) || !body.days.length) throw bad('Выберите дни недели');
      cond.days = body.days.map((d) => int(d, 0, 6, 'день недели'));
    }
    const campaign = {
      id: id('c'),
      partnerId: partner.id,
      type,
      title: str(body.title, { min: 2, max: 120, name: 'название кампании' }),
      bonus: int(body.bonus, 0, 100_000, 'бонус'),
      condition: cond,
      active: body.active !== false,
    };
    db.campaigns.push(campaign);
    return new Reply(201, campaign);
  }, 'partner');

  route('PATCH', '/api/partner/campaigns/:id', ({ db, user, params, body }) => {
    const c = db.campaigns.find((x) => x.id === params.id && x.partnerId === user.sub);
    if (!c) throw new HttpError(404, 'Кампания не найдена');
    if (body.active !== undefined) c.active = !!body.active;
    if (body.bonus !== undefined) c.bonus = int(body.bonus, 0, 100_000, 'бонус');
    return c;
  }, 'partner');

  route('GET', '/api/partner/campaigns', ({ db, user }) => db.campaigns.filter((c) => c.partnerId === user.sub), 'partner');

  route('POST', '/api/partner/news', ({ db, user, body }) => {
    const row = { id: id('n'), title: str(body.title, { min: 3, max: 160, name: 'заголовок' }), body: str(body.body, { min: 3, max: 5000, name: 'текст' }), partnerId: user.sub, published: false, createdAt: now() };
    db.news.push(row);
    return new Reply(201, { ...row, note: 'Публикация после проверки оператором' });
  }, 'partner');

  route('GET', '/api/partner/feedback', ({ db, user }) =>
    db.feedback.filter((f) => f.partnerId === user.sub).map(({ contact, ...rest }) => rest), 'partner');

  // ───────────── Терминал (касса партнёра) ─────────────
  route('POST', '/api/terminal/identify', ({ db, req, body }) => {
    terminalPartner(req);
    const raw = String(body.identifier || '').replace(/\s/g, '');
    const isCard = /^9\d{15}$/.test(raw);
    const guest = db.guests.find((g) => (isCard ? g.cardNumber === raw : g.phone === normalizePhone(raw)));
    if (!guest) throw new HttpError(404, 'Участник не найден');
    return { name: guest.name, balance: L.balanceOf(guest), verified: !!guest.phoneVerified };
  });

  route('POST', '/api/terminal/sale', ({ db, req, body }) => {
    const partner = terminalPartner(req);
    if (partner.status !== 'active') throw new HttpError(409, 'Партнёр не подключён');
    const raw = String(body.identifier || '').replace(/\s/g, '');
    const isCard = /^9\d{15}$/.test(raw);
    const guest = db.guests.find((g) => (isCard ? g.cardNumber === raw : g.phone === normalizePhone(raw)));
    if (!guest) throw new HttpError(404, 'Участник не найден');
    const checkAmount = int(body.checkAmount, 1, 10_000_000, 'сумма чека');
    const bonusAmount = int(body.bonusAmount || 0, 0, checkAmount, 'бонусы к списанию');
    if (bonusAmount > 0) requireVerified(guest);
    const items = (body.itemIds || []).map((itemId) => ({ itemId: String(itemId), qty: 1, price: 0 }));
    const result = L.sale(db, { guest, partner, checkAmount, bonusAmount, items, now: new Date() });
    return { ...result, balance: L.balanceOf(guest) };
  });

  // ───────────── Оператор ─────────────
  route('POST', '/api/admin/login', ({ db, body }) => {
    const a = db.admins.find((x) => x.login === String(body.login || '').trim());
    if (!a || !auth.verifyPassword(body.password, a.passwordHash)) throw new HttpError(401, 'Неверный логин или пароль');
    return { token: auth.signToken({ sub: a.id, role: 'admin' }, secretKey) };
  });

  route('GET', '/api/admin/overview', ({ db }) => {
    const sum = (rows, pick) => rows.reduce((s, r) => s + pick(r), 0);
    const settlements = L.settlementSummary(db);
    const stages = {};
    for (const p of db.partners) stages[p.stage] = (stages[p.stage] || 0) + 1;
    return {
      guests: db.guests.length,
      verifiedGuests: db.guests.filter((g) => g.phoneVerified).length,
      partnersByStage: stages,
      partnersActive: db.partners.filter((p) => p.status === 'active').length,
      accrued: sum(db.transactions.filter((t) => t.type === 'accrual'), (t) => t.bonus),
      redeemed: sum(db.transactions.filter((t) => t.type === 'redeem'), (t) => t.bonus),
      feesTotal: settlements.feesTotal,
      operatorFunded: settlements.operatorFunded,
      outstandingBonuses: sum(db.guests, (g) => L.balanceOf(g)),
      orders: db.orders.length,
      newFeedback: db.feedback.filter((f) => f.status === 'new').length,
    };
  }, 'admin');

  route('GET', '/api/admin/partners', ({ db }) => db.partners.map((p) => partnerAdminView(db, p)), 'admin');

  route('POST', '/api/admin/partners', ({ db, body }) => {
    const login = str(body.login, { min: 3, max: 40, name: 'логин партнёра' });
    if (db.partners.some((p) => p.login === login)) throw new HttpError(409, 'Логин занят');
    const partner = {
      id: id('p'),
      name: str(body.name, { min: 2, max: 120, name: 'название' }),
      category: str(body.category, { max: 80, optional: true }),
      address: str(body.address, { max: 200, optional: true }),
      phone: str(body.phone, { max: 40, optional: true }),
      site: str(body.site, { max: 200, optional: true }),
      description: str(body.description, { max: 1000, optional: true }),
      status: 'onboarding',
      stage: 'negotiation',
      planId: null,
      feeBp: 100,
      bonusRateBp: 500,
      reimbursementBp: 10000,
      checklist: emptyChecklist(),
      login,
      passwordHash: auth.hashPassword(str(body.password, { min: 6, max: 100, name: 'пароль партнёра' })),
      terminalKeyHash: null,
      createdAt: now(),
    };
    db.partners.push(partner);
    return new Reply(201, partnerAdminView(db, partner));
  }, 'admin');

  route('PATCH', '/api/admin/partners/:id', ({ db, params, body }) => {
    const p = db.partners.find((x) => x.id === params.id);
    if (!p) throw new HttpError(404, 'Партнёр не найден');
    for (const key of ['name', 'category', 'address', 'phone', 'site', 'description']) {
      if (body[key] !== undefined) p[key] = str(body[key], { max: 200, optional: true });
    }
    if (body.planId !== undefined) {
      if (!L.PLANS[body.planId]) throw bad('Неизвестный тариф');
      p.planId = body.planId;
      p.feeBp = L.PLANS[body.planId].feeBp;
    }
    if (body.bonusRateBp !== undefined) p.bonusRateBp = int(body.bonusRateBp, 200, 2000, 'ставка начисления (2–20%)');
    if (body.reimbursementBp !== undefined) p.reimbursementBp = int(body.reimbursementBp, 1, 10000, 'возмещение, bp');
    if (body.status !== undefined) {
      if (!['active', 'suspended', 'onboarding'].includes(body.status)) throw bad('Некорректный статус');
      if (body.status === 'active' && p.stage !== 'active') throw bad('Сначала пройдите этапы подключения');
      p.status = body.status;
    }
    if (body.checklist && typeof body.checklist === 'object') {
      for (const [key, val] of Object.entries(body.checklist)) {
        if (key in p.checklist) p.checklist[key] = !!val;
      }
    }
    return partnerAdminView(db, p);
  }, 'admin');

  route('POST', '/api/admin/partners/:id/advance', ({ db, params }) => {
    const p = db.partners.find((x) => x.id === params.id);
    if (!p) throw new HttpError(404, 'Партнёр не найден');
    if (p.stage === 'active') throw new HttpError(409, 'Партнёр уже подключён');
    const missing = missingItems(p, p.stage);
    if (missing.length) throw new HttpError(409, `Не выполнено: ${missing.join('; ')}`);
    const idx = C.STAGE_ORDER.indexOf(p.stage);
    let terminalKey = null;
    if (idx === C.STAGE_ORDER.length - 1) {
      p.stage = 'active';
      p.status = 'active';
      terminalKey = randomBytes(16).toString('hex');
      p.terminalKeyHash = auth.sha256(terminalKey);
    } else {
      p.stage = C.STAGE_ORDER[idx + 1];
    }
    return { partner: partnerAdminView(db, p), terminalKey, note: terminalKey ? 'Ключ терминала показывается один раз' : null };
  }, 'admin');

  route('POST', '/api/admin/partners/:id/terminal-key', ({ db, params }) => {
    const p = db.partners.find((x) => x.id === params.id);
    if (!p || p.status !== 'active') throw new HttpError(409, 'Партнёр не подключён');
    const key = randomBytes(16).toString('hex');
    p.terminalKeyHash = auth.sha256(key);
    return { terminalKey: key, note: 'Ключ показывается один раз, старый ключ больше не работает' };
  }, 'admin');

  route('GET', '/api/admin/settlements', ({ db }) => L.settlementSummary(db), 'admin');

  route('GET', '/api/admin/feedback', ({ db }) => db.feedback.slice().reverse(), 'admin');

  route('PATCH', '/api/admin/feedback/:id', ({ db, params, body }) => {
    const f = db.feedback.find((x) => x.id === params.id);
    if (!f) throw new HttpError(404, 'Обращение не найдено');
    if (body.status !== undefined) {
      if (!['new', 'in_progress', 'answered'].includes(body.status)) throw bad('Некорректный статус');
      f.status = body.status;
    }
    if (body.reply !== undefined) f.reply = str(body.reply, { max: 2000, optional: true });
    if (body.hidden !== undefined) f.hidden = !!body.hidden;
    return f;
  }, 'admin');

  route('GET', '/api/admin/news', ({ db }) => db.news.slice().reverse(), 'admin');

  route('POST', '/api/admin/news', ({ db, body }) => {
    const row = { id: id('n'), title: str(body.title, { min: 3, max: 160, name: 'заголовок' }), body: str(body.body, { min: 3, max: 5000, name: 'текст' }), published: !!body.published, createdAt: now() };
    db.news.push(row);
    return new Reply(201, row);
  }, 'admin');

  route('PATCH', '/api/admin/news/:id', ({ db, params, body }) => {
    const n = db.news.find((x) => x.id === params.id);
    if (!n) throw new HttpError(404, 'Новость не найдена');
    if (body.published !== undefined) n.published = !!body.published;
    if (body.title !== undefined) n.title = str(body.title, { min: 3, max: 160, name: 'заголовок' });
    return n;
  }, 'admin');

  route('POST', '/api/admin/places', ({ db, body }) => {
    const row = {
      id: id('pl'),
      name: str(body.name, { min: 2, max: 160, name: 'название' }),
      category: str(body.category, { max: 80, optional: true }),
      address: str(body.address, { max: 200, optional: true }),
      phone: str(body.phone, { max: 40, optional: true }),
      site: str(body.site, { max: 200, optional: true }),
      description: str(body.description, { max: 1000, optional: true }),
    };
    db.places.push(row);
    return new Reply(201, row);
  }, 'admin');

  route('POST', '/api/admin/audio', ({ db, body }) => {
    const row = {
      id: id('a'),
      title: str(body.title, { min: 2, max: 160, name: 'название' }),
      place: str(body.place, { max: 160, optional: true }),
      duration: str(body.duration, { max: 20, optional: true }),
      url: str(body.url, { max: 500, optional: true }),
      description: str(body.description, { max: 1000, optional: true }),
      status: body.url ? 'ready' : 'in_development',
      createdAt: now(),
    };
    db.audio.push(row);
    return new Reply(201, row);
  }, 'admin');

  route('POST', '/api/admin/expire', ({ db }) => ({ expired: L.expireInactive(db, new Date()) }), 'admin');

  route('GET', '/api/admin/outbox', ({ db }) => db.outbox.slice(-200).reverse(), 'admin');

  route('GET', '/api/admin/quote', ({ query }) =>
    L.quoteSubscription(query.planId, {
      partnersInContract: int(query.partners || 1, 1, 1000, 'партнёров в договоре'),
      catalog: query.catalog !== '0',
      loyalty: query.loyalty !== '0',
    }), 'admin');

  // ───────────── HTTP ─────────────
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 100_000) {
          reject(new HttpError(413, 'Слишком большой запрос'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(bad('Некорректный JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  function sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    let file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'Запрещено' });
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

    const method = req.method;
    const match = routes
      .map((r) => ({ r, m: r.method === method ? pathname.match(r.re) : null }))
      .find((x) => x.m);
    if (!match) {
      const exists = routes.some((r) => r.re.test(pathname));
      return sendJson(res, exists ? 405 : 404, { error: exists ? 'Метод не поддерживается' : 'Не найдено' });
    }

    const { r, m } = match;
    const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
    const query = Object.fromEntries(url.searchParams.entries());
    const mutating = method !== 'GET';
    try {
      const body = mutating ? await readBody(req) : {};
      const user = r.role && r.role !== 'terminal' ? authUser(req, [r.role]) : null;
      const result = r.handler({ db: store.data, req, params, query, body, user });
      if (mutating) store.save();
      if (result instanceof Reply) return sendJson(res, result.status, result.body);
      return sendJson(res, 200, result === undefined ? { ok: true } : result);
    } catch (err) {
      if (mutating) reload();
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      if (err instanceof L.LedgerError) return sendJson(res, err.status, { error: err.message });
      log('[error]', err);
      return sendJson(res, 500, { error: 'Внутренняя ошибка сервера' });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log('[fatal]', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Внутренняя ошибка сервера' });
    });
  });
  return { server, store };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const dataFile = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'db.json');
  const { server } = createApp({
    dataFile,
    seedDemo: process.env.SEED_DEMO === '1',
    adminLogin: process.env.ADMIN_LOGIN || 'operator',
    adminPassword: process.env.ADMIN_PASSWORD || undefined,
  });
  server.listen(port, () => console.log(`«Моя Адыгея» слушает http://localhost:${port}`));
}

module.exports = { createApp };
