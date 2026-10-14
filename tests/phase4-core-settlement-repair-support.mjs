// TEST-only exact SQLite faults and tiny protected media; preserve every artifact.
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {defaultPolicy} from '../src/settings-model.mjs';
import {createTaskManager} from '../src/task-manager.mjs';
import {testAdapter} from './phase4-support.mjs';
export const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
export const work=process.env.SETTLEMENT_WORK_ROOT;
assert.ok(work&&path.isAbsolute(work)&&work.includes('/core-only-ledger-public-repair-v1/'));
assert.ok(process.env.TMPDIR.startsWith(work));
export const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
export const encode=x=>Array.from(Buffer.from(x)).map(c=>'%'+c.toString(16).padStart(2,'0')).join('');
export function sql(file,fn){const db=new DatabaseSync(file);try{return fn(db);}finally{db.close();}}
export function rows(file){return sql(file,db=>({assets:db.prepare('SELECT * FROM assets ORDER BY asset_key').all(),actions:db.prepare("SELECT * FROM actions WHERE state='verified' ORDER BY action_key").all()}));}
export async function files(t){const out={};for(const p of t.products??[])for(const v of [...p.videos,...p.images])if(v.state==='verified')out[v.relative_path]=hash(await fs.readFile(path.join(t.snapshot.video_root,v.relative_path)));return out;}
export async function runCase({coreOnly=true,kind,mutation,phase='cart',title,unavailable=false,resume=false}={}){
 const root=await fs.mkdtemp(path.join(work,'TEST-settle-')),dbPath=path.join(root,'TEST.sqlite'),policy=defaultPolicy();policy.storage.video_root=path.join(root,'archive');
 const a=await testAdapter();a.candidates.splice(1);if(title)a.candidates[0].title=title;
 a.calls.readFeishu=0;const remote=a.readFeishu;a.readFeishu=async function(...args){a.calls.readFeishu++;if(coreOnly)throw Error('TEST_FORBIDDEN_FEISHU');return remote.apply(a,args);};if(coreOnly)a.syncFeishu=async()=>{a.calls.sync++;throw Error('TEST_FORBIDDEN_FEISHU');};
 if(unavailable){const freeze=a.freezeVideos;a.freezeVideos=async function(...args){const x=await freeze.apply(a,args);for(const v of x.videos)delete v.bytes;return x;};a.downloadVideo=async()=>({unavailable:true,reason:'TEST明确无可用视频'});}
 const m=createTaskManager({projectRoot:root,dbPath,coreOnly});let reads=0,before,after,injected=false,task,originalFiles={};
 const inject=()=>{sql(dbPath,db=>{const row=db.prepare('SELECT * FROM assets WHERE kind=? ORDER BY asset_key LIMIT 1').get(kind);assert.ok(row);if(mutation==='missing')db.prepare('DELETE FROM assets WHERE asset_key=?').run(row.asset_key);else if(mutation==='key')db.prepare('UPDATE assets SET asset_key=? WHERE asset_key=?').run(row.asset_key+':TEST_WRONG',row.asset_key);else if(mutation.startsWith('sql-')){const col=mutation.slice(4);assert.ok(['kind','path','sha256'].includes(col));db.prepare('UPDATE assets SET '+col+'=? WHERE asset_key=?').run('TEST_WRONG',row.asset_key);}else{let meta=JSON.parse(row.metadata_json);if(mutation==='bad-json')meta=null;else if(mutation==='null')meta=null;else if(mutation.startsWith('missing-'))delete meta[mutation.slice(8)];else meta[mutation.slice(5)]=mutation==='meta-bytes'?meta.bytes+1:'TEST_WRONG';db.prepare('UPDATE assets SET metadata_json=? WHERE asset_key=?').run(mutation==='bad-json'?'{':JSON.stringify(meta),row.asset_key);}});injected=true;before=rows(dbPath);for(const a of before.actions){const r=JSON.parse(a.result_json);if(r?.relative_path)originalFiles[r.relative_path]=hash(syncFs.readFileSync(path.join(policy.storage.video_root,r.relative_path)));}};
 const cart=a.readCart;a.readCart=async function(...args){if(++reads===3&&mutation&&phase==='cart')inject();return cart.apply(a,args);};const finish=a.finish;a.finish=async function(...args){if(mutation&&phase==='finish')inject();return finish.apply(a,args);};
 try{task=await(await m.start({policy,revision:'a'.repeat(64),adapter:a,testMode:true})).done;after=rows(dbPath);const fileBefore=await files(task);if(resume){const oldCalls={...a.calls};const again=await(await m.resume(task.run_id,{adapter:a,testMode:true})).done;assert.notEqual(again.state,'completed');assert.equal(a.calls.add,oldCalls.add);assert.equal(a.calls.download,oldCalls.download);assert.equal(a.calls.finish,oldCalls.finish);assert.deepEqual(rows(dbPath).assets,after.assets);assert.deepEqual(rows(dbPath).actions,after.actions);assert.deepEqual(await files(again),fileBefore);task=again;}
 for(const [rel,sha]of Object.entries(originalFiles))assert.equal(hash(await fs.readFile(path.join(policy.storage.video_root,rel))),sha);
 const result={root,task,calls:a.calls,injected,before,after,fileBefore};if(before){assert.deepEqual(after.assets,before.assets);assert.deepEqual(after.actions.filter(x=>x.kind!=='browser_finish'),before.actions);}
 if(coreOnly){assert.equal(a.calls.sync,0);assert.equal(a.calls.readFeishu,0);}return result;
 }finally{await m.close();await assert.rejects(fs.access(path.join(root,'.selection.lock')));sql(dbPath,()=>{});await fs.writeFile(path.join(root,'cleanup.json'),JSON.stringify({manager_closed:true,database_closed:true,lockAbsent:true}),{flag:'wx',mode:0o600});}
}
