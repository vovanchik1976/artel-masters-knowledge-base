/** Visible, authenticated app presence. A stopped session cannot restart its timer. */
interface ActivityEnvironment {
  visible(): boolean;
  subscribe(fn:()=>void): ()=>void;
  later(fn:()=>void): number;
  cancel(id:number): void;
}
export class ActivityHeartbeat {
  private running=false;
  private busy: object | null=null;
  private timer: number | null=null;
  private unsubscribe: (()=>void) | null=null;
  constructor(private send:()=>Promise<unknown>, private env:ActivityEnvironment={
    visible:()=>document.visibilityState==='visible',
    subscribe:fn=>{document.addEventListener('visibilitychange',fn);return ()=>document.removeEventListener('visibilitychange',fn);},
    later:fn=>window.setTimeout(fn,60000), cancel:id=>window.clearTimeout(id),
  }) {}
  start(): void {
    if(this.running) return;
    this.running=true;
    this.unsubscribe=this.env.subscribe(()=>void this.tick());
    void this.tick();
  }
  stop(): void {
    this.running=false; this.busy=null;
    this.unsubscribe?.(); this.unsubscribe=null;
    if(this.timer!==null) this.env.cancel(this.timer);
    this.timer=null;
  }
  private async tick(): Promise<void> {
    if(!this.running || this.busy || !this.env.visible()) return;
    if(this.timer!==null) this.env.cancel(this.timer);
    this.timer=null;
    const token={}; this.busy=token;
    try {await this.send();} catch {/* Presence failure never interrupts app work. */}
    finally {
      if(this.busy===token) {
        this.busy=null;
        if(this.running) this.timer=this.env.later(()=>void this.tick());
      }
    }
  }
}
