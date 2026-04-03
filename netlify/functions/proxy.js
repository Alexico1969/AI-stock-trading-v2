// netlify/functions/proxy.js
// Universal Alpaca API proxy — all secrets live here, never in the browser.
// Usage: GET/POST/DELETE /.netlify/functions/proxy?target=<encoded-alpaca-url>

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: '',
    };
  }

  const target = event.queryStringParameters && event.queryStringParameters.target;
  if (!target) {
    return errorResponse(400, 'Missing required parameter: target');
  }

  const apiKey    = process.env.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY;
  if (!apiKey || !secretKey) {
    return errorResponse(500, 'ALPACA_API_KEY / ALPACA_SECRET_KEY not set in environment variables');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(target);
  } catch (e) {
    return errorResponse(400, 'Invalid target URL: ' + e.message);
  }

  // Security: only proxy to official Alpaca domains
  if (!parsedUrl.hostname.endsWith('alpaca.markets')) {
    return errorResponse(403, 'Domain not allowed: ' + parsedUrl.hostname);
  }

  const method = event.httpMethod || 'GET';
  const fetchOptions = {
    method,
    headers: {
      'APCA-API-KEY-ID':     apiKey,
      'APCA-API-SECRET-KEY': secretKey,
      'Content-Type':        'application/json',
      'Accept':              'application/json',
    },
  };

  // Forward request body for POST/PATCH (not for GET/DELETE)
  if (event.body && method !== 'GET' && method !== 'DELETE') {
    fetchOptions.body = event.body;
  }

  try {
    const resp = await fetch(target, fetchOptions);
    const body = await resp.text();

    return {
      statusCode: resp.status,
      headers: {
        ...corsHeaders(),
        'Content-Type': resp.headers.get('content-type') || 'application/json',
      },
      body,
    };
  } catch (e) {
    return errorResponse(502, 'Upstream fetch failed: ' + e.message);
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  };
}

function errorResponse(status, message) {
  return {
    statusCode: status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: message }),
  };
}
