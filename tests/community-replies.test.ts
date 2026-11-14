import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderEntries} from '../src/ui/FileReviews';
import type {CommunityEntry} from '../src/community';
const item:CommunityEntry={id:2,thread_id:1,kind:'message',body:'answer',author_name:'Bob',mine:false,
 can_delete:false,is_deleted:false,created_at:'2026-10-31T10:00:00Z',
 reply_to:{id:1,author_name:'<Alice>',body:'<img onerror=x>',is_deleted:false}};
test('reply renders author and quote as escaped text',()=>{
 const html=renderEntries([item]);
 assert.match(html,/&lt;Alice&gt;/); assert.match(html,/&lt;img onerror=x&gt;/);
 assert.match(html,/data-reply="2"/);
});
test('deleted original and deleted answer cannot reveal an old quote',()=>{
 const gone=renderEntries([{...item,reply_to:{...item.reply_to!,is_deleted:true}}]);
 assert.ok(!gone.includes('onerror')); assert.ok(!gone.includes('Alice'));
 assert.ok(!renderEntries([{...item,is_deleted:true}]).includes('onerror'));
});
