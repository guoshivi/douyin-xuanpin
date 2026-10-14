import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultPolicy } from '../src/settings-model.mjs';
import { createTaskManager } from '../src/task-manager.mjs';

function policy(root) { const p=defaultPolicy(); p.storage.video_root=root; p.limits.max_cart_additions=9; p.limits.max_run_minutes=99; return p; }
function adapter() {
  const bytes=readFileSync(new URL('../data/acceptance/phase4-web-integration-20261010T1442/parent-media-fixtures/test-video-1.mp4',import.meta.url));
  return { mode:'test', async discoverCandidates(){ return [
    {commodity_id:'1000000000000000001',product_id:'2000000000000000001',promotion_id:'1000000000000000001',category_ids:[],metrics:{},seasonal_evidence:[]},
    {commodity_id:'1000000000000000002',product_id:'2000000000000000002',promotion_id:'1000000000000000002',category_ids:[],metrics:{},seasonal_evidence:[]}
  ]; }, async addToCart({candidate}){return {row_key:candidate.promotion_id,commodity_id:candidate.commodity_id,product_id:candidate.product_id,promotion_id:candidate.promotion_id};}, async readCart({candidate}){return {row_key:candidate.promotion_id,commodity_id:candidate.commodity_id,product_id:candidate.product_id,promotion_id:candidate.promotion_id};}, async freezeVideos({candidate}){return [{aweme_id:`${candidate.commodity_id.slice(0,18)}1`,commodity_id:candidate.commodity_id,title:'TEST短片',duration_ms:1400,bytes}];}, async syncFeishu({candidate}){return {record_id:`rec-${candidate.commodity_id}`,business_key:candidate.commodity_id,video_count:1,image_count:0};}, async readFeishu(args){return this.syncFeishu(args);} };
}

test('phase4 explicit test adapter completes two products and freezes limits', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'phase4-pipeline-')); const m=createTaskManager({projectRoot:root,dbPath:path.join(root,'state.sqlite')});
  try { const p=policy(path.join(root,'videos')); const started=await m.start({policy:p,revision:'a'.repeat(64),adapter:adapter(),testMode:true,now:new Date('2026-10-10T01:00:00.000Z')});
  const done=await started.done; assert.equal(done.state,'completed'); assert.equal(done.summary.selected_count,2); assert.equal(done.snapshot.limits.max_cart_additions,3); assert.equal(done.snapshot.limits.max_run_minutes,30); assert.equal(done.snapshot.archive_date,'2026-10-10');
  assert.equal(done.summary.cart_verified,2); assert.equal(done.summary.feishu_verified,2); } finally { await m.close(); }
});

test('phase4 rejects missing confirmation and duplicate start without side effects', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'phase4-reject-')); const m=createTaskManager({projectRoot:root,dbPath:path.join(root,'state.sqlite')}); const p=policy(root); p.confirmed=false;
  try { await assert.rejects(m.start({policy:p,revision:'b'.repeat(64),adapter:adapter(),testMode:true}),e=>e.code==='POLICY_NOT_CONFIRMED');
  const p2=policy(root); const one=await m.start({policy:p2,revision:'c'.repeat(64),adapter:{mode:'test',discoverCandidates:async()=>new Promise(()=>{})},testMode:true});
  await assert.rejects(m.start({policy:p2,revision:'c'.repeat(64),adapter:adapter(),testMode:true}),e=>e.code==='TASK_ALREADY_RUNNING'); await m.pause(one.run_id); } finally { await m.close(); }
});
