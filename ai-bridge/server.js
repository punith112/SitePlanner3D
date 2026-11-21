#!/usr/bin/env node
/**
 * SitePlanner3D — AI Bridge
 * ---------------------------------------------------------------
 * One small local server, two directions:
 *
 *  1) Web bridge (default):  node server.js
 *     Serves HTTP on http://127.0.0.1:8787 for the SitePlanner3D page:
 *       GET  /api/health    bridge + key status
 *       POST /api/chat      { provider:"kimi"|"claude", message, history }
 *       GET  /api/pending   app polls this for queued CAD commands
 *       POST /api/result    app posts back execution results
 *
 *  2) MCP server (stdio):    node server.js --mcp
 *     Exposes the CAD tools over the Model Context Protocol so Claude
 *     Desktop / Kimi CLI can drive the open SitePlanner3D page directly.
 *
 * Keys come from environment or a .env file next to this script:
 *   KIMI_API_KEY=sk-...          (https://platform.moonshot.ai)
 *   ANTHROPIC_API_KEY=sk-ant-... (https://console.anthropic.com)
 *   KIMI_MODEL=kimi-k2-0905-preview        (optional)
 *   CLAUDE_MODEL=claude-sonnet-4-5         (optional)
 *   PORT=8787                               (optional)
 * ---------------------------------------------------------------
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- tiny .env loader (no dependencies) ----------
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const KIMI_KEY = process.env.KIMI_API_KEY || '';
const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY || '';
const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-k2-0905-preview';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
const PORT = +(process.env.PORT || 8787);

// ---------- CAD tool definitions (single source of truth) ----------
const M = (m) => ({ type: 'object', properties: m.properties || {}, required: m.required || [] });
const TOOLS = [
  { name: 'get_state', description: 'Get the current plan: floors, wall list with coordinates, and placed items with positions. Call this before editing an existing design.',
    schema: M({}) },
  { name: 'list_catalog', description: 'List every placeable equipment/library item (hoods, kitchen equipment, HVAC, services, structures) with sizes and MEP connections.',
    schema: M({}) },
  { name: 'add_wall', description: 'Add one wall. Coordinates in metres, plan view (x right, z down).',
    schema: M({ properties: { x1:{type:'number'}, z1:{type:'number'}, x2:{type:'number'}, z2:{type:'number'}, h:{type:'number', description:'wall height in m; omit for full floor height'} }, required:['x1','z1','x2','z2'] }) },
  { name: 'add_walls', description: 'Add a chained polyline of walls — best for room outlines. pts is an array of [x,z] points; set close:true to close the loop.',
    schema: M({ properties: { pts:{type:'array', items:{type:'array', items:{type:'number'}}}, close:{type:'boolean'}, h:{type:'number'} }, required:['pts'] }) },
  { name: 'add_door', description: 'Add a door on a wall. wall is the 0-based wall index from get_state; t is the distance in metres from the wall start point.',
    schema: M({ properties: { wall:{type:'integer'}, t:{type:'number'}, w:{type:'number'}, h:{type:'number'} }, required:['wall'] }) },
  { name: 'add_window', description: 'Add a window on a wall (same indexing as add_door).',
    schema: M({ properties: { wall:{type:'integer'}, t:{type:'number'}, w:{type:'number'}, h:{type:'number'}, sill:{type:'number'} }, required:['wall'] }) },
  { name: 'add_item', description: 'Place a catalogue item at plan position x,z (metres). Use exact catalogue names from list_catalog.',
    schema: M({ properties: { name:{type:'string'}, x:{type:'number'}, z:{type:'number'}, rot:{type:'integer', description:'rotation 0-3 (0/90/180/270 deg)'} }, required:['name','x','z'] }) },
  { name: 'move_item', description: 'Move or rotate a placed item by its index from get_state.',
    schema: M({ properties: { idx:{type:'integer'}, x:{type:'number'}, z:{type:'number'}, rot:{type:'integer'} }, required:['idx'] }) },
  { name: 'delete', description: 'Delete an object. kind: wall|item|door|window|slab|duct ; index: 0-based index.',
    schema: M({ properties: { kind:{type:'string', enum:['wall','item','door','window','slab','duct']}, index:{type:'integer'} }, required:['kind','index'] }) },
  { name: 'add_slab', description: 'Add a floor slab rectangle.',
    schema: M({ properties: { x1:{type:'number'}, z1:{type:'number'}, x2:{type:'number'}, z2:{type:'number'} }, required:['x1','z1','x2','z2'] }) },
  { name: 'add_duct', description: 'Add a duct run through plan points. sys: exhaust|fresh.',
    schema: M({ properties: { pts:{type:'array', items:{type:'array', items:{type:'number'}}}, sys:{type:'string', enum:['exhaust','fresh']}, w:{type:'number'}, h:{type:'number'}, elev:{type:'number'} }, required:['pts'] }) },
  { name: 'add_pillar', description: 'Add a structural column.',
    schema: M({ properties: { x:{type:'number'}, z:{type:'number'}, w:{type:'number'}, h:{type:'number'} }, required:['x','z'] }) },
  { name: 'clear_floor', description: 'Clear everything on the active floor (walls, items, ducts…). Ask the user before using.',
    schema: M({}) },
  { name: 'undo', description: 'Undo the last change.', schema: M({}) },
  { name: 'copilot_review', description: 'Run the CAD Co-pilot: checks the current design against good-practice standards (workflow, clearances, ventilation, drainage, electrical, fire safety, doors, stairs) and returns a score plus a list of findings. Use it when the user asks for a design review, suggestions, or "check my design".',
    schema: M({}) },
  { name: 'design_from_brief', description: 'Braid-Studio-style pipeline: paste a project brief (plain language, e.g. "80-cover restaurant kitchen, about 60 m2, with prep, cooking, washing and storage areas") and the bridge will summarise it, classify the facility type, extract structured requirements, then generate the full layout in the open SitePlanner3D page. Returns the pipeline stages and what was drawn.',
    schema: M({ properties: { brief:{type:'string'}, provider:{type:'string', enum:['kimi','claude'], description:'which LLM to use; defaults to whichever key is configured'} }, required:['brief'] }) },
  { name: 'get_boq', description: 'Get the full BOQ / quantity schedules (walls, doors & windows, equipment, ducts, services) as CSV text. Summarise it for the user.',
    schema: M({}) },
  { name: 'download_boq', description: 'Download the BOQ schedules CSV file in the browser.', schema: M({}) },
  { name: 'bim_report', description: 'Open the one-click BIM engineering report (electrical loads, pipe sizes, ventilation CFM, clearances) in the app.', schema: M({}) },
  { name: 'export_model', description: 'Export the model as IFC / STEP / IGES / OBJ file in the browser.',
    schema: M({ properties: { kind:{type:'string', enum:['ifc','step','iges','obj']} }, required:['kind'] }) },
];

const SYSTEM_PROMPT = `You are the AI assistant inside SitePlanner3D, a BIM kitchen & MEP site-planning CAD app.
You can draw and edit the real model by calling the provided tools (text-to-CAD) and read the model back.

Rules:
- All coordinates are metres in plan view: x to the right, z downward. Walls are lines, items sit at (x,z).
- Before modifying an existing plan, call get_state. Before placing equipment, call list_catalog and use exact names.
- For a room outline prefer one add_walls call with close:true instead of many add_wall calls.
- Keep items inside the wall outline; typical commercial-kitchen wall height is 3 m.
- After drawing, briefly tell the user what was created (counts, positions) — do not dump raw JSON.
- If a tool returns an error, correct your parameters and retry once; otherwise explain the problem.
- BOQ questions: call get_boq and summarise the schedules (totals, key quantities).
- Design review questions: call get_state and give practical kitchen/MEP layout feedback.`;

// ---------- command queue: bridge -> browser app ----------
let nextId = 1;
const pending = [];            // [{id, cmds}]
const waiters = new Map();     // id -> {resolve, timer}

function runInApp(cmds, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.push({ id, cmds });
    const timer = setTimeout(() => {
      waiters.delete(id);
      const i = pending.findIndex(c => c.id === id);
      if (i >= 0) pending.splice(i, 1);
      reject(new Error('SitePlanner3D did not respond — is the page open in a browser?'));
    }, timeoutMs);
    waiters.set(id, { resolve, timer });
  });
}

function normalizeResults(cmds, results) {
  const arr = Array.isArray(results) ? results : [results];
  return (Array.isArray(cmds) ? cmds : [cmds]).map((c, i) => ({ op: c.op, ...(arr[i] || {}) }));
}

// ---------- LLM providers ----------
async function llmChat(provider, messages, tools, systemPrompt) {
  if (provider === 'kimi') {
    if (!KIMI_KEY) throw new Error('KIMI_API_KEY not set — put it in .env next to server.js');
    const r = await fetch('https://api.moonshot.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KIMI_KEY },
      body: JSON.stringify({
        model: KIMI_MODEL, temperature: 0.3, messages,
        tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })),
      }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error('Kimi API: ' + (j.error && j.error.message || r.status));
    const msg = j.choices[0].message;
    return {
      raw: msg, text: msg.content || '',
      calls: (msg.tool_calls || []).map(tc => ({ id: tc.id, name: tc.function.name, args: JSON.parse(tc.function.arguments || '{}') })),
      asToolResults: (results) => results.map(res => ({ role: 'tool', tool_call_id: res.id, content: res.content })),
    };
  }
  // claude
  if (!CLAUDE_KEY) throw new Error('ANTHROPIC_API_KEY not set — put it in .env next to server.js');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: CLAUDE_MODEL, max_tokens: 4096, system: systemPrompt || SYSTEM_PROMPT,
      tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.schema })),
      messages,
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Claude API: ' + (j.error && j.error.message || r.status));
  const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const calls = (j.content || []).filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input }));
  return {
    raw: j.content, text, calls,
    asToolResults: (results) => [{ role: 'user', content: results.map(res => ({ type: 'tool_result', tool_use_id: res.id, content: res.content })) }],
  };
}

// ---------- persona prompt library (ported from Braid Technologies Studio / PromptManager) ----------
// Each persona = systemPrompt + userPrompt with {placeholder} substitution, exactly like
// Braid's PromptManager personas (ArticleSummariser, ArticleClassifier, ThemeFinder …).
const PERSONAS = {
  BriefSummariser: {   // port of Braid "ArticleSummariser"
    systemPrompt: 'You are an AI assistant that summarises project briefs for a kitchen / MEP site-planning tool in {wordCount} words or less. You keep every concrete fact (areas, seat counts, equipment, rooms, utilities) and drop filler.',
    userPrompt: 'Summarise this project brief:\n\n{userInput}' },
  BriefClassifier: {   // port of Braid "ArticleClassifier"
    systemPrompt: 'You are an assistant that can classify a project brief into one of the following facility types: {classifications}. Reply with only the classification, nothing else.',
    userPrompt: 'Classify this brief:\n\n{userInput}' },
  RequirementsExtractor: {   // port of Braid "ThemeFinder" — structured facts instead of a theme
    systemPrompt: 'You are an AI assistant that extracts structured design requirements from a project brief. Reply with ONLY a compact JSON object, no commentary: { "facilityType": string, "covers": number|null, "areaM2": number|null, "zones": string[], "equipment": string[], "utilities": string[], "notes": string }. Use null / empty arrays when the brief does not say.',
    userPrompt: 'Extract the requirements from this brief:\n\n{userInput}' },
  LayoutGenerator: {   // generation persona — disciplined chain-of-thought like Braid's C4 prompts
    systemPrompt: SYSTEM_PROMPT + `

You are now in LAYOUT GENERATION mode. A small, correct design is better than a large one with errors.
Chain of thought:
1) Read the extracted requirements below (facility type, covers, zones, equipment hints).
2) Call list_catalog to see exact placeable item names.
3) Draw the room shell with ONE add_walls call (close:true), sized to the requested area (default 10 x 6 m).
4) Add at least one 0.9 m door.
5) Place equipment zone by zone: washing (sinks + landing table), cooking line against a wall (cookers + exhaust hood directly above), prep tables, refrigeration, storage rack.
6) Add MEP basics the Co-pilot will check: MCB Distribution Box, Fresh Air Grille(s), Grease Trap if sinks have drains, Fire Extinguisher near the cook line.
7) Finish by calling copilot_review and report the score with one line per remaining critical/warning.
Keep everything inside the walls with working aisles >= 1.2 m between facing runs.` },
};
const FACILITY_CLASSES = ['CentralKitchen','RestaurantKitchen','CafeKitchen','Bakery','CloudKitchen','Bar','Cafeteria','IndustrialPantry','Unknown'];

function fillPrompt(tpl, vars) {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}

// single-shot LLM call with a persona (Braid's singleShotSummarize / singleShotClassify pattern)
async function singleShot(provider, personaName, vars, userText) {
  const p = PERSONAS[personaName];
  if (!p) throw new Error('unknown persona ' + personaName);
  const sys = fillPrompt(p.systemPrompt, vars);
  const messages = provider === 'kimi'
    ? [{ role: 'system', content: sys }, { role: 'user', content: fillPrompt(p.userPrompt, vars) }]
    : [{ role: 'user', content: fillPrompt(p.userPrompt, vars) }];
  // reuse llmChat with zero tools; claude path needs system override, so call the raw endpoints here
  if (provider === 'kimi') {
    if (!KIMI_KEY) throw new Error('KIMI_API_KEY not set — put it in .env next to server.js');
    const r = await fetch('https://api.moonshot.ai/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KIMI_KEY },
      body: JSON.stringify({ model: KIMI_MODEL, temperature: 0.2, messages }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error('Kimi API: ' + (j.error && j.error.message || r.status));
    return j.choices[0].message.content || '';
  }
  if (!CLAUDE_KEY) throw new Error('ANTHROPIC_API_KEY not set — put it in .env next to server.js');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 2048, system: sys, messages }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Claude API: ' + (j.error && j.error.message || r.status));
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

// ---------- Waterfall-style pipeline: brief -> summarise -> classify -> extract -> generate ----------
async function briefPipeline(provider, brief) {
  const stages = {};
  // 1 · summarise (keeps long briefs manageable — Braid Waterfall stage 1)
  stages.summary = brief.length > 600
    ? await singleShot(provider, 'BriefSummariser', { wordCount: 150, userInput: brief }, brief)
    : brief;
  // 2 · classify facility type (Braid Waterfall stage 2)
  const raw = await singleShot(provider, 'BriefClassifier', { classifications: FACILITY_CLASSES.join(', '), userInput: stages.summary }, stages.summary);
  stages.classification = FACILITY_CLASSES.find(c => raw.includes(c)) || 'Unknown';
  // 3 · extract structured requirements
  const reqText = await singleShot(provider, 'RequirementsExtractor', { userInput: stages.summary }, stages.summary);
  try { stages.requirements = JSON.parse(reqText.slice(reqText.indexOf('{'), reqText.lastIndexOf('}') + 1)); }
  catch { stages.requirements = { notes: reqText.slice(0, 400) }; }
  // 4 · generate the design with tools (LayoutGenerator persona drives the agent loop)
  const genMsg =
    'Generate the layout for this project now.\n\nFacility classification: ' + stages.classification +
    '\nExtracted requirements: ' + JSON.stringify(stages.requirements) +
    '\n\nOriginal brief:\n' + brief;
  const gen = await chatAgent(provider, genMsg, provider === 'kimi'
    ? [{ role: 'system', content: PERSONAS.LayoutGenerator.systemPrompt }] : [], PERSONAS.LayoutGenerator.systemPrompt);
  stages.generation = gen.reply;
  return { stages, ops: gen.ops };
}

// ---------- agent loop for the in-app chat ----------
async function chatAgent(provider, userMessage, history, systemPrompt) {
  const msgs = Array.isArray(history) ? [...history] : [];
  if (provider === 'kimi' && !msgs.length) msgs.push({ role: 'system', content: systemPrompt || SYSTEM_PROMPT });
  msgs.push({ role: 'user', content: userMessage });

  const opsLog = [];
  let reply = '';
  for (let round = 0; round < 10; round++) {
    const out = await llmChat(provider, msgs, TOOLS, systemPrompt);
    msgs.push(provider === 'kimi' ? out.raw : { role: 'assistant', content: out.raw });
    if (out.text) reply = out.text;
    if (!out.calls.length) break;
    const results = [];
    for (const call of out.calls) {
      const tool = TOOLS.find(t => t.name === call.name);
      let content;
      try {
        if (!tool) throw new Error('unknown tool ' + call.name);
        const cmd = { op: call.name === 'export_model' ? 'export' : call.name, ...call.args };
        const appRes = await runInApp([cmd]);
        const norm = normalizeResults([cmd], appRes)[0];
        opsLog.push(norm);
        content = JSON.stringify(norm);
      } catch (e) {
        opsLog.push({ op: call.name, error: String(e.message || e) });
        content = JSON.stringify({ error: String(e.message || e) });
      }
      results.push({ id: call.id, content });
    }
    msgs.push(...out.asToolResults(results));
  }
  return { reply, ops: opsLog, history: msgs };
}

// ---------- HTTP bridge ----------
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

function startHttp() {
  const server = http.createServer(async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = req.url.split('?')[0];
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (url === '/api/health') return json(200, { ok: true, kimi: !!KIMI_KEY, claude: !!CLAUDE_KEY, queued: pending.length });
    if (url === '/api/pending' && req.method === 'GET') { const out = pending.splice(0, pending.length); return json(200, out); }
    if (url === '/api/result' && req.method === 'POST') {
      const { id, results } = await readBody(req);
      const w = waiters.get(id);
      if (w) { clearTimeout(w.timer); waiters.delete(id); w.resolve(results); }
      return json(200, { ok: true });
    }
    if (url === '/api/brief' && req.method === 'POST') {
      const { provider, brief } = await readBody(req);
      if (!brief) return json(400, { error: 'missing brief' });
      const prov = provider === 'claude' ? 'claude' : (provider === 'kimi' ? 'kimi' : (KIMI_KEY ? 'kimi' : 'claude'));
      try { return json(200, await briefPipeline(prov, brief)); }
      catch (e) { return json(200, { error: String(e.message || e) }); }
    }
    if (url === '/api/chat' && req.method === 'POST') {
      const { provider, message, history } = await readBody(req);
      if (!message) return json(400, { error: 'missing message' });
      try { return json(200, await chatAgent(provider === 'claude' ? 'claude' : 'kimi', message, history)); }
      catch (e) { return json(200, { error: String(e.message || e) }); }
    }
    json(404, { error: 'unknown endpoint' });
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log('SitePlanner3D AI bridge listening on http://127.0.0.1:' + PORT);
    console.log('  Kimi   : ' + (KIMI_KEY ? 'key loaded (' + KIMI_MODEL + ')' : 'NO KEY — set KIMI_API_KEY in .env'));
    console.log('  Claude : ' + (CLAUDE_KEY ? 'key loaded (' + CLAUDE_MODEL + ')' : 'NO KEY — set ANTHROPIC_API_KEY in .env'));
    console.log('Open SitePlanner3D (index.html) and click AI.KIMI or AI.Claude.');
  });
}

// ---------- MCP mode ----------
async function startMcp() {
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
  const server = new Server({ name: 'siteplanner3d', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.schema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) return { content: [{ type: 'text', text: 'Error: unknown tool ' + name }], isError: true };
    if (name === 'design_from_brief') {
      try {
        const prov = (args && args.provider) || (KIMI_KEY ? 'kimi' : 'claude');
        const out = await briefPipeline(prov, String((args && args.brief) || ''));
        return { content: [{ type: 'text', text: JSON.stringify(out.stages, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: 'Error: ' + (e.message || e) }], isError: true };
      }
    }
    try {
      const cmd = { op: name === 'export_model' ? 'export' : name, ...(args || {}) };
      const appRes = await runInApp([cmd]);
      const norm = normalizeResults([cmd], appRes)[0];
      return { content: [{ type: 'text', text: JSON.stringify(norm, null, 2) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: 'Error: ' + (e.message || e) }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
  console.error('SitePlanner3D MCP server running (stdio) — tools reach the open browser page via the bridge queue.');
  // MCP needs the HTTP bridge running too (the browser polls it). Start it in-process.
  startHttpQuiet();
}
function startHttpQuiet() {
  const server = http.createServer(async (req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = req.url.split('?')[0];
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (url === '/api/health') return json(200, { ok: true, kimi: !!KIMI_KEY, claude: !!CLAUDE_KEY });
    if (url === '/api/brief' && req.method === 'POST') {
      const { provider, brief } = await readBody(req);
      if (!brief) return json(400, { error: 'missing brief' });
      const prov = provider === 'claude' ? 'claude' : (provider === 'kimi' ? 'kimi' : (KIMI_KEY ? 'kimi' : 'claude'));
      try { return json(200, await briefPipeline(prov, brief)); }
      catch (e) { return json(200, { error: String(e.message || e) }); }
    }
    if (url === '/api/pending' && req.method === 'GET') { const out = pending.splice(0, pending.length); return json(200, out); }
    if (url === '/api/result' && req.method === 'POST') {
      const { id, results } = await readBody(req);
      const w = waiters.get(id);
      if (w) { clearTimeout(w.timer); waiters.delete(id); w.resolve(results); }
      return json(200, { ok: true });
    }
    json(404, { error: 'unknown endpoint' });
  });
  server.on('error', e => { if (e.code !== 'EADDRINUSE') throw e; /* another bridge instance already serves the queue */ });
  server.listen(PORT, '127.0.0.1');
}

if (process.argv.includes('--mcp')) startMcp().catch(e => { console.error(e); process.exit(1); });
else startHttp();
