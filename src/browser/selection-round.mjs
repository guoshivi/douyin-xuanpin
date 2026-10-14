import fs from 'node:fs/promises';
import {extractRows,libraryCandidates,extractDecision} from './extract.mjs';
import {failure,verifyIdentity,verifyCart,assertNumericId,safeCode} from '../verifier.mjs';
import {productLink} from '../product-links.mjs';
import {noLinks} from '../storage.mjs';
// Wave18(A)：discover 期类目/标题排除（用户勾选：兑换券/虚拟＝本地生活服务整体；医疗健康/酒类/珠宝贵金属/文玩）。
// 反例红线：实物「手写兑换券涂层贴」=居家日用 → 类目判别优先，标题只许极紧（禁用宽词：优惠券/团购/旅游/酒店/外卖/现货/裸「券」）。
const CAT_IDS=['1000002143','1000004960','1000009091','1000000480','1000007740','1000001468'],CAT_NAMES=['本地生活服务','酒类','营养保健/特医食品','医疗器械及保健用品','黄金珠宝玉石','文玩收藏'],EXCLUDED_TITLE=/电子兑换[劵券]|电子提货卡|提货[劵券]|代金[劵券]/u;
export function excludedRow(row){const first=row?.category?.first_category;if(first&&(CAT_IDS.includes(String(first.category_id))||CAT_NAMES.includes(first.category_name)))return true;return EXCLUDED_TITLE.test(row?.title??'');}
// Wave16: square（选品广场）DOM 证明 — 加车按钮在检索结果中恰一个（scroller 内 button[data-high-risk="true"]），
// 搜索框值=product_id、无 spinner、无空态。选择器为字面量，页面侧零依赖（经 p.evaluate 序列化执行）。
export function squareCardProof({candidate,search,scroller}){
 const visible=n=>{if(!n||typeof n.getClientRects!=='function'||!n.getClientRects().length)return false;for(let el=n;el;el=el.parentElement){const st=getComputedStyle(el);if(el.hidden||el.getAttribute?.('aria-hidden')==='true'||st.display==='none'||['hidden','collapse'].includes(st.visibility)||st.opacity==='0')return false;}return true;};
 const s=document.querySelector(scroller),btns=s?[...s.querySelectorAll('button[data-high-risk="true"]')].filter(visible):[];
 const input=document.querySelector(search)?.value??null,spinner=[...document.querySelectorAll('.aurora-spin-spinning,[aria-busy="true"]')].some(visible),empty=!!document.querySelector('.aurora-empty');
 return {ok:!!s&&btns.length===1&&input===candidate.product_id&&!spinner&&!empty,scroller:!!s,buttons:btns.length,input,spinner,empty};
}
// Wave17(B)：决策页容忍匹配——旧提取器要求全页恰 1 个 basicInfoContainer/恰 1 个 titleContainer/恰 1 个 title；实测偶发重复标题结构
// （roots=1/titleContainer=3/title=14/param-style=1/item-img=5）恒 null → 25s 超时。新匹配逐 span：productId 的 span.param-style → 最近
// titleContainer 祖先 → 其中文本==title 的 title 元素须恰 1；images 取该 root 的 item img（非空且全为非空字符串）；全页命中恰 1 才返回
// 原形状（root_count/header_count 恒为 1，供 identity 后检）；waitForFunction 与 evaluate 两处使用替换自 extractDecision。
export function extractDecisionTolerant({productId,title}){
 const roots=[...document.querySelectorAll('[class*="index_module__basicInfoContainer___"]')];const hits=[];
 for(const root of roots)for(const id of [...root.querySelectorAll('span.param-style')].filter(n=>n.textContent?.trim()===productId)){
  const header=id.closest('[class*="index_module__titleContainer___"]');if(!header)continue;
  const titles=[...header.querySelectorAll('[class*="index_module__title___"]')].filter(n=>n.textContent?.trim()===title);if(titles.length!==1)continue;
  const images=[...root.querySelectorAll('img[class*="index_module__item___"]')].map(x=>x.currentSrc||x.src);if(!images.length||images.some(x=>typeof x!=='string'||!x))continue;
  hits.push({product_id:id.textContent.trim(),title:titles[0].textContent.trim(),images});
 }
 if(hits.length!==1)return null;return {...hits[0],root_count:1,header_count:1};
}
export async function handleSelectionRound(req,{taskSpace=globalThis.taskSpace,emit=x=>process.stdout.write(JSON.stringify(x)+'\n')}={}){
 let task,space,ownedAdmissionPage,admissionScript,roundError,postEffectCheck;const createdThisRound=[];
 // Wave7: the platform close() may still touch the certified producers before it returns
 // (late frames/requests during teardown). The post-effect publish permit is therefore
 // adjudicated on the close side as well: the teardown is initiated first, and the last
 // receipt read the platform still resolves before close() returns is the final gate.
 // Any drift of the original parent/child producer binding -> CART_ADD_READBACK_UNCERTAIN,
 // never a success result; the already-performed effect is not rolled back or re-sent.
 // Only an adjudicated (coded) fence failure may fail the round: a read the platform does
 // not answer at all (no driver code) is not adjudicable and must not reject valid rounds.
 const closeAdmission=async()=>{if(!ownedAdmissionPage)return;try{try{if(admissionScript)await ownedAdmissionPage.cdp('Page.removeScriptToEvaluateOnNewDocument',{identifier:admissionScript});}finally{if(postEffectCheck&&!roundError){const closing=ownedAdmissionPage.close();let fenceError=null;try{await postEffectCheck();}catch(e){fenceError=e;}try{await closing;}catch(e){if(!fenceError?.code)throw e;}if(fenceError&&fenceError.code)throw fenceError;}else await ownedAdmissionPage.close();}ownedAdmissionPage=null;}catch(e){if(e?.code==='CART_ADD_READBACK_UNCERTAIN')throw e;throw failure('CART_ADMISSION_CLEANUP_UNCONFIRMED');}};
 try{
  task=await taskSpace(req.space_id!=null?Number(req.space_id):req.space_name);space=String(task.spaceId);if(!/^\d+$/.test(space)||req.space_id!=null&&space!==req.space_id)throw failure('SPACE_REQUEST_MISMATCH');emit({type:'phase4_space',space_id:space});
  if(task.ownership!=='agent')throw failure('USER_OWNED_OR_INACTIVE');
  let result,pages={...(req.pages??{})};
  // Wave17(C)：get() 页面自愈——记录页缺失/失效（task.page 查询失败、label 或 spaceId 不符、await url() 存活探测拒绝）时重建并更新 pages[key]；
  // 重建：library 键以 p1 为基底（既有语义），其余键 newPage()；重建后仍不符才抛既有码 PAGE_SPACE_MISMATCH；其余行为不变。
  const get=async key=>{const usable=async p=>{if(!p||p.label!==pages[key]||String(p.spaceId)!==space)return false;try{await p.url();return true;}catch{return false;}};
   let p=null;try{p=pages[key]?task.page(pages[key]):null;}catch{p=null;}
   if(!(await usable(p))){const rebuilt=key==='library'?task.page('p1'):await task.newPage();if(!rebuilt||typeof rebuilt.label!=='string'||!rebuilt.label||String(rebuilt.spaceId)!==space)throw failure('PAGE_SPACE_MISMATCH');pages[key]=rebuilt.label;p=rebuilt;if(key!=='library')createdThisRound.push(rebuilt.label);}
   return p;};
  const control=()=>{if(task.ownership!=='agent')throw failure('USER_OWNED_OR_INACTIVE');};
  const waitRows=async p=>p.waitForSelector('tr[data-row-key]',{timeout:20000});
 // Wave16：选品库页于 2026-10-11 08:41-08:47 切换为「选品广场」卡片流（批8 run-875289bb 加车 waitRows 超时 →
 // SIDE_EFFECT_UNCERTAIN；零副作用）。readiness 改为有界等待二者的析取（旧表格行/新卡流模块），再把模式读回；
 // 二者皆不可观测时回退旧路径（旧路径自身的既有有界等待继续裁定，行为与切换前逐字一致）。
 const waitLibrary=async p=>{
  try{await p.waitForFunction(()=>document.querySelectorAll('tr[data-row-key]').length>0||!!document.querySelector('.merch-picking-library-product-module'),null,{timeout:20000});}catch{}
  const mode=await p.evaluate(()=>document.querySelectorAll('tr[data-row-key]').length>0?'legacy':document.querySelector('.merch-picking-library-product-module')?'square':null);
  return mode==='square'?'square':'legacy';
 };
 const materialList=value=>{try{const u=new URL(value);return u.pathname==='/pc/selection/common/material_list';}catch{return false;}};
 // 只读响应；不读取/不保存 extra.search_id/session_id（匹配只用 scene/search_text 与 summary_promotions 结构）。
 const materialListBody=async(p,requestId)=>{
  try{const response=await p.cdp('Network.getResponseBody',{requestId});
   if(typeof response?.body!=='string'||typeof response.base64Encoded!=='boolean')return null;
   const raw=JSON.parse(response.base64Encoded?Buffer.from(response.body,'base64').toString('utf8'):response.body);
   if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
   if(raw.code!==undefined&&raw.code!==0||raw.st!==undefined&&raw.st!==0)return null;
   const data=raw.data;if(!data||typeof data!=='object'||Array.isArray(data)||!Number.isSafeInteger(data.total)||data.total<0||typeof data.has_more!=='boolean'||!Array.isArray(data.summary_promotions))return null;
   return data.summary_promotions;
  }catch(e){return null;}
 };
 const waitMaterialList=async(p,scene,searchText,timeoutMs)=>{
  const until=Date.now()+timeoutMs,seen=new Map();
  const drain=async()=>{const events=await p.events();if(!Array.isArray(events))return;for(const e of events){const x=e?.params;if(e?.method==='Network.requestWillBeSent'&&materialList(x?.request?.url)){let post=null;try{post=JSON.parse(x.request.postData);}catch{}if(post&&post.scene===scene&&post.search_text===searchText&&typeof x.requestId==='string'&&x.requestId&&!seen.has(x.requestId))seen.set(x.requestId,{status:null,mime:null,finished:false,failed:false});}else if(e?.method==='Network.responseReceived'){const q=seen.get(x?.requestId);if(q){q.status=x?.response?.status;q.mime=x?.response?.mimeType;}}else if(e?.method==='Network.loadingFinished'){const q=seen.get(x?.requestId);if(q)q.finished=true;}else if(e?.method==='Network.loadingFailed'){const q=seen.get(x?.requestId);if(q)q.failed=true;}}};
  while(true){await drain();for(const [requestId,q] of seen)if(q.finished&&!q.failed&&q.status===200&&q.mime==='application/json'){const items=await materialListBody(p,requestId);if(items)return items;}
   if(Date.now()>=until)return null;
   await p.waitForTimeout(Math.min(100,until-Date.now()));}
 };
 // square 行形状：row_key=product_id、19 位字符串不转数字；cell_texts[1/2/5] 由结构化字段重建为 parseMetric 可解析文本
 // （price_desc.price.origin 分→元；cos_info.cos.cos_ratio 百分数文本；month_sale.origin 千分位）；缺失=空串（旧语义）。
 const squareRows=items=>{
  const digits=v=>typeof v==='string'&&/^\d+$/.test(v);
  const priceText=price=>{if(Number.isSafeInteger(price?.origin)&&price.origin>=0)return '\u00a5'+(price.origin/100).toFixed(2);if(digits(price?.integer))return '\u00a5'+price.integer+'.'+(digits(price?.decimal)?price.decimal:'00');return '';};
  const ratioText=cos=>{const r=cos?.cos?.cos_ratio;if(digits(r?.integer))return r.integer+(digits(r.decimal)?'.'+r.decimal:'')+'%';if(Number.isFinite(r?.origin))return String(r.origin)+'%';return typeof cos?.cos_ratio_text==='string'?cos.cos_ratio_text:'';};
  const salesText=m=>Number.isSafeInteger(m?.origin)&&m.origin>=0?String(m.origin).replace(/\B(?=(\d{3})+(?!\d))/g,','):'';
  return items.map(it=>{const bm=it?.base_model??{},pi=bm.product_info??{};return {row_key:it?.product_id,product_id:it?.product_id,promotion_id:it?.promotion_id,title:pi.name,cell_texts:[null,priceText(bm.marketing_info?.price_desc?.price),ratioText(bm.promotion_info?.cos_info),null,null,salesText(pi.month_sale)],category:pi.category};});
 };
  const writeDeadline=req.deadline_ms;
  const checkWrite=()=>{if(typeof writeDeadline!=='number'||!Number.isFinite(writeDeadline)||writeDeadline<=0)throw failure('RUN_DEADLINE_INVALID');if(Date.now()>=writeDeadline)throw failure('RUN_DEADLINE_EXPIRED');};
  if(req.operation==='add_cart')checkWrite();
  let cartLease=null,admissionUntil=null,framedCart=null,libraryMode=null,libraryFeed=null;
  // This runs at document-start, before application capture/bubble handlers.
  const installAdmission=()=>{
   if(globalThis.__selectionFramedProducer)return;
   const g={pending:0,started:0,completed:0,failed:0,epoch:performance.timeOrigin,arm:null,blocked:0,hits:0};globalThis.__selectionFramedProducer=g;
   const match=u=>{try{const x=new URL(typeof u==='string'?u:u?.url,location.href);return x.origin===location.origin&&x.pathname==='/selection_cart_pc_api/card/m_get_card';}catch{return false;}};
   const fetchOriginal=globalThis.fetch;globalThis.fetch=function(...a){if(!match(a[0]))return fetchOriginal.apply(this,a);g.pending++;g.started++;return Promise.resolve().then(()=>fetchOriginal.apply(this,a)).then(async r=>{try{await r.clone().text();if(r.status!==200)g.failed++;return r;}catch(e){g.failed++;throw e;}finally{g.pending--;g.completed++;}},e=>{g.failed++;g.pending--;g.completed++;throw e;});};
   const open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send,urls=new WeakMap();XMLHttpRequest.prototype.open=function(m,u,...a){urls.set(this,u);return open.call(this,m,u,...a);};XMLHttpRequest.prototype.send=function(...a){if(!match(urls.get(this)))return send.apply(this,a);g.pending++;g.started++;let done=false;const finish=(failed=false)=>{if(done)return;done=true;if(failed||this.status!==200)g.failed++;g.pending--;g.completed++;};this.addEventListener('loadend',()=>finish(),{once:true});try{return send.apply(this,a);}catch(e){finish(true);throw e;}};
   const visible=(n,w=window)=>{if(!n?.getClientRects().length)return false;for(let el=n;el;el=el.parentElement){const style=w.getComputedStyle(el);if(el.hidden||el.getAttribute?.('aria-hidden')==='true'||style.display==='none'||['hidden','collapse'].includes(style.visibility)||style.opacity==='0')return false;}return true;};
   const squareCard=b=>{const a=g.arm,s=document.querySelector(a?.scroller??'.aurora-infinite-scroller');if(!a||a.square!==true||!s||!s.contains(b))return false;const btns=[...s.querySelectorAll('button[data-high-risk="true"]')].filter(n=>visible(n,window));return btns.length===1&&btns[0]===b&&document.querySelector(a.library_search)?.value===a.product&&!document.querySelector('.aurora-empty')&&![...document.querySelectorAll('.aurora-spin-spinning,[aria-busy="true"]')].some(n=>visible(n,window));};
   const guard=e=>{
    const b=e.target?.closest?.('button');if(!b||b.textContent?.trim()!=='加选品车')return;
    const a=g.arm;let ok=false;
    try{const f=document.getElementById(a?.frameId),w=f?.contentWindow,h=w?.__selectionFramedProducer,doc=w?.document,tr=b.closest('tr[data-row-key]');let fibre=tr?.[Object.keys(tr).find(k=>k.startsWith('__reactFiber'))],record;
     for(let i=0;fibre&&i<30;i++,fibre=fibre.return)if(fibre.memoizedProps?.record){record=fibre.memoizedProps.record;break;}
     const rows=[...doc.querySelectorAll('tr[data-row-key]')].filter(n=>visible(n,w)),empty=[...doc.querySelectorAll('.aurora-table-empty .aurora-empty-description')].filter(n=>visible(n,w));
     ok=!!a&&!a.used&&e.isTrusted&&e.button===0&&Date.now()<a.until&&Date.now()<a.writeDeadline&&visible(f)&&visible(b)&&h===a.producer&&h.epoch===a.epoch&&h.started===a.started&&h.completed===a.completed&&h.pending===0&&h.failed===0&&g===a.parentProducer&&globalThis.__selectionFramedProducer===a.parentProducer&&g.epoch===a.parentEpoch&&g.pending===a.parentPending&&g.failed===a.parentFailed&&g.started===a.parentStarted&&g.completed===a.parentCompleted&&doc.querySelector(a.search)?.value===a.product&&rows.length===0&&empty.length===1&&['暂无数据','暂无符合要求的商品，修改条件后试试吧'].includes(empty[0].textContent?.trim())&&![...doc.querySelectorAll('.aurora-spin-spinning,[aria-busy="true"]')].some(n=>visible(n,w))&&(a.square===true?(squareCard(b)):(tr?.getAttribute('data-row-key')===a.product&&record?.product_id===a.product&&record?.promotion_id===a.promotion));
     const expected=['pointerdown','mousedown','pointerup','mouseup','click'];if(ok&&e.type!==expected[a.stage])ok=false;if(ok){a.stage++;if(e.type==='click'){a.used=true;g.hits++;}}
    }catch{}
    if(!ok){g.blocked++;if(a)a.used=true;e.preventDefault();e.stopImmediatePropagation();}
   };
   for(const type of ['pointerdown','mousedown','pointerup','mouseup','click'])window.addEventListener(type,guard,true);
  };
  const makeFramedCart=async()=>{
   admissionUntil=Math.min(Date.now()+20000,writeDeadline);control();checkWrite();
   const p=ownedAdmissionPage=await task.newPage();if(String(p.spaceId)!==space)throw failure('PAGE_SPACE_MISMATCH');
   const installed=await p.cdp('Page.addScriptToEvaluateOnNewDocument',{source:'('+installAdmission.toString()+')();'});admissionScript=installed.identifier;
   await p.cdp('Network.enable');await p.goto(req.contract.library.entry_url);control();checkWrite();libraryMode=await waitLibrary(p);control();checkWrite();if(libraryMode==='legacy')await waitRows(p);else{libraryFeed=await waitMaterialList(p,'PCSquareFeed','',20000);if(!libraryFeed)throw failure('LIBRARY_NOT_READY');}control();checkWrite();
   // Conservative parent scope: only a docstart producer with no cart request
   // history is eligible. Bootstrap histories are not certified by counters.
   await p.evaluate(()=>{const g=globalThis.__selectionFramedProducer;if(!g||!Number.isFinite(g.epoch)||g.started!==0||g.completed!==0||g.pending!==0||g.failed!==0)throw Object.assign(Error('CART_QUERY_UNCERTAIN'),{code:'CART_QUERY_UNCERTAIN'});globalThis.__selectionAdmissionLease={parentProducer:g,parent:{epoch:g.epoch,started:0,completed:0,pending:0,failed:0},childProducer:null};});
   const id='selection-owned-cart-admission';
   const evaluate=(fn,arg)=>p.evaluate(({source,arg,id})=>{const w=document.getElementById(id)?.contentWindow;if(!w||w.location.origin!==location.origin)throw Error('CART_FRAME_UNAVAILABLE');const value=w.eval('('+source+')('+JSON.stringify(arg??null)+')');if(value?.kind==='empty'){const g=globalThis.__selectionFramedProducer,h=w.__selectionFramedProducer,l=globalThis.__selectionAdmissionLease;if(!l||g!==l.parentProducer||!h||Object.keys(l.parent).some(k=>g[k]!==l.parent[k])||h.pending!==0||h.failed!==0||l.childProducer&&h!==l.childProducer)throw Object.assign(Error('CART_QUERY_UNCERTAIN'),{code:'CART_QUERY_UNCERTAIN'});l.childProducer??=h;value.producer={...value.producer,parent:l.parent};}return value;},{source:fn.toString(),arg,id});
   return {label:p.label,spaceId:p.spaceId,evaluate,events:()=>p.events(),cdp:(...a)=>p.cdp(...a),waitForTimeout:ms=>p.waitForTimeout(ms),
    goto:url=>p.evaluate(({id,url})=>{document.getElementById(id)?.remove();const l=globalThis.__selectionAdmissionLease;if(l)l.childProducer=null;const f=document.createElement('iframe');f.id=id;f.title='本品选品车核对';f.width='1200';f.height='240';Object.assign(f.style,{position:'fixed',top:'8px',right:'8px',width:'min(1200px, calc(100vw - 16px))',height:'min(240px, calc(100vh - 16px))',boxSizing:'border-box',zIndex:'2147483600'});f.src=url;document.body.appendChild(f);},{id,url}),
    waitForSelector:(selector,{timeout})=>p.waitForFunction(({id,selector})=>{try{return !!document.getElementById(id)?.contentWindow.document.querySelector(selector);}catch{return false;}},{id,selector},{timeout}),
    waitForFunction:(fn,arg,{timeout})=>p.waitForFunction(({id,source,arg})=>{try{return document.getElementById(id)?.contentWindow.eval('('+source+')('+JSON.stringify(arg??null)+')');}catch{return false;}},{id,source:fn.toString(),arg},{timeout}),
    fill:(selector,value)=>evaluate(({selector,value})=>{const n=document.querySelector(selector);const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(n,value);n.dispatchEvent(new Event('input',{bubbles:true}));n.dispatchEvent(new Event('change',{bubbles:true}));},{selector,value}),
    click:async selector=>{const point=await p.evaluate(({id,selector})=>{const f=document.getElementById(id),d=f.contentWindow.document;const n=selector==='loc=role:button[name="查询"]'?[...d.querySelectorAll('button,[role="button"]')].find(n=>(n.getAttribute('aria-label')||n.textContent)?.trim()==='查询'):d.querySelector(selector);if(!n)throw Error('CART_QUERY_BUTTON_MISSING');n.scrollIntoView({block:'center',inline:'center'});const a=f.getBoundingClientRect(),b=n.getBoundingClientRect(),x=b.left+b.width/2,y=b.top+b.height/2,point={x:a.left+f.clientLeft+x,y:a.top+f.clientTop+y};if(document.elementFromPoint(point.x,point.y)!==f||!n.contains(d.elementFromPoint(x,y)))throw Object.assign(Error('CART_QUERY_UNCERTAIN'),{code:'CART_QUERY_UNCERTAIN'});return point;},{id,selector});await p.cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await p.cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});}
   };
  };
  const cartLookup=async()=>{
   cartLease=null;
   const c=verifyIdentity(req.candidate),p=framedCart??await get('cart');control();
   const until=req.operation==='add_cart'?(admissionUntil??=Math.min(Date.now()+20000,writeDeadline)):Date.now()+20000;
   const assertLive=()=>{control();if(req.signal?.aborted)throw failure('RUN_CANCELLED');if(Date.now()>=until)throw failure('CART_QUERY_DEADLINE');};
   const step=async action=>{assertLive();const value=await action();assertLive();if(postEffectCheck)await postEffectCheck();return value;};
   const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
   const origin=new URL(req.contract.cart.entry_url).origin;
   const endpoint=value=>{try{const u=new URL(value);return u.origin===origin&&u.pathname==='/selection_cart_pc_api/card/m_get_card';}catch{return false;}};
   const queries=new Map();let uncertain=false,click=null,queryStarted=false;
   const ingest=events=>{
    if(!Array.isArray(events)){uncertain=true;return;}
    for(const e of events){const x=e?.params;if(!object(x))continue;
     if(e.method==='Network.requestWillBeSent'&&endpoint(x.request?.url)){
      if(typeof x.requestId!=='string'||!x.requestId||queries.has(x.requestId)||x.redirectResponse){uncertain=true;continue;}
      let post=null;try{post=JSON.parse(x.request.postData);}catch{}
      const prior=!queryStarted;
      const schema=x.request.method==='POST'&&Number.isFinite(x.wallTime)&&object(post)&&(post.page===1||post.page===2)&&post.page_size===20&&post.view_type===0&&post.version===2&&object(post.common_filter)&&Object.keys(post.common_filter).length===0&&Object.keys(post).every(k=>['page','page_size','key_word','view_type','common_filter','version'].includes(k));
      const valid=schema&&(prior?typeof post.key_word==='string'&&(post.key_word===''||/^\d{19}$/.test(post.key_word)):post.page===1&&post.key_word===c.product_id&&Number.isFinite(click?.time)&&x.wallTime*1000>=click.time);
      queries.set(x.requestId,{prior,valid,viewType:post?.view_type,status:null,finished:false,failed:false,bodyChecked:false});
     }else if(e.method==='Network.responseReceived'){
      const q=queries.get(x.requestId);if(!q){if(endpoint(x.response?.url))uncertain=true;continue;}
      if(q.status!==null||!endpoint(x.response?.url)||x.response?.mimeType!=='application/json')q.valid=false;
      q.status=x.response?.status;
     }else if(e.method==='Network.loadingFinished'){const q=queries.get(x.requestId);if(q){if(q.finished||q.failed)q.valid=false;q.finished=true;}}
     else if(e.method==='Network.loadingFailed'){const q=queries.get(x.requestId);if(q)q.failed=true;}
    }
    if([...queries.values()].filter(q=>!q.prior).length>1)uncertain=true;
   };
   const readBody=async(requestId,q)=>{
    try{
     const response=await step(()=>p.cdp('Network.getResponseBody',{requestId}));
     if(typeof response?.body!=='string'||typeof response.base64Encoded!=='boolean')return null;
     const raw=JSON.parse(response.base64Encoded?Buffer.from(response.body,'base64').toString('utf8'):response.body),data=raw?.data,groups=data?.cart_view_card,group=Array.isArray(groups)&&groups.length===1?groups[0]:null,cards=group?.cards;
     // Prior first-screen reads must also have successful, understood terminal bodies.
     // data.total is the whole-cart count, not this query's result count.
     if(!object(raw)||raw.code!==0||raw.st!==0||!object(data)||!Number.isSafeInteger(data.total)||data.total<0||typeof data.has_more!=='boolean'||!object(group)||group.view_type!==q.viewType||!Array.isArray(cards)||!Number.isSafeInteger(group.total)||typeof group.has_more!=='boolean')return null;
     if(data.total<cards.length)return null;
    if(q.prior){if(cards.length>20||group.total<cards.length||!group.has_more&&group.total!==cards.length)return null;}
     else if(cards.length>1||group.total!==cards.length||group.has_more!==false)return null;
     for(const item of cards){const card=item?.product_card;if(!object(item)||item.entity_type!==1||!object(card)||typeof card.product_id!=='string'||!(q.prior&&card.product_id===''||/^\d{19}$/.test(card.product_id))||typeof card.promotion_id!=='string'||!/^\d{19}$/.test(card.promotion_id))return null;}
     q.bodyChecked=true;
     if(q.prior)return {kind:'settled'};
     if(cards.length===0)return {kind:'empty'};
     const card=cards[0].product_card;return {kind:card.product_id===c.product_id&&card.promotion_id===c.promotion_id?'present':'mismatch',product_id:card.product_id,promotion_id:card.promotion_id};
    }catch(e){assertLive();return null;}
   };
   const drain=async()=>{ingest(await step(()=>p.events()));};
   const validState=()=>!uncertain&&[...queries.values()].every(q=>q.valid&&!q.failed&&q.finished&&q.status===200&&q.bodyChecked);
   // Subscribe before navigation and retain every observed prior requestId.
   await step(()=>p.cdp('Network.enable'));await drain();
   await step(()=>p.goto(req.contract.cart.entry_url));
   await step(()=>p.waitForSelector(req.contract.cart.search_input_selector,{timeout:until-Date.now()}));
   await drain();
   while(true){
    assertLive();
    if(uncertain||[...queries.values()].some(q=>!q.valid||q.failed||q.status!==null&&q.status!==200))throw failure('CART_QUERY_UNCERTAIN');
    for(const [id,q] of queries)if(q.finished&&!q.bodyChecked&&(!q.status||!await readBody(id,q)))throw failure('CART_QUERY_UNCERTAIN');
    if(validState())break;
    await step(()=>p.waitForTimeout(Math.min(100,until-Date.now())));await drain();
   }
   await step(()=>p.fill(req.contract.cart.search_input_selector,c.product_id));await drain();
   if(!validState())throw failure('CART_QUERY_UNCERTAIN');
   // Capture the actual trusted click, not the start of an awaited SDK action.
   await step(()=>p.evaluate(({buttonSelector,searchSelector})=>{
    if(globalThis.__selectionCartQueryGate)throw Error('CART_QUERY_GATE_BUSY');
    const gate={count:0,time:null,origin:location.origin,productId:null};
    const buttons=()=>buttonSelector==='loc=role:button[name="查询"]'?[...document.querySelectorAll('button,[role="button"]')].filter(n=>(n.getAttribute('aria-label')||n.textContent)?.trim()==='查询'):[...document.querySelectorAll(buttonSelector)];
    gate.listener=e=>{const matches=buttons();if(e.isTrusted&&e.button===0&&matches.length===1&&matches[0].contains(e.target)){gate.count++;gate.time=performance.timeOrigin+performance.now();gate.productId=document.querySelector(searchSelector)?.value;}};
    globalThis.__selectionCartQueryGate=gate;document.addEventListener('click',gate.listener,true);
   },{buttonSelector:req.contract.cart.query_button_selector,searchSelector:req.contract.cart.search_input_selector}));
   queryStarted=true;
   try{await step(()=>p.click(req.contract.cart.query_button_selector,{label:'核对本品选品车'}));}
   finally{click=await p.evaluate(()=>{const gate=globalThis.__selectionCartQueryGate;if(!gate)return null;document.removeEventListener('click',gate.listener,true);delete globalThis.__selectionCartQueryGate;return {count:gate.count,time:gate.time,origin:gate.origin,productId:gate.productId};});}
   assertLive();uncertain=uncertain||click?.count!==1||click?.origin!==origin||click?.productId!==c.product_id||!Number.isFinite(click?.time);
   let proof=null;
   while(Date.now()<until){
    await drain();
    const current=[...queries.entries()].filter(([,q])=>!q.prior),entry=current.length===1?current[0]:null;
    if(uncertain||entry&&(entry[1].failed||!entry[1].valid))break;
    if(entry&&entry[1].finished){const [requestId,q]=entry;if(q.status===200)proof=await readBody(requestId,q);break;}
    await step(()=>p.waitForTimeout(Math.min(100,until-Date.now())));
   }
   const cartDOM=({candidate,proof,searchSelector,readOnly})=>{
    const visible=n=>{if(!n.getClientRects().length)return false;for(let el=n;el;el=el.parentElement){const style=getComputedStyle(el);if(el.hidden||el.getAttribute?.('aria-hidden')==='true'||style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.opacity==='0')return false;}return true;};
    if(!proof||document.querySelector(searchSelector)?.value!==candidate.product_id||[...document.querySelectorAll('.aurora-spin-spinning,[aria-busy="true"]')].some(visible))return false;
    const rows=[...document.querySelectorAll('tr[data-row-key]')].filter(visible),empty=[...document.querySelectorAll('.aurora-table-empty .aurora-empty-description')].filter(visible);
    if(proof.kind==='empty'){const g=globalThis.__selectionFramedProducer;return rows.length===0&&empty.length===1&&['暂无数据','暂无符合要求的商品，修改条件后试试吧'].includes(empty[0].textContent?.trim())?{kind:'empty',...(g?{producer:{epoch:g.epoch,started:g.started,completed:g.completed,pending:g.pending,failed:g.failed}}:{})}:false;}
    if(rows.length!==1||empty.length!==0||proof.kind==='mismatch'&&!readOnly)return false;
    const tr=rows[0],key=Object.keys(tr).find(k=>k.startsWith('__reactFiber'));let f=key?tr[key]:null,card=null;
    for(let i=0;f&&i<30;i++,f=f.return)if(f.memoizedProps?.record){card=f.memoizedProps.record.product_card;break;}
    if(!card||tr.getAttribute('data-row-key')!==proof.promotion_id||card.product_id!==proof.product_id||card.promotion_id!==proof.promotion_id)return false;
    // Read-only mismatches stay explicitly unverified; never return null/absence for them.
    return proof.kind==='mismatch'?{kind:'mismatch'}:{kind:'present',row:{row_key:tr.getAttribute('data-row-key'),product_id:card.product_id,promotion_id:card.promotion_id,commodity_id:card.promotion_id}};
   };
   const args={candidate:{product_id:c.product_id,promotion_id:c.promotion_id},proof:uncertain?null:proof,searchSelector:req.contract.cart.search_input_selector,readOnly:req.operation==='read_cart'};
   await step(()=>p.waitForFunction(cartDOM,args,{timeout:until-Date.now()}));
   const recheck=async()=>{
    await drain();if(!validState()||[...queries.values()].filter(q=>!q.prior).length!==1)throw failure('CART_QUERY_UNCERTAIN');
    const observed=await step(()=>p.evaluate(cartDOM,args));if(!observed)throw failure('CART_QUERY_UNCERTAIN');
    // Also consume events produced during evaluate and before its SDK return.
    await drain();if(!validState()||[...queries.values()].filter(q=>!q.prior).length!==1)throw failure('CART_QUERY_UNCERTAIN');
    assertLive();return observed;
   };
   const observed=await recheck();
   if(observed.kind==='empty'){
    // The caller must re-read after every library await. This is not an atomic
    // transaction with SDK click: no conditional-click primitive is documented.
    if(req.operation==='add_cart')cartLease={assertLive,producer:observed.producer,check:async()=>{const fresh=await recheck();if(fresh.kind!=='empty'||JSON.stringify(fresh.producer)!==JSON.stringify(observed.producer))throw failure('CART_QUERY_UNCERTAIN');}};
    return null;
   }
   if(observed.kind==='mismatch')return {identity_mismatch:true};
   verifyCart(c,observed.row);return observed.row;
  };
  if(req.operation==='discover'){
   const p=await get('library');await p.cdp('Network.enable');await p.goto(req.contract.library.entry_url);const mode=await waitLibrary(p);control();let rows;
   if(mode==='square'){const items=await waitMaterialList(p,'PCSquareFeed','',20000);if(!items||!items.length)throw failure('LIBRARY_NOT_READY');rows=squareRows(items);}
   else{await waitRows(p);control();rows=await p.evaluate(extractRows,{kind:'library',limit:req.max_candidates});if(!rows.length)throw failure('LIBRARY_NOT_READY');}
   // Wave18(A3)：两条路径同一排除谓词；rows→candidates 之前过滤，excluded_count=被排除行数（安全整数）。
   const kept=rows.filter(r=>!excludedRow(r));
   result={candidates:libraryCandidates(kept).slice(0,req.max_candidates),excluded_count:rows.length-kept.length,pages_observed:1,stop_reason:'ONLY_VERIFIED_FIRST_SCREEN'};
  }else if(req.operation==='read_cart')result=await cartLookup();
  else if(req.operation==='add_cart'){
   const c=verifyIdentity(req.candidate);framedCart=await makeFramedCart();const existing=await cartLookup();if(existing)result=existing;else{const p=ownedAdmissionPage;
   if(libraryMode==='square'){
    /* —— wave16「选品广场」加车：加车按钮只在单品检索结果中唯一（button[data-high-risk="true"]）；结果判定=网络证明
       （PCSquareSearch 恰 1 项 product_id/promotion_id 全等；0 项/多项/不符 → CANDIDATE_SEARCH_NOT_FOUND 既有码）
       + DOM 证明（scroller 内恰 1 个该按钮、搜索框值=product_id、无 spinner/空态）；点击沿用既有 arm/guard/fence/readback。—— */
    checkWrite();await p.fill(req.contract.library.search_input_selector,c.product_id);await p.keyboard.press('Enter');
    const items=await waitMaterialList(p,'PCSquareSearch',c.product_id,Math.min(8000,admissionUntil-Date.now()));
    control();if(!Array.isArray(items)||items.length!==1||items[0]?.product_id!==c.product_id||items[0]?.promotion_id!==c.promotion_id)throw failure('CANDIDATE_SEARCH_NOT_FOUND');
    if(!cartLease)throw failure('CART_QUERY_UNCERTAIN');await cartLease.check();control();cartLease.assertLive();checkWrite();
    const dom=await p.evaluate(squareCardProof,{candidate:{product_id:c.product_id,promotion_id:c.promotion_id},search:req.contract.library.search_input_selector,scroller:'.aurora-infinite-scroller'});control();
    if(!dom?.ok){
     if(dom&&dom.buttons===0&&dom.input===c.product_id&&!dom.spinner&&!dom.empty){const settled=await cartLookup();if(settled)result=settled;}
     if(!result)throw failure('CANDIDATE_SEARCH_NOT_FOUND');
    }
    if(!result){
     await p.evaluate(({candidate,until,writeDeadline,search,expected,square,library_search})=>{const g=globalThis.__selectionFramedProducer,h=document.getElementById('selection-owned-cart-admission')?.contentWindow.__selectionFramedProducer,l=globalThis.__selectionAdmissionLease;if(!g||!h||!expected?.parent||!l||g!==l.parentProducer||h!==l.childProducer||Object.keys(l.parent).some(k=>g[k]!==l.parent[k]||g[k]!==expected.parent[k])||h.pending||h.failed||h.epoch!==expected.epoch||h.started!==expected.started||h.completed!==expected.completed)throw Object.assign(Error('CART_QUERY_UNCERTAIN'),{code:'CART_QUERY_UNCERTAIN'});g.arm={frameId:'selection-owned-cart-admission',childWindow:document.getElementById('selection-owned-cart-admission').contentWindow,producer:l.childProducer,epoch:expected.epoch,started:expected.started,completed:expected.completed,parentProducer:l.parentProducer,parentEpoch:expected.parent.epoch,parentStarted:expected.parent.started,parentCompleted:expected.parent.completed,parentPending:expected.parent.pending,parentFailed:expected.parent.failed,product:candidate.product_id,promotion:candidate.promotion_id,until,writeDeadline,search,stage:0,used:false,square:!!square,library_search:library_search??'div.searchInput input',scroller:'.aurora-infinite-scroller'};l.effectArm=g.arm;},{candidate:c,until:admissionUntil,writeDeadline,search:req.contract.cart.search_input_selector,expected:cartLease.producer,square:true,library_search:req.contract.library.search_input_selector});
     await p.click('.aurora-infinite-scroller button[data-high-risk="true"]',{label:'本品加入选品车'});
     const effectLive=cartLease.assertLive;postEffectCheck=async()=>{control();effectLive();checkWrite();const receipt=await p.evaluate(()=>{const g=globalThis.__selectionFramedProducer,l=globalThis.__selectionAdmissionLease,a=l?.effectArm,h=a?.childWindow?.__selectionFramedProducer;return {hits:g?.hits,blocked:g?.blocked,bound:!!a&&g===a.parentProducer&&g===l.parentProducer&&g.arm===a&&h===a.producer&&h.epoch===a.epoch&&h.started===a.started&&h.completed===a.completed&&h.pending===0&&h.failed===0&&g.epoch===a.parentEpoch&&g.started===a.parentStarted&&g.completed===a.parentCompleted&&g.pending===a.parentPending&&g.failed===a.parentFailed&&a.used&&a.stage===5&&Date.now()<a.until&&Date.now()<a.writeDeadline};});control();effectLive();checkWrite();if(receipt.hits!==1||receipt.blocked!==0)throw failure('CART_ADMISSION_BLOCKED');if(!receipt.bound)throw failure('CART_ADD_READBACK_UNCERTAIN');};await postEffectCheck();result=await cartLookup();if(!result)throw failure('CART_ADD_READBACK_UNCERTAIN');
    }
   }else{let rows=await p.evaluate(extractRows,{kind:'library'});if(!rows.some(r=>r.product_id===c.product_id&&r.promotion_id===c.promotion_id)){checkWrite();await p.fill(req.contract.library.search_input_selector,c.product_id);await p.keyboard.press('Enter');/* bounded search wait: <=8000ms and inside the admission window; presence is adjudicated by the re-read below, so a bounded timeout falls through instead of escaping as an opaque code */try{await p.waitForFunction(({pid})=>!!document.querySelector('tr[data-row-key="'+pid+'"]'),{pid:c.product_id},{timeout:Math.min(8000,admissionUntil-Date.now())});}catch{}rows=await p.evaluate(extractRows,{kind:'library'});if(!rows.some(r=>r.product_id===c.product_id&&r.promotion_id===c.promotion_id))throw failure('CANDIDATE_SEARCH_NOT_FOUND');}control();if(!cartLease)throw failure('CART_QUERY_UNCERTAIN');await cartLease.check();control();cartLease.assertLive();checkWrite();await p.evaluate(({candidate,until,writeDeadline,search,expected,square,library_search})=>{const g=globalThis.__selectionFramedProducer,h=document.getElementById('selection-owned-cart-admission')?.contentWindow.__selectionFramedProducer,l=globalThis.__selectionAdmissionLease;if(!g||!h||!expected?.parent||!l||g!==l.parentProducer||h!==l.childProducer||Object.keys(l.parent).some(k=>g[k]!==l.parent[k]||g[k]!==expected.parent[k])||h.pending||h.failed||h.epoch!==expected.epoch||h.started!==expected.started||h.completed!==expected.completed)throw Object.assign(Error('CART_QUERY_UNCERTAIN'),{code:'CART_QUERY_UNCERTAIN'});g.arm={frameId:'selection-owned-cart-admission',childWindow:document.getElementById('selection-owned-cart-admission').contentWindow,producer:l.childProducer,epoch:expected.epoch,started:expected.started,completed:expected.completed,parentProducer:l.parentProducer,parentEpoch:expected.parent.epoch,parentStarted:expected.parent.started,parentCompleted:expected.parent.completed,parentPending:expected.parent.pending,parentFailed:expected.parent.failed,product:candidate.product_id,promotion:candidate.promotion_id,until,writeDeadline,search,stage:0,used:false,square:!!square,library_search:library_search??'div.searchInput input',scroller:'.aurora-infinite-scroller'};l.effectArm=g.arm;},{candidate:c,until:admissionUntil,writeDeadline,search:req.contract.cart.search_input_selector,expected:cartLease.producer});await p.click(`tr[data-row-key="${c.product_id}"] button:has-text("加选品车")`,{label:'本品加入选品车'});const effectLive=cartLease.assertLive;postEffectCheck=async()=>{control();effectLive();checkWrite();const receipt=await p.evaluate(()=>{const g=globalThis.__selectionFramedProducer,l=globalThis.__selectionAdmissionLease,a=l?.effectArm,h=a?.childWindow?.__selectionFramedProducer;return {hits:g?.hits,blocked:g?.blocked,bound:!!a&&g===a.parentProducer&&g===l.parentProducer&&g.arm===a&&h===a.producer&&h.epoch===a.epoch&&h.started===a.started&&h.completed===a.completed&&h.pending===0&&h.failed===0&&g.epoch===a.parentEpoch&&g.started===a.parentStarted&&g.completed===a.parentCompleted&&g.pending===a.parentPending&&g.failed===a.parentFailed&&a.used&&a.stage===5&&Date.now()<a.until&&Date.now()<a.writeDeadline};});control();effectLive();checkWrite();if(receipt.hits!==1||receipt.blocked!==0)throw failure('CART_ADMISSION_BLOCKED');if(!receipt.bound)throw failure('CART_ADD_READBACK_UNCERTAIN');};await postEffectCheck();result=await cartLookup();if(!result)throw failure('CART_ADD_READBACK_UNCERTAIN');}
  }
   }else if(req.operation==='decision'){
   const c=verifyIdentity(req.candidate);if(req.cart_evidence?.verified!==true)throw failure('DECISION_CART_PROOF_MISSING');verifyCart(c,req.cart_evidence);const p=await get('decision');await p.goto(productLink(c));await p.waitForFunction(extractDecisionTolerant,{productId:c.product_id,title:c.title},{timeout:25000});control();const main=await p.evaluate(extractDecisionTolerant,{productId:c.product_id,title:c.title});if(!main||main.product_id!==c.product_id||main.title!==c.title)throw failure('DECISION_IDENTITY_MISMATCH');result={images:main.images,identity_verified:true,identity_evidence:{product_id:main.product_id,title:main.title,commodity_id:req.cart_evidence.commodity_id,promotion_id:req.cart_evidence.promotion_id,root_count:main.root_count,header_count:main.header_count},metrics:{},reason:'决策页未证实相邻增长、转化分母和自营成本，保留待复核'};
  }else if(req.operation==='freeze'){
   const c=verifyIdentity(req.candidate),p=await get('compass');await p.goto(req.contract.compass.entry_url_template.replace('<product_id>',c.product_id));await p.waitForSelector(req.contract.compass.video_tab_selector,{timeout:20000});await p.click(req.contract.compass.video_tab_selector,{label:'读取当前排序视频首页'});await p.waitForFunction(()=>document.querySelectorAll('tr[data-row-key]').length>0||/^共\s*0\s*条$/.test(document.querySelector('.aurora-pagination-total-text')?.textContent?.trim()??''),{},{timeout:20000});control();const data=await p.evaluate(extractRows,{kind:'compass'}),totalMatch=/^共\s*([\d,]+)\s*条$/.exec(data.total_text??''),total=totalMatch?Number(totalMatch[1].replaceAll(',','')):null;if(data.blocked||!Number.isSafeInteger(total)||data.active_page!=='1'||data.visible_row_count!==data.rows.length||data.success_count!==data.visible_row_count)throw failure('COMPASS_ROW_INCOMPLETE');const extraction={visible_row_count:data.visible_row_count,success_count:data.success_count,total_count:total,active_page:data.active_page,rows:data.rows};
   if(!data.rows.length){if(total!==0||!data.empty_text)throw failure('COMPASS_EMPTY_NOT_PROVEN');result={context:null,videos:[],empty_verified:true,extraction,total_text:data.total_text};}else{const context=data.rows[0].context;
   if(context.product_id!==c.product_id||context.page_no!==1||!Number.isSafeInteger(context.page_size)||data.rows.length>context.page_size||typeof context.sort_field!=='string'||typeof context.is_asc!=='boolean'||typeof context.begin_date!=='string'||typeof context.end_date!=='string'||data.active_page&&data.active_page!=='1')throw failure('COMPASS_CONTEXT_INVALID');
   if(data.rows.length!==Math.min(total,context.page_size))throw failure('COMPASS_ROW_COUNT_MISMATCH');const seen=new Set();const videos=[];for(const row of data.rows){assertNumericId(row.aweme_id);if(JSON.stringify(row.context)!==JSON.stringify(context))throw failure('COMPASS_CONTEXT_MIXED');if(seen.has(row.aweme_id))throw failure('COMPASS_VIDEO_DUPLICATE');seen.add(row.aweme_id);const {context:_,extracted:__,...v}=row;videos.push({...v,commodity_id:c.commodity_id});}result={context,videos,extraction,total_text:data.total_text??null};}
  }else if(req.operation==='metadata'){
   assertNumericId(req.video.aweme_id);const p=await get('decision');const detailUrl=value=>{try{const u=new URL(value);return u.hostname==='www.douyin.com'&&u.pathname.includes('/aweme/detail/')&&u.searchParams.get('aweme_id')===req.video.aweme_id;}catch{return false;}};
   await p.cdp('Network.enable');await p.goto('https://www.douyin.com/video/'+req.video.aweme_id);
   const until=Date.now()+25000;let requestId=null,status=null,mimeType=null,finished=false;
   while(!finished&&Date.now()<until){const events=await p.events();for(const e of Array.isArray(events)?events:[]){const x=e?.params;if(e?.method==='Network.requestWillBeSent'&&requestId===null&&detailUrl(x?.request?.url)&&typeof x?.requestId==='string'&&x.requestId)requestId=x.requestId;else if(e?.method==='Network.responseReceived'&&x?.requestId===requestId){status=x?.response?.status;mimeType=x?.response?.mimeType;}else if(e?.method==='Network.loadingFinished'&&x?.requestId===requestId)finished=true;}if(!finished&&Date.now()<until)await p.waitForTimeout(Math.min(100,until-Date.now()));}
   control();if(requestId===null){const endpoint=await p.evaluate(({id})=>performance.getEntriesByType('resource').map(x=>x.name).find(value=>{try{const u=new URL(value);return u.hostname==='www.douyin.com'&&u.pathname.includes('/aweme/detail/')&&u.searchParams.get('aweme_id')===id;}catch{return false;}}),{id:req.video.aweme_id});if(!endpoint)throw failure('METADATA_ENDPOINT_NOT_OBSERVED');throw failure('METADATA_BODY_INVALID');}
   if([401,403].includes(status))throw failure('METADATA_PERMISSION_DENIED');if(status!==200)throw failure('METADATA_HTTP_FAILED');if(mimeType!=='application/json')throw failure('METADATA_BODY_INVALID');
   const response=await p.cdp('Network.getResponseBody',{requestId});let raw=null;try{const text=typeof response?.body==='string'?(response.base64Encoded?Buffer.from(response.body,'base64').toString('utf8'):response.body):null;if(text!==null)raw=JSON.parse(text);}catch{}
   if(!raw||typeof raw!=='object')throw failure('METADATA_BODY_INVALID');const a=raw.aweme_detail;if(!a){result={error:'METADATA_EMPTY',filter_reason:raw.filter_reason??raw.status_msg??'EMPTY'};}else{const v=a.video,bitrates=(v?.bit_rate??[]).slice().sort((a,b)=>(b.bit_rate??0)-(a.bit_rate??0));result={aweme_id:a.aweme_id,desc:a.desc,status_self_see:a.status?.self_see??a.status?.status_self_see??false,filter_reason:raw.filter_reason??null,error:raw.status_code?String(raw.status_code):null,duration_ms:v?.duration??a.duration,uri:v?.play_addr?.uri,play:bitrates[0]?.play_addr?.url_list??v?.play_addr?.url_list??[],author:a.author?.nickname??null};}
  }else if(req.operation==='finish'){control();await task.finish({keep:[]});result={finished:true};}
  else if(req.operation==='handoff'){control();await task.handOff();result={handed_off:true};}
  else throw failure('ACTION_NOT_ALLOWED');
  await noLinks(req.output_file);if(postEffectCheck)await postEffectCheck();await closeAdmission();await fs.writeFile(req.output_file,JSON.stringify({space_id:space,pages,result}),{flag:'wx',mode:0o600});emit({type:'phase4_result',space_id:space,operation:req.operation,status:'ok'});
 }catch(e){roundError=e;emit({type:'phase4_result',...(space?{space_id:space}:{}),operation:req.operation,status:'error',error_code:safeCode(e,'BROWSER_BLOCKED')});throw failure(safeCode(e,'BROWSER_BLOCKED'));}
 finally{try{await closeAdmission();}catch(e){if(!roundError)throw e;}if(roundError&&task)for(const label of createdThisRound){try{await task.page(label)?.close();}catch{}}}
}
