import { communityEscape as esc } from '../community';
import type { CommunityThread, ThreadPage, EntryIntent, EntryPage } from '../community';
import { EntryPanel } from './FileReviews';
import { t, tLoose, hasKey } from '../i18n';
import { CommunityPresence } from './CommunityPresence';
import type { PresencePage } from '../community';

export function renderThreadHeading(thread:CommunityThread): string {
  const c=thread.card_context;
  const kind=thread.file_id===null ? 'general' : c?.content_kind;
  const known=kind==='firmware' || kind==='documentation' || kind==='software' || kind==='general' ? kind : null;
  const badge=known ? `<span class="community-kind ${known}">${esc(t(`community.kind_${known}`))}</span>` : '';
  let title=thread.file_id===null?t('community.general'):thread.title;
  let detail='';
  if(c && thread.file_id!==null) {
    if(c.content_kind==='software') title=c.title || thread.title;
    else {
      title=[c.brand,c.model].filter(Boolean).join(' · ') || thread.title;
      if(c.content_kind==='firmware' && c.chassis) detail=t('community.chassis',{name:c.chassis});
      if(c.content_kind==='documentation') detail=[
        c.doc_type ? (hasKey(`upload.field.doc_type.options.${c.doc_type}`)?tLoose(`upload.field.doc_type.options.${c.doc_type}`):c.doc_type) : '', c.description,
      ].filter(Boolean).join(' · ');
    }
  }
  return `${badge}<strong class="community-title">${esc(title)}</strong>${detail?`<span class="community-card-detail">${esc(detail)}</span>`:''}`;
}

/** Чип «Открыть карточку» (D-135) — только у файловых чатов, общий без него. */
export function renderOpenCardChip(thread:CommunityThread): string {
  if (thread.file_id===null) return '';
  return `<button type="button" class="btn btn-secondary community-open-card" data-open-card="${thread.file_id}">${esc(t('community.open_card'))}</button>`;
}

export function renderChatFeed(threads: CommunityThread[], selected: number | null): string {
  return threads.map(thread => `<button type="button" class="community-chat${thread.id===selected?' selected':''}" data-thread="${thread.id}" aria-current="${thread.id===selected}">
    <span class="community-chat-top"><span class="community-chat-heading">${renderThreadHeading(thread)}</span>${thread.unread_count ? `<span class="community-unread">${thread.unread_count}</span>`:''}</span>
    <span class="community-preview">${esc(thread.last_message?.body || t('community.empty'))}</span>
    ${thread.last_message ? `<time>${esc(new Date(thread.last_message.created_at).toLocaleString())}</time>`:''}</button>`).join('');
}

export interface CommunityDeps {
  byId?: (threadId:number) => Promise<{thread:CommunityThread}>;
  reading?: (threadId:number|null,pinned:boolean) => void;
  isWindowFocused?: () => boolean;
  ensure: (fileId?: number) => Promise<{thread:CommunityThread}>;
  feed: (offset:number) => Promise<ThreadPage>;
  messages: (id:number,before?:number) => Promise<EntryPage>;
  send: (id:number,intent:EntryIntent) => Promise<unknown>;
  read: (id:number,last:number) => Promise<unknown>;
  remove: (id:number) => Promise<unknown>;
  presence?: (offset:number) => Promise<PresencePage>;
  /** D-135: открыть карточку обсуждаемого файла (App переключит вкладку). */
  openCard?: (fileId:number) => void;
}

export class CommunityPage {
  private active=false;
  private epoch=0;
  private openEpoch=0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tickToken: object | null=null;
  private selected: CommunityThread | null=null;
  private panels=new Map<number,EntryPanel>();
  private threads: CommunityThread[]=[];
  private offset=0;
  private hasMore=false;
  private loading=false;
  private failed=false;
  private list:HTMLElement;
  private title:HTMLElement;
  private content:HTMLElement;
  private status:HTMLElement;
  private next:HTMLButtonElement;
  private prev:HTMLButtonElement;
  private presence:CommunityPresence;

  constructor(private host:HTMLElement,private deps:CommunityDeps) {
    host.innerHTML=`<div class="community-presence"></div><div class="community-layout"><nav class="community-sidebar"><h2></h2><div class="community-chat-list"></div><div class="community-paging"><button type="button" class="btn btn-secondary" data-prev></button><button type="button" class="btn btn-secondary" data-next></button></div></nav><section class="community-conversation"><h2></h2><p role="status" aria-live="polite"></p><div class="community-panel"></div></section></div>`;
    this.presence=new CommunityPresence(host.querySelector('.community-presence')!, deps.presence);
    this.list=host.querySelector('.community-chat-list')!; this.title=host.querySelector('section h2')!;
    this.content=host.querySelector('.community-panel')!; this.status=host.querySelector('section > [role="status"]')!;
    this.next=host.querySelector('[data-next]')!; this.prev=host.querySelector('[data-prev]')!;
    this.next.onclick=()=>{if (!this.loading) {this.offset+=30; void this.refreshFeed();}};
    this.prev.onclick=()=>{if (!this.loading) {this.offset=Math.max(0,this.offset-30); void this.refreshFeed();}};
    this.title.addEventListener('click',e=>{
      const btn=(e.target as HTMLElement).closest<HTMLElement>('[data-open-card]');
      if (btn) {const fid=Number(btn.dataset.openCard); if (fid>0) this.deps.openCard?.(fid);}
    });
    this.list.onclick=e=>{
      const el=(e.target as HTMLElement).closest<HTMLElement>('[data-thread]');
      const thread=this.threads.find(v=>v.id===Number(el?.dataset.thread));
      if (thread) {this.openEpoch++; this.select(thread);}
    };
    document.addEventListener('visibilitychange',()=>{if(this.active && document.visibilityState==='visible') void this.tick();});
    this.applyLang();
  }

  setActive(active:boolean): void {
    this.active=active;
    if (this.timer) clearTimeout(this.timer);
    this.timer=null;
    if(active) void this.tick();
    this.reportReading();
  }

  readingState():{thread_id:number|null;pinned:boolean} {
    return {thread_id:this.active?this.selected?.id ?? null:null,
      pinned:this.active && (this.panels.get(this.selected?.id ?? 0)?.isReadingLatest() ?? false)};
  }

  reportReading():void {
    this.deps.reading?.(this.active?this.selected?.id ?? null:null,
      this.active && (this.panels.get(this.selected?.id ?? 0)?.isReadingLatest() ?? false));
  }

  async openThread(threadId:number):Promise<void> {
    if(!this.deps.byId) return;
    const epoch=this.epoch, open=++this.openEpoch;
    try {
      const result=await this.deps.byId(threadId);
      if(epoch!==this.epoch || open!==this.openEpoch) return;
      this.select(result.thread);await this.refreshFeed();
    } catch {if(epoch===this.epoch) {this.failed=true;this.applyLang();}}
  }

  async openFile(fileId:number): Promise<void> {await this.open(fileId);}

  private async open(fileId?:number): Promise<void> {
    const epoch=this.epoch, open=++this.openEpoch;
    this.status.textContent=t('community.loading');
    try {
      const result=await this.deps.ensure(fileId);
      if(epoch!==this.epoch || open!==this.openEpoch) return;
      this.select(result.thread); this.failed=false;
      await this.refreshFeed();
    } catch {if(epoch===this.epoch && open===this.openEpoch) {this.failed=true; this.applyLang();}}
  }

  private select(thread:CommunityThread): void {
    if(this.selected?.id===thread.id) {this.selected=thread;this.applyLang();return;}
    this.panels.get(this.selected?.id ?? 0)?.unmount();
    this.selected=thread;
    let panel=this.panels.get(thread.id);
    if(!panel) {
      const id=thread.id;
      panel=new EntryPanel('message',{
        load:before=>this.deps.messages(id,before), send:intent=>this.deps.send(id,intent),
        read:last=>this.deps.read(id,last), remove:id=>this.deps.remove(id),
        isActive:()=>this.active && this.selected?.id===id && (this.deps.isWindowFocused?.() ?? document.hasFocus()),
        onReadingChanged:()=>this.reportReading(),
      });
      this.panels.set(id,panel);
    }
    panel.mount(this.content); this.applyLang(); this.reportReading();
  }

  private async refreshFeed(): Promise<void> {
    if(this.loading) return;
    const epoch=this.epoch;
    this.loading=true;
    try {
      const page=await this.deps.feed(this.offset);
      if(epoch!==this.epoch) return;
      this.threads=page.threads; this.hasMore=page.has_more; this.failed=false;
      const current=this.threads.find(v=>v.id===this.selected?.id);
      if(current) this.selected=current;
    } catch {if(epoch===this.epoch) this.failed=true;}
    finally {if(epoch===this.epoch) {this.loading=false; this.applyLang();}}
  }

  private async tick(): Promise<void> {
    if(this.tickToken || !this.active || document.visibilityState!=='visible') return;
    const token={};
    this.tickToken=token;
    const epoch=this.epoch;
    if(this.timer) clearTimeout(this.timer);
    this.timer=null;
    try {
      if(!this.selected) await this.open();
      else await this.refreshFeed();
      if(epoch===this.epoch && this.active) await this.panels.get(this.selected?.id ?? 0)?.refresh();
      if(epoch===this.epoch && this.active && document.visibilityState==='visible') await this.presence.refresh();
    } finally {
      if(this.tickToken===token) {
        this.tickToken=null;
        if(epoch===this.epoch && this.active) this.timer=setTimeout(()=>void this.tick(),5000);
      }
    }
  }

  applyLang(): void {
    this.host.querySelector('nav h2')!.textContent=t('community.chats');
    this.title.innerHTML=this.selected ? renderThreadHeading(this.selected)+renderOpenCardChip(this.selected) : esc(t('community.choose'));
    this.presence.applyLang();
    this.list.innerHTML=renderChatFeed(this.threads,this.selected?.id ?? null);
    this.status.textContent=this.failed?t('community.error'):'';
    this.prev.textContent=t('community.previous'); this.next.textContent=t('community.next');
    this.prev.disabled=this.loading || this.offset===0; this.next.disabled=this.loading || !this.hasMore;
    for(const panel of this.panels.values()) panel.applyLang();
  }

  reset(): void {
    this.presence.reset();
    this.setActive(false); this.epoch++; this.openEpoch++; this.tickToken=null;
    for(const panel of this.panels.values()) panel.unmount();
    this.panels.clear(); this.selected=null; this.threads=[]; this.offset=0;
    this.hasMore=false; this.loading=false; this.failed=false; this.content.innerHTML=''; this.applyLang();
  }
}
