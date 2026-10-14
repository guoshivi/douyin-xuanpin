import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const before = await fs.readFile(new URL('../data/acceptance/ui-redesign/before/settings.html', import.meta.url), 'utf8');
const after = await fs.readFile(new URL('../ui/settings.html', import.meta.url), 'utf8');
const attrs = html => [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
test('改版保留旧版全部控件编号，没有重复编号', () => {
  const old = attrs(before), next = attrs(after);
  assert.deepEqual(old.filter(id => !next.includes(id)), []);
  assert.equal(next.length, new Set(next).size);
});
test('保存字段保留原输入类型、数值约束、下拉选项及错误节点', () => {
  const inputs = html => new Map([...html.matchAll(/<(input|select|textarea)\b[^>]*\bid="([^"]+)"[^>]*>/g)].map(m => [m[2], m[0]]));
  const a = inputs(before), b = inputs(after);
  for (const [id, tag] of a) {
    assert.ok(b.has(id), id);
    for (const attr of ['type','min','max','step','multiple']) {
      const attribute = new RegExp(`\\b${attr}(?:="[^"]*")?(?=\\s|>)`);
      assert.equal(b.get(id).match(attribute)?.[0], tag.match(attribute)?.[0], `${id}:${attr}`);
    }
  }
  const options = html => [...html.matchAll(/<option\b[^>]*\bvalue="([^"]*)"/g)].map(m => m[1]);
  const expectedOptions = options(before);
  // 唯一有意新增的选项：补齐模型原本支持、旧页面遗漏的销量快照。
  expectedOptions.splice(expectedOptions.indexOf('platform_current') + 1, 0, 'snapshot');
  assert.deepEqual(options(after), expectedOptions);
  const errors = html => [...html.matchAll(/\bdata-error="([^"]+)"/g)].map(m => m[1]).sort();
  assert.deepEqual(errors(after), errors(before));
});
test('保留中文、CSRF引导与真实模块，不引入远程依赖或假数据', () => {
  assert.match(after, /<html lang="zh-CN">/);
  assert.match(after, /name="csrf-token" content="__CSRF_TOKEN__"/);
  assert.match(after, /src="\/settings\.mjs"/);
  assert.doesNotMatch(after, /(?:src|href)="https?:\/\//);
});
