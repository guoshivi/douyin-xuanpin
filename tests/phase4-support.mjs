import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {defaultPolicy} from '../src/settings-model.mjs';
export async function testRoot(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'phase4-TEST-'));await fs.mkdir(path.join(root,'config'));const policy=defaultPolicy();policy.storage.video_root=path.join(root,'videos');await fs.writeFile(path.join(root,'config/selection.json'),JSON.stringify(policy),{flag:'wx'});await fs.cp(new URL('../ui/',import.meta.url),path.join(root,'ui'),{recursive:true});return {root,policy};}
export async function testAdapter(){const media=async f=>fs.readFile(new URL('../data/acceptance/phase4-web-integration-20261010T1442/parent-media-fixtures/'+f,import.meta.url));const bytes=[await media('test-video-1.mp4'),await media('test-video-2.mp4')],image=await media('test-image.jpg');const cart=new Map(),feishu=new Map();const calls={add:0,sync:0,finish:0,download:0};const candidates=[1,2].map(n=>({commodity_id:'100000000000000000'+n,promotion_id:'100000000000000000'+n,product_id:'200000000000000000'+n,title:'TEST商品'+n,metrics:{},category_ids:[],seasonal_evidence:[]}));return {mode:'test',calls,cart,feishu,candidates,
 async discoverCandidates(){return candidates;},
 async addToCart({candidate:c}){calls.add++;const row={row_key:c.commodity_id,product_id:c.product_id,promotion_id:c.promotion_id,commodity_id:c.commodity_id};cart.set(c.commodity_id,row);return row;},
 async readCart({candidate:c}){return cart.get(c.commodity_id)??null;},
 async readDecision(){return {identity_verified:true,reason:'TEST口径缺失明确待复核',images:[{bytes:image}]};},
 async freezeVideos({candidate:c}){const videos=[1,2].map((n,i)=>({aweme_id:'70000000000000000'+c.commodity_id.slice(-1)+n,commodity_id:c.commodity_id,title:'TEST短片'+n,index:n,duration_ms:i?2000:1400,bytes:bytes[i],publish_time:1791580800}));return {context:{product_id:c.product_id,page_no:1,page_size:10,sort_field:'pay_amt',is_asc:false,begin_date:'2026/10/03 00:00:00',end_date:'2026/10/09 00:00:00'},videos:[...videos,videos[0]]};},
 async downloadImage({image}){return {bytes:Buffer.from(image.bytes)};},
 async syncFeishu({candidate:c,videos,images}){calls.sync++;const result={record_id:'rec-'+c.commodity_id,business_key:c.commodity_id,video_count:videos.length,image_count:images.length};feishu.set(c.commodity_id,result);return result;},
 async readFeishu({candidate:c}){return feishu.get(c.commodity_id)??null;},
 async finish(){calls.finish++;return {finished:true};}
 };}
export async function waitFor(fn){for(let n=0;n<200;n++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('TEST_WAIT_TIMEOUT');}
