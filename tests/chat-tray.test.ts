import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ChatTray} from '../electron/chat-tray';

test('tray checks preferences, monitor generation and the exact reading thread',()=>{
 const handlers=new Map<string,()=>void>(); let balloons=0; let opened=0;
 const win={isVisible:()=>false,isFocused:()=>false,isMinimized:()=>true,
  show:()=>{opened++;},restore:()=>{},focus:()=>{},hide:()=>{},on:()=>{}};
 const tray={on:(name:string,cb:()=>void)=>{handlers.set(name,cb);},destroy:()=>{},removeBalloon:()=>{},
  setToolTip:()=>{},displayBalloon:(args:{noSound:boolean})=>{assert.equal(args.noSound,true);balloons++;}};
 const prefs={version:1 as const,sound_enabled:false,notifications_enabled:true,sound_id:'drop' as const};
 const events:string[]=[];
 const controller=new ChatTray(win,tray,{settings:()=>prefs,emit:name=>{events.push(name);},quit:()=>{},platform:'win32'});
 const start=controller.command('chat_alerts_start',{}) as {monitor_id:string};
 const present={monitor_id:start.monitor_id,thread_id:5,title:'file',count:1,play_sound:true};
 assert.deepEqual(controller.command('chat_alerts_present',present),{play_sound:false,notification_shown:true});
 assert.equal(balloons,1);
 handlers.get('balloon-click')!(); assert.equal(opened,1); assert.ok(events.includes('chat-open-thread'));
 controller.command('chat_alerts_stop',{});
 assert.deepEqual(controller.command('chat_alerts_present',present),{play_sound:false,notification_shown:false});
 assert.equal(balloons,1); controller.dispose();
});

test('all sound/notification combinations are independent and a focused reading thread stays quiet',t=>{
 let focused=false,visible=false,minimized=true,balloons=0;
 const win={isVisible:()=>visible,isFocused:()=>focused,isMinimized:()=>minimized,
  show:()=>{visible=true;},restore:()=>{minimized=false;},focus:()=>{focused=true;},hide:()=>{visible=false;},on:()=>{}};
 const prefs={version:1 as const,sound_enabled:true,notifications_enabled:true,sound_id:'drop' as const};
 const tray={on:()=>{},destroy:()=>{},removeBalloon:()=>{},setToolTip:()=>{},displayBalloon:()=>{balloons++;}};
 const controller=new ChatTray(win,tray,{settings:()=>prefs,emit:()=>{},quit:()=>{},platform:'win32'});
 t.after(()=>controller.dispose());
 const {monitor_id}=controller.command('chat_alerts_start',{}) as {monitor_id:string};
 const present={monitor_id,thread_id:1,title:'general',count:1,play_sound:true};
 for(const sound of [false,true]) for(const notification of [false,true]) {
  prefs.sound_enabled=sound;prefs.notifications_enabled=notification;
  assert.deepEqual(controller.command('chat_alerts_present',present),{play_sound:sound,notification_shown:notification});
 }
 focused=visible=true;minimized=false;
 controller.command('chat_reading_state',{monitor_id,thread_id:1,pinned:true});
 assert.deepEqual(controller.command('chat_alerts_present',present),{play_sound:false,notification_shown:false});
 assert.deepEqual(controller.command('chat_alerts_present',{...present,thread_id:2}),{play_sound:true,notification_shown:true});
 assert.equal(balloons,3);
 const next=controller.command('chat_alerts_start',{}) as {monitor_id:string};
 controller.command('chat_alerts_stop',{monitor_id}); // late stop cannot kill the new account
 assert.deepEqual(controller.command('chat_alerts_present',{...present,monitor_id:next.monitor_id}),{play_sound:true,notification_shown:true});
});

import {trayIconFile} from '../electron/chat-tray';
test('tray uses ICO on Windows and a supported PNG on Linux',()=>{
 assert.equal(trayIconFile('win32'),'tray-icon.ico');
 assert.equal(trayIconFile('linux'),'artel-logo-128.png');
});
