import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CommunityDraft, shouldSendOnEnter} from '../src/community';

test('Enter sends only a single unmodified, non-IME keypress', () => {
  const key = {key:'Enter', shiftKey:false, ctrlKey:false, altKey:false, metaKey:false, isComposing:false, repeat:false, keyCode:13};
  assert.equal(shouldSendOnEnter(key), true);
  for (const override of [{shiftKey:true},{ctrlKey:true},{altKey:true},{metaKey:true},
    {isComposing:true},{repeat:true},{keyCode:229},{key:'a'}])
    assert.equal(shouldSendOnEnter({...key,...override}), false);
});
test('retry keeps reply and key; changed reply gets a new intent; late success preserves new input', () => {
  let seq=0;
  const draft = new CommunityDraft(() => `key-${++seq}`);
  draft.text='hello'; draft.reply={id:1,author_name:'Alice',body:'quote',is_deleted:false};
  const first=draft.intent();
  assert.equal(first.reply_to_id,1);
  assert.deepEqual(draft.intent(),first);
  draft.reply={...draft.reply,id:2};
  assert.notEqual(draft.intent().request_id,first.request_id);
  draft.accept(first);
  assert.equal(draft.text,'hello'); assert.equal(draft.reply.id,2);
  const second=draft.intent(); draft.text='new text';
  draft.accept(second);
  assert.equal(draft.text,'new text'); assert.equal(draft.reply.id,2);
  draft.accept(draft.intent());
  assert.equal(draft.text,''); assert.equal(draft.reply,null);
});
