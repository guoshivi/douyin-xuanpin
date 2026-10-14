import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeVerifiedAsset, assetPath } from '../src/storage.mjs';
import { assertNumericId, verifyReadback } from '../src/verifier.mjs';

test('phase4 exclusive asset write hashes readback and rejects traversal', async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'phase4-storage-')); const args={root,archiveDate:'2026-10-10',commodityId:'1000000000000000001',awemeId:'2000000000000000001',bytes:Buffer.from('x'),kind:'video',extension:'mp4'};
  const a=await writeVerifiedAsset(args); assert.equal(a.sha256.length,64); assert.equal((await fs.readFile(a.path)).toString(),'x'); assert.equal(assetPath(args),a.path); await assert.rejects(writeVerifiedAsset({...args,bytes:Buffer.from('y')}),e=>e.code==='ASSET_CONFLICT'); assert.throws(()=>assetPath({...args,commodityId:'1/../2'}),e=>e.code==='ID_INVALID');
});
test('phase4 verifier never accepts non-string nineteen digit identities',()=>{assert.equal(assertNumericId('1234567890123456789'),'1234567890123456789'); assert.throws(()=>assertNumericId(1234567890123456789n),e=>e.code==='ID_INVALID'); assert.throws(()=>assertNumericId('123'),e=>e.code==='ID_INVALID'); assert.deepEqual(verifyReadback({id:'x'},{id:'x'}),{verified:true});});
