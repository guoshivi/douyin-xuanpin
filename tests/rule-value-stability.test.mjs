import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultPolicy, policyToDraft, draftToPolicy, validatePolicy, loadPolicyFile } from '../src/settings-model.mjs';

function basePolicy() {
  const draft = policyToDraft(defaultPolicy());
  Object.assign(draft, {priceMin:'0', priceMax:'10', priceBasis:'displayed', commissionRatePercent:'12.5', commissionPerOrder:'2', salesMin:'1', salesPeriod:'snapshot', conversionMinPercent:'2', conversionScope:'product', conversionDenominator:'paid_orders', minimumGrowthRatePercent:'250'});
  const policy = draftToPolicy(draft);
  assert.equal(validatePolicy(policy).valid, true);
  return policy;
}
const metrics = ['price', 'commission_rate', 'commission_amount', 'sales', 'conversion_rate'];
const invalidValues = [{toString:null}, {valueOf:null,toString:null}, [{toString:null}], {}, [], [1], '0', false, true];

test('所有规则的非法 JSON min/max 均稳定拒绝，不隐式转换对象', t => {
  let cases = 0;
  for (const metric of metrics) for (const key of ['min','max']) for (const value of invalidValues) {
    const policy = basePolicy();
    const index = policy.rules.findIndex(r => r.metric === metric);
    assert.ok(index >= 0, metric);
    policy.rules[index].min = 0; policy.rules[index].max = 1;
    policy.rules[index][key] = JSON.parse(JSON.stringify(value));
    let result;
    assert.doesNotThrow(() => { result = validatePolicy(policy); }, `${metric}.${key}=${JSON.stringify(value)}`);
    assert.equal(result.valid, false);
    assert.equal(result.errors[`rules[${index}]`], '数值无效');
    cases++;
  }
  t.diagnostic(`真实验证 ${cases} 个非法 JSON 端点用例`);
});

test('有限数值仍执行区间检查，合法 null/0/1 与 250% 增幅保持', t => {
  let cases = 0;
  for (const metric of metrics) for (const [min,max] of [[null,null],[null,1],[0,null],[0,0],[0,1],[1,1],[1,0]]) {
    const policy = basePolicy();
    const rule = policy.rules.find(r => r.metric === metric);
    rule.min = min; rule.max = max;
    const result = validatePolicy(policy);
    assert.equal(result.valid, !(min === 1 && max === 0), `${metric} ${min}..${max}`);
    assert.equal(policy.priorities.recent_surge.minimum_growth_rate, 2.5);
    cases++;
  }
  t.diagnostic(`真实验证 ${cases} 个数值/空端点用例`);
});

test('载入非法对象型端点配置返回 INVALID_POLICY，而非 TypeError', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'selection-invalid-endpoints-'));
  for (const [index,key] of ['min','max'].entries()) {
    const policy = basePolicy();
    const rule = policy.rules.find(r => r.metric === 'commission_rate');
    rule.min = 0; rule.max = 1; rule[key] = {toString:null};
    const file = path.join(root, `${index}.json`);
    await fs.writeFile(file, JSON.stringify(policy), {flag:'wx'});
    await assert.rejects(loadPolicyFile(file), error => error.message === 'INVALID_POLICY' && Object.keys(error.errors).some(k => k.startsWith('rules[')));
  }
});
