/** SP-28 wire contracts shared by API and UI; no Electron/runtime imports. */
export interface ReplyRef { id: number; author_name: string | null; body: string | null; is_deleted: boolean }
export interface CommunityEntry {
  reply_to?: ReplyRef | null;
  id: number; thread_id: number; kind: 'message' | 'review'; body: string;
  author_name: string; mine: boolean; can_delete: boolean; is_deleted: boolean; created_at: string;
}
export interface CommunityThread {
  id: number; file_id: number | null; title: string;
  card_context?: CardContext | null;
  last_message: CommunityEntry | null; unread_count: number;
}
export interface CardContext {
  // SP-35 (D-185): + даташит микросхемы и произвольный файл личного хранилища.
  // SP-36 (D-188): + ISP-подключение eMMC и фото ремонта.
  content_kind: 'firmware' | 'documentation' | 'software' | 'datasheet' | 'isp_emmc' | 'repair_pictures' | 'any_file';
  brand: string; model: string; chassis: string; doc_type: string; description: string; title: string;
}
export interface PresencePage {
  total: number; window_seconds: number; users: {name:string; mine:boolean}[]; has_more: boolean;
}
export interface EntryPage { items: CommunityEntry[]; has_more: boolean }
export interface ThreadPage { threads: CommunityThread[]; has_more: boolean }
export interface EntryIntent { body: string; request_id: string; reply_to_id?: number | null }

/** One request id per intent, kept on network failure, independent of attempts. */
export class CommunityDraft {
  text = '';
  reply: ReplyRef | null = null;
  private pending: EntryIntent | null = null;
  constructor(private newId: () => string = () => crypto.randomUUID()) {}
  intent(): EntryIntent {
    const body = this.text.trim();
    if (!this.pending || this.pending.body !== body || (this.pending.reply_to_id ?? null) !== (this.reply?.id ?? null))
      this.pending = {body, request_id:this.newId(), ...(this.reply ? {reply_to_id:this.reply.id} : {})};
    return {...this.pending};
  }
  accept(intent: EntryIntent): void {
    if (this.text.trim() === intent.body && (this.reply?.id ?? null) === (intent.reply_to_id ?? null)) {
      this.text = ''; this.reply = null;
    }
    if (this.pending?.request_id === intent.request_id) this.pending = null;
  }
}
export function communityEscape(value: string): string {
  return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

export function shouldSendOnEnter(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey' | 'isComposing' | 'repeat' | 'keyCode'>): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey
    && !e.isComposing && e.keyCode !== 229 && !e.repeat;
}
