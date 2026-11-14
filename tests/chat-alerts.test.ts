import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ChatAlertState,isReadingChat} from '../shared/chatAlertPolicy';
const item=(thread_id:number,latest_incoming_id:number,unread_count=1,created_at='2026-10-30T00:00:00Z')=>
 ({thread_id,file_id:null,title:'general',created_at,latest_incoming_id,unread_count});

test('notifications baseline is silent; every page contributes unread; repeats and deletions stay silent',()=>{
 const state=new ChatAlertState(Date.parse('2026-10-31T00:00:00Z'));
 assert.deepEqual(state.accept([item(1,5),item(2,7)]),{unread:2,changed:[]});
 assert.deepEqual(state.accept([item(1,6),item(2,8)]).changed.map(i=>i.thread_id),[1,2]);
 assert.equal(state.accept([item(1,6),item(2,8)]).changed.length,0);
 assert.equal(state.accept([item(1,0,0),item(2,8)]).changed.length,0);
 assert.equal(state.accept([item(1,5)]).changed.length,0);
 assert.equal(state.accept([item(1,9,0)]).changed.length,0);
});
test('new threads signal; old newly accessible threads only establish a baseline',()=>{
 const state=new ChatAlertState(Date.parse('2026-10-31T00:00:00Z'));
 state.accept([]);
 assert.equal(state.accept([item(1,5,1,'2026-10-31T00:00:01Z')]).changed.length,1);
 assert.equal(state.accept([item(2,7)]).changed.length,0);
 assert.equal(state.accept([item(2,8)]).changed.length,1);
 state.accept([]);
 assert.equal(state.accept([item(2,8)]).changed.length,0);
});
test('reading requires actual focused visible window, selected thread and latest messages',()=>{
 const window={visible:true,focused:true,minimized:false};
 assert.equal(isReadingChat(window,{thread_id:1,pinned:true},1),true);
 for(const state of [{...window,focused:false},{...window,visible:false},{...window,minimized:true}])
  assert.equal(isReadingChat(state,{thread_id:1,pinned:true},1),false);
 assert.equal(isReadingChat(window,{thread_id:1,pinned:false},1),false);
 assert.equal(isReadingChat(window,{thread_id:1,pinned:true},2),false);
});

import {ChatNotifications} from '../src/ui/ChatNotifications';
import type {ChatNotificationItem,ChatNotificationPage} from '../shared/chatAlertPolicy';

function monitorFixture() {
 let now=Date.parse('2026-10-31T00:00:00Z');
 let items=Array.from({length:101},(_,i)=>item(i+1,i+1));
 let failSecond=false,sounds=0,unread=0,present=0;
 let delayed:Promise<ChatNotificationPage>|null=null;
 const events=new Map<string,(payload:unknown)=>void>();
 const monitor=new ChatNotifications({
  now:()=>now,
  load:async(after,maximum,signal)=>{
   if(delayed) return delayed;
   if(failSecond && after>0) throw new Error('offline');
   const rows=items.filter(i=>i.thread_id>after).slice(0,100);
   return {ok:true,snapshot_max_thread_id:101,items:rows,next_after_thread_id:rows.length===100?100:null};
  },
  call:async<T>(cmd:string)=>{
   if(cmd==='chat_window_state') return {visible:true,focused:false,minimized:false} as T;
   if(cmd==='chat_alerts_start') return {monitor_id:'current'} as T;
   if(cmd==='chat_alerts_present') {present++;return {play_sound:true} as T;}
   return null as T;
  },
  listen:async(name,cb)=>{events.set(name,cb);return ()=>events.delete(name);},
  reading:()=>({thread_id:null,pinned:false}),windowChanged:()=>{},
  unread:n=>{unread=n;},openThread:()=>{},sound:()=>{sounds++;},stopSound:()=>{},
  labels:()=>({open:'open',exit:'exit',messages:'messages',general:'general'}),multipleTitle:n=>String(n),
 });
 return {monitor,events,get sounds(){return sounds;},get unread(){return unread;},get present(){return present;},
  advance:()=>{now+=10000;},update:()=>{items=items.map(i=>i.thread_id===101?{...i,latest_incoming_id:1000}:i);},
  fail:(value:boolean)=>{failSecond=value;},delay:(value:Promise<ChatNotificationPage>)=>{delayed=value;}};
}
test('full paginated snapshot: partial failure cannot advance state; retry makes one signal for the final page',async()=>{
 const f=monitorFixture();await f.monitor.start();
 assert.equal(f.unread,101);assert.equal(f.sounds,0);
 f.update();f.fail(true);f.advance();await f.monitor.poll();
 assert.equal(f.sounds,0);assert.equal(f.present,0);
 f.fail(false);f.advance();await f.monitor.poll();
 assert.equal(f.sounds,1);assert.equal(f.present,1);
 f.advance();await f.monitor.poll();assert.equal(f.sounds,1);
 f.monitor.stop();assert.equal(f.unread,0);
});
test('logout drops a late snapshot and rejects stale main events',async()=>{
 const f=monitorFixture();await f.monitor.start();
 let release!:(page:ChatNotificationPage)=>void;
 f.delay(new Promise(resolve=>{release=resolve;}));f.advance();
 const pending=f.monitor.poll();f.monitor.stop();
 release({ok:true,snapshot_max_thread_id:101,items:[item(1,999)],next_after_thread_id:null});
 await pending;
 assert.equal(f.unread,0);assert.equal(f.sounds,0);assert.equal(f.present,0);
 f.events.get('chat-alert-tick')?.({monitor_id:'current'});
 assert.equal(f.sounds,0);
});

test('a main tick aborts a stalled HTTP request after 10 seconds without renderer timers',async()=>{
 let now=0,aborted=false;
 const monitor=new ChatNotifications({now:()=>now,
  load:async(_after,_max,signal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));})),
  call:async<T>(cmd:string)=>(cmd==='chat_alerts_start'?{monitor_id:'current'}:{visible:false,focused:false,minimized:true}) as T,
  listen:async()=>()=>{},reading:()=>({thread_id:null,pinned:false}),windowChanged:()=>{},unread:()=>{},
  openThread:()=>{},sound:()=>{},stopSound:()=>{},labels:()=>({open:'',exit:'',messages:'',general:''}),multipleTitle:()=>'',
 });
 const starting=monitor.start();
 for(let i=0;i<12;i++) await Promise.resolve();
 now=10000;await monitor.poll();await starting;
 assert.equal(aborted,true);monitor.stop();
});
