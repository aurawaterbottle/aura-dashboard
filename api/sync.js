// api/sync.js — Vercel Cron Function (elke 15 minuten)
import { kv } from '@vercel/kv';

const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

const BASE_INVENTORY = { fg: 393, aw: 306, mb: 277, fi: 1215 };

function parseDeductions(lineItems) {
  const d = { fg: 0, aw: 0, mb: 0, fi: 0 };
  for (const item of lineItems) {
    const t = (item.title + ' ' + (item.variant_title || '')).toLowerCase();
    const qty = item.quantity;
    const isFG = t.includes('forest green') || t.includes(' fg');
    const isAW = t.includes('arctic white') || t.includes(' aw');
    const isMB = t.includes('midnight black') || t.includes(' mb');
    const isLooseFles = t.includes('losse fles');
    const isLooseFilter = t.includes('losse filter') || t.includes('3-pack filter');
    const isStarter = t.includes('starter pack') || t.includes('starter & stasher');
    const isCouple = t.includes('couple pack');
    const isFamily = t.includes('family pack');
    const isStasher = t.includes('stasher');
    const isFilter1Jaar = t.includes('filter 1 jaar') || t.includes('1 jaar');
    if (isLooseFles) {
      if (isFG) d.fg += qty; if (isAW) d.aw += qty; if (isMB) d.mb += qty;
    } else if (isLooseFilter) {
      d.fi += qty * 3;
    } else if (isFamily) {
      d.fg += qty; d.aw += qty * 2; d.mb += qty; d.fi += qty * 4;
    } else if (isCouple) {
      if (isFG && isMB) { d.fg += qty; d.mb += qty; }
      else if (isFG) { d.fg += qty * 2; }
      else if (isAW && isMB) { d.aw += qty; d.mb += qty; }
      else if (isAW) { d.aw += qty * 2; }
      else if (isMB) { d.mb += qty * 2; }
      else { d.fg += qty; d.mb += qty; }
      d.fi += qty * 2;
      if (isFilter1Jaar) d.fi += qty * 2;
    } else if (isStarter) {
      if (isFG) d.fg += qty; if (isAW) d.aw += qty; if (isMB) d.mb += qty;
      d.fi += qty * (isStasher ? 3 : 1);
    }
  }
  return d;
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
      const params = new URLSearchParams({ status: 'any', created_at_min: since.toISOString(), limit: '250', fields: 'id,order_number,name,line_items,created_at,financial_status' });
      if (pageInfo) params.set('page_info', pageInfo);
      const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?${params}`, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN } });
      if (!res.ok) throw new Error('Shopify API error: ' + res.status);
      const data = await res.json();
      orders = orders.concat(data.orders);
      const link = res.headers.get('Link');
      if (link && link.includes('rel="next"')) { const m = link.match(/page_info=([^&>]+).*rel="next"/); pageInfo = m ? m[1] : null; hasMore = !!pageInfo; }
      else hasMore = false;
    }
    const valid = orders.filter(o => o.financial_status !== 'voided' && o.financial_status !== 'refunded');
    valid.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const inventory = { ...BASE_INVENTORY };
    const orderList = [];
    for (const order of valid) {
      const ded = parseDeductions(order.line_items);
      inventory.fg -= ded.fg; inventory.aw -= ded.aw; inventory.mb -= ded.mb; inventory.fi -= ded.fi;
      const bundleName = order.line_items.map(i => i.title + (i.variant_title ? ' - ' + i.variant_title : '')).join(' + ');
      orderList.push({ orderNumber: order.order_number, bundleName, deductions: ded, timestamp: order.created_at });
    }
    for (const k of Object.keys(inventory)) inventory[k] = Math.max(0, inventory[k]);
    const payload = { inventory, thresholds: { fg: 50, aw: 50, mb: 50, fi: 100 }, orders: orderList.reverse(), lastUpdate: new Date().toISOString() };
    await kv.set('aura_dashboard_data', JSON.stringify(payload));
    return new Response(JSON.stringify({ ok: true, orderCount: valid.length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

export const config = { runtime: 'edge' };