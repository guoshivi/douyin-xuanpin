import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSettingsServer } from '../src/settings-server.mjs';
const gate=()=>{let release;const promise=new Promise(r=>release=r);return {promise,release};};
async function setup(t,picker=async()=>null){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'settings-race-'));
  const s=await createSettingsServer({projectRoot:root,directoryPicker:picker});
  t.after(()=>s.close());
  const get=async()=>(await fetch(new URL('/api/settings',s.url))).json();
  const post=(pathname,payload)=>fetch(new URL(pathname,s.url),{method:'POST',headers:{'content-type':'application/json',origin:s.origin,'x-csrf-token':s.csrf},body:JSON.stringify(payload)});
  return {root,s,get,post,file:path.join(root,'config','selection.json')};
}

test('交错 GET 与保存：草稿和 revision 来自同一份字节，旧草稿不能覆盖新视频目录', {timeout:5000}, async t=>{
  const f=await setup(t), before=await f.get();
  const reached=gate(), resume=gate(); const original=fs.readFile; let intercept=true;
  fs.readFile=async function(file,...args){
    const bytes=await original.call(this,file,...args);
    if(String(file)===f.file&&intercept){intercept=false;reached.release();await resume.promise;}
    return bytes;
  };
  t.after(()=>{fs.readFile=original;resume.release();});
  try {
    const oldGet=f.get(); await reached.promise;
    const chosen=path.join(f.root,'新视频目录');
    const saved=await f.post('/api/settings',{expected_revision:before.revision,draft:{...before.draft,videoSaveRoot:chosen}});
    assert.equal(saved.status,200); await saved.json(); resume.release();
    const snapshot=await oldGet;
    assert.equal(snapshot.policy.storage.video_root,before.policy.storage.video_root);
    assert.equal(snapshot.revision,before.revision,'旧内容必须搭配旧 revision，不能混入新 revision');
    const stale=await f.post('/api/settings',{expected_revision:snapshot.revision,draft:{...snapshot.draft,seasonalNotes:'另一次普通编辑'}});
    assert.equal(stale.status,409);
    assert.equal((await f.get()).policy.storage.video_root,chosen);
  } finally {fs.readFile=original;resume.release();}
});

test('写入同步失败：旧配置保留且本次临时文件不遗留', async t=>{
  const f=await setup(t), before=await f.get(), original=fs.open, bytes=await fs.readFile(f.file);
  fs.open=async function(file,...args){const handle=await original.call(this,file,...args);if(String(file).startsWith(path.dirname(f.file)+path.sep)&&String(file).endsWith('.tmp'))handle.sync=async()=>{throw new Error('测试夹具：同步失败');};return handle;};
  try {
    const response=await f.post('/api/settings',{expected_revision:before.revision,draft:{...before.draft,seasonalNotes:'不能落盘'}});
    assert.equal(response.status,500);
    assert.deepEqual(await fs.readFile(f.file),bytes);
    assert.deepEqual((await fs.readdir(path.dirname(f.file))).filter(name=>name.endsWith('.tmp')),[]);
  } finally {fs.open=original;}
});

test('选择器忙碌拒绝重入；关服发送中止信号，配置字节不改变', {timeout:5000}, async t=>{
  const started=gate(); let signal; let calls=0;
  const f=await setup(t,options=>new Promise(resolve=>{calls++;signal=options.signal;signal.addEventListener('abort',()=>resolve(null),{once:true});started.release();}));
  const bytes=await fs.readFile(f.file);
  const pending=f.post('/api/choose-video-directory',{}); await started.promise;
  assert.equal((await f.post('/api/choose-video-directory',{})).status,409);assert.equal(calls,1);
  const closing=f.s.close();assert.equal(signal.aborted,true);
  const result=await pending;assert.equal(result.status,200);await result.json();await closing;
  assert.deepEqual(await fs.readFile(f.file),bytes);
});
