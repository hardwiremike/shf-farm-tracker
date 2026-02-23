// ============================================================
// SHF Manifest Scanner — Cloudflare Worker Proxy
// ============================================================
// SETUP:
// 1. Go to dash.cloudflare.com → Workers & Pages → Create Application → Create Worker
// 2. Name it "shf-manifest-scanner", click Deploy
// 3. Click "Edit Code", delete the default, paste this entire file
// 4. Click Save and Deploy
// 5. Go to Settings → Variables → Add Variable:
//    Name: ANTHROPIC_API_KEY
//    Value: your sk-ant-... key
//    Click "Encrypt", then Save
// 6. Copy your worker URL (e.g. https://shf-manifest-scanner.XXXX.workers.dev)
//    and give it to Claude to put in the app
// ============================================================

const ALLOWED_ORIGINS = [
  'https://hardwiremike.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_TOKENS = 4096;

const EXTRACTION_PROMPT = `You are analyzing a photograph of a California Metrc cannabis transfer manifest. Extract all structured data from this document image and return it as JSON.

IMPORTANT RULES:
1. Return ONLY valid JSON — no markdown fences, no commentary, no explanation.
2. If a field is not visible or not legible, use null for that field.
3. For package UIDs, they always start with "1A4" followed by alphanumeric characters (typically 24 chars total).
4. For harvest IDs, they follow the pattern SHF_XX_XXXXXX (e.g., SHF_PJ_091225). Extract all harvest IDs found in each package's source harvest section.
5. For direction: if the originating entity name contains "Highland Canopy" or "The Highland Canopy" (case-insensitive), the direction is "outbound". If the destination entity contains "Highland Canopy" or "The Highland Canopy", the direction is "inbound". If neither, default to "outbound".
6. For type: map "Bulk Flower" to "Tops", "Bulk Trim" or anything mentioning "Leaf" to "Trim", "Bulk Smalls" to "Smalls". Keep "Fresh Frozen", "Clones", "Seeds", "Tissue Culture" as-is.
7. For nursery detection: if direction is "inbound" AND any package type is "Clones", "Seeds", or "Tissue Culture", set is_nursery to true.
8. Quantity values should be numbers (not strings). Parse "1,234.56" as 1234.56.

Return this exact JSON schema:

{
  "manifest_number": "string or null",
  "date_created": "string in M/D/YYYY or YYYY-MM-DD format, or null",
  "origin_entity": "string or null",
  "destination_entity": "string or null",
  "direction": "inbound or outbound",
  "is_nursery": false,
  "packages": [
    {
      "package_uid": "string starting with 1A4, or null",
      "item_name": "string or null",
      "strain": "string or null",
      "type": "string — one of: Tops, Trim, Smalls, Fresh Frozen, Bucked Tops, Mids, Clones, Seeds, Tissue Culture, or raw text if none match",
      "quantity": 0.0,
      "unit": "lb or ea or g or oz",
      "harvest_ids": []
    }
  ],
  "confidence": "high, medium, or low",
  "notes": "string — any issues like blurry text or missing pages"
}`;

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleCORS(request);
    }

    // Only accept POST
    if (request.method !== 'POST') {
      return jsonResp({ error: 'Method not allowed' }, 405, request);
    }

    // Validate origin
    const origin = request.headers.get('Origin') || '';
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      const body = await request.json();
      const { image_base64, media_type } = body;

      if (!image_base64) {
        return jsonResp({ error: 'Missing image_base64 field' }, 400, request);
      }

      // Check image size (~4/3 ratio for base64)
      const approxMB = (image_base64.length * 3) / 4 / (1024 * 1024);
      if (approxMB > 10) {
        return jsonResp({ error: 'Image too large (' + approxMB.toFixed(1) + 'MB). Compress below 5MB.' }, 413, request);
      }

      // Call Claude Vision API
      const claudeRes = await fetch(CLAUDE_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: MAX_TOKENS,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: media_type || 'image/jpeg',
                  data: image_base64,
                },
              },
              {
                type: 'text',
                text: EXTRACTION_PROMPT,
              },
            ],
          }],
        }),
      });

      if (!claudeRes.ok) {
        const errText = await claudeRes.text();
        console.error('Claude API error:', claudeRes.status, errText);
        return jsonResp({
          error: 'Claude API error',
          status: claudeRes.status,
          detail: errText,
        }, 502, request);
      }

      const claudeResult = await claudeRes.json();

      // Extract text content from Claude's response
      const textContent = claudeResult.content?.find(c => c.type === 'text');
      if (!textContent) {
        return jsonResp({ error: 'No text in Claude response' }, 502, request);
      }

      // Parse JSON (strip markdown fences if Claude included them)
      let parsedData;
      try {
        let jsonText = textContent.text.trim();
        if (jsonText.startsWith('```')) {
          jsonText = jsonText.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
        }
        parsedData = JSON.parse(jsonText);
      } catch (parseErr) {
        return jsonResp({
          error: 'Failed to parse Claude response as JSON',
          raw_response: textContent.text,
        }, 502, request);
      }

      return jsonResp({
        success: true,
        data: parsedData,
        usage: claudeResult.usage,
      }, 200, request);

    } catch (err) {
      console.error('Worker error:', err);
      return jsonResp({ error: 'Internal error: ' + err.message }, 500, request);
    }
  },
};

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function handleCORS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

function jsonResp(obj, status, request) {
  return new Response(JSON.stringify(obj), { status, headers: corsHeaders(request) });
}
