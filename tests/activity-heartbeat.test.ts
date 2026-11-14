import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActivityHeartbeat } from '../src/ui/ActivityHeartbeat';

test('heartbeat follows auth/visibility, retries errors and ignores stale completions', async () => {
  let visible=true, count=0, listener=()=>{};
  let pending: (()=>void) | null=null;
  const tasks=new Map<number,()=>void>(); let seq=0;
  const beat=new ActivityHeartbeat(async()=>{count++; await new Promise<void>(r=>pending=r);}, {
    visible:()=>visible,
    subscribe:fn=>{listener=fn; return ()=>{listener=()=>{};};},
    later:fn=>{tasks.set(++seq, fn); return seq;}, cancel:id=>{tasks.delete(id);},
  });
  beat.start(); beat.start(); listener();
  assert.equal(count,1);
  pending!(); await new Promise(r=>setTimeout(r,0));
  assert.equal(tasks.size,1);
  visible=false; const run=[...tasks.values()][0]; tasks.clear(); run();
  assert.equal(count,1);
  visible=true; listener(); assert.equal(count,2);
  const stale=pending!;
  beat.stop(); beat.start(); assert.equal(count,3);
  stale(); await new Promise(r=>setTimeout(r,0));
  assert.equal(tasks.size,0);
  pending!(); await new Promise(r=>setTimeout(r,0));
  assert.equal(tasks.size,1);
  beat.stop(); assert.equal(tasks.size,0); listener(); assert.equal(count,3);
  const failing=new ActivityHeartbeat(async()=>{throw Error('offline');}, {
    visible:()=>true, subscribe:()=>()=>{}, later:fn=>{tasks.set(++seq,fn);return seq;}, cancel:id=>{tasks.delete(id);},
  });
  failing.start(); await new Promise(r=>setTimeout(r,0));
  assert.equal(tasks.size,1); failing.stop();
});
