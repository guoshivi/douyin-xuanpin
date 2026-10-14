import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createSettingsServer } from '../src/settings-server.mjs';
import { defaultPolicy } from '../src/settings-model.mjs';

async function fixtureRoot() { const root=await fs.mkdtemp(path.join(os.tmpdir(),'selection-settings-')); await fs.mkdir(path.join(root,'config')); await fs.mkdir(path.join(root,'ui')); await fs.writeFile(path.join(root,'config','selection.json'),JSON.stringify(defaultPolicy(),null,2)+'\n'); await fs.writeFile(path.join(root,'ui','settings.html'),'<!doctype html><meta name="csrf-token" content="__CSRF_TOKEN__"><body>settings</body>'); await fs.writeFile(path.join(root,'ui','settings.css'),'body{}'); await fs.writeFile(path.join(root,'ui','settings.mjs'),'export {};'); return root; }
async function start(t,root){try{return await createSettingsServer({projectRoot:root});}catch(e){if(e.code==='EPERM'){t.skip('当前受限执行环境禁止绑定 loopback 端口');return null;}throw e;}}
// Node fetch 会忽略 Host 覆盖；安全测试必须发送真实原始 HTTP 请求。
async function req(base,pathname,options={}) {
  return new Promise((resolve,reject) => {
    const request = http.request(new URL(pathname,base), {method:options.method||'GET',headers:options.headers}, response => {
      const chunks=[];
      response.on('data',chunk=>chunks.push(chunk));
      response.on('error',reject);
      response.on('end',()=>{
        const body=Buffer.concat(chunks).toString('utf8');
        resolve({status:response.statusCode,json:async()=>JSON.parse(body),text:async()=>body});
      });
    });
    request.on('error',reject);
    request.setTimeout(10000,()=>request.destroy(new Error('测试 HTTP 请求超时')));
    request.end(options.body);
  });
}

test('settings-load-config',async t=>{const s=await start(t,await fixtureRoot());if(!s)return;t.after(()=>s.close());const r=await req(s.url,'/api/settings');assert.equal(r.status,200);const b=await r.json();assert.equal(b.policy.schema_version,2);assert.equal(b.revision.length,64);assert.deepEqual(b.categories,[]);});
test('settings-save-readback',async t=>{const root=await fixtureRoot(),s=await start(t,root);if(!s)return;t.after(()=>s.close());const g=await (await req(s.url,'/api/settings')).json(),d={...g.draft,seasonalNotes:'测试'};const r=await req(s.url,'/api/settings',{method:'POST',headers:{'content-type':'application/json',origin:s.origin,'x-csrf-token':s.csrf},body:JSON.stringify({expected_revision:g.revision,draft:d})});assert.equal(r.status,200);const b=await r.json();assert.equal(b.policy.priorities.seasonal.notes,'测试');const onDisk=JSON.parse(await fs.readFile(path.join(root,'config','selection.json'),'utf8'));assert.equal(onDisk.priorities.seasonal.notes,'测试');});
test('settings-invalid-preserves-file',async t=>{const root=await fixtureRoot(),before=await fs.readFile(path.join(root,'config','selection.json'),'utf8'),s=await start(t,root);if(!s)return;t.after(()=>s.close());const g=await (await req(s.url,'/api/settings')).json(),r=await req(s.url,'/api/settings',{method:'POST',headers:{'content-type':'application/json',origin:s.origin,'x-csrf-token':s.csrf},body:JSON.stringify({expected_revision:g.revision,draft:{...g.draft,maxCartAdditions:''}})});assert.equal(r.status,422);assert.equal(await fs.readFile(path.join(root,'config','selection.json'),'utf8'),before);});
test('settings-stale-revision-409-and-concurrent',async t=>{const root=await fixtureRoot(),s=await start(t,root);if(!s)return;t.after(()=>s.close());const g=await (await req(s.url,'/api/settings')).json(),headers={'content-type':'application/json',origin:s.origin,'x-csrf-token':s.csrf},one=req(s.url,'/api/settings',{method:'POST',headers,body:JSON.stringify({expected_revision:g.revision,draft:{...g.draft,seasonalNotes:'one'}})}),two=req(s.url,'/api/settings',{method:'POST',headers,body:JSON.stringify({expected_revision:g.revision,draft:{...g.draft,seasonalNotes:'two'}})}),statuses=(await Promise.all([one,two])).map(r=>r.status).sort();assert.deepEqual(statuses,[200,409]);});
test('settings-loopback-host-origin-csrf-content-type',async t=>{const root=await fixtureRoot(),s=await start(t,root);if(!s)return;t.after(()=>s.close());const g=await (await req(s.url,'/api/settings')).json(),body=JSON.stringify({expected_revision:g.revision,draft:g.draft});for(const [name,headers] of [['host',{'host':'localhost:'+s.port,'origin':s.origin,'content-type':'application/json','x-csrf-token':s.csrf}],['origin',{'origin':'http://evil.test','content-type':'application/json','x-csrf-token':s.csrf}],['csrf',{'origin':s.origin,'content-type':'application/json'}],['type',{'origin':s.origin,'content-type':'text/plain','x-csrf-token':s.csrf}]]){const r=await req(s.url,'/api/settings',{method:'POST',headers,body});assert.equal(r.status,403,name);}});
test('settings-static-path-whitelist-and-private',async t=>{const root=await fixtureRoot();await fs.writeFile(path.join(root,'secret.txt'),'x');const s=await start(t,root);if(!s)return;t.after(()=>s.close());assert.equal((await req(s.url,'/secret.txt')).status,404);assert.equal((await req(s.url,'/../secret.txt')).status,404);});
test('settings-body-size-bound-and-json-error',async t=>{const s=await start(t,await fixtureRoot());if(!s)return;t.after(()=>s.close());const headers={'origin':s.origin,'content-type':'application/json','x-csrf-token':s.csrf};assert.equal((await req(s.url,'/api/settings',{method:'POST',headers,body:'x'.repeat(33000)})).status,413);assert.equal((await req(s.url,'/api/settings',{method:'POST',headers,body:'{'})).status,400);});
test('settings-close-releases-listener',async t=>{const s=await start(t,await fixtureRoot());if(!s)return;const headers={'origin':s.origin,'content-type':'application/json','x-csrf-token':s.csrf};const r=await req(s.url,'/api/close',{method:'POST',headers,body:'{}'});assert.equal(r.status,200);await new Promise(r=>setTimeout(r,80));await assert.rejects(fetch(new URL('/api/settings',s.url)));});
test('settings-restart-reads-actual-file',async t=>{const root=await fixtureRoot(),first=await start(t,root);if(!first)return;const before=await (await req(first.url,'/api/settings')).json();await first.close();const second=await start(t,root);if(!second)return;t.after(()=>second.close());const after=await (await req(second.url,'/api/settings')).json();assert.equal(after.revision,before.revision);assert.deepEqual(after.policy,before.policy);});
