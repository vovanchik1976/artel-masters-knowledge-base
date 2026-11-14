import {randomUUID} from 'node:crypto';
import type {ChatSettings} from '../shared/chatSettings';
import {isReadingChat,type ChatWindowState,type ChatReadingState} from '../shared/chatAlertPolicy';

interface WindowPort {
  isVisible():boolean;isFocused():boolean;isMinimized():boolean;
  show():void;restore():void;focus():void;hide():void;on(name:string,cb:()=>void):unknown;
}
interface TrayPort {
  on(name:string,cb:()=>void):unknown;setToolTip(text:string):void;destroy():void;
  removeBalloon():void;displayBalloon(args:{title:string;content:string;noSound:boolean;respectQuietTime:boolean}):void;
}
interface TrayDeps {
  settings:()=>ChatSettings;emit:(name:string,payload:unknown)=>void;quit:()=>void;platform:string;
  menu?:(open:()=>void,exit:()=>void,labels:{open:string;exit:string})=>void;
}
const integer=(value:unknown):value is number=>Number.isInteger(value) && Number(value)>0 && Number(value)<=2147483647;

/** Native effects and timer belong to main; HTTP/auth remain in the renderer. */
export class ChatTray {
  private monitor:string|null=null;
  private timer:ReturnType<typeof setInterval>|null=null;
  private reading:ChatReadingState={thread_id:null,pinned:false};
  private target:number|null=null;
  private labels={open:'Відкрити ARTEL',exit:'Вихід',messages:'Нові повідомлення',general:'Загальний чат'};
  constructor(private win:WindowPort,private tray:TrayPort,private deps:TrayDeps) {
    tray.setToolTip('ARTEL');
    tray.on('click',()=>this.open());tray.on('double-click',()=>this.open());
    tray.on('balloon-click',()=>{
      const thread=this.target;this.open();
      if(this.monitor && thread) deps.emit('chat-open-thread',{monitor_id:this.monitor,thread_id:thread});
    });
    win.on('minimize',()=>{if(deps.platform==='win32') win.hide();});
    for(const event of ['show','hide','focus','blur','minimize','restore'])
      win.on(event,()=>deps.emit('chat-window-state',this.state()));
    this.menu();
  }
  private menu():void {this.deps.menu?.(()=>this.open(),()=>this.deps.quit(),this.labels);}
  private open():void {this.win.show();if(this.win.isMinimized()) this.win.restore();this.win.focus();}
  private state():ChatWindowState {
    return {visible:this.win.isVisible(),focused:this.win.isFocused(),minimized:this.win.isMinimized()};
  }
  command(cmd:string,args:Record<string,unknown>):unknown {
    if(cmd==='chat_window_state') return this.state();
    if(cmd==='chat_alerts_stop') {
      if(!args.monitor_id || args.monitor_id===this.monitor) this.stop();
      return null;
    }
    if(cmd==='chat_alerts_start') {
      this.stop(); this.monitor=randomUUID();
      if(args.labels && typeof args.labels==='object') {
        const labels=args.labels as Record<string,unknown>;
        for(const key of ['open','exit','messages','general'] as const)
          if(typeof labels[key]==='string' && (labels[key] as string).length<=120) this.labels[key]=labels[key] as string;
      }
      this.menu();
      this.timer=setInterval(()=>this.deps.emit('chat-alert-tick',{monitor_id:this.monitor}),5000);
      return {monitor_id:this.monitor};
    }
    if(cmd==='chat_reading_state') {
      if(args.monitor_id!==this.monitor || !this.monitor) return null;
      if((args.thread_id!==null && !integer(args.thread_id)) || typeof args.pinned!=='boolean') throw new Error('INVALID_ARGUMENT');
      this.reading={thread_id:args.thread_id as number|null,pinned:args.pinned};return null;
    }
    if(cmd==='chat_alerts_present') {
      const silent={play_sound:false,notification_shown:false};
      if(!this.monitor || args.monitor_id!==this.monitor) return silent;
      if(!integer(args.thread_id) || !integer(args.count) || typeof args.title!=='string'
        || args.title.length>240 || typeof args.play_sound!=='boolean') throw new Error('INVALID_ARGUMENT');
      if(isReadingChat(this.state(),this.reading,args.thread_id)) return silent;
      const settings=this.deps.settings();let notification_shown=false;
      if(settings.notifications_enabled && this.deps.platform==='win32') {
        this.target=args.thread_id;
        try {
          this.tray.displayBalloon({title:args.title==='general'?this.labels.general:args.title,
            content:`${this.labels.messages}: ${args.count}`,noSound:true,respectQuietTime:true});
          notification_shown=true;
        } catch { /* Windows can suppress balloons; text delivery must still work. */ }
      }
      return {play_sound:settings.sound_enabled && args.play_sound,notification_shown};
    }
    throw new Error('UNKNOWN_CHAT_COMMAND');
  }
  private stop():void {
    if(this.timer) clearInterval(this.timer);
    this.timer=null;this.monitor=null;this.target=null;this.reading={thread_id:null,pinned:false};
    if(this.deps.platform==='win32') this.tray.removeBalloon();
  }
  dispose():void {this.stop();this.tray.destroy();}
}

export function trayIconFile(platform:string):string {
  return platform==='win32'?'tray-icon.ico':'artel-logo-128.png';
}
