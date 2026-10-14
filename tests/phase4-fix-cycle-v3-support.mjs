// TEST ONLY support for the third bounded repair round: fake lark transport, VM UI harness,
// isolated TEST SQLite/files. No real CLI/network/private/config access, no persistent services.
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {pathToFileURL, fileURLToPath} from 'node:url';

export const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const clone = x => JSON.parse(JSON.stringify(x));
export async function waitUntil(fn){for(let n=0;n<400;n++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('TEST_WAIT_TIMEOUT');}

export const sourceRoot = process.env.PHASE4_FIX_SOURCE_ROOT || fileURLToPath(new URL('../', import.meta.url));
export const workRoot = process.env.PHASE4_FIX_WORK_ROOT;
assert.ok(workRoot && path.isAbsolute(workRoot) && workRoot.includes('/phase4-web-integration-20261010T1442/core-review-repair-v2/'),
  'TEST work must stay inside the authorized core-review-repair-v2 evidence root');
await fs.mkdir(workRoot, {recursive:true});
export const load = relative => import(pathToFileURL(path.join(sourceRoot, relative)));
export async function newCase(label){return fs.mkdtemp(path.join(workRoot, 'TEST-' + label + '-'));}

// Synthetic stable attachment field id: v3-attested shape is prefix fld + length 10. Not a real id.
export const MAIN_IMAGE_FIELD_ID = 'fldMAIN001';
export const candidate = (n=1) => ({commodity_id:'100000000000000000'+n, promotion_id:'100000000000000000'+n, product_id:'200000000000000000'+n,
  title:'TEST合法中文商品'+n, category_ids:[], metrics:{}, seasonal_evidence:[]});

const NUMBER_FIELDS = new Set(['视频应有数','视频已保存数','视频不可用数']);
// v3-attested column subshape: key = record_id + selected field names; non record_id columns carry
// stable field_id/field_type/physical_type (values here are synthetic).
export function v3Columns(fields, {attachmentFieldId = MAIN_IMAGE_FIELD_ID} = {}){
  const columns = {record_id:{physical_type:'string', stats:{max_length:16}, example:'TEST-record-000001'}};
  fields.forEach((name, index) => {
    columns[name] = name === '主图'
      ? {field_id:attachmentFieldId, field_type:'attachment', physical_type:'array<struct<file_token string, size number, name string>>', stats:{empty_count:0}, example:[], example_truncated:true}
      : {field_id:'fld'+String(index + 2).padStart(7, '0'), field_type:NUMBER_FIELDS.has(name)?'number':'text', physical_type:NUMBER_FIELDS.has(name)?'number|null':'string|null', stats:{}, example:NUMBER_FIELDS.has(name)?10:'TEST'};
  });
  return columns;
}

// Fake lark-cli transport. Reads can answer with the v3-attested native manifest (no ok/identity
// wrapper) or the wrapped envelope; writes always answer with the wrapped envelope.
// options:
//   native            true -> reads answer native manifests (v3 subshape), false -> wrapped envelope record reads
//   readEnvelope      'ok' | 'failed' | 'bot'   (wrapped read envelope)
//   stderrLine        injected stderr line on reads
//   columnsMode       'ok' | 'none' | 'ambiguous' | 'malformed'  (wrapped manifest columns)
//   uploadReceipt     'field_id' | 'display' | 'missing'
//   uploadTokens      true -> receipt/cell entries carry file_token
//   seedProduct       call seedProductAction after creating the fixture
//   nativeMutate      fn(manifest,{op,fields,reads}) -> mutated manifest applied to BOTH disk and stdout
//   stdoutMutate      fn(responseClone,{op,fields,reads}) -> mutated stdout only
export async function larkFixture({native=false, readEnvelope='ok', stderrLine=null, columnsMode='ok', uploadReceipt='field_id', uploadTokens=true, seedProduct=false, nativeMutate=null, stdoutMutate=null}={}){
  const root = await newCase('lark');
  const privateRoot = path.join(root, 'TEST-runtime');
  await fs.mkdir(privateRoot);
  const target = {base_id:'TEST-base', product_table_id:'TEST-products', video_table_id:'TEST-videos'};
  const targetFile = path.join(root, 'TEST-target.json');
  await fs.writeFile(targetFile, JSON.stringify(target), {flag:'wx', mode:0o600});
  const {openLedger} = await load('src/ledger.mjs');
  const {createFeishuSync, productFields} = await load('src/feishu/sync.mjs');
  const ledger = openLedger(path.join(root, 'TEST.sqlite'));
  const tables = new Map([[target.product_table_id, []], [target.video_table_id, []]]);
  const calls = [];
  const nativeChecks = [];
  let seq = 0, reads = 0;
  const runner = async (command, args, {cwd}) => {
    assert.equal(command, 'TEST-FAKE-LARK-NO-EXEC');
    assert.equal(cwd, root);
    const val = k => args[args.indexOf(k) + 1];
    if (args[0] === 'auth') {
      calls.push({op:'auth-status', field:null});
      return {stdout:JSON.stringify({appId:'TEST-app', brand:'TEST-brand', defaultAs:'user', identity:'user', verified:true, identities:{
        bot:{status:'available', available:true, verified:false, message:'', openId:'TEST-bot-openid', appName:'TEST-app-name'},
        user:{status:'ready', available:true, verified:true, message:'', openId:'TEST-user-openid', userName:'TEST-user-name', tokenStatus:'valid', scope:'TEST-scope', expiresAt:'TEST-expires', refreshExpiresAt:'TEST-refresh-expires', grantedAt:'TEST-granted'}}}), stderr:''};
    }
    assert.equal(val('--as'), 'user');
    const op = args[1];
    calls.push({op, field:args.includes('--field-id') ? val('--field-id') : null});
    const table = val('--table-id');
    const rows = tables.get(table);
    if (op === '+record-batch-create') {
      const fields = JSON.parse(val('--json')).create_records[0];
      const record = {...fields, record_id:'TEST-rec-' + (++seq)};
      rows.push(record);
      return {stdout:JSON.stringify({ok:true, identity:'user', data:{record_id_list:[record.record_id]}}), stderr:''};
    }
    if (op === '+record-upload-attachment') {
      const record = rows.find(x => x.record_id === val('--record-id'));
      const fieldIdArg = val('--field-id');
      const files = args.flatMap((x, i) => x === '--file' ? [args[i + 1]] : []);
      record['主图'] = await Promise.all(files.map(async (f, i) => ({
        ...(uploadTokens ? {file_token:'TEST-upload-token-' + i} : {}),
        name:path.basename(f),
        size:(await fs.stat(path.join(cwd, f))).size,
      })));
      const attachments = uploadReceipt === 'missing' ? undefined : {
        [record.record_id]: {[uploadReceipt === 'display' ? '主图' : fieldIdArg]: record['主图']},
      };
      return {stdout:JSON.stringify({ok:true, identity:'user', data:{attachments}}), stderr:''};
    }
    if (op === '+record-get' || op === '+record-list') {
      reads += 1;
      const fields = args.flatMap((x, i) => x === '--field-id' ? [args[i + 1]] : []);
      const selected = op === '+record-get'
        ? rows.filter(x => args.includes(x.record_id))
        : rows.filter(x => {const [k, , v] = JSON.parse(val('--filter-json')).conditions[0]; return x[k] === v;});
      const result = selected.map(r => ({record_id:r.record_id, ...Object.fromEntries(fields.filter(k => Object.hasOwn(r, k)).map(k => [k, r[k]]))}));
      const dest = path.join(cwd, val('--output'));
      const manifestPath = dest.replace(/\.ndjson$/, '.manifest.json');
      const bytes = Buffer.from(result.map(x => JSON.stringify(x)).join('\n'));
      let response;
      if (native) {
        let manifest = {manifest_version:'v1', format:'ndjson', base_token:target.base_id, table_id:table, rev:2,
          timezone:'Asia/Shanghai', query_context:{field_scope:'selected_fields', record_scope:'filtered_records'},
          requested_limit:2, records_count:result.length, page_count:1, has_more:false,
          record_file:val('--output'), record_file_size_bytes:bytes.length,
          manifest_file:path.relative(cwd, manifestPath), columns:v3Columns(fields)};
        if (nativeMutate) manifest = nativeMutate(clone(manifest), {op, fields, reads}) ?? manifest;
        await fs.writeFile(dest, bytes, {flag:'wx', mode:0o600});
        await fs.writeFile(manifestPath, JSON.stringify(manifest), {flag:'wx', mode:0o600});
        response = stdoutMutate ? (stdoutMutate(clone(manifest), {op, fields, reads}) ?? clone(manifest)) : clone(manifest);
        const disk = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        nativeChecks.push({op, reads, stdoutEqualsDisk:isDeepStrictEqual(disk, response)});
      } else {
        const columns = columnsMode === 'none' ? undefined
          : columnsMode === 'ambiguous' ? {'主图':{field_id:MAIN_IMAGE_FIELD_ID}, '副图':{field_id:MAIN_IMAGE_FIELD_ID}}
          : columnsMode === 'malformed' ? {'主图':{field_id:'主图-image-id'}}
          : {'主图':{field_id:MAIN_IMAGE_FIELD_ID}};
        const manifest = {records_count:result.length, has_more:false, ...(columns ? {columns} : {})};
        await fs.writeFile(dest, bytes, {flag:'wx', mode:0o600});
        await fs.writeFile(manifestPath, JSON.stringify(manifest), {flag:'wx', mode:0o600});
        response = readEnvelope === 'failed' ? {ok:false, identity:'bot', data:{}}
          : readEnvelope === 'bot' ? {ok:true, identity:'bot'}
          : {ok:true, identity:'user'};
      }
      return {stdout:JSON.stringify(response), stderr:stderrLine ? stderrLine + '\n' : ''};
    }
    throw Error('TEST_UNEXPECTED_OP ' + op);
  };
  const snapshot = {run_id:'TEST-run', archive_date:'2026-10-10', video_root:path.join(root, 'archive')};
  const args = {candidate:clone(candidate(1)), snapshot, context:null, videos:[], images:[],
    ctx:{ledger, snapshot:{run_id:'TEST-run'}, remaining:() => 90000, checkpoint(){}, signal:new AbortController().signal}};
  const f = {root, privateRoot, target, targetFile, ledger, tables, calls, args, nativeChecks,
    productKey:'feishu:product:' + target.base_id + ':' + args.candidate.commodity_id,
    imagesKey(image){return 'feishu:images:' + target.base_id + ':' + args.candidate.commodity_id + ':' + image.sha256;},
    sync:createFeishuSync({projectRoot:root, privateRoot, targetFile, command:'TEST-FAKE-LARK-NO-EXEC', runner}),
    close(){ledger.close();}};
  if (seedProduct) await seedProductAction(f, {fields:productFields(args)});
  return f;
}

export async function seedTableRow(f, fields){
  const row = {...fields, record_id:'TEST-historical-record'};
  f.tables.get(f.target.product_table_id).push(row);
  return row;
}

export async function seedProductAction(f, {fields, rowValues=null}){
  const {productFields} = await load('src/feishu/sync.mjs');
  const row = {...(rowValues ?? productFields(f.args)), record_id:'TEST-historical-record'};
  f.tables.get(f.target.product_table_id).push(row);
  const payload = {base_id:f.target.base_id, table_id:f.target.product_table_id, business_key:f.args.candidate.commodity_id};
  f.ledger.begin(f.productKey, 'TEST-history', 'feishu_product_create', payload);
  f.ledger.commit(f.productKey, {record_id:row.record_id, fields:clone(fields), verified:true}, {remote:{...payload, record_id:row.record_id}});
  return row;
}

export async function addImage(f){
  const bytes = Buffer.from('TEST_SYNTHETIC_IMAGE_BYTES_NOT_MEDIA_PROBE ' + path.basename(f.root));
  await fs.mkdir(f.args.snapshot.video_root, {recursive:true});
  const relative_path = 'TEST-image-' + sha(Buffer.from(f.root)) + '.jpg';
  await fs.writeFile(path.join(f.args.snapshot.video_root, relative_path), bytes, {flag:'wx', mode:0o600});
  const image = {relative_path, sha256:sha(bytes), bytes:bytes.length};
  f.args.images = [image];
  return image;
}

export async function attempt(fn){try{return {accepted:true, result:await fn()};}catch(e){return {accepted:false, error_code:e.code ?? e.message};}}

// ---------------------------------------------------------------------------
// UI harness: executes the unchanged frontend body in a VM with explicit DOM/network stubs.
// Copied for this round's new cases only; tests/phase4-ui-draft.test.mjs stays untouched.
export const uiRoot = process.env.PHASE4_FIX_UI_ROOT || sourceRoot;
class TestEvent {
  constructor(type) { this.type = type; this.defaultPrevented = false; }
  preventDefault() { this.defaultPrevented = true; }
}
function deferred() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
export async function uiHarness({ draft, revision = 'TEST-r1', catalog = [{id:'TEST-A', name:'测试甲'}, {id:'TEST-B', name:'测试乙'}], tasks = [], chooser = 'path' } = {}) {
  const sourcePath = path.join(uiRoot, 'ui/settings.mjs');
  const source = await fs.readFile(sourcePath, 'utf8');
  const html = await fs.readFile(path.join(uiRoot, 'ui/settings.html'), 'utf8');
  const { formatSeconds, localizeError, createFormLock } = await import(pathToFileURL(path.join(uiRoot, 'ui/display.mjs')));
  const importLine = "import { formatSeconds, localizeError, createFormLock } from '/display.mjs';";
  assert.ok(source.startsWith(importLine), 'only the actual display import is substituted by its real module exports');
  const frontend = new vm.Script(source.slice(importLine.length), {filename:sourcePath});
  const scalarFields = ['seasonalEnabled','seasonalReferenceDate','seasonalNotes','recentSurgeEnabled','recentDays','baselineDays','minimumGrowthRatePercent','priceMin','priceMax','priceBasis','commissionRatePercent','commissionPerOrder','salesPeriod','salesMin','conversionScope','conversionDenominator','conversionMinPercent','conversionMinSample','missingDataStrategy','maxCartAdditions','maxLibraryPages','maxCandidates','videoSaveRoot'];
  const apiFields = ['seasonalEnabled','videoSaveRoot','seasonalReferenceDate','seasonalNotes','recentSurgeEnabled','recentDays','baselineDays','minimumGrowthRatePercent','includeCategories','excludeCategories','priceMin','priceMax','priceBasis','commissionRatePercent','commissionPerOrder','salesPeriod','salesMin','conversionScope','conversionDenominator','conversionMinPercent','conversionMinSample','missingDataStrategy','maxCartAdditions','maxLibraryPages','maxCandidates'];
  const apiOrder = d => Object.fromEntries(apiFields.map(field => [field, structuredClone(d[field])]));
  const baseDraft = draft ?? apiOrder({seasonalEnabled:true, seasonalReferenceDate:'', seasonalNotes:'TEST ONLY', recentSurgeEnabled:false,
    recentDays:'7', baselineDays:'7', minimumGrowthRatePercent:'', priceMin:'', priceMax:'', priceBasis:'', commissionRatePercent:'', commissionPerOrder:'',
    salesPeriod:'', salesMin:'', conversionScope:'', conversionDenominator:'', conversionMinPercent:'', conversionMinSample:'', missingDataStrategy:'decision_page',
    maxCartAdditions:'3', maxLibraryPages:'3', maxCandidates:'60', videoSaveRoot:path.join(uiRoot, 'TEST-video-root-not-created'), includeCategories:[], excludeCategories:[]});
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
  const server = { draft: structuredClone(baseDraft), revision, catalog: structuredClone(catalog), tasks: structuredClone(tasks), postStatus: 200, startStatus: 200 };
  const pickedPath = path.join(uiRoot, 'TEST-picked-directory-not-created');
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
    if (url === '/api/choose-video-directory' && method === 'POST') {
      if (chooser === 'cancelled') return response(200, { cancelled: true });
      if (chooser === 'error') return response(500, { error: 'FOLDER_PICKER_FAILED' });
      return response(200, { path: pickedPath });
    }
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
