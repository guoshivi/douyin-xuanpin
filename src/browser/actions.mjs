import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {runSelectionRound} from './selection-protocol.mjs';
import {downloadBytes,obtainVideo} from '../media.mjs';
import {createFeishuSync} from '../feishu/sync.mjs';
import {failure,verifyCart} from '../verifier.mjs';
const CONTRACT='data/acceptance/phase4-web-integration-20261010T1442/parent-site-contract.json';
export function createProductionAdapter({projectRoot,privateRoot,browserState,onBrowserState}={}){
 let contract,feishu,cartEvidence;const state=browserState??{};
 async function call(operation,args){const selectionRead=['selection_decision','creator_sample','prefilter_discover'].includes(operation);if(selectionRead)args.ctx.checkpoint();const scanReadDeadline=args.ctx.scanReadDeadline;contract??=JSON.parse(await fs.readFile(path.join(projectRoot,CONTRACT),'utf8'));if(contract.schema_version!==1||contract.library?.row_selector!=='tr[data-row-key]'||contract.decision?.main_image_selector_verified!=='img[class*=index_module__item___]')throw failure('SITE_CONTRACT_INVALID');args.ctx.checkRead();const writeDeadline=typeof args.snapshot.deadline==='string'?Date.parse(args.snapshot.deadline):NaN;if(operation==='add_cart'){if(!Number.isFinite(writeDeadline)||writeDeadline<=0)throw failure('RUN_DEADLINE_INVALID');if(Date.now()>=writeDeadline)throw failure('RUN_DEADLINE_EXPIRED');}// Wave17(A)：只读轮次有界重试——重试条件须全满足：operation∈{discover,read_cart,decision,freeze,metadata} ∧ err.code∈{BROWSER_BLOCKED,COMMAND_FAILED,PROTOCOL_INVALID,STDIN_FAILED} ∧ signal?.aborted!==true ∧ remaining()>30000；总尝试≤3（首次+2重试）；每次尝试重新生成 output_file（新 uuid，避免 wx 冲突）；间隔1500ms；add_cart/finish/handoff 零重试（副作用/生命周期）；最终失败原样抛最后一个错误；state.pages/onBrowserState 仅在成功轮后更新（onSpace 机制不变）。
 const retryable=new Set(['discover','read_cart','decision','freeze','metadata']).has(operation),retryCodes=new Set(['BROWSER_BLOCKED','COMMAND_FAILED','PROTOCOL_INVALID','STDIN_FAILED']);
 for(let attempt=1;;attempt++){
  const scanTimeout=await args.ctx.beforeBrowserRead?.(operation,{reconcile:args.scanReconcile===true,readDeadline:scanReadDeadline});
  const output_file=path.join(privateRoot,'browser-'+crypto.randomUUID()+'.json');
  const req={operation,contract,space_id:state.space_id,space_name:'selection-'+args.snapshot.run_id,pages:state.pages,deadline_ms:['add_cart','selection_decision','creator_sample','prefilter_discover'].includes(operation)?writeDeadline:undefined,decision_config:args.snapshot.policy.selection?.decision,creator_request:args.creator_request,prefilter_config:args.snapshot.policy.selection?.prefilter,prefilter_group:args.prefilter_group,output_file,max_candidates:args.snapshot.limits.max_candidates,candidate:args.candidate,video:args.video,cart_evidence:operation==='decision'?cartEvidence:undefined};
  try{const data=await runSelectionRound(req,{command:contract.tools.ego_command,signal:args.ctx.signal,timeoutMs:operation==='add_cart'?Math.min(90000,args.ctx.remaining(),writeDeadline-Date.now()):Math.min(90000,args.ctx.remaining(),scanTimeout??90000),onSpace:space=>{state.space_id=space;onBrowserState?.(state);}});if(selectionRead)args.ctx.checkpoint();state.pages=data.pages;onBrowserState?.(state);return data.result;}
  catch(e){if(!(attempt<3&&retryable&&retryCodes.has(e?.code)&&args.ctx.signal?.aborted!==true&&args.ctx.remaining()>30000))throw e;await new Promise(resolve=>setTimeout(resolve,1500));}
 }
}
 return {mode:'production',readCreatorSample:args=>call('creator_sample',args),readPrefilterGroup:args=>call('prefilter_discover',args),readSelectionDecision:args=>call('selection_decision',args),
  async discoverCandidates(args){const data=await call('discover',args);args.ctx.note('ONLY_VERIFIED_FIRST_SCREEN');if(Number.isSafeInteger(data.excluded_count)&&data.excluded_count>0)args.ctx.note('EXCLUDED_CLASS_FILTERED');return data.candidates;},
  async readCart(args){const row=await call('read_cart',args);verifyCart(args.candidate,row);cartEvidence={...row,verified:true};return row;},addToCart:args=>call('add_cart',args),async readDecision(args){verifyCart(args.candidate,args.cart_evidence);verifyCart(args.candidate,cartEvidence);if(!cartEvidence?.verified)throw failure('DECISION_CART_PROOF_MISSING');const result=await call('decision',args);cartEvidence=null;return result;},freezeVideos:args=>call('freeze',args),
  async downloadVideo(args){const metadata=await call('metadata',args);return obtainVideo(metadata,args.video,{signal:args.ctx.signal,checkpoint:args.ctx.checkpoint});},
  async downloadImage(args){return {bytes:await downloadBytes(args.image,{signal:args.ctx.signal,checkpoint:args.ctx.checkpoint,maxBytes:20*1024*1024})};},
  async syncFeishu(args){feishu??=createFeishuSync({projectRoot,privateRoot});return feishu.sync(args);},
  async readFeishu(args){return this.syncFeishu({...args,reconcileOnly:true});},
  async finish(args){return call('finish',args);},
  async handoff(args){if(state.space_id)await call('handoff',args);}
 };
}
