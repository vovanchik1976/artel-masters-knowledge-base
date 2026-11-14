import {test} from 'node:test';
import assert from 'node:assert/strict';
import {insertEmoji} from '../src/ui/EmojiPicker';
test('emoji inserts at caret or replaces selection, respecting textarea maxLength', () => {
  assert.deepEqual(insertEmoji('abc',1,2,'👍',10),{text:'a👍c',caret:3});
  assert.deepEqual(insertEmoji('abc',3,3,'🙂',5),{text:'abc🙂',caret:5});
  assert.equal(insertEmoji('abc',3,3,'🙂',4),null);
});
