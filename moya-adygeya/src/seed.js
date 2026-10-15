'use strict';

const { randomBytes } = require('node:crypto');
const { hashPassword, sha256 } = require('./auth');
const C = require('./config');
const { PLANS } = require('./ledger');

const now = () => new Date().toISOString();
const id = (p) => `${p}_${randomBytes(4).toString('hex')}`;

function emptyChecklist() {
  const list = {};
  for (const stage of C.ONBOARDING) for (const key of Object.keys(stage.items)) list[key] = false;
  return list;
}

// Демо-партнёры помечены как ДЕМО и создаются только при SEED_DEMO=1. Настоящие заведения вносит оператор.
function demoPartners() {
  const rows = [
    { name: 'ДЕМО: Ресторан у реки', category: 'Рестораны и кафе', status: 'active', stage: 'active', bonusRateBp: 1000, planId: 'quarter' },
    { name: 'ДЕМО: Салон красоты', category: 'Салоны красоты и фитнес', status: 'active', stage: 'active', bonusRateBp: 500, planId: 'year' },
    { name: 'ДЕМО: Гостиница в горах', category: 'Гостиницы и кемпинги', status: 'active', stage: 'active', bonusRateBp: 800, planId: 'half' },
    { name: 'ДЕМО: Магазин (переговоры)', category: 'Магазины и продукты', status: 'onboarding', stage: 'negotiation', bonusRateBp: 500, planId: 'month' },
  ];
  return rows.map((r, i) => {
    const plan = PLANS[r.planId];
    return {
      id: id('p'),
      address: 'Республика Адыгея (демо)',
      phone: '',
      site: '',
      description: 'Демо-карточка для проверки интерфейса. Данные не настоящие.',
      feeBp: plan.feeBp,
      reimbursementBp: 10000,
      checklist: emptyChecklist(),
      login: `demo${i + 1}`,
      passwordHash: hashPassword('demo-pass-123'),
      terminalKeyHash: null,
      createdAt: now(),
      ...r,
    };
  });
}

function buildInitialData({ seedDemo = false } = {}) {
  const partners = seedDemo ? demoPartners() : [];
  return {
    partners,
    guests: [],
    transactions: [],
    settlements: [],
    campaigns: [],
    items: partners.length
      ? [
          { id: id('i'), partnerId: partners[0].id, kind: 'product', title: 'Ужин на двоих (демо)', category: 'Рестораны и кафе', price: 2500, active: true, description: 'Демо-позиция' },
          { id: id('i'), partnerId: partners[1].id, kind: 'service', title: 'Стрижка (демо)', category: 'Салоны красоты и фитнес', price: 1200, active: true, description: 'Демо-услуга' },
        ]
      : [],
    orders: [],
    news: C.NEWS_SEED.map((n) => ({ id: id('n'), ...n, published: true, createdAt: now() })),
    places: [],
    audio: C.AUDIO_SEED.map((a) => ({ id: id('a'), ...a, createdAt: now() })),
    feedback: [],
    admins: [],
    outbox: [],
    meta: { createdAt: now(), segmentRates: C.SEGMENT_RATES },
  };
}

module.exports = { buildInitialData, emptyChecklist, sha256, id, now };
