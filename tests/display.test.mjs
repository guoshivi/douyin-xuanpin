import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSeconds, localizeError } from '../ui/display.mjs';

test('面板秒数固定一位小数且四舍五入', () => {
  for (const [input, expected] of [[0, '0.0 秒'], [1, '1.0 秒'], [1.24, '1.2 秒'], [1.25, '1.3 秒'], [1.05, '1.1 秒'], [59.95, '60.0 秒'], [1234.567, '1234.6 秒']]) {
    assert.equal(formatSeconds(input), expected);
  }
});
test('缺失或非法时长不冒充零秒', () => {
  for (const input of [null, undefined, '', -1, NaN, Infinity]) assert.equal(formatSeconds(input), '—');
});
test('英文校验代码与浏览器网络错误转换中文', () => {
  assert.equal(localizeError('INVALID_NUMBER'), '请输入有效的非负数字');
  assert.equal(localizeError('maxCartAdditions:REQUIRED'), '此项必须填写');
  assert.equal(localizeError('CATEGORY_NOT_AVAILABLE:类目选项未加载或类目 ID 不存在'), '类目选项未加载或类目标识不存在');
  assert.equal(localizeError('Failed to fetch'), '无法连接本机设置服务，请检查服务是否仍在运行');
  assert.equal(localizeError('最低价格不能高于最高价格'), '最低价格不能高于最高价格');
});
