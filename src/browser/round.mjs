import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {safeEvidencePath} from '../safety.mjs';
const ALLOWED_HOSTS=['buyin.jinritemai.com','jinritemai.com'];
const EVIDENCE_LIMIT=8*1024*1024;
function failure(code){const e=new Error(code);e.code=code;return e;}
function rootOf(){if(!process.env.XP_ROOT)throw failure('XP_ROOT_REQUIRED');return path.resolve(process.env.XP_ROOT);}
export function allowedUrl(value){
  if(typeof value!=='string')throw failure('URL_NOT_ALLOWED');
  let u;try{u=new URL(value);}catch{throw failure('URL_NOT_ALLOWED');}
  if(u.protocol!=='https:'||!ALLOWED_HOSTS.some(h=>u.hostname===h||u.hostname.endsWith(`.${h}`))||u.username||u.password)throw failure('URL_NOT_ALLOWED');
  for(const k of u.searchParams.keys())if(/token|sign|auth|cookie|credential|password|expires|x-oss/iu.test(k))throw failure('URL_NOT_ALLOWED');
  if(/token|signature|authorization|password/iu.test(u.hash))throw failure('URL_NOT_ALLOWED');
  return u.toString();
}
export function validateRequest(request,root){
  if(!request||typeof request!=='object'||Array.isArray(request))throw failure('REQUEST_INVALID');
  const action=request.action??'inspect',page_label=request.page_label??'p1';
  if(!['inspect','finish','handoff'].includes(action))throw failure('ACTION_NOT_ALLOWED');
  if(typeof page_label!=='string'||!/^p[1-9]\d*$/u.test(page_label))throw failure('PAGE_INVALID');
  if(request.space_id!=null&&( !['string','number'].includes(typeof request.space_id)||!String(request.space_id)||String(request.space_id)==='unknown'))throw failure('SPACE_INVALID');
  if(request.commodity_id!=null&&(typeof request.commodity_id!=='string'||!request.commodity_id))throw failure('COMMODITY_INVALID');
  if(action==='finish'&&(!Array.isArray(request.keep)||request.keep.length))throw failure('FINISH_KEEP_MUST_BE_EMPTY');
  if(action!=='inspect'&&request.space_id==null)throw failure('SPACE_REQUIRED');
  if(action==='inspect'&&(request.url!=null||request.requested_url!=null)){
    allowedUrl(request.url??request.requested_url);
    if(request.url!=null&&request.requested_url!=null&&allowedUrl(request.url)!==allowedUrl(request.requested_url))throw failure('URL_MISMATCH');
  }
  if(request.output_file!=null)safeEvidencePath(path.resolve(root),request.output_file);
  return {...request,action,page_label};
}
function emit(x){process.stdout.write(`${JSON.stringify(x)}\n`);}
async function getTask(request,factory){
  const create=factory??globalThis.taskSpace;if(typeof create!=='function')throw failure('EGO_RUNTIME_REQUIRED');
  const id=request.space_id;
  const target=id!=null&&/^\d+$/u.test(String(id))&&Number.isSafeInteger(Number(id))?Number(id):(id??request.space_name??`selection-${request.run_id??'round'}`);
  return await create(target);
}
export async function handleRound(request,{root=rootOf(),taskSpace:factory,requirePageIdentity=false}={}){
  const req=validateRequest(request,root);let space_id,late=false;
  try{
    const task=await getTask(req,factory);
    if(task?.spaceId==null||!['string','number'].includes(typeof task.spaceId)||!String(task.spaceId)||String(task.spaceId)==='unknown')throw failure('SPACE_INVALID');
    space_id=String(task.spaceId);const page_label=req.page_label;
    emit({type:'space',space_id,page_label});
    if(req.space_id!=null&&String(req.space_id)!==space_id)throw failure('SPACE_REQUEST_MISMATCH');
    if(task.ownership!=='agent')throw failure('USER_OWNED_OR_INACTIVE');
    const commodity=req.commodity_id!=null?{commodity_id:req.commodity_id}:{};
    if(req.action==='finish'){late=true;await task.finish({keep:[]});emit({type:'result',status:'ok',space_id,page_label,...commodity});return;}
    if(req.action==='handoff'){late=true;await task.handOff();emit({type:'result',status:'handoff',space_id,page_label,...commodity});return;}
    if(!req.url&&!req.requested_url)throw failure('URL_REQUIRED');
    const requested_url=allowedUrl(req.url??req.requested_url);
    if(!req.output_file)throw failure('OUTPUT_REQUIRED');
    const evidence_path=safeEvidencePath(path.resolve(root),req.output_file);
    try{await fs.lstat(evidence_path);throw failure('EVIDENCE_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}
    const page=task.page(page_label);
    // Legacy injected adapters remain explicit; production wrappers require real identity.
    const strictPage=!factory||requirePageIdentity===true;
    if((page?.label!=null&&page.label!==page_label)||(page?.spaceId!=null&&String(page.spaceId)!==space_id)||(strictPage&&(page?.label!==page_label||String(page?.spaceId)!==space_id)))throw failure('PAGE_SPACE_MISMATCH');
    let landed_url,title,snapshot;
    try{late=true;await page.goto(requested_url,{timeout:req.timeoutMs});landed_url=allowedUrl(await page.url());title=await page.title();snapshot=await page.snapshot({scope:'full_page'});}catch(e){if(e.code==='URL_NOT_ALLOWED')throw e;throw failure('NAVIGATION_TIMEOUT');}
    if(typeof title!=='string'||snapshot==null||!(typeof snapshot==='string'||typeof snapshot==='object'))throw failure('OBSERVATION_INVALID');
    const commodity_id=req.commodity_id??null,captured_at=new Date().toISOString();
    const evidence=JSON.stringify({space_id,page_label,commodity_id,captured_at,requested_url,landed_url,title,snapshot},null,2);
    if(Buffer.byteLength(evidence)>EVIDENCE_LIMIT)throw failure('EVIDENCE_LIMIT');
    safeEvidencePath(path.resolve(root),evidence_path);
    await fs.mkdir(path.dirname(evidence_path),{recursive:true,mode:0o700});
    safeEvidencePath(path.resolve(root),evidence_path);
    const file=await fs.open(evidence_path,'wx',0o600);
    try{await file.writeFile(evidence);}finally{await file.close();}
    emit({type:'observation',status:'ok',space_id,page_label,commodity_id,observed_url:landed_url,evidence_path,observed_count:1});
  }catch(e){
    // Never propagate runtime exception messages, stacks, or other secret data.
    const known=new Set(['EGO_RUNTIME_REQUIRED','SPACE_INVALID','SPACE_REQUEST_MISMATCH','USER_OWNED_OR_INACTIVE','URL_REQUIRED','URL_NOT_ALLOWED','OUTPUT_REQUIRED','EVIDENCE_EXISTS','PAGE_SPACE_MISMATCH','NAVIGATION_TIMEOUT','OBSERVATION_INVALID','EVIDENCE_LIMIT','EVIDENCE_PATH_SYMLINK','LOCAL_PATH_SYMLINK','EEXIST']);
    const out=failure(known.has(e?.code)?e.code:'ROUND_FAILED');
    if(space_id!=null){out.space_id=space_id;out.page_label=req.page_label;}
    out.may_have_late_effects=late;throw out;
  }
}
export function roundErrorRecord(e){
  return {type:'result',status:'error',...(e.space_id!=null?{space_id:e.space_id,page_label:e.page_label}:{}),error_code:e.code??'ROUND_FAILED',may_have_late_effects:Boolean(e.may_have_late_effects)};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let text='';try{for await(const c of process.stdin){text+=c;if(Buffer.byteLength(text)>1024*1024)throw failure('REQUEST_LIMIT');}await handleRound(JSON.parse(text),{root:process.env.XP_ROOT});}
  catch(e){emit(roundErrorRecord(e));process.exitCode=1;}
}
