/** Shared paginated text panel. Stable composer DOM preserves focus and drafts. */
import { CommunityDraft, shouldSendOnEnter, communityEscape as esc } from '../community';
import type { CommunityEntry, EntryIntent, EntryPage } from '../community';
import { t } from '../i18n';
import { EmojiPicker } from './EmojiPicker';

export function renderEntries(items: CommunityEntry[]): string {
  if (!items.length) return `<p class="community-empty">${esc(t('community.empty'))}</p>`;
  return items.map(item => `<article class="community-entry${item.mine ? ' mine' : ''}" data-entry-id="${item.id}">
    <header><strong>${esc(item.author_name)}</strong><time datetime="${esc(item.created_at)}">${esc(new Date(item.created_at).toLocaleString())}</time>
    ${item.can_delete && !item.is_deleted ? `<button type="button" class="community-delete" data-delete="${item.id}" aria-label="${esc(t('community.remove'))}">${esc(t('community.remove'))}</button>` : ''}</header>
    ${!item.is_deleted && item.kind==='message' ? `<button type="button" class="btn community-reply-action" data-reply="${item.id}">${esc(t('community.reply'))}</button>` : ''}
    ${!item.is_deleted && item.reply_to ? `<blockquote class="community-quote">${item.reply_to.is_deleted ? esc(t('community.deleted')) : `<strong>${esc(item.reply_to.author_name || '')}</strong><div>${esc(item.reply_to.body || '')}</div>`}</blockquote>` : ''}
    <div class="community-body">${esc(item.is_deleted ? t('community.deleted') : item.body)}</div></article>`).join('');
}

export interface EntryPanelDeps {
  load: (before?: number) => Promise<EntryPage>;
  send: (intent: EntryIntent) => Promise<unknown>;
  remove: (id: number) => Promise<unknown>;
  read?: (id: number) => Promise<unknown>;
  isActive: () => boolean;
  onReadingChanged?: () => void;
}

export class EntryPanel {
  readonly draft = new CommunityDraft();
  private host: HTMLElement | null = null;
  private list!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private status!: HTMLElement;
  private submit!: HTMLButtonElement;
  private earlier!: HTMLButtonElement;
  private latest!: HTMLButtonElement;
  private jump!: HTMLButtonElement;
  private items: CommunityEntry[] = [];
  private before: number | undefined;
  private hasMore = false;
  private loading = false;
  private sending = false;
  private epoch = 0;
  private error = false;
  private pinned = true;
  private programmaticScroll = false;
  private lastRead = 0;
  private emoji: EmojiPicker | null = null;
  private replyHost!: HTMLElement;

  constructor(private kind: 'message' | 'review', private deps: EntryPanelDeps) {}

  mount(host: HTMLElement): void {
    this.unmount();
    this.host = host;
    host.innerHTML = `<div class="community-history-wrap">
        <div class="community-history" role="region" aria-label="${esc(t('community.history'))}"></div>
        <button type="button" class="community-jump" data-jump-latest hidden aria-label="${esc(t('community.latest'))}">↓</button>
      </div>
      <div class="community-paging"><button type="button" class="btn btn-secondary" data-earlier></button><button type="button" class="btn btn-secondary" data-latest></button><button type="button" class="btn btn-secondary" data-refresh></button></div>
      <form class="community-composer"><div class="community-reply-draft" hidden></div><label><span class="community-input-label"></span><textarea rows="3" required></textarea></label><div class="community-compose-footer"><span role="status" aria-live="polite"></span><button class="btn btn-primary" type="submit"></button></div></form>`;
    this.list = host.querySelector('.community-history')!;
    this.input = host.querySelector('textarea')!;
    this.status = host.querySelector('[role="status"]')!;
    this.submit = host.querySelector('[type="submit"]')!;
    this.earlier = host.querySelector('[data-earlier]')!;
    this.latest = host.querySelector('[data-latest]')!;
    this.jump = host.querySelector('[data-jump-latest]')!;
    this.input.maxLength = this.kind === 'message' ? 4000 : 2000;
    this.input.value = this.draft.text;
    this.replyHost = host.querySelector('.community-reply-draft')!;
    if(this.kind==='message') {
      const emojiHost=document.createElement('div'); emojiHost.className='community-emoji-host';
      host.querySelector('.community-compose-footer')!.prepend(emojiHost);
      this.emoji=new EmojiPicker(emojiHost,this.input,()=>{
        this.draft.text=this.input.value; this.updateButtons();
      });
      this.input.addEventListener('keydown',e=>{
        if(shouldSendOnEnter(e)) {e.preventDefault();void this.send();}
        else if(e.key==='Enter' && e.repeat && !e.shiftKey && !e.isComposing) e.preventDefault();
      });
    }
    this.input.addEventListener('input', () => {this.draft.text = this.input.value; this.updateButtons();});
    this.jump.addEventListener('click', () => {
      this.pinned = true;
      this.jump.hidden = true;
      this.list.scrollTop = this.list.scrollHeight;
      this.deps.onReadingChanged?.(); void this.markRead();
    });
    this.list.addEventListener('scroll', () => {
      if (this.programmaticScroll) {
        this.programmaticScroll=false; this.updateJump();
        return;
      }
      this.trackScroll();
    });
    host.querySelector('form')!.addEventListener('submit', e => {e.preventDefault(); void this.send();});
    this.earlier.addEventListener('click', () => {
      if (this.loading || !this.items.length) return;
      this.before = Math.min(...this.items.map(i=>i.id));
      void this.refresh();
    });
    this.latest.addEventListener('click', () => {if (!this.loading) {this.before=undefined; void this.refresh();}});
    host.querySelector('[data-refresh]')!.addEventListener('click', () => void this.refresh());
    this.list.addEventListener('click', e => {
      const reply=(e.target as HTMLElement).closest<HTMLButtonElement>('[data-reply]');
      if(reply && this.kind==='message') {
        const source=this.items.find(v=>v.id===Number(reply.dataset.reply) && !v.is_deleted);
        if(source) {
          this.draft.reply={id:source.id,author_name:source.author_name,body:Array.from(source.body).slice(0,240).join(''),is_deleted:false};
          this.renderReply(); this.input.focus();
        }
      }
      const target = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-delete]');
      if (target && !target.disabled) void this.remove(Number(target.dataset.delete), target);
    });
    this.applyLang();
    void this.refresh();
  }

  unmount(): void { this.epoch++; this.host=null; this.loading=false; this.emoji=null; }

  applyLang(): void {
    if (!this.host) return;
    this.emoji?.applyLang(); this.renderReply();
    this.host.querySelector('.community-input-label')!.textContent = t(this.kind === 'message' ? 'community.message' : 'community.review_hint');
    this.earlier.textContent=t('community.earlier'); this.latest.textContent=t('community.latest');
    this.host.querySelector('[data-refresh]')!.textContent=t('community.refresh');
    this.jump.setAttribute('aria-label', t('community.latest'));
    this.submit.textContent=t(this.sending ? 'community.sending' : 'community.send');
    if (this.pinned) {
      this.list.innerHTML=renderEntries(this.items);
      this.list.scrollTop=this.list.scrollHeight;
    } else {
      const state=this.captureView();
      this.list.innerHTML=renderEntries(this.items);
      this.applyState(state);
    }
    this.updateJump();
    this.status.textContent=this.error ? t('community.error') : this.loading ? t('community.loading') : '';
    this.updateButtons();
  }

  private renderReply():void {
    if(!this.host) return;
    const reply=this.draft.reply;
    this.replyHost.hidden=!reply;
    this.replyHost.replaceChildren();
    if(!reply) return;
    const quote=document.createElement('span'); quote.textContent=`${reply.author_name}: ${reply.body}`;
    const cancel=document.createElement('button'); cancel.type='button'; cancel.textContent='×';
    cancel.setAttribute('aria-label',t('community.cancel_reply'));
    cancel.onclick=()=>{this.draft.reply=null;this.renderReply();this.input.focus();};
    this.replyHost.append(quote,cancel);
  }

  private updateButtons(): void {
    if (!this.host) return;
    this.submit.disabled=this.sending;
    this.earlier.disabled=this.loading || !this.hasMore;
    this.latest.disabled=this.loading || this.before === undefined;
    this.updateJump();
  }

  private maxScroll(): number { return Math.max(0, this.list.scrollHeight - this.list.clientHeight); }

  /** D-130: пересчитать «прикреплён ли низ» и видимость чипа «вниз». */
  private trackScroll(): void {
    if (!this.host) return;
    this.pinned = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
    this.updateJump(); this.deps.onReadingChanged?.(); void this.markRead();
  }

  private updateJump(): void {
    if (this.host) this.jump.hidden = this.pinned || this.loading;
  }

  /** D-130: первая часть­но видимая запись + её отступ от верха списка. */
  private captureView(): { scrollTop: number; anchor: { id: string; offset: number } | null } {
    const top=this.list.getBoundingClientRect().top;
    const row=Array.from(this.list.querySelectorAll<HTMLElement>('[data-entry-id]'))
      .find(r => r.getBoundingClientRect().bottom > top);
    return {
      scrollTop: this.list.scrollTop,
      anchor: row ? { id: row.dataset.entryId!, offset: row.getBoundingClientRect().top - top } : null,
    };
  }

  private applyState(state: { scrollTop: number; anchor: { id: string; offset: number } | null } | null): void {
    if (!state) {
      this.list.scrollTop=this.list.scrollHeight;
      return;
    }
    const row=state.anchor ? this.list.querySelector<HTMLElement>(`[data-entry-id="${state.anchor.id}"]`) : null;
    if (row) {
      const rowTop=row.getBoundingClientRect().top - this.list.getBoundingClientRect().top + this.list.scrollTop;
      this.list.scrollTop=Math.max(0, rowTop - state.anchor!.offset);
    } else {
      this.list.scrollTop=Math.min(state.scrollTop, this.maxScroll());
    }
  }

  isReadingLatest():boolean {return !!this.host && this.before===undefined && this.pinned;}

  private reading=false;
  private async markRead():Promise<void> {
    const last=this.items[this.items.length-1]?.id ?? 0;
    if(this.reading || this.kind!=='message' || !this.isReadingLatest() || !this.deps.isActive()
      || document.visibilityState!=='visible' || last<=this.lastRead) return;
    const epoch=this.epoch;this.reading=true;
    try {await this.deps.read?.(last);if(epoch===this.epoch) this.lastRead=last;}
    catch {if(epoch===this.epoch) this.error=true;}
    finally {this.reading=false;}
  }

  async refresh(): Promise<void> {
    if (!this.host || this.loading) return;
    const epoch=this.epoch;
    const prepend=this.before !== undefined;
    this.loading=true; this.updateButtons();
    try {
      const page=await this.deps.load(this.before);
      if (epoch !== this.epoch || !this.host) return;
      const state=this.pinned && !prepend ? null : this.captureView();
      this.hasMore=page.has_more; this.error=false;
      if (prepend) {
        const known=new Set(this.items.map(i=>i.id));
        const fresh=page.items.filter(i=>!known.has(i.id));
        this.items=[...fresh, ...this.items];
        this.before=page.has_more ? this.items[0]?.id : undefined;
      } else {
        this.items=page.items;
        this.before=undefined;
      }
      this.list.innerHTML=renderEntries(this.items);
      if (prepend) {
        // D-130: дозагрузка старших страниц ставит пользователя в историю —
        // чип «вниз» должен висеть, пока он не кликнет или не доскроллит сам.
        this.programmaticScroll=true;
        this.applyState(state);
        this.pinned=false;
        this.updateJump();
      } else {
        this.applyState(state);
        this.trackScroll();
      }
      this.deps.onReadingChanged?.();
      await this.markRead();
    } catch {
      if (epoch===this.epoch) this.error=true;
    } finally {
      if (epoch===this.epoch && this.host) {
        this.loading=false;
        this.status.textContent=this.error ? t('community.error') : '';
        this.updateButtons();
      }
    }
  }

  async send(): Promise<void> {
    if (this.sending || !this.draft.text.trim()) return;
    const epoch=this.epoch, intent=this.draft.intent();
    this.sending=true; this.error=false; this.applyLang();
    try {
      await this.deps.send(intent);
      if (epoch!==this.epoch || !this.host) return;
      this.draft.accept(intent); this.input.value=this.draft.text;
      this.before=undefined;
      this.pinned=true;
      await this.refresh();
    } catch {
      if (epoch===this.epoch) this.error=true;
    } finally {
      this.sending=false;
      if (epoch===this.epoch) this.applyLang();
    }
  }

  private async remove(id: number, button: HTMLButtonElement): Promise<void> {
    const epoch=this.epoch;
    button.disabled=true;
    try {
      await this.deps.remove(id);
      if (epoch===this.epoch) await this.refresh();
    } catch {if (epoch===this.epoch) {this.error=true; this.applyLang();}}
  }
}

/** Lazy reviews; no per-card background timers. */
export class FileReviews {
  private panel: EntryPanel;
  private details: HTMLDetailsElement | null = null;
  private opened=false;
  constructor(deps: EntryPanelDeps) {this.panel=new EntryPanel('review',deps);}
  mount(host: HTMLElement): void {
    const details=document.createElement('details');
    details.className='file-reviews';
    const summary=document.createElement('summary'); summary.textContent=t('community.reviews');
    const content=document.createElement('div'); content.className='file-reviews-content';
    details.append(summary,content); host.append(details); this.details=details;
    details.open=this.opened;
    let loaded=false;
    details.addEventListener('toggle',()=>{if (details.open && !loaded) {loaded=true; this.panel.mount(content);}});
  }
  applyLang(): void {if(this.details) this.details.querySelector('summary')!.textContent=t('community.reviews'); this.panel.applyLang();}
  unmount(): void {this.opened=this.details?.open ?? this.opened; this.panel.unmount(); this.details=null;}
}
