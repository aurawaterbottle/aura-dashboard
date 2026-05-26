// api/sync.js
import { kv } from '@vercel/kv';

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

const BASE_INVENTORY = { fg: 393, aw: 306, mb: 277, fi: 1215 };

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
const since = new Date(); since.setDate(since.getDate() - 90);
let orders = [], pageInfo = null, hasMore = true;

while (hasMore) {
const params = new URLSearchParams({
status: 'any',
created_at_min: since.toISOString(),
limit: '250',
fields: 'id,order_number,line_items,created_at,financial_status'
});
if (pageInfo) params.set('page_info', pageInfo);

const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?${params}`, {
headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN }
});
if (!res.ok) throw new Error('Shopify API error: ' + res.status);
const data = await res.json();
orders = orders.concat(data.orders);

const link = res.headers.get('Link') || '';
if (link.includes('rel="next"')) {
const m = link.match(/page_info=([^&>]+)[^>]*>; rel="next"/);
pageInfo = m ? m[1] : null; hasMore = !!pageInfo;
} else hasMore = false;
}

const valid = orders.filter(o => o.financial_status !== 'voided' && o.financial_status !== 'refunded');
valid.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

const inventory = { ...BASE_INVENTORY };
const orderList = [];

for (const order of valid) {
const ded = parseDeductions(order.line_items);
inventory.fg = Math.max(0, inventory.fg - ded.fg);
inventory.aw = Math.max(0, inventory.aw - ded.aw);
inventory.mb = Math.max(0, inventory.mb - ded.mb);
inventory.fi = Math.max(0, inventory.fi - ded.fi);

const bundleName = order.line_items
.map(i => i.title + (i.variant_title ? ' - ' + i.variant_title : ''))
.join(' + ');
orderList.push({ orderNumber: order.order_number, bundleName, deductions: ded, timestamp: order.created_at });
}

// Handmatige correcties toepassen bovenop Shopify data
const adjRaw = await kv.get('aura_adjustments');
const adjustments = adjRaw ? (typeof adjRaw === 'string' ? JSON.parse(adjRaw) : adjRaw) : [];
for (const adj of adjustments) {
if (inventory[adj.product] !== undefined) {
if (adj.type === 'toevoeging') {
inventory[adj.product] = Math.max(0, inventory[adj.product] + adj.amount);
} else {
inventory[adj.product] = Math.max(0, inventory[adj.product] - adj.amount);
}
}
}

const payload = {
inventory,
thresholds: { fg: 50, aw: 50, mb: 50, fi: 100 },
orders: orderList.reverse(),
lastUpdate: new Date().toISOString()
};

await kv.set('aura_dashboard_data', JSON.stringify(payload));
return new Response(JSON.stringify({ ok: true, orderCount: valid.length }), {
status: 200, headers: { 'Content-Type': 'application/json' }
});
} catch (err) {
return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
}
}

export const config = { runtime: 'edge' };
