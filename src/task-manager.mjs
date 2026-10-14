import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {validatePolicy} from './settings-model.mjs';
import {getVideoRoot} from './storage-settings.mjs';
import {acquireLock} from './safety.mjs';
import {captureStorageIdentity,noLinks} from './storage.mjs';
import {openLedger} from './ledger.mjs';
import {executePipeline,summarize} from './pipeline.mjs';
import {createProductionAdapter} from './browser/actions.mjs';
import {failure,safeCode} from './verifier.mjs';
import {assertPublicSafe} from './public-safety.mjs';
import {projectedProductLink} from './product-links.mjs';
export function publicTask(t){if(!t)return null;const mode=t.snapshot.execution_mode??'integrated',coreOnly=mode==='core_only';const out={run_id:t.run_id,state:t.state,stage:t.stage,error_code:t.error_code??null,notes:t.notes??[],snapshot:{execution_mode:mode,revision:t.snapshot.revision,archive_date:t.snapshot.archive_date,seasonal_reference_date:t.snapshot.seasonal_reference_date,video_root:t.snapshot.video_root,deadline:t.snapshot.deadline,limits:t.snapshot.limits},summary:{...(t.summary??summarize(t)),...(coreOnly?{feishu_verified:0}:{})},products:(t.products??[]).map(p=>({commodity_id:p.candidate.commodity_id,promotion_id:p.candidate.promotion_id,product_id:p.candidate.product_id,title:p.candidate.title??'',source_url:projectedProductLink(p.candidate),reason:p.candidate.provisional_reason??p.decision?.reason??null,cart_verified:p.cart?.verified===true,feishu_status:coreOnly?'disabled':p.feishu?.verified===true?'verified':'pending',feishu_verified:!coreOnly&&p.feishu?.verified===true,videos:(p.videos??[]).map(v=>({aweme_id:v.aweme_id,state:v.state,reason:v.reason??null,duration_seconds:v.duration_seconds??null,quality:v.quality??null})),images_verified:(p.images??[]).filter(x=>x.state==='verified').length}))};const {snapshot:publicSnapshot,...body}=out;assertPublicSafe(body);assertPublicSafe(publicSnapshot);return out;}
export function freezeSnapshot(policy,revision,now,{coreOnly=false}={}){if(typeof coreOnly!=='boolean')throw failure('TASK_OPTION_INVALID');if(policy?.confirmed!==true)throw failure('POLICY_NOT_CONFIRMED');if(typeof revision!=='string'||!/^[a-f0-9]{64}$/.test(revision))throw failure('REVISION_INVALID');
 if(!Number.isSafeInteger(policy.limits?.max_run_minutes)||policy.limits.max_run_minutes<=0)throw failure('POLICY_INVALID');const capped=structuredClone(policy);capped.limits.max_cart_additions=Math.min(policy.limits.max_cart_additions,3);const minutes=Math.min(policy.limits.max_run_minutes,30);capped.limits.max_run_minutes=30;if(!validatePolicy(capped).valid)throw failure('POLICY_INVALID');capped.limits.max_run_minutes=minutes;
 const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(now);return {execution_mode:coreOnly?'core_only':'integrated',revision,policy:structuredClone(policy),limits:capped.limits,archive_date:date,seasonal_reference_date:policy.priorities.seasonal.reference_date??date,video_root:getVideoRoot(policy),started_at:now.toISOString(),deadline:new Date(now.getTime()+minutes*60000).toISOString()};}
export function createTaskManager({projectRoot=process.cwd(),dbPath=path.join(projectRoot,'data/state.sqlite'),faults={},coreOnly=false}={}){
 if(typeof coreOnly!=='boolean')throw failure('TASK_OPTION_INVALID');
 projectRoot=path.resolve(projectRoot);let ledger,active=null,closed=false;const db=()=>ledger??=openLedger(dbPath,{faults});
 const assertOpen=()=>{if(closed)throw failure('TASK_MANAGER_CLOSED');};
 const load=id=>{const t=db().get(id);if(!t)throw failure('TASK_NOT_FOUND');return t;};
 function launch(task,adapter,testMode,now){const reconcileOnly=task.state==='completed';const startedReal=Date.now(),base=testMode&&now?now.getTime():startedReal,clock=()=>base+Date.now()-startedReal;const ctl=new AbortController();const job={task,ctl,requested:false,inFlight:false,lock:active?.lock};active=job;
 const privateRoot=path.join(projectRoot,'data/private/runtime',task.run_id);const save=t=>db().save(t);
 const ctx={storageFaults:faults.storage,snapshot:task.snapshot,ledger:db(),signal:ctl.signal,get inFlight(){return job.inFlight;},set inFlight(v){job.inFlight=v;},remaining:()=>clock()>=Date.parse(task.snapshot.deadline)?90000:Math.max(1,Date.parse(task.snapshot.deadline)-clock()),
  checkRead(){if(job.requested&&!job.inFlight)throw failure('TASK_PAUSED');},
  checkpoint({allowPause=false}={}){if(job.requested&&!allowPause)throw failure('TASK_PAUSED');if(clock()>=Date.parse(task.snapshot.deadline))throw failure('RUN_DEADLINE_EXPIRED');if(reconcileOnly)throw failure('RECONCILE_ONLY');},
  note(code){if(!task.notes.includes(code))task.notes.push(code);save(task);},
  async read(fn){this.checkRead();let timer,abort;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{abort=()=>reject(failure('TASK_PAUSED'));if(ctl.signal.aborted)return abort();ctl.signal.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>reject(failure('READ_TIMEOUT')),Math.min(90000,this.remaining()));})]);}finally{clearTimeout(timer);ctl.signal.removeEventListener('abort',abort);}}
 };
 db().requestPause(task.run_id,false);task.state='running';task.error_code=null;save(task);
 const controlPoll=setInterval(()=>{if(db().pauseRequested(task.run_id)){job.requested=true;if(!job.inFlight)ctl.abort();}},100);
 const done=(async()=>{let resolvedAdapter=adapter;
  try{await noLinks(privateRoot);await fs.mkdir(privateRoot,{recursive:true,mode:0o700});if(!resolvedAdapter)resolvedAdapter=createProductionAdapter({projectRoot,privateRoot,browserState:task.browser,onBrowserState:state=>{task.browser=structuredClone(state);save(task);}});if(resolvedAdapter.mode==='test'&&!testMode)throw failure('TEST_ADAPTER_NOT_ALLOWED');await executePipeline(task,{adapter:resolvedAdapter,ledger:db(),privateRoot,ctx,save});}
  catch(e){const code=safeCode(e);task.error_code=code;task.state=code==='TASK_PAUSED'?'paused':code==='RUN_DEADLINE_EXPIRED'?'expired':code.includes('UNCERTAIN')||db().pending(task.run_id).length?'uncertain':['USER_OWNED_OR_INACTIVE','BROWSER_BLOCKED','LIBRARY_NOT_READY','COMPASS_EMPTY_NOT_PROVEN','METADATA_PERMISSION_DENIED'].includes(code)?'needs_input':code==='MEDIA_FAILED'?'needs_review':'blocked';task.summary=summarize(task);save(task);if(task.state!=='paused'&&task.state!=='completed'&&resolvedAdapter?.handoff&&code!=='USER_OWNED_OR_INACTIVE'){try{await resolvedAdapter.handoff({snapshot:task.snapshot,ctx});}catch{ctx.note('HANDOFF_NOT_CONFIRMED');}}}
  finally{clearInterval(controlPoll);try{job.lock?.release();}catch{task.state='uncertain';task.error_code='LOCK_RELEASE_UNCONFIRMED';save(task);}if(active===job)active=null;}
  return structuredClone(task);
 })();job.done=done;return {run_id:task.run_id,done,task:publicTask(task)};
 }
 return {
  async start({policy,revision,adapter,testMode=false,now=new Date()}={}){assertOpen();if(active)throw failure('TASK_ALREADY_RUNNING');if(adapter&&(adapter.mode!=='test'||!testMode))throw failure('TEST_ADAPTER_NOT_ALLOWED');if(!testMode&&now.getTime()!==now.getTime())throw failure('DATE_INVALID');const snapshot=freezeSnapshot(policy,revision,now,{coreOnly});const run_id='run-'+crypto.randomUUID();let lock;try{lock=acquireLock(projectRoot,run_id);}catch{throw failure('PROJECT_LOCK_HELD');}active={lock};try{snapshot.run_id=run_id;snapshot.storage_identity=await captureStorageIdentity(snapshot.video_root,{projectRoot});const task={run_id,snapshot,state:'starting',stage:'discover',notes:[],browser:{}};db().save(task);return launch(task,adapter,testMode,now);}catch(e){active=null;lock.release();throw e;}},
  async resume(id,{adapter,testMode=false,now}={}){assertOpen();if(active)throw failure('TASK_ALREADY_RUNNING');if(adapter&&(!testMode||adapter.mode!=='test'))throw failure('TEST_ADAPTER_NOT_ALLOWED');const task=load(id);if(task.state==='cancelled')throw failure('TASK_CANCELLED');const mode=task.snapshot.execution_mode??'integrated';if(!['core_only','integrated'].includes(mode))throw failure('TASK_MODE_INVALID');if(coreOnly&&mode!=='core_only')throw failure('TASK_MODE_CONFLICT');let lock;try{lock=acquireLock(projectRoot,id);}catch{throw failure('PROJECT_LOCK_HELD');}active={lock};return launch(task,adapter,testMode,now);},
  async pause(id){assertOpen();const task=load(id);if(task.state==='completed'||task.state==='cancelled')return publicTask(task);db().requestPause(id);const job=active;if(!job||job.task?.run_id!==id)return publicTask({...task,error_code:'PAUSE_REQUESTED'});job.requested=true;if(!job.inFlight)job.ctl.abort();return publicTask(await job.done);},
  async cancel(id){assertOpen();const task=load(id);if(task.state==='completed'||task.state==='cancelled')return publicTask(task);const job=active;if(job&&job.task?.run_id===id&&['starting','running'].includes(task.state)){await this.pause(id);const latest=load(id);if(latest.state!=='completed'){latest.state='cancelled';latest.error_code='TASK_CANCELLED';}latest.summary=summarize(latest);db().save(latest);return publicTask(latest);}task.state='cancelled';task.error_code='TASK_CANCELLED';task.summary=summarize(task);db().save(task);return publicTask(task);},
  get(id){assertOpen();return structuredClone(load(id));},
  list(){assertOpen();let owner;try{const file=path.join(projectRoot,'.selection.lock');if(!syncFs.lstatSync(file).isSymbolicLink()){const lock=JSON.parse(syncFs.readFileSync(file,'utf8'));if(Number.isSafeInteger(lock.pid)){try{process.kill(lock.pid,0);owner=lock.run_id;}catch(e){if(e.code==='EPERM')owner=lock.run_id;}}}}catch{}return db().list().map(t=>{if(['running','starting'].includes(t.state)&&active?.task?.run_id!==t.run_id&&owner!==t.run_id)return {...t,state:'paused',error_code:'RESTART_RECONCILE_REQUIRED'};return t;});},
  async close(){if(closed)return;try{if(active?.task)await this.pause(active.task.run_id);}finally{closed=true;ledger?.close();}}
 };
}
