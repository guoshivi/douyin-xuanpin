// TEST ONLY: fake lark transport with v3-attested subshapes + VM UI stubs; isolated TEST SQLite/files.
// No real CLI/network/private/config/business call. Synthetic values only; this is not real-server acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {larkFixture, seedTableRow, seedProductAction, addImage, attempt, clone, MAIN_IMAGE_FIELD_ID, candidate, uiHarness, uiRoot, load} from './phase4-fix-cycle-v3-support.mjs';

const {publicTask} = await load('src/task-manager.mjs');
const {assertPublicSafe} = await load('src/public-safety.mjs');
const {productFields} = await load('src/feishu/sync.mjs');

function taskFixture(title){
  return {run_id:'TEST-public', state:'paused', stage:'discover', notes:[], summary:{},
    snapshot:{revision:'a'.repeat(64), archive_date:'2026-10-10', seasonal_reference_date:'2026-10-10', video_root:'/TEST/public-root', deadline:'2026-10-10T01:00:00Z', limits:{}},
    products:[{candidate:{...candidate(1), title}, videos:[], images:[]}]};
}

// ---------------------------------------------------------------------------
// F05: native manifest positive (v3 attested subshapes, synthetic values) + forged matrix.
test('F05 native positive: v3 subshape manifest passes exact readback and user auth with deep-equal stdout', async () => {
  const f = await larkFixture({native:true});
  await seedTableRow(f, productFields(f.args));
  try {
    const result = await attempt(() => f.sync.sync(f.args));
    assert.equal(result.accepted, true, result.error_code);
    assert.equal(result.result.verified, true);
    assert.equal(result.result.record_id, 'TEST-historical-record');
    assert.equal(f.calls.filter(c => c.op === '+record-list').length, 1);
    assert.equal(f.calls.filter(c => c.op === '+record-get').length, 1);
    assert.equal(f.calls.filter(c => c.op === 'auth-status').length, 2, 'each native read re-verifies the user auth');
    assert.equal(f.nativeChecks.length, 2);
    assert.ok(f.nativeChecks.every(x => x.stdoutEqualsDisk), 'TEST transport attests stdout deep-equals the artifact manifest');
    assert.equal(f.calls.filter(c => c.op === '+record-batch-create').length, 0);
    assert.equal(f.ledger.action(f.productKey).state, 'verified');
  } finally { f.close(); }
});

const FORGED = [
  ['record_file_size_bytes mismatch', 'FEISHU_NATIVE_MANIFEST_INVALID', {nativeMutate:(m, {reads}) => {if (reads === 1) m.record_file_size_bytes += 1; return m;}}],
  ['record_file path mismatch', 'FEISHU_NATIVE_MANIFEST_INVALID', {nativeMutate:(m, {reads}) => {if (reads === 1) m.record_file = 'TEST-elsewhere.ndjson'; return m;}}],
  ['columns projection missing requested field', 'EXACT_READBACK_MISMATCH', {nativeMutate:(m, {reads}) => {if (reads === 1) delete m.columns['商品名称']; return m;}}],
  ['has_more true', 'FEISHU_READ_INCOMPLETE', {nativeMutate:(m, {reads}) => {if (reads === 1) m.has_more = true; return m;}}],
  ['manifest_version wrong', 'FEISHU_NATIVE_MANIFEST_INVALID', {nativeMutate:(m, {reads}) => {if (reads === 1) m.manifest_version = 'v2'; return m;}}],
  ['base_token mismatch', 'FEISHU_NATIVE_MANIFEST_INVALID', {nativeMutate:(m, {reads}) => {if (reads === 1) m.base_token = 'TEST-other-base'; return m;}}],
  ['query_context missing', 'FEISHU_NATIVE_MANIFEST_INVALID', {nativeMutate:(m, {reads}) => {if (reads === 1) delete m.query_context; return m;}}],
  ['rev missing', 'FEISHU_NATIVE_MANIFEST_INVALID', {nativeMutate:(m, {reads}) => {if (reads === 1) m.rev = null; return m;}}],
  ['stdout differs from artifact manifest', 'EXACT_READBACK_MISMATCH', {stdoutMutate:(r, {reads}) => {if (reads === 1) r.rev = 3; return r;}}],
  ['stderr injected error JSON', 'FEISHU_USER_OPERATION_FAILED', {stderrLine:'{"ok":false,"error":"TEST_INJECTED_ERROR"}'}],
  ['wrapped ok false envelope', 'FEISHU_USER_OPERATION_FAILED', {readEnvelope:'failed'}],
  ['wrapped bot identity envelope', 'FEISHU_USER_OPERATION_FAILED', {readEnvelope:'bot'}],
];
for (const [label, code, options] of FORGED) {
  test(`F05 forged manifest rejects ${label}`, async () => {
    const f = await larkFixture({native:options.readEnvelope === undefined, ...options});
    try {
      const result = await attempt(() => f.sync.sync(f.args));
      assert.equal(result.accepted, false, 'forged transport must never be accepted');
      assert.equal(result.error_code, code);
      assert.equal(f.calls.filter(c => c.op === '+record-batch-create').length, 0);
      assert.equal(f.calls.filter(c => c.op === '+record-upload-attachment').length, 0);
      assert.equal(f.calls.filter(c => c.op === 'auth-status').length, 0);
      assert.equal(f.ledger.action(f.productKey), null);
    } finally { f.close(); }
  });
}

// ---------------------------------------------------------------------------
// F06: stable attachment field_id binding between upload call and receipt indexing.
test('F06 positive: manifest field_id drives the upload call and receipt indexing with exact token binding', async () => {
  const f = await larkFixture({seedProduct:true});
  const image = await addImage(f);
  try {
    const result = await attempt(() => f.sync.sync(f.args));
    assert.equal(result.accepted, true, result.error_code);
    assert.equal(result.result.verified, true);
    const uploads = f.calls.filter(c => c.op === '+record-upload-attachment');
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].field, MAIN_IMAGE_FIELD_ID, 'upload uses the stable field id from the manifest');
    const row = f.tables.get(f.target.product_table_id)[0];
    assert.equal(row['主图'].length, 1);
    assert.equal(row['主图'][0].file_token, 'TEST-upload-token-0');
    assert.equal(row['主图'][0].name, image.sha256 + '.jpg');
    assert.equal(row['主图'][0].size, image.bytes);
    const action = f.ledger.action(f.imagesKey(image));
    assert.equal(action.state, 'verified');
    assert.equal(action.result.attachments.length, 1);
    assert.equal(action.result.attachments[0].file_token, 'TEST-upload-token-0');
    const again = await attempt(() => f.sync.sync({...f.args, reconcileOnly:true}));
    assert.equal(again.accepted, true, again.error_code);
    assert.equal(again.result.verified, true);
    assert.equal(f.calls.filter(c => c.op === '+record-upload-attachment').length, 1, 'no duplicate upload on reconcile');
  } finally { f.close(); }
});

test('F06 negative: receipt keyed by display name instead of stable field_id is rejected', async () => {
  const f = await larkFixture({seedProduct:true, uploadReceipt:'display'});
  await addImage(f);
  try {
    const result = await attempt(() => f.sync.sync(f.args));
    assert.equal(result.accepted, false);
    assert.equal(result.error_code, 'FEISHU_ATTACHMENT_RECEIPT_INVALID');
    const uploads = f.calls.filter(c => c.op === '+record-upload-attachment');
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].field, MAIN_IMAGE_FIELD_ID);
    assert.equal(f.ledger.action(f.imagesKey(f.args.images[0])).state, 'uncertain');
    const retry = await attempt(() => f.sync.sync({...f.args, reconcileOnly:true}));
    assert.equal(retry.accepted, false);
    assert.equal(retry.error_code, 'FEISHU_ATTACHMENT_UNCERTAIN');
    assert.equal(f.calls.filter(c => c.op === '+record-upload-attachment').length, 1, 'no blind re-upload');
  } finally { f.close(); }
});

test('F06 negative: tokenless name/size-only receipt is rejected with no blind re-upload', async () => {
  const f = await larkFixture({seedProduct:true, uploadTokens:false});
  await addImage(f);
  try {
    const result = await attempt(() => f.sync.sync(f.args));
    assert.equal(result.accepted, false);
    assert.equal(result.error_code, 'FEISHU_ATTACHMENT_RECEIPT_INVALID');
    assert.equal(f.ledger.action(f.imagesKey(f.args.images[0])).state, 'uncertain');
    const retry = await attempt(() => f.sync.sync({...f.args, reconcileOnly:true}));
    assert.equal(retry.accepted, false);
    assert.equal(f.calls.filter(c => c.op === '+record-upload-attachment').length, 1, 'no blind re-upload');
  } finally { f.close(); }
});

for (const [label, columnsMode] of [['absent columns', 'none'], ['ambiguous field id', 'ambiguous'], ['malformed field id', 'malformed']]) {
  test(`F06 negative: ${label} fails closed before any upload`, async () => {
    const f = await larkFixture({seedProduct:true, columnsMode});
    const image = await addImage(f);
    try {
      const result = await attempt(() => f.sync.sync(f.args));
      assert.equal(result.accepted, false, 'unresolvable field id must fail closed');
      assert.equal(result.error_code, 'FEISHU_ATTACHMENT_FIELD_UNRESOLVED');
      assert.equal(f.calls.filter(c => c.op === '+record-upload-attachment').length, 0);
      assert.equal(f.ledger.action(f.imagesKey(image)), null, 'no uncertain action is created before the upload decision');
    } finally { f.close(); }
  });
}

test('F06 positive: historical exact token reuse stays verified with zero re-upload', async () => {
  const f = await larkFixture({seedProduct:true});
  const image = await addImage(f);
  try {
    const receipt = [{file_token:'TEST-HISTORY-TOKEN-0', name:image.sha256 + '.jpg', size:image.bytes}];
    const row = f.tables.get(f.target.product_table_id)[0];
    row['主图'] = clone(receipt);
    const key = f.imagesKey(image);
    f.ledger.begin(key, 'TEST-history', 'feishu_image_upload', {business_key:key});
    f.ledger.commit(key, {record_id:row.record_id, image_count:1, field_id:MAIN_IMAGE_FIELD_ID, attachments:receipt, verified:true});
    const before = clone(f.ledger.action(key));
    const result = await attempt(() => f.sync.sync({...f.args, reconcileOnly:true}));
    assert.equal(result.accepted, true, result.error_code);
    assert.equal(result.result.verified, true);
    assert.deepEqual(f.ledger.action(key), before, 'historical verified action is unchanged');
    assert.equal(f.calls.filter(c => c.op === '+record-upload-attachment').length, 0);
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// F07: historical field snapshot must cover the whole frozen contract before any current success.
test('F07 negative: incomplete historical fields block current success and preserve history', async () => {
  const f = await larkFixture();
  try {
    const full = productFields(f.args);
    const partial = {'推广ID':f.args.candidate.commodity_id};
    await seedProductAction(f, {fields:partial, rowValues:{...full, '商品名称':'TEST错误商品名称'}});
    const before = clone(f.ledger.action(f.productKey));
    const result = await attempt(() => f.sync.sync({...f.args, reconcileOnly:true}));
    assert.equal(result.accepted, false, 'partial historical fields must not publish current success');
    assert.equal(result.error_code, 'FEISHU_HISTORICAL_CONTRACT_MISSING');
    assert.deepEqual(f.ledger.action(f.productKey), before, 'history stays verified and unchanged');
    assert.equal(f.ledger.action(f.productKey).state, 'verified');
    assert.deepEqual(f.ledger.action(f.productKey).result.fields, partial);
    assert.equal(f.calls.filter(c => ['+record-batch-create','+record-upload-attachment'].includes(c.op)).length, 0);
    const missing = Object.keys(full).filter(k => !Object.hasOwn(partial, k));
    assert.equal(missing.length, Object.keys(full).length - 1);
  } finally { f.close(); }
});

test('F07 positive: complete frozen fields verify exact readback and stay reused', async () => {
  const f = await larkFixture();
  try {
    const full = productFields(f.args);
    await seedProductAction(f, {fields:full});
    const before = clone(f.ledger.action(f.productKey));
    const result = await attempt(() => f.sync.sync({...f.args, reconcileOnly:true}));
    assert.equal(result.accepted, true, result.error_code);
    assert.equal(result.result.verified, true);
    assert.equal(result.result.record_id, 'TEST-historical-record');
    assert.deepEqual(f.ledger.action(f.productKey), before);
  } finally { f.close(); }
});

test('F07 negative: complete historical fields with a mutated remote value block exact readback', async () => {
  const f = await larkFixture();
  try {
    const full = productFields(f.args);
    await seedProductAction(f, {fields:full, rowValues:{...full, '商品名称':'TEST错误商品名称'}});
    const before = clone(f.ledger.action(f.productKey));
    const result = await attempt(() => f.sync.sync({...f.args, reconcileOnly:true}));
    assert.equal(result.accepted, false);
    assert.equal(result.error_code, 'FEISHU_PROPAGATION_UNCONFIRMED');
    assert.deepEqual(f.ledger.action(f.productKey), before);
    assert.equal(f.calls.filter(c => ['+record-batch-create','+record-upload-attachment'].includes(c.op)).length, 0);
  } finally { f.close(); }
});

// ---------------------------------------------------------------------------
// F09: bounded-decode and fragment boundaries at the public DTO / archive guard / Feishu field exits.
const SENTINELS = [
  ['encoded assignment', 'TEST中文说明 access%5Ftoken%3DTEST_ENCODED_SENTINEL'],
  ['double-encoded assignment', 'TEST中文说明 access%255Ftoken%253DTEST_ENC_SENTINEL'],
  ['sensitive fragment', 'TEST中文说明 https://www.douyin.com/video/7000000000000000001#token=TEST_FRAGMENT_SENTINEL'],
  ['combined', 'TEST中文说明 access%5Ftoken%3DTEST_ENCODED_SENTINEL https://www.douyin.com/video/7000000000000000001#token=TEST_FRAGMENT_SENTINEL'],
];
for (const [label, text] of SENTINELS) {
  test(`F09 negative: ${label} rejected at public DTO, archive guard and Feishu fields`, async () => {
    assert.throws(() => publicTask(taskFixture(text)), {code:'PUBLIC_SECRET_REJECTED'}, 'public DTO exit');
    assert.throws(() => assertPublicSafe({candidate:{...candidate(1), title:text}, videos:[], images:[], video_uploaded_to_feishu:false}),
      {code:'PUBLIC_SECRET_REJECTED'}, 'archive guard exit');
    const f = await larkFixture();
    try {
      f.args.candidate.title = text;
      const result = await attempt(() => f.sync.sync(f.args));
      assert.equal(result.accepted, false, 'Feishu fields exit');
      assert.equal(result.error_code, 'PUBLIC_SECRET_REJECTED');
      assert.equal(f.calls.length, 0, 'no CLI call for rejected public text');
      assert.equal(f.tables.get(f.target.product_table_id).length, 0);
    } finally { f.close(); }
  });
}

test('F09 positive: Chinese text, product decision link and video link pass all three exits', async () => {
  const link = 'https://buyin.jinritemai.com/dashboard/merch-picking-library/merch-promoting?id=1000000000000000001&commodity_id=1000000000000000001&product_id=2000000000000000001';
  const text = 'TEST合法中文商品 视频 https://www.douyin.com/video/7000000000000000001 决策页 ' + link;
  const dto = publicTask(taskFixture(text));
  assert.equal(dto.products[0].title, text);
  assertPublicSafe({candidate:{...candidate(1), title:text}, videos:[], images:[], video_uploaded_to_feishu:false});
  const f = await larkFixture();
  try {
    f.args.candidate.title = text;
    await seedProductAction(f, {fields:productFields(f.args)});
    const result = await attempt(() => f.sync.sync(f.args));
    assert.equal(result.accepted, true, result.error_code);
    assert.equal(result.result.verified, true);
    assert.equal(f.tables.get(f.target.product_table_id)[0]['商品名称'], text);
  } finally { f.close(); }
});

test('F09 positive: benign percent text decodes safely without crash or false rejection', () => {
  for (const text of ['折扣50% 说明', '进度100%25 完成', '编码%2F安全', '描述 access 与 token 为普通词']) {
    assert.equal(assertPublicSafe(text), text);
    assert.equal(publicTask(taskFixture(text)).products[0].title, text);
    assert.equal(assertPublicSafe([{nested:[text]}]).length, 1);
  }
});

// ---------------------------------------------------------------------------
// UI: chooser completion recompute + revision-conflict notice persistence.
async function withUi(options, callback){
  if (typeof options === 'function') { callback = options; options = {}; }
  const h = await uiHarness(options);
  try { await callback(h); } finally { await h.close(); }
}

test('UI chooser completion recomputes start state and preserves the unsaved guard', () => withUi(async h => {
  await h.fire('chooseVideoDirectory');
  assert.equal(h.get('videoSaveRoot').value, path.join(uiRoot, 'TEST-picked-directory-not-created'));
  assert.match(h.get('directoryStatus').textContent, /点击“保存配置”后生效/);
  assert.equal(h.get('startSelection').disabled, true, 'unsaved draft after the chooser disables start immediately');
  const before = h.starts().length;
  await h.eval("taskAction('start')");
  assert.equal(h.starts().length, before, 'direct invocation cannot bypass the unsaved guard');
  assert.match(h.get('taskError').textContent, /有未保存修改/);
  assert.equal(h.settingsPosts().length, 0, 'guard never silently saves');
}));

test('UI chooser cancel and failure recompute start state without side effects', async () => {
  for (const chooser of ['cancelled', 'error']) {
    await withUi({chooser}, async h => {
      await h.fire('chooseVideoDirectory');
      if (chooser === 'cancelled') assert.match(h.get('directoryStatus').textContent, /已取消选择/);
      else assert.match(h.get('directoryStatus').textContent, /无法完成文件夹选择/);
      assert.equal(h.get('startSelection').disabled, false, 'clean draft keeps start enabled after ' + chooser);
      assert.equal(h.starts().length, 0);
      assert.equal(h.settingsPosts().length, 0);
    });
  }
});

test('UI task revision conflict notice persists across renders until success or reload', async () => {
  await withUi(async h => {
    h.server.startStatus = 409;
    await h.fire('startSelection');
    assert.equal(h.starts().length, 1);
    assert.match(h.get('taskError').textContent, /另一页面修改/);
    await h.poll();
    assert.match(h.get('taskError').textContent, /另一页面修改/, 'notice survives the task poll render');
    await h.fire('reloadButton');
    await h.poll();
    assert.equal(h.get('taskError').textContent, '', 're-reading the configuration clears the notice');
    h.server.startStatus = 409;
    await h.fire('startSelection');
    assert.match(h.get('taskError').textContent, /另一页面修改/);
    h.server.startStatus = 200;
    await h.fire('startSelection');
    assert.equal(h.get('taskError').textContent, '', 'successful action clears the notice');
    assert.equal(h.settingsPosts().length, 0, 'no implicit settings save');
  });
});
