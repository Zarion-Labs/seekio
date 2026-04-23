// test/helpers.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

// --- implementations duplicated inline; keep in sync with seekio.js ---
const AGENT_NAMES = ['Ace','Atlas','Blaze','Cedar','Chip','Clay','Cole','Dace',
  'Dawn','Dell','Echo','Fern','Finn','Flux','Ford','Gale','Gene','Glen','Grey',
  'Halo','Hawk','Haze','Iris','Jade','Jett','Kane','Kira','Knox','Lane','Lark',
  'Lena','Levi','Lux','Mace','Mira','Nash','Neon','Nova','Orin','Owen','Page',
  'Park','Pax','Pike','Remy','Rex','Rift','Rio','Rox','Rune','Rush','Sage',
  'Shaw','Skye','Sora','Tace','Teal','Tide','Vex','Wade','Ward','Wren','Zara','Zed'];

function hashStr(s) {
  s = String(s ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function agentName(agentId, customTitle) {
  if (customTitle) return customTitle;
  return AGENT_NAMES[hashStr(agentId) % AGENT_NAMES.length];
}

function getKeyArg(toolName, input) {
  if (!input) return '';
  const n = (toolName || '').toLowerCase();
  if (n === 'read' || n === 'edit' || n === 'write' || n === 'multiedit') return String(input.file_path || '');
  if (n === 'bash') return String(input.command || '').slice(0, 80);
  if (n === 'grep') return String(input.pattern || '');
  if (n === 'glob') return String(input.pattern || '');
  if (n === 'agent' || n === 'task') return String(input.prompt || input.task || '').slice(0, 60);
  const firstVal = Object.values(input).find(v => typeof v === 'string');
  return firstVal ? String(firstVal).slice(0, 80) : '';
}

test('hashStr is deterministic', () => {
  assert.equal(hashStr('abc'), hashStr('abc'));
});

test('hashStr returns different values for different inputs', () => {
  assert.notEqual(hashStr('abc'), hashStr('xyz'));
});

test('agentName returns customTitle when provided', () => {
  assert.equal(agentName('any-id', 'Rox'), 'Rox');
});

test('agentName returns a name from AGENT_NAMES when no customTitle', () => {
  const name = agentName('a2dc1234', null);
  assert.ok(AGENT_NAMES.includes(name), `Expected ${name} to be in AGENT_NAMES`);
});

test('agentName is deterministic for same agentId', () => {
  assert.equal(agentName('a2dc1234', null), agentName('a2dc1234', null));
});

test('getKeyArg extracts file_path for Read', () => {
  assert.equal(getKeyArg('Read', { file_path: 'seekio.js' }), 'seekio.js');
});

test('getKeyArg extracts command for Bash', () => {
  assert.equal(getKeyArg('Bash', { command: 'node seekio.js' }), 'node seekio.js');
});

test('getKeyArg extracts pattern for Grep', () => {
  assert.equal(getKeyArg('Grep', { pattern: 'getSessions', path: '.' }), 'getSessions');
});

test('getKeyArg returns empty string for null input', () => {
  assert.equal(getKeyArg('Read', null), '');
});

function parseToolCalls(lines) {
  const toolCalls = [];
  const pending = {}; // id -> index in toolCalls
  let msgIndex = -1;

  for (const line of lines) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const role = d.message?.role;
    if (!role) continue;
    const ts = d.timestamp ? new Date(d.timestamp).getTime() : 0;
    const raw = d.message.content;
    const content = Array.isArray(raw) ? raw
      : typeof raw === 'string' ? [{ type: 'text', text: raw }]
      : [];

    if (role === 'user') {
      const hasText = content.some(c => c.type === 'text' && c.text?.trim());
      const hasResult = content.some(c => c.type === 'tool_result');
      if (hasText && !hasResult) msgIndex++;
      for (const c of content) {
        if (c.type !== 'tool_result') continue;
        const idx = pending[c.tool_use_id];
        if (idx === undefined) continue;
        const tc = toolCalls[idx];
        let result = '';
        if (typeof c.content === 'string') result = c.content;
        else if (Array.isArray(c.content)) {
          for (const rc of c.content) { if (rc.type === 'text') { result = rc.text; break; } }
        }
        tc.result = result.slice(0, 500);
        tc.isError = !!(c.is_error);
        tc.status = c.is_error ? 'error' : 'done';
        tc.endedAt = ts || Date.now();
        tc.durationMs = tc.startedAt ? tc.endedAt - tc.startedAt : null;
        delete pending[c.tool_use_id];
      }
    } else if (role === 'assistant') {
      for (const c of content) {
        if (c.type !== 'tool_use') continue;
        const tc = {
          msgIndex, id: c.id, name: c.name,
          input: c.input || {}, keyArg: getKeyArg(c.name, c.input || {}),
          result: null, isError: false, status: 'running',
          durationMs: null, startedAt: ts || 0, endedAt: null,
        };
        pending[c.id] = toolCalls.length;
        toolCalls.push(tc);
      }
    }
  }
  return toolCalls;
}

// Sample JSONL lines for testing
const sampleLines = [
  JSON.stringify({ message: { role: 'user', content: 'fix the bug' } }),
  JSON.stringify({ message: { role: 'assistant', content: [
    { type: 'text', text: 'Let me read the file.' },
    { type: 'tool_use', id: 'toolu_001', name: 'Read', input: { file_path: 'seekio.js' } }
  ]}, timestamp: '2024-01-01T00:00:00.000Z' }),
  JSON.stringify({ message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'toolu_001', content: 'const http = require...', is_error: false }
  ]}, timestamp: '2024-01-01T00:00:00.400Z' }),
  JSON.stringify({ message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'toolu_002', name: 'Edit', input: { file_path: 'seekio.js' } }
  ]}, timestamp: '2024-01-01T00:00:01.000Z' }),
];

test('parseToolCalls returns empty array for no lines', () => {
  assert.deepEqual(parseToolCalls([]), []);
});

test('parseToolCalls matches tool_use with tool_result', () => {
  const tcs = parseToolCalls(sampleLines);
  const read = tcs.find(t => t.id === 'toolu_001');
  assert.ok(read, 'should find toolu_001');
  assert.equal(read.status, 'done');
  assert.equal(read.name, 'Read');
  assert.equal(read.keyArg, 'seekio.js');
  assert.ok(read.result.includes('const http'));
});

test('parseToolCalls marks unmatched tool_use as running', () => {
  const tcs = parseToolCalls(sampleLines);
  const edit = tcs.find(t => t.id === 'toolu_002');
  assert.ok(edit, 'should find toolu_002');
  assert.equal(edit.status, 'running');
  assert.equal(edit.result, null);
});

test('parseToolCalls sets correct msgIndex', () => {
  const tcs = parseToolCalls(sampleLines);
  assert.equal(tcs[0].msgIndex, 0); // triggered by first user message
});

test('parseToolCalls calculates durationMs', () => {
  const tcs = parseToolCalls(sampleLines);
  const read = tcs.find(t => t.id === 'toolu_001');
  assert.equal(read.durationMs, 400);
});

// --- formatTimestamp (duplicated from public/index.html) ---
function formatTimestamp(iso, now = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const diffMs = now - t;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const d = new Date(t);
  const pad = n => String(n).padStart(2, '0');
  const display = `${months[d.getMonth()]} ${d.getDate()} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  let tooltip;
  if (diffMs < 3000) tooltip = 'just now';
  else if (diffMs < 60_000) tooltip = `${Math.floor(diffMs / 1000)}s ago`;
  else if (diffMs < 3_600_000) tooltip = `${Math.floor(diffMs / 60_000)}m ago`;
  else if (diffMs < 86_400_000) tooltip = `${Math.floor(diffMs / 3_600_000)}h ago`;
  else tooltip = display;
  return { display, tooltip };
}

test('formatTimestamp: null for empty/invalid', () => {
  assert.equal(formatTimestamp(''), null);
  assert.equal(formatTimestamp(null), null);
  assert.equal(formatTimestamp('garbage'), null);
});

test('formatTimestamp: under 3 seconds shows just now', () => {
  const now = Date.parse('2026-04-22T14:32:08.000Z');
  const iso = '2026-04-22T14:32:07.000Z'; // 1s ago
  assert.equal(formatTimestamp(iso, now).tooltip, 'just now');
});

test('formatTimestamp: under 1 minute shows seconds', () => {
  const now = Date.parse('2026-04-22T14:32:08.000Z');
  const iso = '2026-04-22T14:31:23.000Z'; // 45s ago
  assert.equal(formatTimestamp(iso, now).tooltip, '45s ago');
});

test('formatTimestamp: under 1 hour shows minutes', () => {
  const now = Date.parse('2026-04-22T14:32:08.000Z');
  const iso = '2026-04-22T14:27:08.000Z'; // 5m ago
  assert.equal(formatTimestamp(iso, now).tooltip, '5m ago');
});

test('formatTimestamp: under 24 hours shows hours', () => {
  const now = Date.parse('2026-04-22T14:32:08.000Z');
  const iso = '2026-04-22T11:32:08.000Z'; // 3h ago
  assert.equal(formatTimestamp(iso, now).tooltip, '3h ago');
});

test('formatTimestamp: 24+ hours falls back to absolute display', () => {
  const now = Date.parse('2026-04-22T14:32:08.000Z');
  const iso = '2026-04-20T09:14:00.000Z'; // 2 days ago
  const r = formatTimestamp(iso, now);
  assert.equal(r.tooltip, r.display); // falls back to display
});

test('formatTimestamp: display format is MMM D · HH:mm', () => {
  const now = Date.parse('2026-04-22T14:32:08.000Z');
  const localDate = new Date(2026, 3, 22, 14, 32, 8); // April 22, 2026, 14:32 local
  const iso = localDate.toISOString();
  const r = formatTimestamp(iso, now);
  assert.equal(r.display, 'Apr 22 · 14:32');
});

test('formatTimestamp: future timestamps say just now', () => {
  const now = Date.parse('2026-04-22T14:32:08.000Z');
  const iso = '2026-04-22T14:35:00.000Z'; // 3 minutes in the future
  assert.equal(formatTimestamp(iso, now).tooltip, 'just now');
});
