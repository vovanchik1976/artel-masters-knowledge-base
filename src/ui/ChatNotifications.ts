import {ChatAlertState,isReadingChat,type ChatNotificationItem,type ChatNotificationPage,type ChatWindowState,type ChatReadingState} from '../../shared/chatAlertPolicy';

interface AlertDeps {
  load:(after:number,maximum:number|undefined,signal:AbortSignal)=>Promise<ChatNotificationPage>;
  call:<T>(command:string,args?:Record<string,unknown>)=>Promise<T>;
  listen:(event:string,cb:(payload:unknown)=>void)=>Promise<()=>void>;
  reading:()=>ChatReadingState;
  windowChanged:()=>void;
  unread:(count:number)=>void;
  openThread:(id:number)=>void;
  sound:()=>void;
  stopSound:()=>void;
  labels:()=>{open:string;exit:string;messages:string;general:string};
  multipleTitle:(count:number)=>string;
  now?:()=>number;
}
const positive=(n:unknown):n is number=>typeof n==='number' && Number.isInteger(n) && n>0 && n<=2147483647;
const nonnegative=(n:unknown):n is number=>n===0 || positive(n);

function checkedPage(page:ChatNotificationPage,after:number,maximum:number|undefined):ChatNotificationPage {
  if(!page || page.ok!==true || !nonnegative(page.snapshot_max_thread_id) || !Array.isArray(page.items)
    || page.items.length>100 || (maximum!==undefined && page.snapshot_max_thread_id!==maximum)) throw new Error('INVALID_NOTIFICATION_PAGE');
  let previous=after;
  for(const item of page.items) {
    if(!positive(item.thread_id) || item.thread_id<=previous || item.thread_id>page.snapshot_max_thread_id
      || (item.file_id!==null && !positive(item.file_id)) || typeof item.title!=='string'
      || typeof item.created_at!=='string' || !Number.isFinite(Date.parse(item.created_at))
      || !nonnegative(item.latest_incoming_id) || !nonnegative(item.unread_count)) throw new Error('INVALID_NOTIFICATION_PAGE');
    previous=item.thread_id;
  }
  if(page.next_after_thread_id!==null && (!positive(page.next_after_thread_id)
    || page.next_after_thread_id!==previous || previous<=after)) throw new Error('INVALID_NOTIFICATION_CURSOR');
  return page;
}

/** One full snapshot per main tick; no renderer timers or account state on disk. */
export class ChatNotifications {
  window:ChatWindowState={visible:false,focused:false,minimized:false};
  private epoch=0;
  private active=false;
  private monitor:string|null=null;
  private busy:object|null=null;
  private abort:AbortController|null=null;
  private state:ChatAlertState|null=null;
  private ready:Promise<void>|null=null;
  private nextAt=0;
  private requestDeadline=0;
  private failures=0;
  constructor(private deps:AlertDeps) {}
  private now():number {return this.deps.now?.() ?? Date.now();}
  private init():Promise<void> {
    return this.ready ??= (async()=>{
      await this.deps.listen('chat-alert-tick',payload=>{
        const tick=payload as {monitor_id?:unknown};
        if(tick?.monitor_id===this.monitor) void this.poll();
      });
      await this.deps.listen('chat-window-state',payload=>{
        const state=payload as ChatWindowState;
        if(state && typeof state.visible==='boolean' && typeof state.focused==='boolean' && typeof state.minimized==='boolean') {
          this.window=state;this.deps.windowChanged();this.syncReading();
        }
      });
      await this.deps.listen('chat-open-thread',payload=>{
        const target=payload as {monitor_id?:unknown;thread_id?:unknown};
        if(this.active && target?.monitor_id===this.monitor && positive(target.thread_id)) this.deps.openThread(target.thread_id);
      });
    })();
  }
  async start():Promise<void> {
    if(this.active) return;
    const epoch=++this.epoch;this.active=true;
    this.state=new ChatAlertState(this.now());this.nextAt=0;this.failures=0;
    try {
      await this.init();if(epoch!==this.epoch) return;
      this.window=await this.deps.call<ChatWindowState>('chat_window_state');
      if(epoch!==this.epoch) return;
      const result=await this.deps.call<{monitor_id:string}>('chat_alerts_start',{labels:this.deps.labels()});
      if(epoch!==this.epoch) {
        void this.deps.call('chat_alerts_stop',{monitor_id:result.monitor_id}).catch(()=>{});return;
      }
      this.monitor=result.monitor_id;this.deps.windowChanged();this.syncReading();await this.poll();
    } catch {if(epoch===this.epoch) {this.active=false;this.monitor=null;}}
  }
  stop():void {
    const monitor=this.monitor;
    this.epoch++;this.active=false;this.monitor=null;this.state=null;this.busy=null;
    this.abort?.abort();this.abort=null;this.deps.stopSound();this.deps.unread(0);
    void this.deps.call('chat_alerts_stop',monitor?{monitor_id:monitor}:{}).catch(()=>{});
  }
  syncReading():void {
    if(this.monitor) void this.deps.call('chat_reading_state',{monitor_id:this.monitor,...this.deps.reading()}).catch(()=>{});
  }
  async poll():Promise<void> {
    if(this.busy) {
      if(this.now()>=this.requestDeadline) this.abort?.abort();
      return;
    }
    if(!this.active || !this.monitor || this.now()<this.nextAt) return;
    const token={};this.busy=token;
    const epoch=this.epoch,monitor=this.monitor,abort=new AbortController();this.abort=abort;
    try {
      let after=0,maximum:number|undefined;
      const items:ChatNotificationItem[]=[];
      for(;;) {
        this.requestDeadline=this.now()+10000;
        const page=checkedPage(await this.deps.load(after,maximum,abort.signal),after,maximum);
        if(epoch!==this.epoch) return;
        maximum=page.snapshot_max_thread_id;items.push(...page.items);
        if(page.next_after_thread_id===null) break;
        after=page.next_after_thread_id;
      }
      if(epoch!==this.epoch || !this.state) return;
      const result=this.state.accept(items);this.deps.unread(result.unread);
      this.failures=0;this.nextAt=this.now()+5000;
      const reading=this.deps.reading();
      const changed=result.changed.filter(i=>!isReadingChat(this.window,reading,i.thread_id));
      if(changed.length) {
        const last=changed[changed.length-1];this.syncReading();
        const permission=await this.deps.call<{play_sound:boolean}>('chat_alerts_present',{
          monitor_id:monitor,thread_id:last.thread_id,
          title:(changed.length===1?last.title:this.deps.multipleTitle(changed.length)).slice(0,240),
          count:Math.min(2147483647,changed.reduce((sum,i)=>sum+i.unread_count,0)),play_sound:true,
        });
        if(epoch===this.epoch && permission.play_sound) this.deps.sound();
      }
    } catch {
      if(epoch===this.epoch) {this.failures++;this.nextAt=this.now()+Math.min(60000,10000*2**Math.min(this.failures-1,3));}
    } finally {
      if(this.busy===token) {this.busy=null;this.abort=null;}
    }
  }
}
