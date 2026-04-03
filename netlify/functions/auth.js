// netlify/functions/auth.js
// Password gate — compares submitted password against the PSSW environment variable.
// POST /.netlify/functions/auth   body: { "password": "..." }
// Returns: { "ok": true } or { "ok": false }

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'Invalid JSON' }) };
  }

  const expected = process.env.PSSW;
  if (!expected) {
    return { statusCode: 500, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false, error: 'PSSW not configured' }) };
  }

  const ok = body.password === expected;
  return {
    statusCode: ok ? 200 : 401,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok }),
  };
};
