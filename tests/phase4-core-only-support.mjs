// TEST only: fresh local roots and tiny verified fixtures; no real business adapter.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {defaultPolicy} from '../src/settings-model.mjs';
import {testAdapter,waitFor} from './phase4-support.mjs';
export {waitFor};
export const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
export const work=process.env.PHASE4_CORE_ONLY_WORK_ROOT;
assert.ok(work&&path.isAbsolute(work)&&work.includes('/phase4-web-integration-20261010T1442/core-only-lan-v1/'));
assert.ok(process.env.TMPDIR?.startsWith(work));
await fs.mkdir(work,{recursive:true,mode:0o700});
export const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
export async function fixture(){const root=await fs.mkdtemp(path.join(work,'TEST-core-'));const policy=defaultPolicy();policy.storage.video_root=path.join(root,'archive');await fs.mkdir(path.join(root,'config'));await fs.writeFile(path.join(root,'config/selection.json'),JSON.stringify(policy),{flag:'wx',mode:0o600});await fs.cp(path.join(sourceRoot,'ui'),path.join(root,'ui'),{recursive:true});return {root,policy,dbPath:path.join(root,'TEST.sqlite')};}
export async function adapter(){const a=await testAdapter();a.calls.readFeishu=0;a.calls.image=0;a.calls.discover=0;const discover=a.discoverCandidates,image=a.downloadImage;a.discoverCandidates=async function(...args){a.calls.discover++;return discover.apply(a,args);};a.downloadImage=async function(...args){a.calls.image++;return image.apply(a,args);};a.syncFeishu=async()=>{a.calls.sync++;throw Error('TEST_FEISHU_MUST_NOT_BE_CALLED');};a.readFeishu=async()=>{a.calls.readFeishu++;throw Error('TEST_FEISHU_MUST_NOT_BE_READ');};return a;}
export const dataKey=(t,p)=>`archive:${t.snapshot.archive_date}:${p.candidate.commodity_id}:data:${t.run_id}`;
export async function post(s,endpoint,body,origin=s.origin){return fetch(origin+endpoint,{method:'POST',headers:{origin,'content-type':'application/json','x-csrf-token':s.csrf},body:JSON.stringify(body)});}
export async function assertClosed(s,root){await s.close();assert.equal(s.server.listening,false);await assert.rejects(fetch(s.origin+'/api/settings'));await assert.rejects(fs.access(path.join(root,'.selection.lock')));}
export async function paused(m,policy,a){a.discoverCandidates=()=>new Promise(()=>{});const s=await m.start({policy,revision:'a'.repeat(64),adapter:a,testMode:true});await m.pause(s.run_id);return m.get(s.run_id);}
