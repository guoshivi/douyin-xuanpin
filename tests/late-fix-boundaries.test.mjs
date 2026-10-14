import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { defaultPolicy, policyToDraft, draftToPolicy, validateDraft, validatePolicy } from '../src/settings-model.mjs';
import { createSettingsServer } from '../src/settings-server.mjs';

async function fixture(t, directoryPicker = async () => null) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'late-fix-boundaries-'));
  const server = await createSettingsServer({root, directoryPicker});
  t.after(() => server.close());
  const get = () => fetch(new URL('/api/settings', server.url));
  const post = (route, body) => fetch(new URL(route, server.url), {
    method:'POST', headers:{'content-type':'application/json', origin:server.origin, 'x-csrf-token':server.csrf}, body:JSON.stringify(body)
  });
  return {server, get, post, file:path.join(root, 'config', 'selection.json')};
}

function specialDraft(key, value) {
  return JSON.parse(JSON.stringify({...policyToDraft(defaultPolicy()), [key]:value}));
}

test('特殊未知键的错误为自有可枚举数据属性，不改变任何对象原型', () => {
  for (const key of ['constructor', 'toString', '__proto__']) {
    for (const value of ['NONSECRET_SENTINEL', null, {late_fix_polluted:true}]) {
      const draft = specialDraft(key, value);
      const result = validateDraft(draft);
      assert.equal(result.valid, false);
      assert.deepEqual(Object.keys(result.errors), [key]);
      assert.equal(Object.getPrototypeOf(result.errors), Object.prototype);
      assert.deepEqual(Object.getOwnPropertyDescriptor(result.errors, key), {
        value:'未知或受保护字段', enumerable:true, writable:true, configurable:true
      });
      assert.equal(JSON.parse(JSON.stringify(result.errors))[key], '未知或受保护字段');
      assert.throws(() => draftToPolicy(draft));
      assert.equal(Object.hasOwn(Object.prototype, 'late_fix_polluted'), false);
    }
  }
});

test('规则结构错误逐项稳定返回，业务与重点指标要求完整唯一集合', () => {
  const badRules = defaultPolicy();
  badRules.rules = [null, [], 1, 'invalid'];
  badRules.numeric_filters_enabled = true;
  const result = validatePolicy(badRules);
  assert.equal(result.valid, false);
  assert.deepEqual(Object.keys(result.errors), ['rules[0]', 'rules[1]', 'rules[2]', 'rules[3]']);
  for (const modes of [['self_store', 'self_store'], ['affiliate', 'affiliate']]) {
    assert.equal(validatePolicy({...defaultPolicy(), business_modes:modes}).valid, false);
  }
  assert.equal(validatePolicy({...defaultPolicy(), business_modes:['self_store', 'affiliate']}).valid, true);
  assert.equal(validatePolicy({...defaultPolicy(), focus_metrics:['price', 'commission_amount', 'sales', 'conversion_rate']}).valid, false);
  assert.equal(validatePolicy({...defaultPolicy(), focus_metrics:['conversion_rate', 'sales', 'commission_rate', 'price']}).valid, true);
});

test('fraction两个边界仅接受0到1，增长率和佣金金额不误限', () => {
  const draft = {...policyToDraft(defaultPolicy()), commissionRatePercent:'12.5', conversionMinPercent:'2', conversionScope:'product', conversionDenominator:'paid_orders', minimumGrowthRatePercent:'250', commissionPerOrder:'250'};
  const base = draftToPolicy(draft);
  assert.equal(base.priorities.recent_surge.minimum_growth_rate, 2.5);
  assert.equal(base.priorities.recent_surge.recent_days, 7);
  assert.equal(base.priorities.recent_surge.baseline_days, 7);
  assert.equal(policyToDraft(base).commissionRatePercent, '12.5');
  for (const metric of ['commission_rate', 'conversion_rate']) {
    for (const key of ['min', 'max']) {
      for (const value of [null, 0, 1, -0.1, 1.01, 3]) {
        const policy = structuredClone(base);
        const rule = policy.rules.find(r => r.metric === metric);
        rule.min = null;
        rule.max = null;
        rule[key] = value;
        assert.equal(validatePolicy(policy).valid, value === null || (value >= 0 && value <= 1), `${metric}.${key}=${value}`);
      }
    }
  }
});

test('JSON草稿特殊未知键经HTTP拒绝，原配置字节与revision不变', async t => {
  const f = await fixture(t);
  const before = await (await f.get()).json();
  const bytes = await fs.readFile(f.file);
  for (const key of ['constructor', 'toString', '__proto__']) {
    const response = await f.post('/api/settings', {expected_revision:before.revision, draft:specialDraft(key, {late_fix_polluted:true})});
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.error, 'VALIDATION_ERROR');
    assert.equal(Object.hasOwn(body.errors, key), true);
    assert.equal(body.errors[key], '未知或受保护字段');
    assert.deepEqual(await fs.readFile(f.file), bytes);
    assert.equal((await (await f.get()).json()).revision, before.revision);
  }
});

async function partialPost(t, server) {
  let request;
  const received = new Promise(resolve => server.server.once('request', resolve));
  request = http.request(new URL('/api/settings', server.url), {
    method:'POST', headers:{'content-type':'application/json', origin:server.origin, 'x-csrf-token':server.csrf, 'content-length':'100'}
  });
  request.on('error', () => {});
  request.on('response', response => response.resume());
  t.after(() => request.destroy());
  request.write('{');
  await received;
  return request;
}

test('关闭共享原Promise、同步中止选择器、2秒内关闭半POST且隔离其它服务', {timeout:6000}, async t => {
  let pickerSignal;
  let pickerStarted;
  const started = new Promise(resolve => { pickerStarted = resolve; });
  const f = await fixture(t, ({signal}) => new Promise(resolve => {
    pickerSignal = signal;
    signal.addEventListener('abort', () => resolve(null), {once:true});
    pickerStarted();
  }));
  const other = await fixture(t);
  await partialPost(t, f.server);
  const otherPartial = await partialPost(t, other.server);
  const pendingPicker = f.post('/api/choose-video-directory', {});
  await started;
  const begin = performance.now();
  const first = f.server.close();
  assert.equal(pickerSignal.aborted, true);
  assert.equal(f.server.close(), first);
  const response = await pendingPicker;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {cancelled:true});
  await first;
  assert.ok(performance.now() - begin <= 2000, '真实关闭应在2秒内完成');
  assert.equal(f.server.server.listening, false);
  assert.equal(f.server.close(), first);
  assert.equal(otherPartial.socket.destroyed, false);
  assert.equal(other.server.server.listening, true);
  const readback = await other.get();
  assert.equal(readback.status, 200);
  await readback.json();
  otherPartial.destroy();
});
