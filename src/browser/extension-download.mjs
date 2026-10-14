import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {failure,assertNumericId} from '../verifier.mjs';

export const MAX_DOWNLOAD_BYTES=157286400;
// Sanitized backup placeholder, not an observed installation identity.
// No browser capability or permission is implied; WIP remains unverified.
// Real deployment binding must be separately authorized and verified.
export const OBSERVED_EXTENSION_ID='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export class DownloadUncertainError extends Error { constructor(reason='UNCERTAIN'){super('UNCERTAIN');this.name='DownloadUncertainError';this.code='UNCERTAIN';this.reason=reason;} }
const uncertain=(reason)=>new DownloadUncertainError(reason);
const keyFor=(c,v)=>`download:${c.commodity_id}:${v.aweme_id}`;
const immutableEvidence=(candidate,video,binding)=>binding?.video_id===video.aweme_id&&binding?.message_video_id===video.aweme_id&&binding?.commodity_id===candidate.commodity_id&&binding?.context_product_id===candidate.product_id&&binding?.title===video.title;

function checkIdentity(candidate,video){
 if(typeof candidate?.commodity_id!=='string'||!/^[0-9]{19}$/.test(candidate.commodity_id))throw failure('VIDEO_IDENTITY_INVALID');
 assertNumericId(video?.aweme_id);
 if(video.commodity_id!==candidate.commodity_id)throw failure('VIDEO_COMMODITY_MISMATCH');
 if(typeof candidate.product_id!=='string'||!/^[0-9]{19}$/.test(candidate.product_id)||typeof video.title!=='string'||!video.title)throw failure('VIDEO_IDENTITY_INVALID');
}
function nativeMatch(item,binding){
 if(!item||typeof item!=='object'||typeof binding?.download_id!=='number')return false;
 if(item.id!==binding.download_id)return false;
 if(typeof binding.url!=='string'||!binding.url)return false;
 const actual=item.finalUrl??item.url;
 if(actual!==binding.url)return false;
 if(typeof binding.filename!=='string'||!path.isAbsolute(binding.filename)||item.filename!==binding.filename)return false;
 if(/(?:\.crdownload|\.html?)$/iu.test(item.filename))return false;
 return true;
}
function methods(store){
 if(!store||typeof store.read!=='function'||typeof store.write!=='function')throw failure('DOWNLOAD_INTENT_STORE_REQUIRED');
 return store;
}
async function pathChecks(filename,fsImpl){
 if(!path.isAbsolute(filename))throw uncertain('SOURCE_FILENAME_NOT_ABSOLUTE');
 let current=filename;
 const ancestors=[];
 while(true){ancestors.push(current);const next=path.dirname(current);if(next===current)break;current=next;}
 for(const p of ancestors){let st;try{st=await fsImpl.lstat(p);}catch{throw uncertain(p===filename?'SOURCE_MISSING':'SOURCE_PATH_UNVERIFIED');}if(st.isSymbolicLink())throw uncertain('SOURCE_SYMLINK');}
 const st=await fsImpl.stat(filename);if(!st.isFile())throw uncertain('SOURCE_NOT_FILE');return st;
}
async function readNative(item,fsImpl){
 if(item.exists!==true)throw uncertain('SOURCE_NOT_EXISTS');
 const st=await pathChecks(item.filename,fsImpl);
 if(st.size>MAX_DOWNLOAD_BYTES)throw failure('LIMIT_EXCEEDED');
 const bytes=await fsImpl.readFile(item.filename);
 const afterLink=await fsImpl.lstat(item.filename);if(afterLink.isSymbolicLink())throw uncertain('SOURCE_SYMLINK');const after=await fsImpl.stat(item.filename);if(!after.isFile()||after.size!==st.size)throw uncertain('SOURCE_SIZE_CHANGED');
 if(bytes.length!==st.size||bytes.length>MAX_DOWNLOAD_BYTES)throw failure('LIMIT_EXCEEDED');
 const received=Number(item.bytesReceived),total=item.totalBytes==null?null:Number(item.totalBytes);
 if(!Number.isSafeInteger(received)||received!==st.size||total!==null&&total!==st.size)throw uncertain('NATIVE_RECEIPT_INCOMPLETE');
 return bytes;
}
function validateComplete(item){
 if(item.state!=='complete'||item.error!=null||typeof item.startTime!=='string'||typeof item.endTime!=='string')return false;
 const received=Number(item.bytesReceived),total=item.totalBytes==null?null:Number(item.totalBytes);
 return Number.isSafeInteger(received)&&received>0&&(total===null||Number.isSafeInteger(total)&&total===received);
}

export async function readVerifiedNativeFile({receipt,expectedSha256,fsImpl=fs}={}){
 if(!validateComplete(receipt))throw uncertain('NATIVE_RECEIPT_INCOMPLETE');
 const bytes=await readNative(receipt,fsImpl);const sha256=crypto.createHash('sha256').update(bytes).digest('hex');
 if(typeof expectedSha256!=='string'||sha256!==expectedSha256)throw uncertain('SOURCE_HASH_DRIFT');return bytes;
}
function cleanReceipt(item,binding){return {id:item.id,url:item.url??null,finalUrl:item.finalUrl??null,filename:item.filename,state:item.state,startTime:item.startTime??null,endTime:item.endTime??null,exists:item.exists??null,bytesReceived:item.bytesReceived,totalBytes:item.totalBytes??null,error:item.error??null,download_id:binding.download_id,source_url:binding.url};}
function intentCompatible(a,b){return a?.commodity_id===b?.commodity_id&&a?.product_id===b?.product_id&&a?.aweme_id===b?.aweme_id&&a?.title===b?.title;}

export function createDownloadDriver({chrome,store,fsImpl=fs,clickDownload2,clickDownload1,pollMs=100,deadlineMs=30000,sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=()=>Date.now(),guard=()=>true,onEvent}={}){
 methods(store);
 if(typeof chrome?.downloads?.search!=='function')throw failure('DOWNLOADS_API_UNAVAILABLE');
 if(typeof clickDownload2!=='function'||typeof clickDownload1!=='function')throw failure('DOWNLOAD_BUTTON_DRIVER_UNAVAILABLE');
 const search=async()=>chrome.downloads.search({});
 const eventBuffer=[];
 if(typeof chrome.downloads.onCreated?.addListener==='function')chrome.downloads.onCreated.addListener(item=>eventBuffer.push({type:'created',item}));
 if(typeof chrome.downloads.onChanged?.addListener==='function')chrome.downloads.onChanged.addListener(change=>eventBuffer.push({type:'changed',change}));
 const baseline=async()=>new Set((await search()).map(x=>x?.id).filter(Number.isInteger));
 const postItems=async(base,binding)=>{const all=await search();return all.filter(x=>!base.has(x?.id)&&nativeMatch(x,binding));};
 const settle=async({base,binding,deadline,guard:liveGuard=guard})=>{
  if(!immutableEvidence(binding.candidate,binding.video,binding))return {status:'uncertain',reason:'BRIDGE_IDENTITY_MISSING'};
  let last=[];
  const checkpoint=()=>{if(!liveGuard())throw failure('TASK_PAUSED');if(now()>=deadline)throw failure('RUN_DEADLINE_EXPIRED');};
  checkpoint();
  while(now()<deadline){
   checkpoint(); const all=await search(); const related=all.filter(x=>!base.has(x?.id)&&x&&x.filename===binding.filename&&(x.finalUrl??x.url)===binding.url);if(related.length>1)return {status:'uncertain',reason:'MULTIPLE_NATIVE_RECEIPTS'};last=related.filter(x=>nativeMatch(x,binding));
   if(last.length>1)return {status:'uncertain',reason:'MULTIPLE_NATIVE_RECEIPTS'};
   if(last.length===1){const item=last[0];if(item.state==='in_progress'||item.state==='pending'||item.state==='paused'){await sleep(Math.min(pollMs,Math.max(1,deadline-now())));continue;}if(item.state==='interrupted'||item.error!=null)return {status:'failed',item};if(item.state!=='complete')return {status:'uncertain',reason:'UNKNOWN_NATIVE_STATE',item};if(!validateComplete(item))return {status:'uncertain',reason:'NATIVE_RECEIPT_INCOMPLETE',item};let bytes;try{bytes=await readNative(item,fsImpl);}catch(e){if(e?.code==='LIMIT_EXCEEDED')return {status:'limit_exceeded',item};return {status:'uncertain',reason:e?.reason??e?.code??'SOURCE_READ_FAILED',item};}const sha256=crypto.createHash('sha256').update(bytes).digest('hex');if(binding.expected_sha256&&binding.expected_sha256!==sha256)return {status:'uncertain',reason:'SOURCE_HASH_DRIFT',item};return {status:'complete',item,bytes,sha256};}
   await sleep(Math.min(pollMs,Math.max(1,deadline-now()))); checkpoint();
  }
  const late=(await postItems(base,binding));if(late.some(x=>x.state==='in_progress'||x.state==='pending'||x.state==='paused'))return {status:'uncertain',reason:'LATE_IN_FLIGHT'};
  return {status:'uncertain',reason:last.length?'DEADLINE_NO_SETTLE':'NO_NATIVE_RECEIPT'};
 };
 const result=(r,source,video)=>({bytes:r.bytes,quality:source,attempts:source==='download1'?2:1,receipt:cleanReceipt(r.item,source==='download1'?video.binding1:video.binding2),sha256:r.sha256,aweme_id:video.aweme_id,author:video.author??null,author_reason:video.author?null:(video.author_reason??'ROW_AUTHOR_MISSING'),duration_ms:video.duration_ms??null,duration_source:video.duration_source??null,duration_raw:video.duration_raw??null,source});
 const downloadVideo=async({candidate,video,intent,guard:guardOverride,deadlineAt}={})=>{
  checkIdentity(candidate,video);const activeGuard=typeof guardOverride==='function'?guardOverride:guard;let operationDeadline=Number.isFinite(deadlineAt)?deadlineAt:now()+deadlineMs;const live=()=>{if(!activeGuard())throw failure('TASK_PAUSED');if(now()>=operationDeadline)throw failure('RUN_DEADLINE_EXPIRED');};live();if(!intent||typeof intent!=='object'||typeof intent.click_token!=='string'||!intent.frozen_context)throw failure('DOWNLOAD_BINDING_EVIDENCE_REQUIRED');
  if(intent.frozen_context.product_id!==candidate.product_id||intent.frozen_context.title!==video.title||intent.frozen_context.aweme_id!==video.aweme_id)throw failure('DOWNLOAD_BINDING_EVIDENCE_REQUIRED');
  const key=keyFor(candidate,video),st=methods(store);let record=await st.read(key);if(Number.isFinite(record?.deadline_at))operationDeadline=Math.min(operationDeadline,record.deadline_at);live();if(record&&!intentCompatible(record.intent,{commodity_id:candidate.commodity_id,product_id:candidate.product_id,aweme_id:video.aweme_id,title:video.title}))throw uncertain('INTENT_MISMATCH');
  if(record?.stage==='effect_uncertain'||record?.stage==='download1_started'||record?.stage==='download2_started'&&record?.binding1)throw uncertain('RECONCILE_ONLY');
  if(record && !['verified','download2_started'].includes(record.stage))throw uncertain('RECONCILE_ONLY');
  const base=await baseline();live();
  if(record?.stage==='download2_started'){if(!record.binding2)throw uncertain('RECONCILE_ONLY');const r=await settle({base:new Set(record.baseline_ids??[]),binding:{...record.binding2,candidate,video},deadline:Math.min(operationDeadline,now()+deadlineMs)});if(r.status==='complete')return result(r,'download2',{...video,binding2:record.binding2});throw uncertain(r.reason);}
  if(record?.stage==='verified'){const binding=record.binding1??record.binding2;if(!binding)throw uncertain('RECONCILE_ONLY');const source=record.binding1?'download1':'download2';const r=await settle({base:new Set(),binding:{...binding,candidate,video},deadline:Math.min(operationDeadline,now()+deadlineMs),guard:activeGuard});if(r.status==='complete')return result(r,source,{...video,[record.binding1?'binding1':'binding2']:binding});throw uncertain(r.reason);}
  const persisted={intent:{commodity_id:candidate.commodity_id,product_id:candidate.product_id,aweme_id:video.aweme_id,title:video.title,click_token:intent.click_token,frozen_context:intent.frozen_context},stage:'effect_uncertain',baseline_ids:[...base],deadline_at:operationDeadline,created_at:now()};await st.write(key,persisted);onEvent?.({type:'effect_uncertain',key});
  let d2;try{live();d2=await clickDownload2({candidate,video,intent:persisted.intent,deadline:operationDeadline,guard:activeGuard});live();}catch(e){if(e?.code==='TASK_PAUSED'||e?.code==='RUN_DEADLINE_EXPIRED')throw e;throw uncertain('CLICK2_BRIDGE_ERROR');}
  if(!d2?.binding||!immutableEvidence(candidate,video,d2.binding))throw uncertain('BRIDGE_IDENTITY_MISSING');
  const binding2={...d2.binding,candidate,video};await st.write(key,{...persisted,stage:'download2_started',binding2});onEvent?.({type:'download2_started',key});live();
  let r=await settle({base,binding:binding2,deadline:Math.min(operationDeadline,now()+deadlineMs),guard:activeGuard});if(r.status==='complete'){await st.write(key,{...persisted,stage:'verified',binding2,receipt:cleanReceipt(r.item,binding2)});live();return result(r,'download2',{...video,binding2});}
  if(r.status==='limit_exceeded')throw failure('LIMIT_EXCEEDED');
  if(r.status!=='failed'||d2.failureConfirmed!==true||d2.noLateStart!==true)throw uncertain(r.reason);
  if(['USER_CANCELED','TASK_PAUSED','USER_OWNED_OR_INACTIVE','RUN_DEADLINE_EXPIRED'].includes(d2.error))throw uncertain(d2.error);
  live();
  let d1;try{d1=await clickDownload1({candidate,video,intent:persisted.intent,deadline:operationDeadline,guard:activeGuard});live();}catch(e){if(e?.code==='TASK_PAUSED'||e?.code==='RUN_DEADLINE_EXPIRED')throw e;throw uncertain('CLICK1_BRIDGE_ERROR');}if(!d1?.binding||!immutableEvidence(candidate,video,d1.binding))throw uncertain('BRIDGE_IDENTITY_MISSING');
  const binding1={...d1.binding,candidate,video};await st.write(key,{...persisted,stage:'download1_started',binding2,binding1});onEvent?.({type:'download1_started',key});
  r=await settle({base,binding:binding1,deadline:Math.min(operationDeadline,now()+deadlineMs),guard:activeGuard});if(r.status==='complete'){await st.write(key,{...persisted,stage:'verified',binding2,binding1,receipt:cleanReceipt(r.item,binding1)});live();return result(r,'download1',{...video,binding1});}
  if(r.status==='limit_exceeded')throw failure('LIMIT_EXCEEDED');throw uncertain(r.reason);
 };
 return {downloadVideo,reconcile:async()=>{throw uncertain('RECONCILE_REQUIRES_INTENT');}};
}

/** Child-round bridge: the only production entry point is a caller supplied Ego/CDP handler.
 * It must return native binding evidence from the owned extension page and never fabricates Chrome fields. */
export async function runExtensionDownloadRound({req,bridge}){
 if(!bridge||typeof bridge.run!=='function')throw failure('DOWNLOAD_BRIDGE_UNAVAILABLE');
 const raw=await bridge.run({req,download2:bridge.download2,download1:bridge.download1});if(raw&&Buffer.isBuffer(raw.bytes)){const {bytes,...meta}=raw;return {...meta,source_filename:meta.receipt?.filename??null};}return raw;
}

/**
 * 真实 Ego/CDP 接线工厂。调用方必须提供来自 frozen row/context 的点击 handler，
 * 以及从 owned chrome-extension://<id>/manifest.json 页读取的原生 DownloadItem。
 * 工厂不创建 URL、文件名、downloadId 或身份字段；缺任一可信证据即阻断。
 */
export function createEgoDownloadBridge({store,chrome,fsImpl=fs,clickDownload2,clickDownload1,ownedPage,compassPage,extensionId,download2Selector,download1Selector,readBinding,pollMs=100,deadlineMs=30000,guard=()=>true,sleep,probeDuration}={}){
 let nativeChrome=chrome;
 if(!nativeChrome){
  if(!ownedPage||!compassPage||typeof ownedPage.cdp!=='function'||typeof ownedPage.events!=='function'||typeof ownedPage.goto!=='function')throw failure('DOWNLOAD_EGO_PAGE_REQUIRED');
  if(typeof extensionId!=='string'||!/^[a-p]{32}$/i.test(extensionId))throw failure('DOWNLOAD_EXTENSION_ID_INVALID');
  if(typeof readBinding!=='function')throw failure('DOWNLOAD_BINDING_READER_REQUIRED');
  let contextIdPromise;
  const contextId=async()=>{if(!contextIdPromise)contextIdPromise=(async()=>{await ownedPage.cdp('Runtime.enable');await ownedPage.goto(`chrome-extension://${extensionId}/manifest.json`);const events=await ownedPage.events();const hit=(Array.isArray(events)?events:[]).find(e=>e?.method==='Runtime.executionContextCreated'&&e?.params?.context?.origin===`chrome-extension://${extensionId}`);if(!Number.isInteger(hit?.params?.context?.id))throw failure('DOWNLOAD_EXTENSION_CONTEXT_UNAVAILABLE');return hit.params.context.id;})();return contextIdPromise;};
  const evaluateOwned=async expression=>{const id=await contextId();const out=await ownedPage.cdp('Runtime.evaluate',{expression,contextId:id,awaitPromise:true,returnByValue:true});if(out?.exceptionDetails)throw failure('DOWNLOADS_API_UNAVAILABLE');const value=out?.result?.value;if(value===undefined)throw failure('DOWNLOADS_API_UNAVAILABLE');return value;};
  nativeChrome={downloads:{search:async()=>evaluateOwned('chrome.downloads.search({})'),onCreated:{addListener(){}},onChanged:{addListener(){}}}};
  const click=selector=>async({candidate,video,intent})=>{
   if(typeof selector!=='string'||!selector)throw failure('DOWNLOAD_SELECTOR_EVIDENCE_REQUIRED');
   // A real binding reader may arm an observation before the DOM click and
   // close it afterwards.  The legacy TEST reader returns a binding directly;
   // accepting that shape keeps the driver model usable without manufacturing
   // a native id.
   const prepared=await readBinding({phase:'prepare',candidate,video,intent,selector});
   await compassPage.click(selector,{label:selector});
   const proof=await readBinding({phase:'finish',candidate,video,intent,selector,prepared});
   const out=proof?.binding?proof:(prepared?.binding?prepared:proof);
   if(!out||typeof out!=='object')throw failure('DOWNLOAD_BINDING_READER_REQUIRED');
   return out;
  };
  clickDownload2=click(download2Selector);clickDownload1=click(download1Selector);
 }
 if(typeof clickDownload2!=='function'||typeof clickDownload1!=='function')throw failure('DOWNLOAD_EGO_HANDLER_REQUIRED');
 if(typeof nativeChrome?.downloads?.search!=='function')throw failure('DOWNLOADS_API_UNAVAILABLE');
 const driver=createDownloadDriver({store,chrome:nativeChrome,fsImpl,clickDownload2,clickDownload1,pollMs,deadlineMs,guard,sleep});
 return {run:async({req})=>{const out=await driver.downloadVideo({candidate:req.candidate,video:req.video,intent:req.video?.download_intent});if(!Number.isFinite(out.duration_ms)&&typeof probeDuration==='function'){const p=await probeDuration(out.bytes,{candidate:req.candidate,video:req.video});if(!Number.isFinite(p?.duration_ms)||p.source!=='ffprobe')throw failure('MEDIA_DURATION_EVIDENCE_MISSING');out.duration_ms=p.duration_ms;out.duration_source='ffprobe';}return out;}};
}
