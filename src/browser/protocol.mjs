import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import fs from 'node:fs';
import path from 'node:path';
import {safeEvidencePath} from '../safety.mjs';
import {allowedUrl,validateRequest} from './round.mjs';
const LIMIT=1024*1024,EVIDENCE_LIMIT=8*1024*1024;
const FIELDS={space:new Set(['type','space_id','page_label']),observation:new Set(['type','status','space_id','page_label','commodity_id','observed_url','evidence_path','observed_count']),result:new Set(['type','status','space_id','page_label','commodity_id','error_code','retryable','may_have_late_effects'])};
function failure(code){const e=new Error(code);e.code=code;return e;}
function publicCode(e,fallback){return /^[A-Z][A-Z0-9_]{0,63}$/u.test(e?.code??'')?e.code:fallback;}
function sensitive(x){if(x&&typeof x==='object')for(const [k,v] of Object.entries(x)){if(/cookie|token|auth|password|passwd|snapshot|secret|sign|credential/iu.test(k))throw failure('PROTOCOL_SENSITIVE_FIELD');sensitive(v);}}
function sanitize(x){
  sensitive(x);
  if(x==null||typeof x!=='object'||Array.isArray(x))throw failure('PROTOCOL_MESSAGE_INVALID');
  if(x.type==='notice')return null;
  const allowed=FIELDS[x.type];if(!allowed)throw failure('PROTOCOL_TYPE_INVALID');
  for(const k of Object.keys(x))if(!allowed.has(k))throw failure('PROTOCOL_FIELD_NOT_ALLOWED');
  if(x.status==='error'&&x.type==='result'&&x.space_id==null){if(x.page_label!=null)throw failure('PROTOCOL_PAGE_INVALID');}
  else{
    if(typeof x.space_id!=='string'||!/^[-\w]{1,128}$/u.test(x.space_id)||x.space_id==='unknown')throw failure('PROTOCOL_SPACE_INVALID');
    if(typeof x.page_label!=='string'||!/^p[1-9]\d*$/u.test(x.page_label))throw failure('PROTOCOL_PAGE_INVALID');
  }
  if(x.commodity_id!=null&&(typeof x.commodity_id!=='string'||!/^[-\w]{1,128}$/u.test(x.commodity_id)))throw failure('COMMODITY_INVALID');
  if(x.observed_count!=null&&(!Number.isSafeInteger(x.observed_count)||x.observed_count<0))throw failure('OBSERVED_COUNT_INVALID');
  if(x.observed_url!=null)allowedUrl(x.observed_url);
  if(x.error_code!=null&&(typeof x.error_code!=='string'||!/^[A-Z][A-Z0-9_]{0,63}$/u.test(x.error_code)))throw failure('PROTOCOL_ERROR_CODE_INVALID');
  for(const k of ['may_have_late_effects','retryable'])if(x[k]!=null&&typeof x[k]!=='boolean')throw failure('PROTOCOL_FLAG_INVALID');
  return x;
}
function checkEvidence(response,req,root){
  if(!req.output_file||response.evidence_path!==req.output_file)throw failure('EVIDENCE_REQUEST_MISMATCH');
  const target=safeEvidencePath(root,response.evidence_path,{mustExist:true});
  let fd;try{
    fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    const st=fs.fstatSync(fd);if(!st.isFile()||(st.mode&0o777)!==0o600||st.size>EVIDENCE_LIMIT)throw failure('EVIDENCE_FILE_INVALID');
    const bytes=Buffer.alloc(st.size+1);let used=0,n;
    while(used<bytes.length&&(n=fs.readSync(fd,bytes,used,bytes.length-used,null))>0)used+=n;
    if(used!==st.size||fs.fstatSync(fd).size!==st.size)throw failure('EVIDENCE_FILE_CHANGED');
    let evidence;try{evidence=JSON.parse(bytes.subarray(0,used).toString('utf8'));}catch{throw failure('EVIDENCE_CONTENT_INVALID');}
    if(!evidence||Array.isArray(evidence)||typeof evidence!=='object')throw failure('EVIDENCE_CONTENT_INVALID');
    const keys=['space_id','page_label','commodity_id','captured_at','requested_url','landed_url','title','snapshot'];
    if(keys.some(k=>!Object.hasOwn(evidence,k)))throw failure('EVIDENCE_CONTENT_INCOMPLETE');
    if(evidence.space_id!==response.space_id||evidence.page_label!==response.page_label||evidence.commodity_id!==response.commodity_id||evidence.commodity_id!==(req.commodity_id??null))throw failure('EVIDENCE_OWNERSHIP_MISMATCH');
    if(typeof evidence.captured_at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(evidence.captured_at)||!Number.isFinite(Date.parse(evidence.captured_at))||new Date(evidence.captured_at).toISOString()!==evidence.captured_at)throw failure('EVIDENCE_TIME_INVALID');
    if(typeof evidence.title!=='string'||evidence.snapshot==null||!(typeof evidence.snapshot==='string'||typeof evidence.snapshot==='object'))throw failure('EVIDENCE_CONTENT_INVALID');
    if(allowedUrl(evidence.requested_url)!==allowedUrl(req.url??req.requested_url)||allowedUrl(evidence.landed_url)!==allowedUrl(response.observed_url))throw failure('EVIDENCE_URL_MISMATCH');
  }finally{if(fd!=null)fs.closeSync(fd);}
}
export function runBrowserRound(request,{command='ego-browser',timeoutMs=90000,env={},root=process.cwd()}={}){
  root=path.resolve(root);let req,stdin;
  const ego=path.basename(command)==='ego-browser';const script=!ego&&/\.m?js$/u.test(command);
  try{
    req=validateRequest(request,root);
    if(ego&&req.action==='inspect'&&(!req.output_file||!(req.url??req.requested_url)))throw failure('INSPECT_EVIDENCE_REQUIRED');
    if(!Number.isFinite(timeoutMs)||timeoutMs<1)throw failure('TIMEOUT_INVALID');
    if(ego){
      const moduleUrl=new URL('./round.mjs',import.meta.url).href;
      stdin=`const {handleRound,roundErrorRecord}=await import(${JSON.stringify(moduleUrl)});\ntry { await handleRound(${JSON.stringify(req)},{root:${JSON.stringify(root)},taskSpace:globalThis.taskSpace,requirePageIdentity:true}); } catch(e) { process.stdout.write(JSON.stringify(roundErrorRecord(e))+'\\n'); process.exitCode=1; }\n`;
    }else stdin=`${JSON.stringify(req)}\n`;
  }catch(e){return Promise.reject(failure(publicCode(e,'REQUEST_REJECTED')));}
  return new Promise((resolve,reject)=>{
    let child,space=null,response=null,pending=null,closed=false,timer,killTimer;
    const outputs={stdout:{buffer:'',bytes:0,decoder:new StringDecoder('utf8')},stderr:{buffer:'',bytes:0,decoder:new StringDecoder('utf8')}};
    const cleanup=()=>{clearTimeout(timer);clearTimeout(killTimer);};
    const attach=e=>{if(space){e.space_id=space.space_id;e.page_label=space.page_label;}e.may_have_late_effects=Boolean(e.may_have_late_effects);return e;};
    const stop=(code,late=false)=>{
      if(pending||closed)return;
      pending=attach(failure(code));pending.may_have_late_effects=late;
      clearTimeout(timer);
      try{child?.kill('SIGTERM');}catch{}
      killTimer=setTimeout(()=>{if(!closed)try{child?.kill('SIGKILL');}catch{}},100);
    };
    const line=text=>{
      if(!text.trim()||pending)return;let x;
      try{x=JSON.parse(text);}catch{return;}
      const msg=sanitize(x);if(!msg)return;
      if(msg.type==='space'){
        if(space)throw failure('PROTOCOL_SPACE_DUPLICATE');
        space=msg;
        if(req.space_id!=null&&String(req.space_id)!==space.space_id)throw failure('SPACE_REQUEST_MISMATCH');
        if(space.page_label!==req.page_label)throw failure('PAGE_REQUEST_MISMATCH');
        return;
      }
      if(response)throw failure('PROTOCOL_MULTIPLE_RESULTS');
      response=msg;
      if(msg.status==='error'){
        if(space&&(msg.space_id!==space.space_id||msg.page_label!==space.page_label))throw failure('SPACE_PAGE_MISMATCH');
        if(closed){pending=attach(failure(msg.error_code??'ROUND_FAILED'));pending.may_have_late_effects=Boolean(msg.may_have_late_effects);}
        else stop(msg.error_code??'ROUND_FAILED',Boolean(msg.may_have_late_effects));return;
      }
      // Independent Ego pipes may complete a response before the space line.
      // Ownership is still mandatory and checked again after both pipes close.
      if(!space&&!ego)throw failure('PROTOCOL_SPACE_MISSING');
      if(space&&(msg.space_id!==space.space_id||msg.page_label!==space.page_label))throw failure('SPACE_PAGE_MISMATCH');
      if(req.commodity_id!=null&&msg.commodity_id!==req.commodity_id)throw failure('COMMODITY_MISMATCH');
      if(msg.type!==(req.action==='inspect'?'observation':'result')||msg.status!==(req.action==='handoff'?'handoff':'ok'))throw failure('ACTION_RESULT_MISMATCH');
    };
    try{child=spawn(script?process.execPath:command,ego?['nodejs']:script?[command]:[],{shell:false,env:{...process.env,...env,XP_ROOT:root},stdio:['pipe','pipe','pipe']});}
    catch{cleanup();reject(attach(failure('SPAWN_FAILED')));return;}
    timer=setTimeout(()=>stop('TIMEOUT',true),timeoutMs);
    const consume=(name,text)=>{
      const output=outputs[name];output.buffer+=text;let i;
      while((i=output.buffer.indexOf('\n'))!==-1){const row=output.buffer.slice(0,i);output.buffer=output.buffer.slice(i+1);line(row);if(pending)break;}
    };
    const read=(name,d)=>{
      if(pending||closed)return;const output=outputs[name];output.bytes+=d.length;
      if(output.bytes>LIMIT){stop(name==='stdout'?'OUTPUT_LIMIT':'STDERR_LIMIT',true);return;}
      // Only the Ego CLI forwards its protocol stdout through stderr.
      if(name==='stderr'&&!ego)return;
      try{consume(name,output.decoder.write(d));}catch(e){stop(publicCode(e,'PROTOCOL_INVALID'),true);}
    };
    child.stdout.on('data',d=>read('stdout',d));
    child.stderr.on('data',d=>read('stderr',d));
    child.stdin.on('error',()=>stop('STDIN_FAILED',true));
    child.on('error',()=>stop('SPAWN_FAILED'));
    child.on('close',code=>{
      if(closed)return;closed=true;cleanup();
      if(pending){reject(attach(pending));return;}
      try{
        for(const name of ego?['stdout','stderr']:['stdout']){
          const output=outputs[name];consume(name,output.decoder.end());
          if(output.buffer.trim())line(output.buffer);
          if(pending)break;
        }
        if(pending){reject(attach(pending));return;}
        if(code!==0)throw failure('ROUND_FAILED');
        if(!space)throw failure('PROTOCOL_SPACE_MISSING');
        if(!response)throw failure('PROTOCOL_RESULT_MISSING');
        if(response.space_id!==space.space_id||response.page_label!==space.page_label)throw failure('SPACE_PAGE_MISMATCH');
        if(req.action==='inspect'){
          const legacy=!ego&&response.observed_count===0&&response.observed_url==null&&req.url==null&&req.requested_url==null&&(response.evidence_path==null||response.evidence_path===req.output_file);
          // A URL-less legacy fake may echo the requested path; it is not evidence.
          if(legacy){resolve({...response,evidence_path:null,verified:false,missing_reason:'NO_OBSERVATIONS'});return;}
          if(response.observed_count!==1||!response.observed_url||!response.evidence_path)throw failure('OBSERVATION_EVIDENCE_REQUIRED');
          checkEvidence(response,req,root);
        }
        resolve({...response,verified:true});
      }catch(e){reject(attach(failure(publicCode(e,'PROTOCOL_INVALID'))));}
    });
    try{child.stdin.end(stdin);}catch{stop('STDIN_FAILED',true);}
  });
}
