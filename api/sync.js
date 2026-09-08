// api/sync.js
import { kv } from '@vercel/kv';

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// === Voorraad-ijkpunt ========================================================
// BASE_INVENTORY = de voorraad zoals FYSIEK geteld op INVENTORY_ANCHOR_DATE.
// Alle Shopify-orders vanaf dat moment worden hiervan afgetrokken.
//
// Deze sync houdt een LOPENDE administratie bij in KV (key: aura_ledger).
// Elke order wordt precies EEN keer geteld en blijft geteld - ook nadat hij
// buiten Shopify's 60-dagen-venster is gevallen. Daardoor kan de voorraad niet
// meer stilzwijgend "omhoog kruipen" zoals met het oude rollende venster.
//
// NA EEN NIEUWE FYSIEKE TELLING:
//   1. pas de 4 getallen in BASE_INVENTORY aan naar de getelde voorraad
//   2. zet INVENTORY_ANCHOR_DATE op het moment van die telling
//      (formaat: 'JJJJ-MM-DDTHH:MM:SS+02:00', bv '2026-11-15T18:00:00+01:00')
//   3. committen -> de eerstvolgende sync gooit de administratie weg en bouwt
//      hem automatisch opnieuw op vanaf dit nieuwe ijkpunt.
const BASE_INVENTORY = { fg: 393, aw: 306, mb: 277, fi: 1215 };
const INVENTORY_ANCHOR_DATE = process.env.INVENTORY_ANCHOR_DATE || '2026-05-18T00:00:00+02:00';

const LEDGER_KEY = 'aura_ledger';
const MAX_DISPLAY_ORDERS = 250; // hoeveel orders het dashboard toont (admin bewaart alles)
// ============================================================================

function getColorFromText(text) {
const t = text.toLowerCase();
if (t.includes('forest green') || t.includes('- fg') || t.includes('/ fg')) return 'fg';
if (t.includes('arctic white') || t.includes('- aw') || t.includes('/ aw')) return 'aw';
if (t.includes('midnight black') || t.includes('- mb') || t.includes('/ mb')) return 'mb';
return null;
}

function parseDeductions(lineItems) {
const d = { fg: 0, aw: 0, mb: 0, fi: 0 };

for (const item of lineItems) {
const title = item.title || '';
const variant = item.variant_title || '';
const full = (title + ' ' + variant).toLowerCase();
const qty = item.quantity || 1;
const props = item.properties || [];

// --- FILTERS ---
if (full.includes('filter voorraad') || full.includes('filtervoorraad')) {
if (full.includes('3 jaar')) { d.fi += qty * 6; continue; }
if (full.includes('2 jaar')) { d.fi += qty * 4; continue; }
if (full.includes('1 jaar')) { d.fi += qty * 2; continue; }
}
if (full.includes('3-pack') || full.includes('3 pack') || full.includes('filters (3')) {
d.fi += qty * 1; continue;
}

// --- LOSSE FLES ---
if (full.includes('water bottle') || full.includes('losse fles') || (full.includes('aura') && !full.includes('pack') && !full.includes('filter'))) {
const color = getColorFromText(full) || getColorFromText(variant);
if (color) { d[color] += qty; }
continue;
}

// --- FAMILY PACK --- (kleuren via properties)
if (full.includes('family pack')) {
const colorProps = props.filter(p => p.name && (p.name.toLowerCase().includes('kleur') || p.name.toLowerCase().includes('color') || p.name.toLowerCase().includes('image-swatches')));
if (colorProps.length > 0) {
for (const cp of colorProps) {
const c = getColorFromText(cp.value || '');
if (c) d[c] += qty;
}
} else {
// Fallback: standaard family pack mix
d.fg += qty; d.aw += qty * 2; d.mb += qty;
}
d.fi += qty * 4;
continue;
}

// --- COUPLE & STASHER PACK --- (2 flessen + 6 filters)
if (full.includes('couple') && full.includes('stasher')) {
const colors = extractCoupleColors(full);
colors.forEach(c => { if (d[c] !== undefined) d[c] += qty; });
d.fi += qty * 6;
continue;
}

// --- STARTER & STASHER PACK --- (1 fles + 3 filters)
if (full.includes('starter') && full.includes('stasher')) {
const color = getColorFromText(full) || getColorFromText(variant);
if (color) d[color] += qty;
d.fi += qty * 3;
continue;
}

// --- COUPLE PACK --- (2 flessen + 2 filters)
if (full.includes('couple pack')) {
const colors = extractCoupleColors(full);
colors.forEach(c => { if (d[c] !== undefined) d[c] += qty; });
d.fi += qty * 2;
continue;
}

// --- STARTER PACK --- (1 fles + 1 filter)
if (full.includes('starter pack')) {
const color = getColorFromText(full) || getColorFromText(variant);
if (color) d[color] += qty;
d.fi += qty * 1;
continue;
}
}

return d;
}

function extractCoupleColors(text) {
// "forest green / arctic white" -> ['fg', 'aw']
const colors = [];
const parts = text.split('/');
for (const part of parts) {
const c = getColorFromText(part);
if (c) colors.push(c);
}
// Als we 2 kleuren gevonden hebben, return ze
if (colors.length >= 2) return colors.slice(0, 2);
// Als maar 1 kleur (bijv "forest green / forest green"), gebruik 2x dezelfde
if (colors.length === 1) return [colors[0], colors[0]];
return ['fg', 'mb']; // fallback
}

export default async function handler(req) {
const authHeader = req.headers.get('authorization');
if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
return new Response('Unauthorized', { status: 401 });
}
try {
const anchor = new Date(INVENTORY_ANCHOR_DATE);
if (isNaN(anchor.getTime())) throw new Error('Ongeldige INVENTORY_ANCHOR_DATE: ' + INVENTORY_ANCHOR_DATE);

// --- Lopende administratie laden (of opnieuw opbouwen bij nieuw ijkpunt) ---
const ledgerRaw = await kv.get(LEDGER_KEY);
let ledger = ledgerRaw ? (typeof ledgerRaw === 'string' ? JSON.parse(ledgerRaw) : ledgerRaw) : null;
const anchorChanged = !ledger
|| ledger.anchorDate !== INVENTORY_ANCHOR_DATE
|| JSON.stringify(ledger.anchorInventory) !== JSON.stringify(BASE_INVENTORY);
if (anchorChanged) {
ledger = { anchorDate: INVENTORY_ANCHOR_DATE, anchorInventory: { ...BASE_INVENTORY }, orders: {} };
}
if (!ledger.orders) ledger.orders = {};

// --- Orders bij Shopify ophalen ---
// We vragen ruim 90 dagen op; zonder de read_all_orders-scope geeft Shopify
// er hooguit ~60 terug. Dat is genoeg: alles ouder staat al in de administratie.
const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
let fetched = [], pageInfo = null, hasMore = true;

while (hasMore) {
// Shopify staat op vervolgpagina's (page_info) geen andere filters toe
// dan limit/fields — anders 400. Daarom alleen op de 1e pagina filteren.
const params = new URLSearchParams({
limit: '250',
fields: 'id,order_number,line_items,created_at,financial_status'
});
if (pageInfo) {
params.set('page_info', pageInfo);
} else {
params.set('status', 'any');
params.set('created_at_min', since.toISOString());
}

const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?${params}`, {
headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
});
if (!res.ok) throw new Error('Shopify API error: ' + res.status);
const data = await res.json();
fetched = fetched.concat(data.orders || []);

const link = res.headers.get('Link') || '';
if (link.includes('rel="next"')) {
const m = link.match(/page_info=([^&>]+)[^>]*>; rel="next"/);
pageInfo = m ? m[1] : null; hasMore = !!pageInfo;
} else hasMore = false;
}

// --- Elke opgehaalde order 1x in de administratie zetten / bijwerken ---
// Zolang een order binnen Shopify's venster valt wordt hij elke sync opnieuw
// beoordeeld (zo worden latere refunds/annuleringen alsnog verwerkt). Valt hij
// buiten het venster, dan blijft de laatst bekende stand staan.
let newOrders = 0;
for (const order of fetched) {
const created = new Date(order.created_at);
if (isNaN(created.getTime()) || created < anchor) continue; // vóór het ijkpunt: telt niet mee
const id = String(order.id);
const ded = parseDeductions(order.line_items || []);
const bundleName = (order.line_items || [])
.map(i => i.title + (i.variant_title ? ' - ' + i.variant_title : ''))
.join(' + ');
if (!ledger.orders[id]) newOrders++;
ledger.orders[id] = {
n: order.order_number,
t: order.created_at,
b: bundleName,
d: ded,
void: order.financial_status === 'voided' || order.financial_status === 'refunded'
};
}

// --- Voorraad = ijkpunt minus som van alle (niet-geannuleerde) order-deducties ---
const inventory = { ...ledger.anchorInventory };
for (const id in ledger.orders) {
const o = ledger.orders[id];
if (o.void || !o.d) continue;
inventory.fg -= (o.d.fg || 0);
inventory.aw -= (o.d.aw || 0);
inventory.mb -= (o.d.mb || 0);
inventory.fi -= (o.d.fi || 0);
}

// --- Handmatige correcties toepassen bovenop Shopify data ---
const adjRaw = await kv.get('aura_adjustments');
const adjustments = adjRaw ? (typeof adjRaw === 'string' ? JSON.parse(adjRaw) : adjRaw) : [];
for (const adj of adjustments) {
if (inventory[adj.product] !== undefined) {
if (adj.type === 'toevoeging') {
inventory[adj.product] = inventory[adj.product] + adj.amount;
} else {
inventory[adj.product] = inventory[adj.product] - adj.amount;
}
}
}

for (const k of ['fg', 'aw', 'mb', 'fi']) inventory[k] = Math.max(0, Math.round(inventory[k]));

// --- Orderlijst voor het dashboard (nieuwste eerst, gecapt) ---
const orderList = Object.values(ledger.orders)
.sort((a, b) => new Date(b.t) - new Date(a.t))
.slice(0, MAX_DISPLAY_ORDERS)
.map(o => ({ orderNumber: o.n, bundleName: o.b, deductions: o.d, timestamp: o.t }));

const payload = {
inventory,
thresholds: { fg: 50, aw: 50, mb: 50, fi: 100 },
orders: orderList,
lastUpdate: new Date().toISOString()
};

await kv.set(LEDGER_KEY, JSON.stringify(ledger));
await kv.set('aura_dashboard_data', JSON.stringify(payload));
return new Response(JSON.stringify({
ok: true,
rebuilt: anchorChanged,
newOrders,
ordersInLedger: Object.keys(ledger.orders).length
}), {
status: 200, headers: { 'Content-Type': 'application/json' }
});
} catch (err) {
return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
}
}

export const config = { runtime: 'edge' };
