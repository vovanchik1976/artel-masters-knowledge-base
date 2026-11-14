import {t} from '../i18n';
import {CHAT_SOUND_IDS,DEFAULT_CHAT_SETTINGS,normalizeChatSoundId,type ChatSettings,type ChatSoundId} from '../../shared/chatSettings';
import {ChatSettingsWriter} from './ChatSettingsWriter';
import {store} from '../store';
import {normalizeTheme,themeAttrValue} from './ThemePresets';

export interface SettingsDeps {
  get:()=>Promise<ChatSettings>;
  save:(value:ChatSettings)=>Promise<ChatSettings>;
  /** Проба звука по клику (выбор звука делается на слух, а не по названию). */
  preview:(id:ChatSoundId)=>void;
  /** Настройки прочитаны/сохранены — App переключает звук уведомлений без перезапуска. */
  onSaved:(value:ChatSettings)=>void;
}

export class SettingsPage {
  private value:ChatSettings={...DEFAULT_CHAT_SETTINGS};
  private sound:HTMLInputElement;
  private notifications:HTMLInputElement;
  private status:HTMLElement;
  /** Идёт ПЕРВИЧНОЕ чтение настроек: контролы заблокированы до первого значения. */
  private busy=false;
  /** Идёт запись (индикатор «Сохраняю…»). Контролы НЕ блокирует — см. pickSound. */
  private saving=false;
  private failed=false;
  /**
   * Единственная точка записи: очередь «последнее намерение побеждает».
   * Без неё второй клик по звуку терялся, пока шла запись первого, а два
   * параллельных chat_settings_set переставлялись местами
   * (BUG-CHAT-SOUND-PREVIEW-001).
   */
  private readonly writer=new ChatSettingsWriter({
    current:()=>this.value,
    save:next=>this.deps.save(next),
    applied:value=>{this.value=value;this.failed=false;this.deps.onSaved(value);},
    failed:()=>{this.failed=true;},
  });
  constructor(private host:HTMLElement,private deps:SettingsDeps) {
    // Кнопки звука строятся из ЕДИНОГО списка: новый id без файла ломает сборку
    // (Record в chatSoundUrls), а не превращается в молчащую кнопку.
    const soundButtons=CHAT_SOUND_IDS.map((id)=>
      `<button class="theme-btn" data-sound-id="${id}" aria-pressed="false"><span class="theme-dot"></span><span></span></button>`,
    ).join('');
    host.innerHTML='<h2></h2><p class="settings-hint"></p>'
      +'<label class="chat-setting"><input type="checkbox" data-sound /><span></span></label>'
      +`<div class="settings-group"><span class="settings-label" data-sound-label></span>`
      +`<div class="theme-segment" role="radiogroup" data-sound-group>${soundButtons}</div></div>`
      +'<label class="chat-setting"><input type="checkbox" data-notifications /><span></span></label>'
      +'<div class="settings-group"><span class="settings-label" data-theme-label></span>'
      +'<div class="theme-segment" role="radiogroup"><button class="theme-btn" data-theme="artel" aria-pressed="true"><span class="theme-dot"></span><span></span></button>'
      +'<button class="theme-btn" data-theme="paper"><span class="theme-dot"></span><span></span></button>'
      +'<button class="theme-btn" data-theme="photon"><span class="theme-dot"></span><span></span></button>'
      +'<button class="theme-btn" data-theme="hud"><span class="theme-dot"></span><span></span></button></div></div>'
      +'<p role="status" aria-live="polite"></p>';
    this.sound=host.querySelector('[data-sound]')!;
    this.notifications=host.querySelector('[data-notifications]')!;
    this.status=host.querySelector('[role="status"]')!;
    this.sound.onchange=this.notifications.onchange=()=>void this.save();
    this.host.querySelectorAll<HTMLButtonElement>('[data-sound-id]').forEach((b)=>{
      b.addEventListener('click',()=>void this.pickSound(b.dataset.soundId!));
    });
    this.host.querySelectorAll<HTMLButtonElement>('[data-theme]').forEach((b)=>{
      b.addEventListener('click',()=>{void this.setTheme(b.dataset.theme!);});
    });
    this.applyLang(); void this.load();
  }
  private async load():Promise<void> {
    if(this.busy) return;
    this.busy=true;this.applyLang();
    try {this.value=await this.deps.get();this.failed=false;this.deps.onSaved(this.value);} catch {this.failed=true;}
    finally {this.busy=false;this.applyLang();}
  }
  private async save():Promise<void> {
    // Галочки и звук идут через ОДНУ очередь: параллельных записей нет.
    await this.submit({sound_enabled:this.sound.checked,notifications_enabled:this.notifications.checked});
  }
  /**
   * Выбор звука = проба (сразу слышно) + обычное авто-сохранение.
   * Кнопки «Сохранить» нет намеренно (решение владельца 2026-10-31): черновик
   * создаёт состояние «нажал, но на диске старое» — тот же класс обмана,
   * что и удалённая кнопка «Повторить» (BUG-SETTINGS-RETRY-001).
   *
   * Проба играет ВСЕГДА и ДО записи: это локальное действие. Раньше здесь стоял
   * `if (busy) return`, поэтому клик во время сохранения предыдущего звука молча
   * пропадал — мастер видел «через раз» (BUG-CHAT-SOUND-PREVIEW-001).
   */
  private async pickSound(id:string):Promise<void> {
    const sound_id=normalizeChatSoundId(id);
    this.deps.preview(sound_id);
    await this.submit({sound_id,sound_enabled:this.sound.checked,notifications_enabled:this.notifications.checked});
  }
  /** Одна точка записи: очередь сама схлопывает частые клики и не теряет последний. */
  private async submit(patch:Partial<ChatSettings>):Promise<void> {
    if(this.saving) {
      // Кнопки/галочки не блокируем: клик обязан дойти до очереди, а не утонуть.
      await this.writer.submit(patch);
      return;
    }
    this.saving=true;this.applyLang();
    try {await this.writer.submit(patch);} finally {this.saving=false;this.applyLang();}
  }
  /** Переключить пресет оформления: сохранить + применить атрибут на <html> сразу. */
  private setTheme(theme:string):void {
    const next=store.setTheme(theme);
    const attr=themeAttrValue(normalizeTheme(next));
    if(attr) document.documentElement.dataset.theme=attr;
    else document.documentElement.removeAttribute('data-theme');
    this.syncThemeButtons();
  }
  private syncThemeButtons():void {
    const cur=store.getTheme();
    this.host.querySelectorAll<HTMLButtonElement>('[data-theme]').forEach((b)=>{
      b.setAttribute('aria-pressed',String(b.dataset.theme===cur));
      b.disabled=this.busy;
    });
  }
  applyLang():void {
    const h2=this.host.querySelector('h2'); if(h2) h2.textContent=t('settings.title');
    const hint=this.host.querySelector('.settings-hint'); if(hint) hint.textContent=t('settings.hint');
    const sSpan=this.sound.nextElementSibling; if(sSpan) sSpan.textContent=t('settings.sound');
    const nSpan=this.notifications.nextElementSibling; if(nSpan) nSpan.textContent=t('settings.notifications');
    this.sound.checked=this.value.sound_enabled;this.notifications.checked=this.value.notifications_enabled;
    this.sound.disabled=this.notifications.disabled=this.busy;
    // Кнопки «Повторить» здесь НЕТ намеренно (решение владельца 2026-10-31, вариант C):
    // при ошибке ЗАПИСИ она вызывала load() — перечитывала старые значения, галочка
    // молча откатывалась, и мастер думал, что настройка сохранена (а она нет).
    // Повтор — это обычное повторное переключение самого переключателя (save()).
    this.status.textContent=this.busy||this.saving?t('settings.saving'):this.failed?t('settings.error'):'';
    // Звук уведомления: подпись группы, названия и нажатая кнопка.
    const soundLabel=this.host.querySelector('[data-sound-label]'); if(soundLabel) soundLabel.textContent=t('settings.sound_choice');
    const soundNames:Record<ChatSoundId,string>={
      drop:t('settings.sound_drop'),chime:t('settings.sound_chime'),ping:t('settings.sound_ping'),
      knock:t('settings.sound_knock'),triple:t('settings.sound_triple'),alert:t('settings.sound_alert'),
    };
    this.host.querySelectorAll<HTMLButtonElement>('[data-sound-id]').forEach((b)=>{
      const id=normalizeChatSoundId(b.dataset.soundId);
      const span=b.querySelector('span:last-child'); if(span) span.textContent=soundNames[id];
      b.setAttribute('aria-pressed',String(id===this.value.sound_id));
      b.disabled=this.busy;
    });
    // Тема оформления: подписи и нажатая кнопка.
    const label=this.host.querySelector('[data-theme-label]'); if(label) label.textContent=t('settings.theme');
    const labels:Record<string,string>={artel:t('settings.theme_artel'),paper:t('settings.theme_paper'),photon:t('settings.theme_photon'),hud:t('settings.theme_hud')};
    this.host.querySelectorAll<HTMLButtonElement>('[data-theme]').forEach((b)=>{
      const th=b.dataset.theme!;
      const span=b.querySelector('span:last-child'); if(span) span.textContent=labels[th];
      b.setAttribute('aria-pressed',String(th===store.getTheme()));
      b.disabled=this.busy;
    });
  }
}
