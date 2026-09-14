'use strict';

const MAX_BODY_BYTES = 100 * 1024;
const DEFAULT_MODEL = 'claude-sonnet-4-5';

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
        reject(new Error('Request too large.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function buildPrompt(summary, businessContext, mode) {
  const context = businessContext && typeof businessContext === 'object' ? businessContext : {};
  return [
    'Write a concise, decision-useful business data narrative.',
    'Use only the supplied statistical summary. Do not invent facts or imply causation.',
    'Mention important trends, concentrations, anomalies, and limitations.',
    `Analysis mode: ${mode === 'compare' ? 'period comparison' : 'single dataset'}.`,
    `Business context: ${JSON.stringify({ description: context.description || '', domain: context.domain || '', expectations: context.expectations || '' })}`,
    `Statistical summary: ${JSON.stringify(summary)}`,
  ].join('\n');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return sendJson(res, 503, { error: 'AI insights are not configured on this deployment.' });
  }
  if (req.headers['content-type'] && !req.headers['content-type'].toLowerCase().includes('application/json')) {
    return sendJson(res, 415, { error: 'Content-Type must be application/json.' });
  }

  try {
    const rawBody = await readBody(req);
    const input = JSON.parse(rawBody || '{}');
    if (!input.summary || typeof input.summary !== 'object') {
      return sendJson(res, 400, { error: 'A statistical summary is required.' });
    }

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
        max_tokens: 900,
        temperature: 0.2,
        messages: [{ role: 'user', content: buildPrompt(input.summary, input.businessContext, input.mode) }],
      }),
    });
    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      console.error('Anthropic request failed:', upstream.status);
      return sendJson(res, 502, { error: 'The AI service could not complete the request.' });
    }
    const text = data && Array.isArray(data.content)
      ? data.content.filter(block => block && block.type === 'text').map(block => block.text).join('\n').trim()
      : '';
    if (!text) return sendJson(res, 502, { error: 'The AI service returned no narrative.' });
    return sendJson(res, 200, { text });
  } catch (error) {
    if (error instanceof SyntaxError) return sendJson(res, 400, { error: 'Request body must be valid JSON.' });
    if (error.message === 'Request too large.') return sendJson(res, 413, { error: error.message });
    console.error('AI insights request failed:', error.message);
    return sendJson(res, 500, { error: 'Unable to process the AI insights request.' });
  }
};
