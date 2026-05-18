// api/data.js — publiek endpoint dat het dashboard aanroept
import { kv } from '@vercel/kv';

export default async function handler(req) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
  };
  try {
    const raw = await kv.get('aura_dashboard_data');
    if (!raw) {
      return new Response(JSON.stringify({ error: 'Nog geen data beschikbaar.' }), { status: 404, headers });
    }
    const data = typeof raw === 'string' ? raw : JSON.stringify(raw);
    return new Response(data, { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
}

export const config = { runtime: 'edge' };