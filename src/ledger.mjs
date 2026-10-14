import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {openStore} from './store.mjs';
import {failure,verifyReadback} from './verifier.mjs';
export function openLedger(file,{faults={}}={}) {
 const old=openStore(file);old.close();fs.chmodSync(file,0o600);const db=new DatabaseSync(file);
 db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS task_runs(run_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS task_controls(run_id TEXT PRIMARY KEY,pause_requested INTEGER NOT NULL)");let closed=false;
 const getAction=key=>{const r=db.prepare('SELECT * FROM actions WHERE action_key=?').get(key);return r?{...r,payload:JSON.parse(r.payload_json),result:r.result_json?JSON.parse(r.result_json):null}:null;};
 function transaction(fn){db.exec('BEGIN IMMEDIATE');try{fn();faults.beforeCommit?.();db.exec('COMMIT');}catch(e){try{db.exec('ROLLBACK');}catch{}throw failure('LEDGER_COMMIT_FAILED');}faults.afterCommit?.();}
 return {
  save(task){db.prepare('INSERT INTO task_runs VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at').run(task.run_id,JSON.stringify(task),new Date().toISOString());return this.get(task.run_id);},
  get(id){const r=db.prepare('SELECT payload_json FROM task_runs WHERE run_id=?').get(id);return r?JSON.parse(r.payload_json):null;},
  list(){return db.prepare('SELECT payload_json FROM task_runs ORDER BY updated_at DESC').all().map(r=>JSON.parse(r.payload_json));},
  action:getAction,
  asset(key){try{const r=db.prepare('SELECT asset_key,kind,path,sha256,metadata_json,verified_at FROM assets WHERE asset_key=?').get(key);return r?{...r,metadata:JSON.parse(r.metadata_json)}:null;}catch{throw failure('ASSET_LEDGER_READBACK_FAILED');}},
  requestPause(id,value=true){db.prepare('INSERT INTO task_controls VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET pause_requested=excluded.pause_requested').run(id,value?1:0);},
  pauseRequested(id){return db.prepare('SELECT pause_requested FROM task_controls WHERE run_id=?').get(id)?.pause_requested===1;},
  begin(key,run,kind,payload){const old=getAction(key);if(old){if(old.kind!==kind)throw failure('ACTION_KEY_CONFLICT');for(const k of ['commodity_id','product_id','aweme_id','business_key'])if(payload[k]!=null&&old.payload[k]!=null&&payload[k]!==old.payload[k])throw failure('ACTION_KEY_CONFLICT');return {fresh:false,...old};}transaction(()=>db.prepare('INSERT INTO actions(action_key,run_id,kind,state,payload_json,result_json,updated_at) VALUES(?,?,?,?,?,?,?)').run(key,run,kind,'uncertain',JSON.stringify(payload),null,new Date().toISOString()));const r=getAction(key);if(r?.state!=='uncertain')throw failure('LEDGER_READBACK_FAILED');return {fresh:true,...r};},
  commit(key,result,{asset,remote}={}){
   result=JSON.parse(JSON.stringify(result));if(asset)asset=JSON.parse(JSON.stringify(asset));
   const prior=getAction(key);if(!prior)throw failure('ACTION_NOT_FOUND');if(prior.state==='verified'){verifyReadback(prior.result,result);return prior.result;}
   transaction(()=>{
    const stamp=new Date().toISOString();if(prior.state!=='uncertain')throw failure('ACTION_CHECKPOINT_REQUIRED');
    if(asset)db.prepare('INSERT INTO assets(asset_key,kind,path,sha256,metadata_json,verified_at) VALUES(?,?,?,?,?,?)').run(key,asset.kind,asset.path,asset.sha256,JSON.stringify(asset),stamp);
    if(remote){const ex=db.prepare('SELECT * FROM remote_records WHERE base_id=? AND table_id=? AND business_key=?').get(remote.base_id,remote.table_id,remote.business_key);if(ex&&ex.record_id!==remote.record_id)throw failure('REMOTE_RECORD_CONFLICT');if(!ex)db.prepare('INSERT INTO remote_records VALUES(?,?,?,?,?)').run(remote.base_id,remote.table_id,remote.business_key,remote.record_id,stamp);}
    db.prepare("UPDATE actions SET state='verified',result_json=?,updated_at=? WHERE action_key=? AND state='uncertain'").run(JSON.stringify(result),stamp,key);
   });
   faults.readback?.();const a=getAction(key);if(a?.state!=='verified')throw failure('LEDGER_READBACK_FAILED');verifyReadback(result,a.result);
   if(asset){const r=db.prepare('SELECT * FROM assets WHERE asset_key=?').get(key);if(!r)throw failure('LEDGER_READBACK_FAILED');verifyReadback(asset,JSON.parse(r.metadata_json));}
   if(remote){const r=this.remote(remote);if(!r||r.record_id!==remote.record_id)throw failure('LEDGER_READBACK_FAILED');}return a.result;
  },
  receipt(key,result){db.prepare("UPDATE actions SET result_json=?,updated_at=? WHERE action_key=? AND state='uncertain'").run(JSON.stringify(result),new Date().toISOString(),key);},
  remote({base_id,table_id,business_key}){return db.prepare('SELECT * FROM remote_records WHERE base_id=? AND table_id=? AND business_key=?').get(base_id,table_id,business_key)??null;},
  pending(run){return db.prepare("SELECT action_key FROM actions WHERE state='uncertain' AND run_id=?").all(run).map(x=>x.action_key);},
  close(){if(!closed){closed=true;db.close();}}
 };
}
