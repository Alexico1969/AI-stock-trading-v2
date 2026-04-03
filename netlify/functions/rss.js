// netlify/functions/rss.js
// Server-side RSS feed fetcher — avoids CORS issues in the browser.
// Usage: GET /.netlify/functions/rss?url=<encoded-feed-url>

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: '',
    };
  }

  const feedUrl = event.queryStringParameters && event.queryStringParameters.url;
  if (!feedUrl) {
    return errorResponse(400, 'Missing required parameter: url');
  }

  try {
    const resp = await fetch(feedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AlpacaTrader/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
    });

    if (!resp.ok) {
      return errorResponse(resp.status, `Feed returned HTTP ${resp.status}`);
    }

    const xml = await resp.text();

    // Extract the channel/feed title
    const feedTitleMatch = xml.match(/<channel[^>]*>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/);
    const feedTitle = feedTitleMatch
      ? cdataStrip(feedTitleMatch[1]).replace(/<[^>]+>/g, '').trim()
      : feedUrl;

    // Extract items
    const items = [];
    const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRegex.exec(xml)) !== null) {
      const content = m[1];
      items.push({
        title:       getTag(content, 'title'),
        description: getTag(content, 'description').slice(0, 300),
        link:        getTag(content, 'link'),
        pubDate:     getTag(content, 'pubDate'),
      });
      if (items.length >= 20) break;
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ feed: { title: feedTitle }, items }),
    };
  } catch (e) {
    return errorResponse(500, 'RSS fetch error: ' + e.message);
  }
};

function getTag(content, tag) {
  const m = content.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!m) return '';
  return cdataStrip(m[1]).replace(/<[^>]+>/g, '').trim();
}

function cdataStrip(str) {
  return str.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}

function errorResponse(status, message) {
  return {
    statusCode: status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: message }),
  };
}
