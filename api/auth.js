export default async function handler(req) {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    if (!code) return new Response('no code', { status: 400 });

  const res = await fetch('https://p1faiw-6e.myshopify.com/admin/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
                client_id: process.env.SHOPIFY_CLIENT_ID,
                client_secret: process.env.SHOPIFY_CLIENT_SECRET,
                code
        })
  });
    const data = await res.json();
    return new Response(JSON.stringify(data), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
    });
}

export const config = { runtime: 'edge' };
