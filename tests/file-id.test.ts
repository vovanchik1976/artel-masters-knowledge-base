import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseFileId} from '../src/search/FileId';

test('file ID: numeric, hash and ID forms open the same public card', () => {
  for (const value of ['65', '#65', 'ID65', 'id65', '  ID65  ', '00065'])
    assert.equal(parseFileId(value), 65);
  assert.equal(parseFileId('1'), 1);
  assert.equal(parseFileId('2147483647'), 2147483647);
});
test('file ID: rejects invalid numbers and overflow before HTTP', () => {
  for (const value of ['', ' ', '0', '#0', '-1', '+65', '1.5', '1e2', 'ID 65',
    '#ID65', '６５', '65x', '2147483648', '999999999999999999999999'])
    assert.equal(parseFileId(value), null, value);
});
