// netlify/functions/generate-checklist.js

// Função auxiliar para resposta JSON
const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

exports.handler = async function (event) {
  console.log("Function invoked with method:", event.httpMethod);
  
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method Not Allowed' });
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error("Missing OPENAI_API_KEY");
    return jsonResponse(500, { error: 'Server is missing OPENAI_API_KEY env var.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (err) {
    console.error("Payload parse error:", err);
    return jsonResponse(400, { error: 'Invalid JSON body.' });
  }

  const {
    flowName, deliveryType, interfaceType, productContext,
    description, businessRules, statesConsidered,
  } = payload;

  if (!description || !description.trim()) {
    return jsonResponse(400, { error: 'Description is required.' });
  }
  if (description.length > 4000 || (businessRules && businessRules.length > 4000)) {
    return jsonResponse(400, {
      error: 'Input too long. Keep description and business rules under 4000 chars each.',
    });
  }

  // Prompt do sistema — TUDO o que a UI mostra vem daqui
  const systemPrompt = `You are a Senior Product Designer reviewing a design handoff to engineering. Your job is to spot gaps a designer is most likely to miss: undefined states, accessibility issues, fuzzy product logic, edge cases, and questions engineers will ask.

Output STRICT JSON with this exact schema (no markdown, no commentary):
{
  "score": 0-100,
  "summary": "One sentence summarising readiness and what to fix next, specific to the input.",
  "categories": [
    {
      "id": "missing-states",
      "title": "Missing states",
      "subtitle": "Short contextual subtitle specific to THIS handoff (max ~10 words)",
      "severity": "high" | "medium" | "low" | "info",
      "items": ["...", "..."]
    },
    {
      "id": "accessibility",
      "title": "Accessibility risks",
      "subtitle": "...",
      "severity": "...",
      "items": ["...", "..."]
    },
    {
      "id": "product-logic",
      "title": "Product logic gaps",
      "subtitle": "...",
      "severity": "...",
      "items": ["...", "..."]
    },
    {
      "id": "edge-cases",
      "title": "Edge cases",
      "subtitle": "...",
      "severity": "...",
      "items": ["...", "..."]
    },
    {
      "id": "developer-questions",
      "title": "Developer questions",
      "subtitle": "...",
      "severity": "info",
      "items": ["...", "..."]
    },
    {
      "id": "acceptance-criteria",
      "title": "Suggested acceptance criteria",
      "subtitle": "...",
      "severity": "info",
      "items": ["...", "..."]
    }
  ]
}

RULES:
- "score" — handoff readiness from 0 to 100. Higher = fewer/less critical risks AND more detailed input. Be honest: a one-line description with many gaps should score low.
- "summary" — 1 sentence, specific to the input. Reference what's strong and what needs work. No generic phrases like "Solid progress!".
- "subtitle" — specific to this handoff and category. Avoid generic phrases. Each category gets a UNIQUE subtitle tailored to the input.
- "severity" — "high" = blocks ship; "medium" = needs attention; "low" = minor polish; "info" = informational only. ALWAYS "info" for "developer-questions" and "acceptance-criteria".
- Exactly 6 categories, in the order above, with those exact ids and titles.
- 3 to 5 items per category. Each item one short sentence (max ~20 words), specific to the input.
- If user listed "States considered", do NOT include matching items in "Missing states".
- No duplicates across categories.
- Plain English. Output JSON only.`;

  // Prompt do utilizador
  let userPrompt = `Handing off: ${deliveryType || 'Component'}\n`;
  userPrompt += `Interface type: ${interfaceType || 'Other'}\n`;
  userPrompt += `Product context: ${productContext || 'Other'}\n`;
  if (flowName) userPrompt += `Flow / Component name: ${flowName}\n`;
  if (Array.isArray(statesConsidered) && statesConsidered.length) {
    userPrompt += `States considered: ${statesConsidered.join(', ')}\n`;
  }
  userPrompt += `\nDescription:\n${description.trim()}\n`;
  if (businessRules && businessRules.trim()) {
    userPrompt += `\nBusiness rules / Dependencies:\n${businessRules.trim()}\n`;
  }
  userPrompt += `\nGenerate the handoff risk review now.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.6,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    
    // Debug log para ver o que a OpenAI responde
    console.log("OpenAI Status:", response.status);

    if (!response.ok) {
      let detail = '';
      try {
        const err = await response.json();
        detail = err?.error?.message || '';
      } catch {}
      if (response.status === 401) {
        return jsonResponse(502, {
          error: 'OpenAI rejected the API key. Check OPENAI_API_KEY in Netlify.',
        });
      }
      if (response.status === 429) {
        return jsonResponse(502, {
          error: 'OpenAI rate limit or quota reached. Try again in a moment.',
        });
      }
      return jsonResponse(502, {
        error: `OpenAI request failed (${response.status}). ${detail}`.trim(),
      });
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      return jsonResponse(502, { error: 'Empty response from OpenAI.' });
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return jsonResponse(502, { error: 'OpenAI returned invalid JSON.' });
    }

    if (!parsed || !Array.isArray(parsed.categories) || parsed.categories.length === 0) {
      return jsonResponse(502, { error: 'No categories in response.' });
    }

    // Normaliza defensivamente
    const allowedSeverity = new Set(['high', 'medium', 'low', 'info']);
    const categories = parsed.categories
      .filter((c) => c && typeof c.title === 'string' && Array.isArray(c.items))
      .map((c) => ({
        id: String(c.id || ''),
        title: String(c.title).trim(),
        subtitle: typeof c.subtitle === 'string' ? c.subtitle.trim() : '',
        severity: allowedSeverity.has(c.severity) ? c.severity : 'low',
        items: c.items
          .filter((i) => typeof i === 'string' && i.trim())
          .map((i) => String(i).trim()),
      }))
      .filter((c) => c.items.length > 0);

    if (!categories.length) {
      return jsonResponse(502, { error: 'No valid categories.' });
    }

    const score = typeof parsed.score === 'number'
      ? Math.max(0, Math.min(100, Math.round(parsed.score)))
      : null;

    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';

    return jsonResponse(200, { score, summary, categories });
  } catch (err) {
    console.error("Function Error:", err);
    return jsonResponse(500, { error: `Internal Server Error: ${err.message}` });
  }
};
