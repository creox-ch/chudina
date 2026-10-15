'use strict';

// Бизнес-правила «Моя Адыгея». Все суммы — целые рубли, 1 бонус = 1 ₽ скидки (Правила 5.17).
// Ставки хранятся в базисных пунктах: 100 bp = 1%.

const { randomUUID } = require('node:crypto');

const BP = 10000;
const OPERATOR = 'OPERATOR';
const INACTIVITY_DAYS = 365; // Правила 2.11: бонусы могут быть аннулированы через год без использования карты
const REFERRAL_BONUS = 100; // акция «Приведи друга», оплачивает оператор (презентация 04f38896: реферальные акции)

// Тарифы из презентаций (9bd47266 / cc07d3b3, слайд «Стоимость участия»).
// Допущение: значения для периодов — сумма за весь период, а не за месяц. Проверить с оператором.
const PLANS = {
  month: { id: 'month', title: '1 месяц', months: 1, catalogFee: 1000, loyaltyFee: 2000, feeBp: 100 },
  quarter: { id: 'quarter', title: '3 месяца', months: 3, catalogFee: 2500, loyaltyFee: 5000, feeBp: 100 },
  half: { id: 'half', title: '6 месяцев', months: 6, catalogFee: 4500, loyaltyFee: 10000, feeBp: 80 },
  year: { id: 'year', title: '12 месяцев', months: 12, catalogFee: 8000, loyaltyFee: 15000, feeBp: 50 },
};

class LedgerError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'LedgerError';
    this.status = status;
  }
}

const uid = (prefix) => `${prefix}_${randomUUID().slice(0, 8)}`;
const bonusFor = (amount, bp) => Math.floor((amount * bp) / BP);

function requireInt(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new LedgerError(`Некорректное значение: ${name}`);
  }
  return value;
}

function requireActivePartner(partner) {
  if (!partner || partner.status !== 'active') {
    throw new LedgerError('Партнёр не подключён к программе', 409);
  }
  return partner;
}

function balanceOf(guest) {
  return guest.lots.reduce((sum, lot) => sum + lot.remaining, 0);
}

function addSettlement(db, row) {
  db.settlements.push({ id: uid('stl'), createdAt: new Date().toISOString(), ...row });
}

// Абонентская плата: скидка за пакет партнёров (презентация: 3 партнёра −10%, 4–10 партнёров −20%).
function packDiscountBp(partnersInContract) {
  if (partnersInContract >= 4) return 2000;
  if (partnersInContract >= 3) return 1000;
  return 0;
}

function quoteSubscription(planId, { partnersInContract = 1, catalog = true, loyalty = true } = {}) {
  const plan = PLANS[planId];
  if (!plan) throw new LedgerError('Неизвестный тариф');
  const base = (catalog ? plan.catalogFee : 0) + (loyalty ? plan.loyaltyFee : 0);
  const discountBp = packDiscountBp(partnersInContract);
  const total = base - bonusFor(base, discountBp);
  return { plan, base, discountBp, total, feeBp: loyalty ? plan.feeBp : 0 };
}

// Условия кампаний из таблицы «Возможные механики по сегментам» (b0101274).
// Поддержанные типы: product, avg_check, first_purchase, frequency, birthday, weekday.
function campaignMatches(c, guest, partner, ctx, priorTx, monthCount) {
  const cond = c.condition || {};
  switch (c.type) {
    case 'product':
      return ctx.items.some((i) => i.itemId === cond.itemId);
    case 'avg_check':
      return ctx.amount >= cond.threshold;
    case 'first_purchase':
      return priorTx.length === 0;
    case 'frequency':
      return monthCount + 1 === cond.threshold; // награда за n-ю покупку в месяце
    case 'birthday': {
      if (!guest.birthDate) return false;
      const [, m, d] = guest.birthDate.split('-').map(Number);
      const bday = new Date(Date.UTC(ctx.now.getUTCFullYear(), m - 1, d));
      const diffDays = Math.abs(Math.round((ctx.now - bday) / 86400000));
      return diffDays <= (cond.days ?? 7);
    }
    case 'weekday':
      return (cond.days || []).includes(ctx.now.getUTCDay());
    default:
      return false;
  }
}

function matchCampaigns(db, guest, partner, ctx) {
  const priorTx = db.transactions.filter(
    (t) => t.type === 'accrual' && t.guestId === guest.id && t.partnerId === partner.id,
  );
  const monthKey = ctx.now.toISOString().slice(0, 7);
  const monthCount = priorTx.filter((t) => t.createdAt.slice(0, 7) === monthKey).length;
  return db.campaigns.filter(
    (c) => c.partnerId === partner.id && c.active && campaignMatches(c, guest, partner, ctx, priorTx, monthCount),
  );
}

// Начисление на полную сумму покупки (Правила 5.2, 5.15): скидка от бонусов базу не уменьшает.
function accrue(db, { guest, partner, amount, items = [], now = new Date() }) {
  requireActivePartner(partner);
  requireInt(amount, 1, 10_000_000, 'сумма покупки');
  const campaigns = matchCampaigns(db, guest, partner, { amount, items, now });
  const base = bonusFor(amount, partner.bonusRateBp);
  const extra = campaigns.reduce((sum, c) => sum + c.bonus, 0);
  const bonus = base + extra;
  const fee = bonusFor(amount, partner.feeBp);
  const tx = {
    id: uid('tx'),
    type: 'accrual',
    guestId: guest.id,
    partnerId: partner.id,
    checkAmount: amount,
    bonus,
    base,
    extra,
    fee,
    campaignIds: campaigns.map((c) => c.id),
    items: items.map((i) => ({ itemId: i.itemId, qty: i.qty, price: i.price })),
    createdAt: now.toISOString(),
  };
  db.transactions.push(tx);
  if (bonus > 0) {
    guest.lots.push({ id: uid('lot'), partnerId: partner.id, remaining: bonus, createdAt: tx.createdAt, txId: tx.id });
  }
  if (fee > 0) addSettlement(db, { txId: tx.id, partnerId: partner.id, kind: 'fee', amount: fee });
  guest.lastActivityAt = tx.createdAt;
  return { tx, base, extra, bonus, fee, campaigns: tx.campaignIds };
}

// Списание: сначала бонусы партнёра, где совершена покупка (Правила 6.13), далее FIFO.
function redeem(db, { guest, partner, bonusAmount, checkAmount, now = new Date() }) {
  requireActivePartner(partner);
  requireInt(checkAmount, 1, 10_000_000, 'сумма покупки');
  requireInt(bonusAmount, 1, checkAmount, 'бонусы к списанию');
  if (bonusAmount > balanceOf(guest)) throw new LedgerError('Недостаточно бонусов', 409);

  const ordered = guest.lots
    .filter((l) => l.remaining > 0)
    .sort(
      (a, b) =>
        (a.partnerId === partner.id ? 0 : 1) - (b.partnerId === partner.id ? 0 : 1) ||
        a.createdAt.localeCompare(b.createdAt),
    );
  const issued = new Map();
  let need = bonusAmount;
  for (const lot of ordered) {
    if (need === 0) break;
    const take = Math.min(lot.remaining, need);
    lot.remaining -= take;
    need -= take;
    issued.set(lot.partnerId, (issued.get(lot.partnerId) || 0) + take);
  }
  const lines = [...issued].map(([issuerId, amount]) => ({ issuerId, amount }));
  const reimbursement = bonusFor(bonusAmount, partner.reimbursementBp ?? BP);
  const tx = {
    id: uid('tx'),
    type: 'redeem',
    guestId: guest.id,
    partnerId: partner.id,
    checkAmount,
    bonus: bonusAmount,
    reimbursement,
    lines,
    createdAt: now.toISOString(),
  };
  db.transactions.push(tx);
  for (const line of lines) {
    addSettlement(db, {
      txId: tx.id,
      partnerId: line.issuerId,
      kind: line.issuerId === OPERATOR ? 'operator_funded' : 'bonus_issued',
      amount: line.amount,
    });
  }
  addSettlement(db, { txId: tx.id, partnerId: partner.id, kind: 'bonus_accepted', amount: reimbursement });
  guest.lastActivityAt = tx.createdAt;
  return { tx, used: bonusAmount, cashDue: checkAmount - bonusAmount, reimbursement };
}

// Полная продажа на терминале или в заказе: списание части, начисление на весь чек.
function sale(db, { guest, partner, checkAmount, bonusAmount = 0, items = [], now = new Date() }) {
  requireActivePartner(partner);
  requireInt(checkAmount, 1, 10_000_000, 'сумма покупки');
  requireInt(bonusAmount, 0, checkAmount, 'бонусы к списанию');
  if (bonusAmount > balanceOf(guest)) throw new LedgerError('Недостаточно бонусов', 409);
  const redemption = bonusAmount > 0 ? redeem(db, { guest, partner, bonusAmount, checkAmount, now }) : null;
  const accrual = accrue(db, { guest, partner, amount: checkAmount, items, now });
  return {
    checkAmount,
    bonusUsed: bonusAmount,
    cashDue: checkAmount - bonusAmount,
    bonusEarned: accrual.bonus,
    fee: accrual.fee,
    campaigns: accrual.campaigns,
    redemptionTxId: redemption ? redemption.tx.id : null,
    accrualTxId: accrual.tx.id,
  };
}

const ORDER_TRANSITIONS = {
  new: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

function createOrder(db, { guest, partner, lines, bonusRequested = 0, bookingAt = null, now = new Date() }) {
  requireActivePartner(partner);
  if (!lines.length) throw new LedgerError('Пустой заказ');
  const total = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
  requireInt(total, 1, 10_000_000, 'сумма заказа');
  requireInt(bonusRequested, 0, total, 'бонусы к списанию');
  const order = {
    id: uid('ord'),
    guestId: guest.id,
    partnerId: partner.id,
    lines: lines.map((l) => ({ itemId: l.itemId, title: l.title, price: l.price, qty: l.qty })),
    total,
    bonusReserved: Math.min(bonusRequested, balanceOf(guest)),
    bookingAt,
    status: 'new',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  db.orders.push(order);
  return order;
}

function transitionOrder(db, order, partner, guest, nextStatus, now = new Date()) {
  if (!(ORDER_TRANSITIONS[order.status] || []).includes(nextStatus)) {
    throw new LedgerError(`Нельзя перевести заказ из «${order.status}» в «${nextStatus}»`, 409);
  }
  if (nextStatus === 'completed') {
    const bonusAmount = Math.min(order.bonusReserved, balanceOf(guest));
    const result = sale(db, {
      guest,
      partner,
      checkAmount: order.total,
      bonusAmount,
      items: order.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, price: l.price })),
      now,
    });
    Object.assign(order, { bonusUsed: result.bonusUsed, cashDue: result.cashDue, bonusEarned: result.bonusEarned });
    rewardReferrerIfEligible(db, guest, now);
  }
  order.status = nextStatus;
  order.updatedAt = now.toISOString();
  return order;
}

// Реферальный бонус начисляется один раз — после первой завершённой покупки реферала (защита от фейковых регистраций).
function rewardReferrerIfEligible(db, guest, now = new Date()) {
  if (!guest.referredBy || guest.referralRewarded) return null;
  const referrer = db.guests.find((g) => g.id === guest.referredBy);
  guest.referralRewarded = true;
  if (!referrer) return null;
  referrer.lots.push({
    id: uid('lot'),
    partnerId: OPERATOR,
    remaining: REFERRAL_BONUS,
    createdAt: now.toISOString(),
    source: 'referral',
  });
  const tx = {
    id: uid('tx'),
    type: 'referral',
    guestId: referrer.id,
    partnerId: OPERATOR,
    bonus: REFERRAL_BONUS,
    createdAt: now.toISOString(),
  };
  db.transactions.push(tx);
  addSettlement(db, { txId: tx.id, partnerId: OPERATOR, kind: 'operator_funded', amount: REFERRAL_BONUS });
  return tx;
}

// Аннулирование бонусов неактивных участников (Правила 2.11).
function expireInactive(db, now = new Date()) {
  const cutoff = now.getTime() - INACTIVITY_DAYS * 86400000;
  let expired = 0;
  for (const guest of db.guests) {
    const last = Date.parse(guest.lastActivityAt || guest.createdAt);
    if (last >= cutoff) continue;
    const amount = balanceOf(guest);
    if (amount === 0) continue;
    guest.lots = [];
    expired += amount;
    db.transactions.push({
      id: uid('tx'),
      type: 'expiry',
      guestId: guest.id,
      partnerId: OPERATOR,
      bonus: -amount,
      createdAt: now.toISOString(),
    });
  }
  return expired;
}

// Взаиморасчёты: партнёр платит оператору начисленные (выпущенные) бонусы и комиссию,
// оператор возмещает партнёру принятые к оплате бонусы.
function settlementSummary(db) {
  const rows = new Map();
  const row = (id) => {
    if (!rows.has(id)) rows.set(id, { partnerId: id, issued: 0, fees: 0, accepted: 0 });
    return rows.get(id);
  };
  let operatorFunded = 0;
  for (const s of db.settlements) {
    if (s.kind === 'operator_funded') {
      operatorFunded += s.amount;
      continue;
    }
    const r = row(s.partnerId);
    if (s.kind === 'bonus_issued') r.issued += s.amount;
    if (s.kind === 'fee') r.fees += s.amount;
    if (s.kind === 'bonus_accepted') r.accepted += s.amount;
  }
  const partners = db.partners.map((p) => {
    const r = rows.get(p.id) || { issued: 0, fees: 0, accepted: 0 };
    const liability = db.guests.reduce(
      (sum, g) => sum + g.lots.filter((l) => l.partnerId === p.id).reduce((s, l) => s + l.remaining, 0),
      0,
    );
    return {
      partnerId: p.id,
      name: p.name,
      issued: r.issued,
      fees: r.fees,
      accepted: r.accepted,
      netToOperator: r.issued + r.fees - r.accepted,
      outstandingBonuses: liability,
    };
  });
  return {
    partners,
    operatorFunded,
    feesTotal: partners.reduce((s, p) => s + p.fees, 0),
  };
}

module.exports = {
  BP,
  OPERATOR,
  INACTIVITY_DAYS,
  REFERRAL_BONUS,
  PLANS,
  LedgerError,
  bonusFor,
  balanceOf,
  quoteSubscription,
  accrue,
  redeem,
  sale,
  createOrder,
  transitionOrder,
  expireInactive,
  settlementSummary,
};
