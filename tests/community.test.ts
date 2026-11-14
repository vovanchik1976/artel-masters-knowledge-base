import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommunityDraft } from '../src/community';
import { renderEntries } from '../src/ui/FileReviews';
import { renderChatFeed, renderOpenCardChip } from '../src/ui/CommunityPage';
import type { CommunityEntry } from '../src/community';

const entry: CommunityEntry = { id: 4, thread_id: 1, kind: 'message', body: '<img src=x onerror=alert(1)>',
  author_name: '<Alice>', mine: false, can_delete: false, is_deleted: false, created_at: '2026-10-26T10:00:00Z' };

test('failed send reuses one intent; changed text gets another; late success preserves new draft', () => {
  let seq = 0;
  const draft = new CommunityDraft(() => `request-${++seq}`);
  draft.text = ' hello ';
  const a = draft.intent();
  assert.deepEqual(draft.intent(), a);
  draft.text = 'edited';
  assert.notEqual(draft.intent().request_id, a.request_id);
  draft.accept(a);
  assert.equal(draft.text, 'edited');
  const b = draft.intent();
  draft.accept(b);
  assert.equal(draft.text, '');
  draft.text = 'hello';
  assert.notEqual(draft.intent().request_id, a.request_id);
});

test('entry text/author are escaped and deletion never renders old content', () => {
  const html = renderEntries([entry]);
  assert.ok(html.includes('&lt;img'));
  assert.ok(html.includes('&lt;Alice&gt;'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('data-delete'));
  assert.ok(renderEntries([{...entry, can_delete:true}]).includes('data-delete="4"'));
  const removed = renderEntries([{...entry, is_deleted:true}]);
  assert.ok(!removed.includes('onerror'));
});

test('D-130: entries carry data-entry-id for scroll anchoring', () => {
  const html = renderEntries([entry]);
  assert.ok(html.includes('data-entry-id="4"'));
});

test('D-135: в чате карточки есть чип — переход к карточке; в общем чате чипа нет', () => {
  const fileThread = { id: 2, file_id: 5, title: 'FDBG', last_message: null, unread_count: 0 };
  const html = renderOpenCardChip(fileThread);
  assert.match(html, /data-open-card="5"/, 'чип несёт id файла карточки');
  assert.match(html, /community-open-card/);
  assert.equal(
    renderOpenCardChip({ id: 1, file_id: null, title: 'general', last_message: null, unread_count: 0 }),
    '',
    'у общего чата чипа нет',
  );
});

test('feed displays context, last message, unread, general and escaped titles', () => {
  const html = renderChatFeed([
    {id:1, file_id:null, title:'general', last_message:null, unread_count:0},
    {id:2, file_id:5, title:'<Firmware>', last_message:entry, unread_count:3},
  ], 2);
  assert.ok(html.includes('&lt;Firmware&gt;'));
  assert.ok(html.includes('community-unread'));
  assert.ok(html.includes('aria-current="true"'));
  assert.ok(html.indexOf('data-thread="1"') < html.indexOf('data-thread="2"'));
});

test('feed renders category and full card-specific fields without leaking markup', () => {
  const base = {id: 2, file_id: 5, title: 'legacy', last_message:null, unread_count:123};
  const context = {content_kind:'firmware' as const, brand:'LG', model:'TV', chassis:'TP.MS3663.PB818',
    doc_type:'', description:'', title:''};
  let html = renderChatFeed([{...base, card_context:context}], 2);
  assert.ok(html.includes('community-kind firmware'));
  assert.ok(html.includes('TP.MS3663.PB818'));
  html = renderChatFeed([{...base, card_context:{...context, content_kind:'documentation', doc_type:'schematic', description:'<Power supply> revision B'}}], 2);
  assert.ok(html.includes('community-kind documentation'));
  assert.ok(html.includes('&lt;Power supply&gt; revision B'));
  assert.ok(!html.includes('>schematic<'));
  const name = 'Program_' + 'A'.repeat(300);
  html = renderChatFeed([{...base, card_context:{...context, content_kind:'software', title:name}}], 2);
  assert.ok(html.includes(name));
  assert.ok(!html.includes('LG'));
});
