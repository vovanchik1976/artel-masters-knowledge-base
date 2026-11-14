export interface ChatNotificationItem {
  thread_id:number;file_id:number|null;title:string;created_at:string;latest_incoming_id:number;unread_count:number;
}
export interface ChatNotificationPage {
  ok:true;snapshot_max_thread_id:number;items:ChatNotificationItem[];next_after_thread_id:number|null;
}
export interface ChatWindowState {visible:boolean;focused:boolean;minimized:boolean}
export interface ChatReadingState {thread_id:number|null;pinned:boolean}
export function isReadingChat(window:ChatWindowState,reading:ChatReadingState,thread:number):boolean {
  return window.visible && window.focused && !window.minimized && reading.pinned && reading.thread_id===thread;
}

/** Advance only with a complete snapshot. Per-thread maxima survive deletion and temporary loss of access. */
export class ChatAlertState {
  private initialized=false;
  private latest=new Map<number,number>();
  constructor(private startedAt:number) {}
  accept(items:ChatNotificationItem[]):{unread:number;changed:ChatNotificationItem[]} {
    const changed:ChatNotificationItem[]=[];
    let unread=0;
    for(const item of items) {
      unread+=item.unread_count;
      const previous=this.latest.get(item.thread_id);
      if(this.initialized && item.unread_count>0 && item.latest_incoming_id>(previous ?? 0)
        && (previous!==undefined || Date.parse(item.created_at)>this.startedAt)) changed.push(item);
      this.latest.set(item.thread_id,Math.max(previous ?? 0,item.latest_incoming_id));
    }
    this.initialized=true;
    return {unread,changed};
  }
}
