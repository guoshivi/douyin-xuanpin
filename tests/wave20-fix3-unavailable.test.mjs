import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createTaskManager} from '../src/task-manager.mjs';
import {createDownloadDriver,readVerifiedNativeFile,MAX_DOWNLOAD_BYTES} from '../src/browser/extension-download.mjs';
import {testRoot,testAdapter} from './phase4-support.mjs';

const rev='f'.repeat(64);

test('wave20-fix3 unavailable closes pre-click intent and leaves no asset', async()=>{
  const {root,policy}=await testRoot();
  const adapter=await testAdapter();
  adapter.freezeVideos=async({candidate})=>[{aweme_id:'7000000000000000001',commodity_id:candidate.commodity_id,title:'TEST restricted'}];
  adapter.downloadVideo=async()=>({unavailable:true,reason:'METADATA_RESTRICTED'});
  const m=createTaskManager({projectRoot:root});
  try {
    const done=await (await m.start({policy,revision:rev,adapter,testMode:true})).done;
    assert.equal(done.state,'completed',done.error_code);
    assert.equal(done.summary.videos_unavailable,2);
    const actions=(await import('node:sqlite')).DatabaseSync;
    const db=new actions(path.join(root,'data/state.sqlite'));
    const rows=db.prepare("SELECT state,result_json FROM actions WHERE kind='video_download'").all();
    db.close();
    assert.equal(rows.length,2);assert.ok(rows.every(r=>r.state==='verified'&&JSON.parse(r.result_json).state==='unavailable'));
    for(const p of done.products) await assert.rejects(fs.access(path.join(policy.storage.video_root,done.snapshot.archive_date,p.candidate.commodity_id,'7000000000000000001.mp4')));
  } finally { await m.close(); }
});

test('wave20-fix3 receipt requires exact native length and preserves 150MiB cap',async()=>{
  const dir=await fs.mkdtemp('/private/tmp/w20-fix3-');const file=path.join(dir,'x.mp4');await fs.writeFile(file,'1234');
  const receipt={id:1,filename:file,state:'complete',exists:true,bytesReceived:4,totalBytes:4,startTime:'2026-01-01T00:00:00Z',endTime:'2026-01-01T00:00:01Z'};
  await assert.rejects(readVerifiedNativeFile({receipt,expectedSha256:'0'.repeat(64)}),e=>e.reason==='SOURCE_HASH_DRIFT');
  assert.equal(MAX_DOWNLOAD_BYTES,157286400);
});

test('wave20-fix3 driver writes intent before first download2 click',async()=>{
  const file=path.join(await fs.mkdtemp('/private/tmp/w20-fix3-'),'x.mp4');await fs.writeFile(file,'mp4');
  const writes=[];let active=[];const candidate={product_id:'2000000000000000001',commodity_id:'1000000000000000001'};
  const video={aweme_id:'7000000000000000001',commodity_id:candidate.commodity_id,title:'v'};
  const intent={click_token:'t',frozen_context:{product_id:candidate.product_id,aweme_id:video.aweme_id,title:video.title}};
  const binding={download_id:2,url:'https://example.invalid/v.mp4',filename:file,video_id:video.aweme_id,message_video_id:video.aweme_id,commodity_id:candidate.commodity_id,context_product_id:candidate.product_id,title:video.title};
  const chrome={downloads:{search:async()=>active}};const store={read:async()=>null,write:async(k,v)=>writes.push(v)};
  const d=createDownloadDriver({chrome,store,deadlineMs:100,pollMs:1,sleep:async()=>{},clickDownload2:async()=>{assert.equal(writes[0].stage,'effect_uncertain');active=[{...binding,id:2,state:'complete',exists:true,bytesReceived:3,totalBytes:3,startTime:'2026-01-01T00:00:00Z',endTime:'2026-01-01T00:00:01Z'}];return {binding,failureConfirmed:true,noLateStart:true}},clickDownload1:async()=>{throw Error('not reached')}});
  const result=await d.downloadVideo({candidate,video,intent});
  assert.equal(result.source,'download2');
  assert.equal(writes[0].stage,'effect_uncertain');
});
