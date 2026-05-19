// api/adjust.js
import { kv } from '@vercel/kv';

export default async function handler(req) {
  const h = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: h });

  if (req.method === 'GET') {
    try {
      const raw = await kv.get('aura_adjustments');
      const adj = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
      return new Response(JSON.stringify(adj), { status: 200, headers: h });
    } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: h }); }
  }

  if (req.method === 'POST') {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) return new Response('Unauthorized', { status: 401 });
    try {
      const { product, amount, reason, type } = await req.json();
      if (!product || !amount || !reason) return new Response(JSON.stringify({ error: 'product, amount en reason verplicht' }), { status: 400, headers: h });
      const raw = await kv.get('aura_adjustments');
      const adj = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
      const entry = { id: Date.now(), product, amount: parseInt(amount), type: type || 'aftrek', reason, timestamp: new Date().toISOString() };
      adj.unshift(entry);
      await kv.set('aura_adjustments', JSON.stringify(adj));
      const dataRaw = await kv.get('aura_dashboard_data');
      if (dataRaw) {
        const data = typeof dataRaw === 'string' ? JSON.parse(dataRaw) : dataRaw;
        if (type === 'toevoeging') { data.inventory[product] = Math.max(0, (data.inventory[product] || 0) + parseInt(amount)); }
        else { data.inventory[product] = Math.max(0, (data.inventory[product] || 0) - parseInt(amount)); }
        data.lastUpdate = new Date().toISOString();
        await kv.set('aura_dashboard_data', JSON.stringify(data));
      }
      return new Response(JSON.stringify({ ok: true, entry }), { status: 200, headers: h });
    } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: h }); }
  }
  return new Response('Method not allowed', { status: 405 });
}
export const config = { runtime: 'edge' };