import {t} from '../i18n';

export function insertEmoji(text:string, start:number, end:number, emoji:string, maxLength:number): {text:string;caret:number} | null {
  const next=text.slice(0,start)+emoji+text.slice(end);
  return next.length > maxLength ? null : {text:next,caret:start+emoji.length};
}

/**
 * Иконка кнопки смайликов в материале приложения (владелец, 2026-10-31):
 * заливной «стикер»-смайлик с тёплым янтарным градиентом и блик-подсветкой.
 *
 * ПОЧЕМУ НЕ ТОНКАЯ ЛИНИЯ (было): на 24 px stroke-контур читался как «бедная»
 * плашка рядом с градиентными кнопками приложения — жалоба владельца.
 * Градиентные `id` уникальны на инстанс (`uid`): на странице может жить больше
 * одного пикера, и общий id после размонтирования первого ломал бы заливку.
 */
export function emojiToggleIconMarkup(uid: string = ''): string {
  const face = `emoji-face${uid}`;
  const rim = `emoji-rim${uid}`;
  return '<svg class="emoji-toggle-icon" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<defs>'
    + `<radialGradient id="${face}" cx="36%" cy="26%" r="82%">`
    + '<stop offset="0%" stop-color="#fff3b0"/>'
    + '<stop offset="52%" stop-color="#f7c948"/>'
    + '<stop offset="100%" stop-color="#e39a1b"/>'
    + '</radialGradient>'
    + `<linearGradient id="${rim}" x1="0" y1="0" x2="0" y2="1">`
    + '<stop offset="0%" stop-color="#fff8d8"/>'
    + '<stop offset="100%" stop-color="#d08a12"/>'
    + '</linearGradient>'
    + '</defs>'
    + `<circle cx="12" cy="12" r="10.2" fill="url(#${face})" stroke="url(#${rim})" stroke-width="1.4"/>`
    + '<ellipse cx="9.1" cy="7.9" rx="3.1" ry="1.9" fill="#ffffff" opacity="0.5"/>'
    + '<circle cx="8.7" cy="10.2" r="1.3" fill="#4a3208"/>'
    + '<circle cx="15.3" cy="10.2" r="1.3" fill="#4a3208"/>'
    + '<path d="M7.6 13.7c0.95 2.05 2.5 3.15 4.4 3.15s3.45-1.1 4.4-3.15"'
    + ' stroke="#4a3208" stroke-width="1.9" stroke-linecap="round" fill="none"/>'
    + '</svg>';
}

/** Счётчик инстансов — гарантирует уникальные id градиентов в документе. */
let emojiIconSeq = 0;


/** Local symbols only. Closing restores the textarea selection and focus. */
export class EmojiPicker {
  private button:HTMLButtonElement;
  private panel:HTMLDivElement;
  private start=0;
  private end=0;
  constructor(host:HTMLElement, private input:HTMLTextAreaElement, private onInput:()=>void) {
    this.button=document.createElement('button'); this.button.type='button';
    this.button.className='community-emoji-toggle';
    this.button.innerHTML=emojiToggleIconMarkup('_'+(++emojiIconSeq));
    this.panel=document.createElement('div'); this.panel.className='community-emoji-picker';
    this.panel.hidden=true; this.panel.setAttribute('role','group');
    for(const emoji of ['🙂','😀','😂','😉','😊','😎','🤔','😢','😮','😡','👍','👎','👏','🙏','💪','❤','✅','❌','⚠','🔧','💡','☕','👌','🤝']) {
      const choice=document.createElement('button'); choice.type='button'; choice.textContent=emoji;
      choice.setAttribute('aria-label',emoji);
      choice.onclick=()=>{
        const next=insertEmoji(input.value,this.start,this.end,emoji,input.maxLength);
        if(next) { input.value=next.text; this.start=this.end=next.caret; this.onInput(); }
        this.close();
      };
      this.panel.append(choice);
    }
    this.button.onmousedown=()=>{ this.start=input.selectionStart; this.end=input.selectionEnd; };
    this.button.onclick=()=>{
      if(!this.panel.hidden) {this.close(); return;}
      this.start=input.selectionStart; this.end=input.selectionEnd;
      this.panel.hidden=false; this.button.setAttribute('aria-expanded','true');
      this.panel.querySelector('button')!.focus();
    };
    this.panel.onkeydown=e=>{if(e.key==='Escape') {e.preventDefault();this.close();}};
    host.append(this.button,this.panel); this.applyLang();
  }
  private close():void {
    this.panel.hidden=true; this.button.setAttribute('aria-expanded','false');
    this.input.focus(); this.input.setSelectionRange(this.start,this.end);
  }
  applyLang():void {
    this.button.setAttribute('aria-label',t('community.emoji'));
    this.button.setAttribute('aria-expanded',String(!this.panel.hidden));
    this.panel.setAttribute('aria-label',t('community.emoji'));
  }
}
