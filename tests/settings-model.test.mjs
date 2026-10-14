import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { optionalNumber, optionalPercent, policyToDraft, draftToPolicy, validateDraft, validatePolicy, defaultPolicy } from '../src/settings-model.mjs';

test('settings-empty-is-unrestricted', () => {
  assert.equal(optionalNumber(''), null);
  assert.equal(optionalNumber('   '), null);
  assert.equal(optionalPercent(''), null);
});
test('settings-zero-is-not-empty', () => {
  assert.equal(optionalNumber('0'), 0);
  assert.equal(optionalPercent('0'), 0);
});
test('settings-percent-fraction', () => assert.equal(optionalPercent('20'), 0.2));
test('settings-growth-over-100-valid', () => assert.equal(optionalNumber('250') / 100, 2.5));
test('settings-invalid-number-rejected', () => {
  for (const input of ['abc', '-1', {}, true, Infinity]) assert.throws(() => optionalNumber(input), /INVALID_NUMBER/);
  assert.throws(() => optionalPercent('101'), /INVALID_NUMBER/);
});
test('settings-default-roundtrip', () => {
  const draft = policyToDraft(defaultPolicy());
  const result = draftToPolicy(draft, defaultPolicy(), []);
  assert.deepEqual(result.rules, []);
  assert.equal(result.numeric_filters_enabled, false);
  assert.equal(result.allow_provisional_cart, true);
  assert.deepEqual(result.categories.include, []);
});
test('settings-category-empty-all', () => {
  const d = policyToDraft(defaultPolicy()); d.includeCategories = []; d.excludeCategories = [];
  assert.deepEqual(draftToPolicy(d, defaultPolicy(), []).categories.include, []);
});
test('settings-disabled-rule-removed', () => {
  const p = defaultPolicy();
  p.rules = [{ metric:'price', op:'gte', min:10, max:null, unit:'CNY', scope:'product', period:'snapshot', denominator:null, min_sample:null, required:true }];
  const d = policyToDraft(p); d.priceMin = '';
  const next = draftToPolicy(d, p, []);
  assert.deepEqual(next.rules, []);
  assert.equal(next.numeric_filters_enabled, false);
});
test('settings-price-range-invalid', () => {
  const d = policyToDraft(defaultPolicy()); d.priceMin='30'; d.priceMax='20'; d.priceBasis='displayed';
  assert.throws(() => draftToPolicy(d, defaultPolicy(), []), /priceMin|priceMax|RANGE/);
});
test('settings-large-id-preserved', () => {
  const d = policyToDraft(defaultPolicy()); d.includeCategories=['900719925474099312345'];
  assert.throws(() => draftToPolicy(d, defaultPolicy(), []), /CATEGORY/);
  const catalog=[{id:'900719925474099312345',name:'长ID'}];
  const p=draftToPolicy(d, defaultPolicy(), catalog);
  assert.equal(p.categories.include[0], '900719925474099312345');
});
test('settings-validation-protection-and-required-budget', () => {
  const d=policyToDraft(defaultPolicy()); d.maxCartAdditions='';
  const out=validateDraft(d, []); assert.equal(out.valid,false); assert.ok(out.errors.maxCartAdditions);
  d.maxCartAdditions='3'; d.feishu={identity:'attacker'};
  assert.equal(validateDraft(d, []).valid,false);
});
test('settings-percent-rule-mapping-and-decisions', () => {
  const d=policyToDraft(defaultPolicy());
  d.commissionRatePercent='20'; d.conversionMinPercent='3'; d.conversionScope='product'; d.conversionDenominator='paid_orders';
  const p=draftToPolicy(d,defaultPolicy(),[]);
  assert.equal(p.rules.find(r=>r.metric==='commission_rate').min,0.2);
  assert.equal(p.rules.find(r=>r.metric==='conversion_rate').min,0.03);
});
test('settings-validate-policy-rejects-unknown-and-overlap', () => {
  const p=defaultPolicy(); p.extra=1; assert.equal(validatePolicy(p).valid,false);
  const q=defaultPolicy(); q.categories.include=['a']; q.categories.exclude=['a']; assert.equal(validatePolicy(q,[{id:'a'}]).valid,false);
});
test('settings-growth-and-days-validation', () => {
  const d=policyToDraft(defaultPolicy()); d.recentDays='0'; assert.equal(validateDraft(d,[]).valid,false);
  d.recentDays='7'; d.baselineDays='8'; assert.equal(validateDraft(d,[]).valid,true);
});
test('settings-invalid-calendar-date-rejected', () => {
  const d = policyToDraft(defaultPolicy()); d.seasonalReferenceDate = '2026-02-30';
  const out = validateDraft(d, []); assert.equal(out.valid, false); assert.ok(out.errors.seasonalReferenceDate);
});
test('settings-ui-labels-and-no-cdn', async () => {
  const html = await fs.readFile(path.join(process.cwd(), 'ui/settings.html'), 'utf8');
  const js = await fs.readFile(path.join(process.cwd(), 'ui/settings.mjs'), 'utf8');
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:/i);
  assert.doesNotMatch(html + js, /innerHTML/);
  for (const id of ['seasonalEnabled','recentSurgeEnabled','seasonalReferenceDate','includeCategories','excludeCategories','priceMin','priceMax','priceBasis','commissionRatePercent','commissionPerOrder','salesPeriod','salesMin','conversionScope','conversionDenominator','conversionMinPercent','conversionMinSample','recentDays','baselineDays','minimumGrowthRatePercent','missingDataStrategy','maxCartAdditions','maxLibraryPages','maxCandidates']) {
    assert.match(html, new RegExp(`(?:for|id)=["']${id}["']`));
  }
});
