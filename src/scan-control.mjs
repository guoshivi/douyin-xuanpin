import {readRows} from './selection-read-state.mjs';
import {detailRows} from './decision-signals.mjs';
import {failure,verifyIdentity} from './verifier.mjs';
import {evaluateSelection,selectionSettings} from './selection-filters.mjs';
import {rankCandidates} from './priorities.mjs';
import {categoriesResult} from './policy.mjs';
export const SCAN_DEFAULTS=Object.freeze({target_enabled:false,target_matches:100,category_enabled:false,max_per_category:600,pacing_enabled:false,interval_ms:1000,cooldown_enabled:false,cooldown_every:100,cooldown_ms:20000,read_budget_enabled:false,max_read_calls:300});
export const SCAN_FIELDS=Object.freeze({scanTargetEnabled:'target_enabled',scanTargetMatches:'target_matches',scanCategoryEnabled:'category_enabled',scanMaxPerCategory:'max_per_category',scanPacingEnabled:'pacing_enabled',scanIntervalMs:'interval_ms',scanCooldownEnabled:'cooldown_enabled',scanCooldownEvery:'cooldown_every',scanCooldownMs:'cooldown_ms',scanReadBudgetEnabled:'read_budget_enabled',scanMaxReadCalls:'max_read_calls'});
export function scanSettings(value){
 if(value===undefined)return {...SCAN_DEFAULTS};
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==Object.keys(SCAN_DEFAULTS).length||Object.keys(value).some(k=>!Object.hasOwn(SCAN_DEFAULTS,k)))throw failure('SCAN_CONFIG_INVALID');
 for(const [k,v]of Object.entries(value)){const flag=k.endsWith('_enabled'),time=k==='interval_ms'||k==='cooldown_ms';if(flag?typeof v!=='boolean':!Number.isSafeInteger(v)||v<(time?0:1)||v>(time?2147483647:Number.MAX_SAFE_INTEGER))throw failure('SCAN_CONFIG_INVALID');}
 return {...value};
}
export const scanEnabled=s=>Object.keys(SCAN_DEFAULTS).some(k=>k.endsWith('_enabled')&&s[k]);
export function scanDraft(value){if(value===undefined)return {};const s=scanSettings(value);return Object.fromEntries(Object.entries(SCAN_FIELDS).map(([k,v])=>[k,typeof s[v]==='boolean'?s[v]:String(s[v])]));}
export function scanFromDraft(d,current){const s=scanSettings(current);for(const [k,v]of Object.entries(SCAN_FIELDS))if(Object.hasOwn(d,k)){const n=d[k];if(typeof s[v]==='boolean')s[v]=n;else{if(typeof n!=='number'&&(typeof n!=='string'||!/^\d+$/.test(n)))throw failure('SCAN_CONFIG_INVALID');s[v]=typeof n==='number'?n:Number(n);}}return scanSettings(s);}
const countKeys=['read_calls','exempt_read_calls','observed_unique','evaluated','matched','category_skipped','target_skipped','unknown_category'];
const stops=['not_started','first_screen_exhausted','target_reached','read_budget_exhausted'];
export function newScanProgress(){return {read_calls:0,exempt_read_calls:0,next_read_at:0,cooldown_until:0,observed_unique:0,evaluated:0,matched:0,category_skipped:0,target_skipped:0,unknown_category:0,source_scope:'not_observed',stop_reason:'not_started'};}
export function scanProgress(value){
 const keys=Object.keys(newScanProgress());if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(k=>!keys.includes(k)))throw failure('SCAN_PROGRESS_INVALID');
 for(const k of [...countKeys,'next_read_at','cooldown_until'])if(!Number.isSafeInteger(value[k])||value[k]<0||value[k]>Number.MAX_SAFE_INTEGER)throw failure('SCAN_PROGRESS_INVALID');
 if(value.next_read_at>8640000000000000||value.cooldown_until>8640000000000000||!['not_observed','verified_first_screen'].includes(value.source_scope)||!stops.includes(value.stop_reason)||value.matched>value.evaluated||value.unknown_category>value.observed_unique||value.evaluated+value.category_skipped+value.target_skipped!==value.observed_unique)throw failure('SCAN_PROGRESS_INVALID');
 return Object.fromEntries(keys.map(k=>[k,value[k]]));
}
export function scanCandidates(rows,settings,evaluate,progress){
 const counts=new Map(),kept=[];Object.assign(progress,{observed_unique:rows.length,evaluated:0,matched:0,category_skipped:0,target_skipped:0,unknown_category:0,source_scope:'verified_first_screen',stop_reason:'first_screen_exhausted'});
 for(const row of rows){const bucket=typeof row.category_ids?.[0]==='string'&&row.category_ids[0]?row.category_ids[0]:null;if(bucket===null)progress.unknown_category++;
  if(settings.target_enabled&&progress.matched>=settings.target_matches){progress.target_skipped++;continue;}
  if(settings.category_enabled&&(counts.get(bucket)??0)>=settings.max_per_category){progress.category_skipped++;continue;}
  counts.set(bucket,(counts.get(bucket)??0)+1);const {signals,...selection}=evaluate(row);kept.push({...row,selection});progress.evaluated++;if(selection.state==='matched')progress.matched++;
 }
 if(settings.target_enabled&&progress.matched>=settings.target_matches)progress.stop_reason='target_reached';return kept;
}
// Recompute semantic statistics from the observed, identity-checked first screen.
export function validateScanTask(task){
 const settings=scanSettings(task.snapshot.policy?.scan_control),p=scanProgress(task.scan_progress);readRows(task,detailRows(task,task.scan_observation??[]));
 if(task.scan_observation===undefined){
  if(task.candidates!==undefined||task.state==='completed'||(task.products??[]).length||p.source_scope!=='not_observed'||countKeys.slice(2).some(k=>p[k]!==0)||!['not_started','read_budget_exhausted'].includes(p.stop_reason))throw failure('SCAN_PROGRESS_INVALID');
 }else{
  if(!Array.isArray(task.scan_observation)||!Array.isArray(task.candidates)||p.read_calls<1)throw failure('SCAN_PROGRESS_INVALID');
  const policy={...task.snapshot.policy,limits:task.snapshot.limits},collect=selectionSettings(policy.selection).mode==='collect_only',rows=task.scan_observation;
  const ids=new Set();if(rows.length>task.snapshot.limits.max_candidates)throw failure('SCAN_PROGRESS_INVALID');for(const row of rows){try{verifyIdentity(row);}catch{throw failure('SCAN_PROGRESS_INVALID');}if(ids.has(row.commodity_id))throw failure('SCAN_PROGRESS_INVALID');ids.add(row.commodity_id);}
  const kept=rows.filter(c=>collect||categoriesResult(c,policy).state!=='reject'),rank=rankCandidates(kept,policy,{archiveDate:task.snapshot.seasonal_reference_date}),expected=newScanProgress();
  const candidates=scanCandidates(readRows(task,detailRows(task,rank.ranked)),settings,c=>evaluateSelection(c,policy),expected);expected.observed_unique+=rows.length-kept.length;expected.category_skipped+=rows.length-kept.length;
  if(JSON.stringify(candidates)!==JSON.stringify(task.candidates)||[...countKeys.slice(2),'source_scope'].some(k=>p[k]!==expected[k])||p.stop_reason!=='read_budget_exhausted'&&p.stop_reason!==expected.stop_reason)throw failure('SCAN_PROGRESS_INVALID');
 }
 if(p.stop_reason==='read_budget_exhausted'&&(!settings.read_budget_enabled||p.read_calls<settings.max_read_calls))throw failure('SCAN_PROGRESS_INVALID');
 return p;
}
// Exact effect readbacks must remain possible even after budget exhaustion.
export function attachScanControl({task,ctx,save,clock=Date.now}){
 const settings=scanSettings(task.snapshot.policy?.scan_control);if(!scanEnabled(settings)&&task.snapshot.selection_detail_version!==1&&task.snapshot.selection_read_version!==1)return;
 task.scan_progress=task.scan_progress===undefined?newScanProgress():scanProgress(task.scan_progress);const p=task.scan_progress;
 ctx.beforeBrowserRead=async(operation,{reconcile=false,readDeadline:outerDeadline}={})=>{
  if(!['discover','read_cart','decision','freeze','metadata','selection_decision','creator_sample','prefilter_discover'].includes(operation))return;
  ctx.checkRead();
  if(operation==='read_cart'&&(ctx.reconcileOnly||ctx.inFlight||reconcile)){if(p.exempt_read_calls===Number.MAX_SAFE_INTEGER)throw failure('SCAN_PROGRESS_INVALID');p.exempt_read_calls++;save(task);return;}
  if(settings.read_budget_enabled&&p.read_calls>=settings.max_read_calls){p.stop_reason='read_budget_exhausted';save(task);throw failure('SCAN_READ_BUDGET_EXHAUSTED');}
  const deadline=Date.parse(task.snapshot.deadline);if(!Number.isFinite(deadline))throw failure('RUN_DEADLINE_INVALID');
  const until=Math.max(settings.pacing_enabled?p.next_read_at:0,settings.cooldown_enabled?p.cooldown_until:0),readDeadline=Math.min(clock()+90000,Number.isFinite(outerDeadline)?outerDeadline:Infinity);
  while(clock()<until){ctx.checkRead();if(ctx.signal?.aborted)throw failure('TASK_PAUSED');const left=deadline-clock();if(left<=0)throw failure('RUN_DEADLINE_EXPIRED');if(clock()>=readDeadline)throw failure('READ_TIMEOUT');await new Promise((resolve,reject)=>{let timer;const abort=()=>{clearTimeout(timer);reject(failure('TASK_PAUSED'));};ctx.signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>{ctx.signal?.removeEventListener('abort',abort);resolve();},Math.min(until-clock(),left,readDeadline-clock(),2147483647));if(ctx.signal?.aborted)abort();});}
  ctx.checkRead();if(clock()>=deadline)throw failure('RUN_DEADLINE_EXPIRED');if(clock()>=readDeadline)throw failure('READ_TIMEOUT');if(p.read_calls===Number.MAX_SAFE_INTEGER)throw failure('SCAN_PROGRESS_INVALID');p.read_calls++;const now=clock();p.next_read_at=settings.pacing_enabled?now+settings.interval_ms:0;if(settings.cooldown_enabled&&p.read_calls%settings.cooldown_every===0)p.cooldown_until=now+settings.cooldown_ms;save(task);return Math.max(1,readDeadline-clock());
 };
}
