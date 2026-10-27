import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateVideoRoot, getVideoRoot, DEFAULT_VIDEO_ROOT } from '../src/storage-settings.mjs';
import { defaultPolicy, policyToDraft, draftToPolicy, validatePolicy } from '../src/settings-model.mjs';
import { createSettingsServer } from '../src/settings-server.mjs';

async function fixture(t, picker) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-root-settings-'));
  await fs.mkdir(path.join(root, 'ui'));
  await fs.writeFile(path.join(root, 'ui', 'settings.html'), '<meta name="csrf-token" content="__CSRF_TOKEN__">');
  const server = await createSettingsServer({projectRoot:root, directoryPicker:picker});
  t.after(() => server.close());
  const get = async () => (await fetch(new URL('/api/settings', server.url))).json();
  const post = (route, body, authorized=true) => fetch(new URL(route, server.url), {
    method:'POST', headers:{'content-type':'application/json', origin:server.origin, ...(authorized ? {'x-csrf-token':server.csrf} : {})}, body:JSON.stringify(body)
  });
  return {root, server, get, post};
}

test('保存目录兼容旧配置，默认不变', () => {
  const old = defaultPolicy(); delete old.storage;
  assert.equal(getVideoRoot(old), DEFAULT_VIDEO_ROOT);
  assert.equal(policyToDraft(old).videoSaveRoot, DEFAULT_VIDEO_ROOT);
  assert.equal(validatePolicy(old).valid, true);
});
test('本机与 NAS 中文路径逐字保留，不擅自标准化', () => {
  for (const root of ['/Users/example/Movies/选品 视频', '/Volumes/选品素材/自选素材/']) {
    assert.equal(validateVideoRoot(root), root);
    const draft = {...policyToDraft(defaultPolicy()), videoSaveRoot:root};
    const policy = draftToPolicy(draft);
    assert.equal(policy.storage.video_root, root);
    assert.equal(policyToDraft(policy).videoSaveRoot, root);
  }
});
test('拒绝空、相对路径、网络 URI、控制字符和点段，不写目录', () => {
  for (const root of ['', '  ', null, 0, '../视频', '~/Movies', 'smb://server/share', '/', '/Users/x/../y', '/Users/x/./y', '/Users/x\n坏路径', '/Users/x\u0000']) {
    assert.throws(() => validateVideoRoot(root));
    assert.throws(() => draftToPolicy({...policyToDraft(defaultPolicy()), videoSaveRoot:root}));
  }
});
test('目录改动与其它配置一起原子保存，重启仍读回；不创建目标目录', async t => {
  const f = await fixture(t, async () => null);
  const before = await f.get();
  const chosen = path.join(f.root, '中文 视频目标');
  const response = await f.post('/api/settings', {expected_revision:before.revision, draft:{...before.draft,videoSaveRoot:chosen}});
  assert.equal(response.status, 200);
  const after = await f.get();
  const disk = JSON.parse(await fs.readFile(path.join(f.root, 'config', 'selection.json'), 'utf8'));
  assert.equal(after.draft.videoSaveRoot, chosen);
  assert.equal(after.policy.storage.video_root, chosen);
  assert.deepEqual(after.policy, disk);
  await assert.rejects(fs.stat(chosen), {code:'ENOENT'});
  await f.server.close();
  const restarted = await createSettingsServer({projectRoot:f.root}); t.after(() => restarted.close());
  assert.equal((await (await fetch(new URL('/api/settings', restarted.url))).json()).draft.videoSaveRoot, chosen);
});
test('非法目录不影响磁盘配置', async t => {
  const f = await fixture(t, async () => null); const before = await f.get();
  const file = path.join(f.root, 'config', 'selection.json'); const bytes = await fs.readFile(file);
  const response = await f.post('/api/settings', {expected_revision:before.revision, draft:{...before.draft, videoSaveRoot:'../视频'}});
  assert.equal(response.status, 422);
  assert.deepEqual(await fs.readFile(file), bytes);
});
test('选择文件夹仅改变草稿，取消不改配置；无授权不弹选择器', async t => {
  let calls = 0; let picked = '/Users/example/Movies/中文 视频';
  const f = await fixture(t, async () => {calls++; return picked;}); const before = await f.get();
  assert.equal((await f.post('/api/choose-video-directory', {}, false)).status, 403); assert.equal(calls, 0);
  assert.equal((await f.post('/api/choose-video-directory', {path:'/other'})).status, 422); assert.equal(calls, 0);
  const selected = await f.post('/api/choose-video-directory', {}); assert.equal(selected.status, 200);
  assert.equal((await selected.json()).path, picked);
  assert.equal((await f.get()).revision, before.revision);
  picked = null;
  assert.equal((await (await f.post('/api/choose-video-directory', {})).json()).cancelled, true);
  assert.equal((await f.get()).revision, before.revision);
});
