import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath,pathToFileURL} from 'node:url';
const source=path.resolve(process.env.INTERMEDIATE_SOURCE_ROOT??path.join(path.dirname(fileURLToPath(import.meta.url)),'..'));
const work=process.env.INTERMEDIATE_WORK_ROOT??process.env.TMPDIR;
assert.ok(work&&path.isAbsolute(work)&&work.includes('/选品/data/acceptance/'),'only explicit isolated project TEST roots');
await fs.mkdir(work,{recursive:true,mode:0o700});
const load=rel=>import(pathToFileURL(path.join(source,rel)).href);
const {assertPublicSafe}=await load('src/public-safety.mjs');
const {createTaskManager,publicTask}=await load('src/task-manager.mjs');
const {defaultPolicy}=await load('src/settings-model.mjs');
const {testAdapter}=await load('tests/phase4-support.mjs');
const whole=text=>[...text].map(c=>'%'+c.charCodeAt(0).toString(16).padStart(2,'0').toUpperCase()).join('');
const encoded=(text,layers)=>{for(let i=0;i<layers;i++)text=whole(text);return 'TEST中文 '+text;};
const base='https://www.douyin.com/video/7000000000000000001';
const escapes=['%20','%09','%0A','%0D','%3C','%3E','%22','%27','%60'];
const dto=title=>({run_id:'TEST-intermediate',state:'paused',stage:'discover',notes:[],snapshot:{execution_mode:'core_only',revision:'a'.repeat(64),archive_date:'2026-10-10',seasonal_reference_date:'2026-10-10',video_root:'/TEST/public-root',deadline:'2026-10-10T05:00:00Z',limits:{}},products:[{candidate:{commodity_id:'1000000000000000001',promotion_id:'1000000000000000001',product_id:'2000000000000000001',title},videos:[],images:[]}]});
const rejected=e=>e?.code==='PUBLIC_SECRET_REJECTED';
const evidence=[],cleanup=[];
for(const escape of escapes)for(const type of ['fragment','query'])for(const layer of [1,2])test(`intermediate-private-${type}-${escape}-outer-${layer}`,()=>{
 const suffix=type==='fragment'?'#token=TEST_SENTINEL':'?token=TEST_SENTINEL',text=encoded(base+escape+suffix,layer);
 assert.throws(()=>assertPublicSafe({title:text}),rejected);assert.throws(()=>publicTask(dto(text)),rejected);
});
for(const escape of escapes)for(const layer of [1,2])test(`intermediate-public-${escape}-outer-${layer}`,()=>{
 const text=encoded(base+escape+'?from=TEST#section=one',layer),object={title:text};
 assert.strictEqual(assertPublicSafe(object),object);assert.equal(publicTask(dto(text)).products[0].title,text);
});
for(const text of ['普通中文与公开说明','测试进度50%与%ZZ保留',base+'%20?from=TEST#section=one'])test(`intermediate-plain-positive-${text}`,()=>{
 assert.equal(assertPublicSafe({title:text}).title,text);assert.equal(publicTask(dto(text)).products[0].title,text);
});
async function pipeline(id,{field,escape='%20',privateValue=true}){
 const root=await fs.mkdtemp(path.join(work,'TEST-'+id+'-'));const policy=defaultPolicy();policy.storage.video_root=path.join(root,'archive');
 const adapter=await testAdapter();adapter.candidates.splice(1);const text=encoded(base+escape+(privateValue?'#token=TEST_SENTINEL':'?from=TEST#section=one'),1);
 const originalFreeze=adapter.freezeVideos;if(field==='candidate')adapter.candidates[0].title=text;else adapter.freezeVideos=async x=>{const f=await originalFreeze(x);f.videos.forEach(v=>v.title=text);return f;};
 adapter.syncFeishu=adapter.readFeishu=async()=>{throw Error('TEST_FEISHU_MUST_NOT_BE_CALLED');};
 const dbPath=path.join(root,'TEST.sqlite');const manager=createTaskManager({projectRoot:root,dbPath,coreOnly:true});let db;
 try{
  const started=await manager.start({policy,revision:'a'.repeat(64),adapter,testMode:true,now:new Date('2026-10-10T04:00:00Z')});const task=await started.done;
  db=new DatabaseSync(dbPath,{readOnly:true});const rows=db.prepare("SELECT path FROM assets WHERE kind='data'").all();
  const actual={id,state:task.state,error_code:task.error_code,finish:adapter.calls.finish,add:adapter.calls.add,sync:adapter.calls.sync,data_files:rows.length,root};evidence.push(actual);
  if(privateValue){assert.equal(task.state,'blocked');assert.equal(task.error_code,'PUBLIC_SECRET_REJECTED');assert.equal(adapter.calls.finish,0);assert.equal(rows.length,0);if(field==='candidate')assert.equal(adapter.calls.add,0);}
  else {assert.equal(task.state,'completed');assert.equal(adapter.calls.finish,1);assert.equal(rows.length,1);publicTask(task);const data=JSON.parse(await fs.readFile(rows[0].path,'utf8'));assert.equal(field==='candidate'?data.candidate.title:data.videos[0].title,text);}
  assert.equal(adapter.calls.sync,0);
 }finally{
  db?.close();await manager.close();let absent;try{await fs.access(path.join(root,'.selection.lock'));absent=false;}catch(e){absent=e.code==='ENOENT';}
  cleanup.push({id,root,sqlite_closed:true,manager_closed:true,lock_absent:absent});assert.equal(absent,true);
 }
}
for(const field of ['candidate','data'])for(const escape of ['%20','%09','%3C'])test(`intermediate-${field}-private-${escape}`,()=>pipeline(`${field}-private-${escape}`,{field,escape}));
for(const field of ['candidate','data'])test(`intermediate-${field}-public-mixed-path`,()=>pipeline(`${field}-public-mixed-path`,{field,privateValue:false}));
after(async()=>{
 const bindings={};for(const rel of ['src/public-safety.mjs','src/safety.mjs','src/task-manager.mjs','src/pipeline.mjs','src/ledger.mjs','src/settings-model.mjs','tests/phase4-support.mjs'])bindings[rel]={url:pathToFileURL(path.join(source,rel)).href,sha256:crypto.createHash('sha256').update(await fs.readFile(path.join(source,rel))).digest('hex')};
 await fs.writeFile(path.join(work,'test-evidence.json'),JSON.stringify({source,probe_sha256:crypto.createHash('sha256').update(await fs.readFile(fileURLToPath(import.meta.url))).digest('hex'),bindings,evidence,cleanup},null,2),{flag:'wx',mode:0o600});
});
