import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { defaultPolicy, validatePolicy, validateDraft, policyToDraft, draftToPolicy } from '../src/settings-model.mjs';
import { createSettingsServer } from '../src/settings-server.mjs';

test('嵌套未知字段含非敏感凭据标记被拒绝，不能成为API配置', () => {
  for (const key of ['app_secret','token','constructor','__proto__']) {
    const p=defaultPolicy();p.feishu=JSON.parse(JSON.stringify(p.feishu).slice(0,-1)+`,"${key}":"NONSECRET_SENTINEL"}`);
    assert.equal(validatePolicy(p).valid,false,key);
  }
});
test('继承属性名不能绕过草稿未知字段拒绝', () => {
  for (const key of ['constructor','toString','__proto__']) {
    const d=JSON.parse(JSON.stringify(policyToDraft(defaultPolicy())).slice(0,-1)+`,"${key}":"NONSECRET_SENTINEL"}`);
    assert.equal(validateDraft(d).valid,false,key);
    assert.throws(()=>draftToPolicy(d));
  }
});
test('非法规则结构返回稳定校验结果，不解引用null或数组', () => {
  for (const r of [null,[],1,'invalid']) {
    const p=defaultPolicy();p.rules=[r];p.numeric_filters_enabled=true;
    assert.doesNotThrow(()=>validatePolicy(p));assert.equal(validatePolicy(p).valid,false);
  }
});
test('业务模式及重点指标不能使用重复项替代必需项', () => {
  const p=defaultPolicy();p.business_modes=['affiliate','affiliate'];assert.equal(validatePolicy(p).valid,false);
  const q=defaultPolicy();q.focus_metrics=['price','price','sales','conversion_rate'];assert.equal(validatePolicy(q).valid,false);
});
test('佣金率和转化率fraction不得超过1，增长率仍可超过1', () => {
  for (const metric of ['commission_rate','conversion_rate']) {
    const d=policyToDraft(defaultPolicy());d.commissionRatePercent='12.5';d.conversionMinPercent='2';d.conversionScope='product';d.conversionDenominator='paid_orders';
    const p=draftToPolicy(d);p.rules.find(r=>r.metric===metric).min=3;assert.equal(validatePolicy(p).valid,false,metric);
  }
  const d=policyToDraft(defaultPolicy());d.minimumGrowthRatePercent='250';assert.equal(validatePolicy(draftToPolicy(d)).valid,true);
});
test('并发关闭等待同一次真实关闭，半个请求不得无限拖住退出', {timeout:6000}, async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'late-close-'));
  const s=await createSettingsServer({root});
  let request;
  t.after(async()=>{request?.destroy();await s.close();});
  const socketReady=new Promise(resolve=>{
    request=http.request(new URL('/api/settings',s.url),{method:'POST',headers:{'content-type':'application/json',origin:s.origin,'x-csrf-token':s.csrf,'content-length':'100'}});
    request.on('error',()=>{});request.on('response',r=>r.resume());request.on('socket',socket=>socket.once('connect',resolve));request.write('{');
  });
  await socketReady;
  const first=s.close();let secondResolved=false;const second=s.close().then(()=>{secondResolved=true;});
  // 给异步关闭一次事件循环机会；不对实际耗时作假设。
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(secondResolved,false,'另一次close不能在首次关闭完成前提前返回');
  await Promise.race([Promise.all([first,second]),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('关闭超时')),2500);timer.unref();})]);
  assert.equal(s.server.listening,false);
});
