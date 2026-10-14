import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormLock } from '../ui/form-lock.mjs';
const gate=()=>{let release;const promise=new Promise(r=>release=r);return {promise,release};};
function fixture(){const controls=[{disabled:false},{disabled:false},{disabled:true}];return {controls,lock:createFormLock({querySelectorAll:()=>controls})};}

test('异步保存/读取/选择期间锁住表单，避免迟到响应覆盖后续编辑', async()=>{
  const {controls,lock}=fixture(), waiting=gate();const pending=lock.run(()=>waiting.promise);
  assert.equal(lock.busy,true);assert.ok(controls.every(e=>e.disabled));
  let resetCalled=false;await lock.run(()=>{resetCalled=true;});assert.equal(resetCalled,false);
  waiting.release('完成');assert.equal(await pending,'完成');assert.equal(lock.busy,false);
  assert.deepEqual(controls.map(e=>e.disabled),[false,false,true]);
});
test('请求失败仍恢复原禁用状态，不把本来禁用的字段打开', async()=>{
  const {controls,lock}=fixture();await assert.rejects(lock.run(async()=>{throw new Error('真实失败分支的测试夹具');}));
  assert.equal(lock.busy,false);assert.deepEqual(controls.map(e=>e.disabled),[false,false,true]);
});
test('嵌套操作不能提前解锁正在等待的请求', async()=>{
  const {controls,lock}=fixture(), waiting=gate();let nested=false;
  const pending=lock.run(async()=>{await lock.run(()=>{nested=true;});await waiting.promise;});
  assert.equal(nested,false);assert.equal(lock.busy,true);assert.ok(controls.every(e=>e.disabled));
  waiting.release();await pending;assert.equal(lock.busy,false);
});
