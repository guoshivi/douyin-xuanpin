import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
export const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export const clone=x=>JSON.parse(JSON.stringify(x));
export async function waitUntil(fn){for(let n=0;n<400;n++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('TEST_WAIT_TIMEOUT');}
export const sourceRoot=process.env.PHASE4_CORE_SOURCE_ROOT||fileURLToPath(new URL('../',import.meta.url));
export const workRoot=process.env.PHASE4_CORE_WORK_ROOT;
assert.ok(workRoot&&path.isAbsolute(workRoot)&&workRoot.includes('/phase4-web-integration-20261010T1442/core-review-repair-v1/'),'TEST work must be in the authorized fresh core repair root');
await fs.mkdir(workRoot,{recursive:true});
export const load=relative=>import(pathToFileURL(path.join(sourceRoot,relative)));
export async function newCase(label){return fs.mkdtemp(path.join(workRoot,'TEST-'+label+'-'));}
export const candidate=(n=1)=>({commodity_id:'100000000000000000'+n,promotion_id:'100000000000000000'+n,product_id:'200000000000000000'+n,title:'TEST合法中文商品'+n,category_ids:[],metrics:{},seasonal_evidence:[]});
export function taskFixture(title){return {run_id:'TEST-public',state:'paused',stage:'discover',notes:[],snapshot:{revision:'a'.repeat(64),archive_date:'2026-10-10',seasonal_reference_date:'2026-10-10',video_root:'/TEST/public-root',deadline:'2026-10-10T01:00:00Z',limits:{}},products:[{candidate:{...candidate(),title},videos:[],images:[]}]};}
