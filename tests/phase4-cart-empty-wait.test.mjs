// TEST ONLY: synthetic DOM and SDK; no live browser, accounts or business writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath,pathToFileURL} from 'node:url';
const source=process.env.CART_EMPTY_SOURCE_ROOT??fileURLToPath(new URL('../',import.meta.url));
const {handleSelectionRound}=await import(pathToFileURL(path.join(source,'src/browser/selection-round.mjs')).href);
const {verifyCart}=await import(pathToFileURL(path.join(source,'src/verifier.mjs')).href);
const work=process.env.CART_EMPTY_TEST_ROOT;
if(!work)throw Error('TEST_ROOT_REQUIRED');
const c={product_id:'1000000000000000001',promotion_id:'2000000000000000001',commodity_id:'2000000000000000001',title:'TEST商品'};
const search='input[placeholder="请输入商品名称或者ID"]';
const contract={cart:{entry_url:'https://buyin.jinritemai.com/dashboard/merch-picking-cart',search_input_selector:search,query_button_selector:'button.query'},library:{entry_url:'https://buyin.jinritemai.com/dashboard/merch-picking-library'}};
async function run(opt={},operation='read_cart'){
  const root=await fs.mkdtemp(path.join(work,'TEST-case-'));let added=0,queries=0,clock=10;
  let present=!!opt.present,kind='cart';const resources=[];
  const rect=visible=>()=>visible?[{}]:[];
  const row=()=>({getAttribute:()=>opt.wrongRow?'2000000000000000009':kind==='library'?c.product_id:c.commodity_id,querySelectorAll:()=>[],__reactFiberTEST:{memoizedProps:{record:kind==='cart'?{entity_type:1,product_card:{product_id:opt.wrongProduct?'1000000000000000009':c.product_id,promotion_id:c.promotion_id}}:{product_id:c.product_id,promotion_id:c.promotion_id,base_model:{product_info:{name:c.title}}}}}});
  const rows=()=>kind==='library'||present?[row()]:[];
  const empty={textContent:opt.emptyText??'暂无符合要求的商品，修改条件后试试吧',getClientRects:rect(!opt.hidden)};
  const input={value:opt.wrongQuery?'1000000000000000009':c.product_id};
  const doc={body:{innerText:opt.bodyText??empty.textContent},querySelector:s=>s===search&&!opt.missingInput?input:null,querySelectorAll:s=>s==='tr[data-row-key]'?rows():s==='.aurora-table-empty .aurora-empty-description'?opt.outside||present?[]:Array(opt.ambiguous?2:1).fill(empty):s==='.aurora-spin-spinning,[aria-busy="true"]'?opt.loading?[{getClientRects:rect(true)}]:[]:[]};
  const perf={now:()=>clock+=10,getEntriesByType:()=>resources};
  const scope={document:doc,performance:perf,location:{origin:'https://buyin.jinritemai.com'},URL};
  const evaluate=(fn,arg)=>vm.runInNewContext('('+fn.toString()+')(ARG)',{...scope,ARG:arg});
  const page={label:'p1',spaceId:991,async goto(url){kind=url.endsWith('merch-picking-cart')?'cart':'library';},async fill(selector,value){assert.equal(selector,search);assert.equal(value,c.product_id);},async click(selector){if(selector==='button.query'){queries++;if(!opt.pending)resources.push({name:opt.wrongEndpoint?'https://buyin.jinritemai.com/pc/selection_square/author/info':opt.wrongOrigin?'https://other.example/selection_cart_pc_api/card/m_get_card':'https://buyin.jinritemai.com/selection_cart_pc_api/card/m_get_card',startTime:opt.stale?clock-1:clock+1,responseEnd:opt.incomplete?0:clock+2});}else{assert.ok(selector.includes('加选品车'));added++;present=true;}},async waitForSelector(){},async evaluate(fn,arg){return evaluate(fn,arg);},async waitForFunction(fn,arg){if(!evaluate(fn,arg))throw Object.assign(Error('TEST_WAIT_UNSATISFIED'),{code:'TEST_WAIT_UNSATISFIED'});}};
  const req={operation,space_id:'991',pages:{cart:'p1',library:'p1'},candidate:c,contract,output_file:path.join(root,'out.json')};
  try{await handleSelectionRound(req,{taskSpace:async()=>({spaceId:991,ownership:'agent',page:()=>page}),emit(){}});return {result:JSON.parse(await fs.readFile(req.output_file)).result,added,queries};}
  catch(e){e.testAdded=added;throw e;}
}
test('CART-EMPTY: new scoped empty text returns confirmed zero without add',async()=>{const r=await run();assert.equal(r.result,null);assert.equal(r.added,0);assert.equal(r.queries,1);});
test('CART-EMPTY: legacy scoped empty text remains supported',async()=>assert.equal((await run({emptyText:'暂无数据'})).result,null));
test('CART-EMPTY: trimmed new scoped empty text remains supported',async()=>assert.equal((await run({emptyText:'  暂无符合要求的商品，修改条件后试试吧\n'})).result,null));
test('CART-EMPTY: exact existing product returns dual-ID evidence',async()=>{const r=await run({present:true});assert.equal(verifyCart(c,r.result).verified,true);assert.equal(r.added,0);});
for(const [label,opt]of [['loading',{loading:true}],['hidden empty',{hidden:true}],['outside table',{outside:true}],['ambiguous empties',{ambiguous:true}],['unknown empty text',{emptyText:'加载中'}],['wrong query ID',{wrongQuery:true}],['missing query input',{missingInput:true}],['pending response',{pending:true}],['stale response',{stale:true}],['incomplete response',{incomplete:true}],['unrelated endpoint',{wrongEndpoint:true}],['unrelated origin',{wrongOrigin:true}],['legacy text outside table',{outside:true,bodyText:'暂无数据'}],['stale existing row before response',{present:true,pending:true}],['existing row with wrong query',{present:true,wrongQuery:true}],['wrong row ID',{present:true,wrongRow:true}]])test('CART-EMPTY rejects '+label,async()=>{await assert.rejects(run(opt,'add_cart'),e=>e.code==='TEST_WAIT_UNSATISFIED'&&e.testAdded===0);});
test('CART-EMPTY: valid empty then one add produces exact readback',async()=>{const r=await run({},'add_cart');assert.equal(r.added,1);assert.equal(r.queries,2);assert.equal(verifyCart(c,r.result).verified,true);});
test('CART-EMPTY: existing product prevents duplicate add',async()=>{const r=await run({present:true},'add_cart');assert.equal(r.added,0);assert.equal(r.queries,1);assert.equal(verifyCart(c,r.result).verified,true);});
test('CART-EMPTY: wrong product in matching promotion row cannot verify',async()=>{const r=await run({present:true,wrongProduct:true});assert.throws(()=>verifyCart(c,r.result),e=>e.code==='CART_READBACK_MISMATCH');});
