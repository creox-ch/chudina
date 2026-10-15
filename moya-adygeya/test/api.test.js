'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { createApp } = require('../src/server');
const C = require('../src/config');

const dataFile = path.join(__dirname, '..', 'data', `test-${randomBytes(4).toString('hex')}.json`);
let base;
let app;
let close;

before(async () => {
  const quiet = () => {};
  app = createApp({ dataFile, adminPassword: 'admin-pass-1', secret: 'test-secret', log: quiet });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
  close = () => new Promise((resolve) => app.server.close(resolve));
});

after(async () => {
  await close();
  for (const f of [dataFile, `${dataFile}.tmp`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

async function api(method, route, { token, body, key } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['X-Terminal-Key'] = key;
  const res = await fetch(base + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

test('каркас: здоровье, конфиг и пустые публичные списки', async () => {
  assert.equal((await api('GET', '/api/health')).data.ok, true);
  const cfg = (await api('GET', '/api/config')).data;
  assert.equal(cfg.onboarding.length, 4);
  assert.equal(cfg.plans.length, 4);
  const news = (await api('GET', '/api/news')).data;
  assert.ok(news.length >= 1);
  assert.equal((await api('GET', '/api/partners')).data.length, 0);
});

let guestToken;
let guestId;
test('регистрация гостя и подтверждение телефона кодом из SMS', async () => {
  const reg = await api('POST', '/api/guest/register', { body: { phone: '+7 (918) 000-11-22', password: 'secret1', name: 'Анна', birthDate: '1990-06-18' } });
  assert.equal(reg.status, 201);
  guestToken = reg.data.token;
  guestId = reg.data.guest.id;
  assert.match(reg.data.guest.cardNumber, /^9\d{15}$/);
  assert.equal(reg.data.guest.phoneVerified, false);
  const dup = await api('POST', '/api/guest/register', { body: { phone: '89180001122', password: 'secret1' } });
  assert.equal(dup.status, 409);

  const code = app.store.data.guests.find((g) => g.id === guestId).verifyCode;
  const bad = await api('POST', '/api/guest/verify', { token: guestToken, body: { code: '0000' } });
  assert.equal(bad.status, 400);
  const ok = await api('POST', '/api/guest/verify', { token: guestToken, body: { code } });
  assert.equal(ok.data.phoneVerified, true);
});

let adminToken;
let partnerId;
let partnerToken;
let terminalKey;
test('оператор создаёт партнёра и проводит его по этапам подключения', async () => {
  adminToken = (await api('POST', '/api/admin/login', { body: { login: 'operator', password: 'admin-pass-1' } })).data.token;
  assert.ok(adminToken);
  assert.equal((await api('GET', '/api/admin/overview', { token: adminToken })).status, 200);
  assert.equal((await api('GET', '/api/admin/overview', { token: guestToken })).status, 401);

  const created = await api('POST', '/api/admin/partners', {
    token: adminToken,
    body: { name: 'Тестовый ресторан', category: 'Рестораны и кафе', login: 'rest1', password: 'partner-pass' },
  });
  assert.equal(created.status, 201);
  partnerId = created.data.id;
  assert.equal(created.data.status, 'onboarding');

  const early = await api('POST', `/api/admin/partners/${partnerId}/advance`, { token: adminToken });
  assert.equal(early.status, 409);

  const checklist = {};
  for (const stage of C.ONBOARDING) for (const k of Object.keys(stage.items)) checklist[k] = true;
  const patched = await api('PATCH', `/api/admin/partners/${partnerId}`, { token: adminToken, body: { checklist, planId: 'quarter', bonusRateBp: 1000 } });
  assert.equal(patched.data.feeBp, 100);

  let res;
  for (let i = 0; i < C.STAGE_ORDER.length; i += 1) res = await api('POST', `/api/admin/partners/${partnerId}/advance`, { token: adminToken });
  assert.equal(res.status, 200);
  assert.equal(res.data.partner.status, 'active');
  terminalKey = res.data.terminalKey;
  assert.match(terminalKey, /^[0-9a-f]{32}$/);

  partnerToken = (await api('POST', '/api/partner/login', { body: { login: 'rest1', password: 'partner-pass' } })).data.token;
  assert.ok(partnerToken);
});

let itemId;
test('партнёр добавляет позицию и кампанию «первая покупка»', async () => {
  const item = await api('POST', '/api/partner/items', { token: partnerToken, body: { title: 'Ужин на двоих', price: 2000, kind: 'product' } });
  assert.equal(item.status, 201);
  itemId = item.data.id;
  const camp = await api('POST', '/api/partner/campaigns', { token: partnerToken, body: { type: 'first_purchase', title: 'Знакомство', bonus: 100 } });
  assert.equal(camp.status, 201);
  const bad = await api('POST', '/api/partner/campaigns', { token: partnerToken, body: { type: 'unknown', title: 'x', bonus: 1 } });
  assert.equal(bad.status, 400);
});

test('терминал: продажа начисляет бонусы на полный чек и списывает только у активированного участника', async () => {
  const noKey = await api('POST', '/api/terminal/sale', { body: { identifier: guestId, checkAmount: 1000 } });
  assert.equal(noKey.status, 401);

  const phoneIdent = '+7 918 000 11 22';
  const identify = await api('POST', '/api/terminal/identify', { key: terminalKey, body: { identifier: phoneIdent } });
  assert.equal(identify.status, 200);
  assert.equal(identify.data.balance, 0);

  const first = await api('POST', '/api/terminal/sale', { key: terminalKey, body: { identifier: phoneIdent, checkAmount: 1000 } });
  assert.equal(first.status, 200);
  assert.equal(first.data.bonusEarned, 100 + 100); // 10% от 1000 + первая покупка
  assert.equal(first.data.fee, 10); // 1% оператору

  const cardIdent = app.store.data.guests.find((g) => g.id === guestId).cardNumber;
  const second = await api('POST', '/api/terminal/sale', { key: terminalKey, body: { identifier: cardIdent, checkAmount: 500, bonusAmount: 50 } });
  assert.equal(second.status, 200);
  assert.equal(second.data.bonusUsed, 50);
  assert.equal(second.data.cashDue, 450);
  assert.equal(second.data.balance, 200 - 50 + 50); // 200 накоплено, −50 списано, +50 за чек 500
});

test('списание через терминал и заказ требуют активации карты', async () => {
  const other = await api('POST', '/api/guest/register', { body: { phone: '+79990000001', password: 'secret2' } });
  const otherToken = other.data.token;
  const otherId = other.data.guest.id;
  const otherPhone = '+79990000001';
  await api('POST', '/api/terminal/sale', { key: terminalKey, body: { identifier: otherPhone, checkAmount: 800 } });
  const notVerified = await api('POST', '/api/terminal/sale', { key: terminalKey, body: { identifier: otherPhone, checkAmount: 100, bonusAmount: 10 } });
  assert.equal(notVerified.status, 403);
  const orderTry = await api('POST', '/api/guest/orders', { token: otherToken, body: { partnerId, lines: [{ itemId, qty: 1 }], bonusRequested: 10 } });
  assert.equal(orderTry.status, 403);
  assert.ok(otherId);
});

test('заказ: участник создаёт, партнёр подтверждает и выполняет, бонусы списываются только при выполнении', async () => {
  const before = (await api('GET', '/api/guest/me', { token: guestToken })).data.balance;
  const order = await api('POST', '/api/guest/orders', { token: guestToken, body: { partnerId, lines: [{ itemId, qty: 1 }], bonusRequested: 100 } });
  assert.equal(order.status, 201);
  assert.equal(order.data.status, 'new');
  assert.equal((await api('GET', '/api/guest/me', { token: guestToken })).data.balance, before);

  const confirmed = await api('PATCH', `/api/partner/orders/${order.data.id}`, { token: partnerToken, body: { status: 'confirmed' } });
  assert.equal(confirmed.data.status, 'confirmed');
  const done = await api('PATCH', `/api/partner/orders/${order.data.id}`, { token: partnerToken, body: { status: 'completed' } });
  assert.equal(done.data.status, 'completed');
  assert.equal(done.data.bonusUsed, 100);
  assert.equal(done.data.cashDue, 1900);
  const after = (await api('GET', '/api/guest/me', { token: guestToken })).data.balance;
  assert.equal(after, before - 100 + done.data.bonusEarned);
});

test('отзыв оставляет только зарегистрированный участник; оператор модерирует и публикует', async () => {
  const anon = await api('POST', '/api/feedback', { body: { kind: 'review', partnerId, rating: 5, text: 'Отлично!' } });
  assert.equal(anon.status, 401);
  const review = await api('POST', '/api/guest/feedback', { token: guestToken, body: { kind: 'review', partnerId, rating: 5, text: 'Понравилось обслуживание' } });
  assert.equal(review.status, 201);
  const fbId = review.data.id;
  const hidden = await api('PATCH', `/api/admin/feedback/${fbId}`, { token: adminToken, body: { hidden: true, status: 'answered', reply: 'Спасибо!' } });
  assert.equal(hidden.data.hidden, true);
  const pub = await api('GET', `/api/partners/${partnerId}`);
  assert.equal(pub.data.reviews.length, 0);
});

test('сводка взаиморасчётов сходится: сумма чистых обязательств = комиссии − операторские бонусы', async () => {
  const s = (await api('GET', '/api/admin/settlements', { token: adminToken })).data;
  const net = s.partners.reduce((sum, p) => sum + p.netToOperator, 0);
  assert.equal(net, s.feesTotal - s.operatorFunded);
});

test('персональные данные не утекают в публичный каталог и в ответы партнёру', async () => {
  const list = (await api('GET', '/api/partners')).data;
  assert.equal(list.length, 1);
  assert.equal('passwordHash' in list[0], false);
  const me = (await api('GET', '/api/partner/me', { token: partnerToken })).data;
  assert.equal('passwordHash' in me, false);
  assert.equal('terminalKeyHash' in me, false);
  const fb = (await api('GET', '/api/partner/feedback', { token: partnerToken })).data;
  assert.ok(fb.every((f) => !('contact' in f)));
});
