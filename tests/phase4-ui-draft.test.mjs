// TEST ONLY: execute the unchanged frontend body in a VM with explicit DOM/network stubs.
// This is not a real browser, HTTP server, native folder picker, or business execution test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = process.env.PHASE4_UI_ROOT || fileURLToPath(new URL('../', import.meta.url));
const sourcePath = path.join(root, 'ui/settings.mjs');
const source = await fs.readFile(sourcePath, 'utf8');
const html = await fs.readFile(path.join(root, 'ui/settings.html'), 'utf8');
const { formatSeconds, localizeError, createFormLock } = await import(pathToFileURL(path.join(root, 'ui/display.mjs')));
const importLine = "import { formatSeconds, localizeError, createFormLock } from '/display.mjs';";
assert.ok(source.startsWith(importLine), 'only the actual display import is substituted by its real module exports');
const frontendBody = source.slice(importLine.length);
const frontend = new vm.Script(frontendBody, { filename: sourcePath });
const sha256 = text => createHash('sha256').update(text).digest('hex');
console.log(`# TEST_VM_SOURCE ${JSON.stringify({ sourcePath, sourceSha256: sha256(source), frontendBodySha256: sha256(frontendBody), htmlSha256: sha256(html), realBrowser: false })}`);

const scalarFields = ['seasonalEnabled','seasonalReferenceDate','seasonalNotes','recentSurgeEnabled','recentDays','baselineDays','minimumGrowthRatePercent','priceMin','priceMax','priceBasis','commissionRatePercent','commissionPerOrder','salesPeriod','salesMin','conversionScope','conversionDenominator','conversionMinPercent','conversionMinSample','missingDataStrategy','maxCartAdditions','maxLibraryPages','maxCandidates','videoSaveRoot'];
// The API insertion order from the parent's reproduced failure is deliberately NOT the form order.
const apiFields = ['seasonalEnabled','videoSaveRoot','seasonalReferenceDate','seasonalNotes','recentSurgeEnabled','recentDays','baselineDays','minimumGrowthRatePercent','includeCategories','excludeCategories','priceMin','priceMax','priceBasis','commissionRatePercent','commissionPerOrder','salesPeriod','salesMin','conversionScope','conversionDenominator','conversionMinPercent','conversionMinSample','missingDataStrategy','maxCartAdditions','maxLibraryPages','maxCandidates'];
const categoryCatalog = [{ id: 'TEST-A', name: '测试甲' }, { id: 'TEST-B', name: '测试乙' }, { id: 'TEST-C', name: '测试丙' }, { id: 'TEST-D', name: '测试丁' }];
const apiOrder = draft => Object.fromEntries(apiFields.map(field => [field, structuredClone(draft[field])]));
function fixtureDraft(overrides = {}) {
  return apiOrder({
    seasonalEnabled: true, seasonalReferenceDate: '', seasonalNotes: 'TEST ONLY', recentSurgeEnabled: false,
    recentDays: '7', baselineDays: '7', minimumGrowthRatePercent: '', priceMin: '', priceMax: '', priceBasis: '',
    commissionRatePercent: '', commissionPerOrder: '', salesPeriod: '', salesMin: '', conversionScope: '', conversionDenominator: '',
    conversionMinPercent: '', conversionMinSample: '', missingDataStrategy: 'decision_page', maxCartAdditions: '3', maxLibraryPages: '3', maxCandidates: '60',
    videoSaveRoot: path.join(root, 'TEST-video-root-not-created'), includeCategories: [], excludeCategories: [], ...overrides,
  });
}
class TestEvent {
  constructor(type) { this.type = type; this.defaultPrevented = false; }
  preventDefault() { this.defaultPrevented = true; }
}
function deferred() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
async function harness({ draft = fixtureDraft(), revision = 'TEST-r1', catalog = categoryCatalog, tasks = [] } = {}) {
  const pending = new Set(), nodes = new Map(), all = [], timers = new Map(), windowListeners = new Map(), gates = [];
  let timerId = 0;
  function element(tag, attrs = '') {
    const classes = new Set(attrs.match(/\bclass="([^"]*)"/)?.[1].split(/\s+/).filter(Boolean) || []);
    const e = {
      tagName: tag.toUpperCase(), id: attrs.match(/\bid="([^"]+)"/)?.[1] || '', type: attrs.match(/\btype="([^"]+)"/)?.[1] || '',
      disabled: /\bdisabled(?:\s|$)/.test(attrs), hidden: /\bhidden(?:\s|$)/.test(attrs), multiple: /\bmultiple(?:\s|$)/.test(attrs),
      checked: false, textContent: '', dataset: {}, children: [], listeners: new Map(),
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name), toggle(name, force) { if (force ?? !classes.has(name)) classes.add(name); else classes.delete(name); } },
      addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); },
      dispatchEvent(event) {
        event.target = this;
        for (const listener of this.listeners.get(event.type) || []) {
          const result = listener(event);
          if (result?.then) { pending.add(result); result.then(() => pending.delete(result), () => pending.delete(result)); }
        }
        return !event.defaultPrevented;
      },
      replaceChildren(...children) { this.children = []; this.append(...children); },
      append(...children) { for (const child of children) { child.parent = this; this.children.push(child); if (this.tagName === 'SELECT' && !this.multiple && !this.children.some(o => o.selected)) child.selected = true; } },
      querySelectorAll(selector) {
        assert.equal(this.id, 'settings-form'); assert.equal(selector, 'input,select,textarea,button');
        return all.filter(node => ['INPUT','SELECT','TEXTAREA','BUTTON'].includes(node.tagName));
      },
    };
    let value = '', selected = false;
    Object.defineProperties(e, {
      options: { get: () => e.children }, selectedOptions: { get: () => e.children.filter(option => option.selected) },
      selected: { get: () => selected, set(v) { selected = Boolean(v); if (selected && e.parent?.tagName === 'SELECT' && !e.parent.multiple) for (const sibling of e.parent.children) if (sibling !== e) sibling.selected = false; } },
      value: { get: () => e.tagName === 'SELECT' ? e.children.find(option => option.selected)?.value || '' : value, set(v) { value = String(v); if (e.tagName === 'SELECT') for (const option of e.children) option.selected = option.value === value; } },
    });
    if (e.id) nodes.set(e.id, e);
    all.push(e);
    return e;
  }
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/g)) {
    const [,tag,attrs] = match;
    if (/\bid="/.test(attrs) || ['input','select','textarea','button'].includes(tag) || /\bdata-error="/.test(attrs)) {
      const node = element(tag, attrs), field = attrs.match(/\bdata-error="([^"]+)"/)?.[1];
      if (field) node.dataset.error = field;
    }
  }
  for (const match of html.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    for (const option of match[2].matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)) {
      const node = element('option'); node.value = option[1]; node.textContent = option[2]; nodes.get(match[1]).append(node);
    }
  }
  const document = {
    getElementById: id => nodes.get(id) || null,
    createElement: tag => element(tag),
    querySelector(selector) {
      if (selector === 'meta[name="csrf-token"]') return { content: 'TEST-csrf' };
      const field = selector.match(/^\[data-error="([^"]+)"\]$/)?.[1];
      return all.find(node => node.dataset.error === field) || null;
    },
    querySelectorAll(selector) {
      if (selector === '.error[data-error]') return all.filter(node => node.dataset.error);
      if (selector === '.invalid') return all.filter(node => node.classList.contains('invalid'));
      throw new Error(`Unexpected TEST selector: ${selector}`);
    },
  };
  const server = { draft: structuredClone(draft), revision, catalog: structuredClone(catalog), tasks: structuredClone(tasks), postStatus: 200, startStatus: 200 };
  const requests = [];
  const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => structuredClone(body) });
  const policy = () => ({ TEST_ONLY: true, revision: server.revision });
  const waits = new Map();
  async function fetchStub(url, options = {}) {
    const method = options.method || 'GET', request = { url, method, headers: { ...options.headers }, body: options.body ? JSON.parse(options.body) : null };
    requests.push(structuredClone(request));
    const gate = waits.get(`${method} ${url}`); if (gate) { waits.delete(`${method} ${url}`); await gate.promise; }
    if (url === '/api/settings' && method === 'GET') return response(200, { draft: server.draft, revision: server.revision, categories: server.catalog, policy: policy() });
    if (url === '/api/settings' && method === 'POST') {
      if (request.body.expected_revision !== server.revision || server.postStatus === 409) return response(409, { error: 'REVISION_CONFLICT' });
      if (server.postStatus === 422) return response(422, { errors: { priceMin: 'INVALID_NUMBER' } });
      if (server.postStatus !== 200) return response(server.postStatus, {});
      server.draft = apiOrder(request.body.draft); server.revision = 'TEST-r2';
      return response(200, { revision: server.revision, policy: policy() });
    }
    if (url === '/api/tasks' && method === 'GET') return response(200, { tasks: server.tasks });
    if (/^\/api\/tasks\/(start|pause|resume)$/.test(url) && method === 'POST') return response(server.startStatus, server.startStatus === 409 ? { error: 'REVISION_CONFLICT' } : { TEST_ONLY: true });
    if (url === '/api/choose-video-directory' && method === 'POST') return response(200, { path: path.join(root, 'TEST-picked-directory-not-created') });
    throw new Error(`Unexpected TEST request (no real network is available): ${method} ${url}`);
  }
  const context = vm.createContext({
    document, Event: TestEvent, CSS: { escape: value => value }, location: { origin: 'http://TEST.invalid' }, performance,
    structuredClone, fetch: fetchStub, formatSeconds, localizeError, createFormLock,
    setInterval(callback, milliseconds) { assert.equal(milliseconds, 2000); timers.set(++timerId, callback); return timerId; },
    clearInterval: id => timers.delete(id), addEventListener(type, listener) { windowListeners.set(type, listener); },
  });
  async function idle() {
    for (let i = 0; i < 4; i++) { await new Promise(resolve => setImmediate(resolve)); if (pending.size) await Promise.all([...pending]); }
  }
  const h = {
    context, server, requests, nodes, get: id => nodes.get(id), eval: code => vm.runInContext(code, context), idle,
    starts: () => requests.filter(request => request.url === '/api/tasks/start'),
    settingsPosts: () => requests.filter(request => request.url === '/api/settings' && request.method === 'POST'),
    edit(id, value) { const node = nodes.get(id); if (node.type === 'checkbox') node.checked = value; else node.value = value; nodes.get('settings-form').dispatchEvent(new TestEvent('input')); },
    async fire(id, type = 'click') { const node = nodes.get(id); if (type === 'click' && node.disabled) return false; node.dispatchEvent(new TestEvent(type)); await idle(); return true; },
    async poll() { for (const callback of timers.values()) await callback(); await idle(); },
    waitNext(method, url) { const gate = deferred(); gates.push(gate); waits.set(`${method} ${url}`, gate); return gate; },
    async close() { for (const gate of gates) gate.release(); await idle(); windowListeners.get('pagehide')?.(); assert.equal(timers.size, 0, 'TEST pagehide closes every simulated interval'); assert.equal(pending.size, 0, 'TEST event promises drained'); assert.equal(h.eval('formLock.busy'), false, 'TEST form lock released'); },
  };
  try { frontend.runInContext(context); await idle(); return h; }
  catch (error) { await h.close(); throw error; }
}
async function withHarness(options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const h = await harness(options);
  try { await callback(h); } finally { await h.close(); }
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }
async function assertUnsavedGuard(h) {
  assert.equal(h.get('startSelection').disabled, true, 'unsaved value disables start');
  const before = h.starts().length;
  await h.eval("taskAction('start')");
  assert.equal(h.starts().length, before, 'direct invocation cannot bypass the unsaved guard');
  assert.match(h.get('taskError').textContent, /有未保存修改/);
  assert.equal(h.settingsPosts().length, 0, 'guard never silently saves');
}

test('untouched loaded draft: different JSON key order, same 25 values, enabled start', () => withHarness(h => {
  const form = plain(h.eval('draftFromForm()'));
  assert.equal(Object.keys(form).length, 25);
  assert.notDeepEqual(Object.keys(form), Object.keys(h.server.draft));
  assert.notEqual(JSON.stringify(form), JSON.stringify(h.server.draft));
  assert.deepEqual(form, h.server.draft);
  assert.equal(h.get('dirtyState').textContent, '未修改');
  assert.equal(h.get('startSelection').disabled, false);
}));

test('untouched loaded draft: actual click reaches start with saved revision only, never a draft/save', () => withHarness(async h => {
  assert.equal(await h.fire('startSelection'), true);
  assert.equal(h.starts().length, 1);
  assert.deepEqual(h.starts()[0].body, { expected_revision: 'TEST-r1' });
  assert.equal(h.starts()[0].headers['x-csrf-token'], 'TEST-csrf');
  assert.equal(h.settingsPosts().length, 0);
}));

const changes = {
  seasonalEnabled: false, seasonalReferenceDate: '2026-10-10', seasonalNotes: 'TEST changed', recentSurgeEnabled: true,
  recentDays: '8', baselineDays: '9', minimumGrowthRatePercent: '0', priceMin: '0', priceMax: '10', priceBasis: 'sku',
  commissionRatePercent: '0', commissionPerOrder: '0', salesPeriod: 'snapshot', salesMin: '0', conversionScope: 'video',
  conversionDenominator: 'clicks', conversionMinPercent: '0', conversionMinSample: '0', missingDataStrategy: 'manual_review',
  maxCartAdditions: '2', maxLibraryPages: '4', maxCandidates: '61', videoSaveRoot: path.join(root, 'TEST-changed-directory-not-created'),
};
for (const field of scalarFields) {
  test(`changed field ${field}: disabled start and direct unsaved rejection`, () => withHarness(async h => {
    h.edit(field, changes[field]);
    assert.equal(h.get('dirtyState').textContent, '有未保存修改');
    await assertUnsavedGuard(h);
  }));
}

test('pure comparator: strict booleans and empty/zero/null/type distinctions; no mutation', () => withHarness(h => {
  assert.equal(h.eval('typeof draftsEqual'), 'function');
  const d = fixtureDraft(), reversed = Object.fromEntries(Object.entries(d).reverse());
  h.context.TEST_LEFT = d; h.context.TEST_RIGHT = reversed;
  const before = JSON.stringify([d, reversed]);
  assert.equal(h.eval('draftsEqual(TEST_LEFT, TEST_RIGHT)'), true);
  assert.equal(JSON.stringify([d, reversed]), before);
  for (const [field, value] of [['priceMin','0'],['priceMin',0],['priceMin',null],['seasonalEnabled','true'],['seasonalEnabled',1],['recentSurgeEnabled','false'],['recentSurgeEnabled',0]]) {
    h.context.TEST_RIGHT = { ...d, [field]: value };
    assert.equal(h.eval('draftsEqual(TEST_LEFT, TEST_RIGHT)'), false, `${field}:${JSON.stringify(value)}`);
  }
  h.context.TEST_RIGHT = null;
  assert.equal(h.eval('draftsEqual(TEST_LEFT, TEST_RIGHT)'), false);
}));

test('pure comparator: only category IDs are sets, not scalar/other arrays', () => withHarness(h => {
  assert.equal(h.eval('typeof draftsEqual'), 'function');
  h.context.TEST_LEFT = fixtureDraft({ includeCategories: ['TEST-B','TEST-A'], excludeCategories: ['TEST-D','TEST-C'] });
  h.context.TEST_RIGHT = fixtureDraft({ includeCategories: ['TEST-A','TEST-B','TEST-A'], excludeCategories: ['TEST-C','TEST-D'] });
  const before = JSON.stringify([h.context.TEST_LEFT, h.context.TEST_RIGHT]);
  assert.equal(h.eval('draftsEqual(TEST_LEFT, TEST_RIGHT)'), true, 'deduplicated ID membership is the contract');
  assert.equal(JSON.stringify([h.context.TEST_LEFT, h.context.TEST_RIGHT]), before);
  h.context.TEST_LEFT = fixtureDraft({ seasonalNotes: ['TEST-A','TEST-B'] });
  h.context.TEST_RIGHT = fixtureDraft({ seasonalNotes: ['TEST-B','TEST-A'] });
  assert.equal(h.eval('draftsEqual(TEST_LEFT, TEST_RIGHT)'), false, 'no blanket array sorting/coercion');
  h.context.TEST_LEFT = fixtureDraft(); h.context.TEST_RIGHT = fixtureDraft({ includeCategories: null });
  assert.equal(h.eval('draftsEqual(TEST_LEFT, TEST_RIGHT)'), false);
}));

test('multiple category IDs load without loss; API versus DOM order does not dirty or block start', () => withHarness({ draft: fixtureDraft({ includeCategories: ['TEST-B','TEST-A'], excludeCategories: ['TEST-D','TEST-C'] }) }, async h => {
  const form = plain(h.eval('draftFromForm()'));
  assert.deepEqual(form.includeCategories, ['TEST-A','TEST-B']);
  assert.deepEqual(form.excludeCategories, ['TEST-C','TEST-D']);
  assert.equal(h.get('dirtyState').textContent, '未修改');
  assert.equal(h.get('startSelection').disabled, false);
  await h.eval("taskAction('start')");
  assert.equal(h.starts().length, 1);
}));

for (const field of ['includeCategories','excludeCategories']) {
  test(`${field}: changed membership rejects start`, () => withHarness({ draft: fixtureDraft({ [field]: ['TEST-A','TEST-B'] }) }, async h => {
    h.get(field).options.find(option => option.value === 'TEST-B').selected = false;
    h.get('settings-form').dispatchEvent(new TestEvent('change'));
    await assertUnsavedGuard(h);
  }));
}

test('reset restores all saved values and enabled start on the existing task-poll cycle, without saving', () => withHarness(async h => {
  h.edit('videoSaveRoot', path.join(root, 'TEST-reset-draft-not-created'));
  await assertUnsavedGuard(h);
  await h.fire('resetButton'); await h.poll();
  assert.deepEqual(plain(h.eval('draftFromForm()')), h.server.draft);
  assert.equal(h.get('dirtyState').textContent, '未修改');
  assert.equal(h.get('startSelection').disabled, false);
  assert.equal(h.settingsPosts().length, 0);
}));

test('save performs zero task actions, reads back all 25 values, and recovers start on existing task poll', () => withHarness({ draft: fixtureDraft({ includeCategories: ['TEST-B','TEST-A'], excludeCategories: ['TEST-D','TEST-C'] }) }, async h => {
  h.edit('seasonalNotes', 'TEST saved unrelated edit');
  const intended = plain(h.eval('draftFromForm()'));
  await h.fire('settings-form', 'submit'); await h.poll();
  assert.equal(h.settingsPosts().length, 1);
  assert.deepEqual(h.settingsPosts()[0].body, { expected_revision: 'TEST-r1', draft: intended });
  assert.deepEqual(h.server.draft, intended);
  assert.deepEqual(plain(h.eval('draftFromForm()')), intended);
  assert.equal(h.get('connection-status').textContent, '已保存并读回核对');
  assert.equal(h.get('dirtyState').textContent, '未修改');
  assert.equal(h.get('startSelection').disabled, false);
  assert.equal(h.requests.filter(request => /^\/api\/tasks\//.test(request.url)).length, 0, 'save causes zero task/business actions');
  await h.fire('startSelection');
  assert.deepEqual(h.starts()[0].body, { expected_revision: 'TEST-r2' });
}));

test('reload replaces only unsaved draft with saved values, preserves category IDs, and recovers start on task poll', () => withHarness({ draft: fixtureDraft({ includeCategories: ['TEST-B','TEST-A'] }) }, async h => {
  h.edit('seasonalNotes', 'TEST unsaved');
  await assertUnsavedGuard(h);
  h.server.draft = fixtureDraft({ seasonalNotes: 'TEST other page saved', includeCategories: ['TEST-B','TEST-A'] }); h.server.revision = 'TEST-r3';
  await h.fire('reloadButton'); await h.poll();
  assert.deepEqual(plain(h.eval('draftFromForm()')).includeCategories, ['TEST-A','TEST-B']);
  assert.equal(h.get('seasonalNotes').value, 'TEST other page saved');
  assert.equal(h.get('dirtyState').textContent, '未修改');
  assert.equal(h.get('startSelection').disabled, false);
  assert.equal(h.settingsPosts().length, 0);
  await h.fire('startSelection'); assert.deepEqual(h.starts()[0].body, { expected_revision: 'TEST-r3' });
}));

test('native-directory response stub changes only the draft and the unsaved guard still rejects', () => withHarness(async h => {
  await h.fire('chooseVideoDirectory');
  assert.equal(h.get('videoSaveRoot').value, path.join(root, 'TEST-picked-directory-not-created'));
  assert.match(h.get('directoryStatus').textContent, /点击“保存配置”后生效/);
  await assertUnsavedGuard(h);
}));

test('editing then reverting a value restores semantic equality without a save', () => withHarness(async h => {
  h.edit('seasonalNotes', 'TEST changed'); await assertUnsavedGuard(h);
  h.edit('seasonalNotes', 'TEST ONLY');
  assert.equal(h.get('startSelection').disabled, false);
  assert.equal(h.settingsPosts().length, 0);
  await h.fire('startSelection'); assert.equal(h.starts().length, 1);
}));

test('empty versus explicit zero: zero survives save/reload; clearing it remains unsaved', () => withHarness({ draft: fixtureDraft({ priceMin: '0', priceBasis: 'sku' }) }, async h => {
  assert.equal(h.get('priceMin').value, '0');
  h.edit('seasonalNotes', 'TEST preserve zero');
  await h.fire('settings-form', 'submit'); await h.poll();
  assert.equal(h.server.draft.priceMin, '0');
  assert.equal(h.get('priceMin').value, '0');
  assert.equal(h.get('startSelection').disabled, false);
  h.edit('priceMin', '');
  const before = h.starts().length; await h.eval("taskAction('start')");
  assert.equal(h.get('startSelection').disabled, true); assert.equal(h.starts().length, before);
}));

for (const status of [409, 422]) {
  test(`save ${status} keeps unsaved draft blocked and triggers zero task actions`, () => withHarness(async h => {
    h.server.postStatus = status; h.edit('priceMin', '0');
    await h.fire('settings-form', 'submit'); await h.poll();
    assert.equal(h.get('priceMin').value, '0'); assert.equal(h.server.draft.priceMin, '');
    assert.equal(h.get('startSelection').disabled, true);
    await h.eval("taskAction('start')"); assert.equal(h.starts().length, 0);
    assert.equal(h.settingsPosts().length, 1);
    assert.match(h.get('form-error').textContent, status === 409 ? /另一页面保存/ : /标红字段/);
  }));
}

test('missing revision keeps start disabled; revision conflict is not auto-saved', () => withHarness({ revision: null }, h => {
  assert.equal(h.get('startSelection').disabled, true); assert.equal(h.starts().length, 0);
}));

test('task revision conflict preserves draft and issues no implicit settings save', () => withHarness(async h => {
  h.server.startStatus = 409; await h.fire('startSelection');
  assert.equal(h.starts().length, 1); assert.deepEqual(h.starts()[0].body, { expected_revision: 'TEST-r1' });
  assert.match(h.get('taskError').textContent, /另一页面修改/);
  assert.equal(h.settingsPosts().length, 0);
}));

test('form lock still freezes controls and rejects start/reset while settings save is pending', () => withHarness(async h => {
  h.edit('seasonalNotes', 'TEST locked save');
  const gate = h.waitNext('POST', '/api/settings');
  const save = h.eval('save({preventDefault(){}})');
  try {
    assert.equal(h.eval('formLock.busy'), true);
    assert.ok([...h.nodes.values()].filter(node => ['INPUT','SELECT','TEXTAREA','BUTTON'].includes(node.tagName)).every(node => node.disabled));
    await h.eval("taskAction('start')");
    h.get('resetButton').dispatchEvent(new TestEvent('click'));
    assert.equal(h.get('seasonalNotes').value, 'TEST locked save');
    assert.equal(h.starts().length, 0); assert.equal(h.eval('formLock.busy'), true);
  } finally { gate.release(); await save; }
  await h.poll();
  assert.equal(h.eval('formLock.busy'), false); assert.equal(h.get('startSelection').disabled, false);
}));

test('pending task action retains the form lock and rejects a second start', () => withHarness(async h => {
  const gate = h.waitNext('POST', '/api/tasks/start');
  const first = h.eval("taskAction('start')");
  try {
    assert.equal(h.eval('formLock.busy'), true); assert.equal(h.get('startSelection').disabled, true);
    await h.eval("taskAction('start')");
    assert.equal(h.starts().length, 1); assert.equal(h.eval('formLock.busy'), true);
  } finally { gate.release(); await first; }
  assert.equal(h.eval('formLock.busy'), false);
}));

test('running task still disables start despite an equal untouched draft', () => withHarness({ tasks: [{ run_id: 'TEST-run', state: 'running', stage: 'discover', products: [], snapshot: { archive_date: 'TEST-date', seasonal_reference_date: 'TEST-reference', limits: { max_cart_additions: 3, max_candidates: 60, max_library_pages: 3 }, deadline: 'TEST-deadline', video_root: 'TEST-root' } }] }, h => {
  assert.equal(h.get('startSelection').disabled, true); assert.equal(h.get('pauseSelection').disabled, false); assert.equal(h.starts().length, 0);
}));
