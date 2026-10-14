import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { defaultPolicy, policyToDraft, draftToPolicy } from '../src/settings-model.mjs';
const html=await fs.readFile(new URL('../ui/settings.html',import.meta.url),'utf8');
const source=await fs.readFile(new URL('../src/settings-model.mjs',import.meta.url),'utf8');
const fields={PRICE_BASES:'priceBasis',SALES_PERIODS:'salesPeriod',CONVERSION_SCOPES:'conversionScope',CONVERSION_DENOMINATORS:'conversionDenominator',MISSING_STRATEGIES:'missingDataStrategy'};
test('模型每个合法下拉枚举都有真实页面选项，不会渲染为隐式空白',()=>{
  for(const [constant,id] of Object.entries(fields)) {
    const declaration=source.match(new RegExp(`const ${constant} = new Set\\((\\[[^\\]]+\\])\\);`));assert.ok(declaration,constant);
    const allowed=JSON.parse(declaration[1].replace(/'/g,'"'));
    const select=html.match(new RegExp(`<select[^>]+id="${id}"[^>]*>([\\s\\S]*?)</select>`));assert.ok(select,id);
    const rendered=[...select[1].matchAll(/<option[^>]+value="([^"]*)"/g)].map(m=>m[1]);
    assert.deepEqual(allowed.filter(value=>!rendered.includes(value)),[],id);
  }
});
test('只改备注仍完整保留合法的snapshot销量周期',()=>{
  const p=defaultPolicy();p.decisions.sales_period='snapshot';
  const d=policyToDraft(p);d.seasonalNotes='仅修改无关备注';
  assert.equal(d.salesPeriod,'snapshot');assert.equal(draftToPolicy(d,p).decisions.sales_period,'snapshot');
});
