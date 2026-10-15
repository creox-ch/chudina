'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/ledger');

const NOW = new Date('2026-06-15T12:00:00Z');

function makeDb() {
  return {
    partners: [
      { id: 'pA', name: 'Партнёр А', status: 'active', bonusRateBp: 500, feeBp: 100 },
      { id: 'pB', name: 'Партнёр Б', status: 'active', bonusRateBp: 1000, feeBp: 100 },
      { id: 'pC', name: 'Лид', status: 'negotiation', bonusRateBp: 500, feeBp: 100 },
    ],
    guests: [],
    transactions: [],
    settlements: [],
    campaigns: [],
    orders: [],
  };
}

function makeGuest(db, id = 'g1', extra = {}) {
  const guest = { id, lots: [], createdAt: NOW.toISOString(), lastActivityAt: NOW.toISOString(), ...extra };
  db.guests.push(guest);
  return guest;
}

test('начисление идёт на полную сумму чека, комиссия оператора 1%', () => {
  const db = makeDb();
  const g = makeGuest(db);
  const res = L.accrue(db, { guest: g, partner: db.partners[0], amount: 1000, now: NOW });
  assert.equal(res.base, 50); // 5% от 1000
  assert.equal(res.bonus, 50);
  assert.equal(res.fee, 10); // 1% от 1000
  assert.equal(L.balanceOf(g), 50);
});

test('округление бонусов вниз до рубля', () => {
  assert.equal(L.bonusFor(999, 500), 49); // 4.995 -> 49
});

test('списание: сначала бонусы партнёра, где покупка, затем FIFO', () => {
  const db = makeDb();
  const g = makeGuest(db);
  L.accrue(db, { guest: g, partner: db.partners[1], amount: 1000, now: new Date('2026-01-01T00:00:00Z') }); // +100 от pB
  L.accrue(db, { guest: g, partner: db.partners[0], amount: 1000, now: new Date('2026-02-01T00:00:00Z') }); // +50 от pA
  const res = L.redeem(db, { guest: g, partner: db.partners[0], bonusAmount: 80, checkAmount: 500, now: NOW });
  const issuers = Object.fromEntries(res.tx.lines.map((l) => [l.issuerId, l.amount]));
  assert.deepEqual(issuers, { pA: 50, pB: 30 }); // сначала 50 от pA (свой партнёр), затем 30 от pB
  assert.equal(L.balanceOf(g), 70);
  assert.equal(res.cashDue, 420);
});

test('списание сверх баланса и сверх суммы чека отклоняется', () => {
  const db = makeDb();
  const g = makeGuest(db);
  L.accrue(db, { guest: g, partner: db.partners[0], amount: 1000, now: NOW });
  assert.throws(() => L.redeem(db, { guest: g, partner: db.partners[0], bonusAmount: 51, checkAmount: 500, now: NOW }), /Недостаточно бонусов/);
  assert.throws(() => L.redeem(db, { guest: g, partner: db.partners[0], bonusAmount: 30, checkAmount: 20, now: NOW }), /бонусы к списанию/);
});

test('неактивный партнёр (лид) не может начислять и списывать', () => {
  const db = makeDb();
  const g = makeGuest(db);
  assert.throws(() => L.accrue(db, { guest: g, partner: db.partners[2], amount: 100, now: NOW }), /не подключён/);
});

test('кампания «первая покупка» срабатывает один раз', () => {
  const db = makeDb();
  db.campaigns.push({ id: 'c1', partnerId: 'pA', active: true, type: 'first_purchase', bonus: 200, condition: {} });
  const g = makeGuest(db);
  const first = L.accrue(db, { guest: g, partner: db.partners[0], amount: 1000, now: NOW });
  const second = L.accrue(db, { guest: g, partner: db.partners[0], amount: 1000, now: NOW });
  assert.equal(first.extra, 200);
  assert.equal(second.extra, 0);
});

test('кампания «n-я покупка в месяце» срабатывает ровно на n-й покупке', () => {
  const db = makeDb();
  db.campaigns.push({ id: 'c2', partnerId: 'pA', active: true, type: 'frequency', bonus: 100, condition: { threshold: 3 } });
  const g = makeGuest(db);
  const results = [1, 2, 3, 4].map(() => L.accrue(db, { guest: g, partner: db.partners[0], amount: 100, now: NOW }).extra);
  assert.deepEqual(results, [0, 0, 100, 0]);
});

test('кампания «день рождения» работает в окне ±N дней', () => {
  const db = makeDb();
  db.campaigns.push({ id: 'c3', partnerId: 'pA', active: true, type: 'birthday', bonus: 300, condition: { days: 7 } });
  const near = makeGuest(db, 'gb', { birthDate: '1990-06-18' });
  const far = makeGuest(db, 'gf', { birthDate: '1990-09-01' });
  assert.equal(L.accrue(db, { guest: near, partner: db.partners[0], amount: 100, now: NOW }).extra, 300);
  assert.equal(L.accrue(db, { guest: far, partner: db.partners[0], amount: 100, now: NOW }).extra, 0);
});

test('продажа со списанием: начисление на полный чек, часть оплачена бонусами', () => {
  const db = makeDb();
  const g = makeGuest(db);
  L.accrue(db, { guest: g, partner: db.partners[1], amount: 1000, now: NOW }); // +100 у pB
  const res = L.sale(db, { guest: g, partner: db.partners[0], checkAmount: 800, bonusAmount: 100, now: NOW });
  assert.equal(res.bonusUsed, 100);
  assert.equal(res.cashDue, 700);
  assert.equal(res.bonusEarned, 40); // 5% от полного чека 800
  assert.equal(L.balanceOf(g), 40);
});

test('взаиморасчёты: при возмещении 100% сумма чистых обязательств = комиссии − операторские бонусы', () => {
  const db = makeDb();
  const g = makeGuest(db);
  const h = makeGuest(db, 'g2');
  L.accrue(db, { guest: g, partner: db.partners[0], amount: 2000, now: NOW });
  L.accrue(db, { guest: g, partner: db.partners[1], amount: 3000, now: NOW });
  L.redeem(db, { guest: g, partner: db.partners[1], bonusAmount: 150, checkAmount: 900, now: NOW });
  L.redeem(db, { guest: g, partner: db.partners[0], bonusAmount: 40, checkAmount: 400, now: NOW });
  h.lots.push({ id: 'op1', partnerId: L.OPERATOR, remaining: 25, createdAt: NOW.toISOString() });
  L.redeem(db, { guest: h, partner: db.partners[0], bonusAmount: 25, checkAmount: 200, now: NOW });
  const s = L.settlementSummary(db);
  const net = s.partners.reduce((sum, p) => sum + p.netToOperator, 0);
  assert.equal(net, s.feesTotal - s.operatorFunded);
});

test('партнёр с возмещением 97,5% оставляет оператору маржу', () => {
  const db = makeDb();
  db.partners[1].reimbursementBp = 9750;
  const g = makeGuest(db);
  L.accrue(db, { guest: g, partner: db.partners[0], amount: 1000, now: NOW });
  const res = L.redeem(db, { guest: g, partner: db.partners[1], bonusAmount: 40, checkAmount: 200, now: NOW });
  assert.equal(res.reimbursement, 39); // 97,5% от 40, округлено вниз
});

test('заказ: новый → подтверждён → выполнен, бонусы списываются только при выполнении', () => {
  const db = makeDb();
  const g = makeGuest(db);
  L.accrue(db, { guest: g, partner: db.partners[0], amount: 1000, now: NOW }); // 50 бонусов
  const order = L.createOrder(db, {
    guest: g,
    partner: db.partners[0],
    lines: [{ itemId: 'i1', title: 'Тур', price: 600, qty: 2 }],
    bonusRequested: 80,
    now: NOW,
  });
  assert.equal(order.total, 1200);
  assert.equal(order.bonusReserved, 50); // ограничено балансом
  assert.equal(L.balanceOf(g), 50); // ещё не списано
  L.transitionOrder(db, order, db.partners[0], g, 'confirmed', NOW);
  L.transitionOrder(db, order, db.partners[0], g, 'completed', NOW);
  assert.equal(order.status, 'completed');
  assert.equal(order.bonusUsed, 50);
  assert.equal(order.cashDue, 1150);
  assert.throws(() => L.transitionOrder(db, order, db.partners[0], g, 'cancelled', NOW), /Нельзя перевести/);
});

test('реферальный бонус начисляется один раз — после первой завершённой покупки реферала', () => {
  const db = makeDb();
  const referrer = makeGuest(db, 'ref');
  const friend = makeGuest(db, 'friend', { referredBy: 'ref' });
  const order = L.createOrder(db, { guest: friend, partner: db.partners[0], lines: [{ itemId: 'i', title: 'x', price: 300, qty: 1 }], now: NOW });
  assert.equal(L.balanceOf(referrer), 0);
  L.transitionOrder(db, order, db.partners[0], friend, 'confirmed', NOW);
  L.transitionOrder(db, order, db.partners[0], friend, 'completed', NOW);
  assert.equal(L.balanceOf(referrer), L.REFERRAL_BONUS);
  const order2 = L.createOrder(db, { guest: friend, partner: db.partners[0], lines: [{ itemId: 'i', title: 'x', price: 300, qty: 1 }], now: NOW });
  L.transitionOrder(db, order2, db.partners[0], friend, 'confirmed', NOW);
  L.transitionOrder(db, order2, db.partners[0], friend, 'completed', NOW);
  assert.equal(L.balanceOf(referrer), L.REFERRAL_BONUS);
});

test('бонусы неактивных более года аннулируются', () => {
  const db = makeDb();
  const old = makeGuest(db, 'old', { lastActivityAt: '2024-01-01T00:00:00Z' });
  old.lots.push({ id: 'l', partnerId: 'pA', remaining: 120, createdAt: '2024-01-01T00:00:00Z' });
  const fresh = makeGuest(db, 'fresh');
  fresh.lots.push({ id: 'l2', partnerId: 'pA', remaining: 40, createdAt: NOW.toISOString() });
  const expired = L.expireInactive(db, NOW);
  assert.equal(expired, 120);
  assert.equal(L.balanceOf(old), 0);
  assert.equal(L.balanceOf(fresh), 40);
});

test('пакетная скидка абонентской платы: 3 партнёра −10%, 4+ партнёров −20%', () => {
  assert.equal(L.quoteSubscription('quarter', { partnersInContract: 1 }).total, 7500);
  assert.equal(L.quoteSubscription('quarter', { partnersInContract: 3 }).total, 6750);
  assert.equal(L.quoteSubscription('quarter', { partnersInContract: 4 }).total, 6000);
});
