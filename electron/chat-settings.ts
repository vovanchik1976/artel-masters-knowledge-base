import * as fs from 'node:fs';
import * as path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DEFAULT_CHAT_SETTINGS,normalizeChatSoundId,validChatFlags,type ChatSettings} from '../shared/chatSettings';

export class ChatSettingsStore {
  private value:ChatSettings={...DEFAULT_CHAT_SETTINGS};
  constructor(private file:string) {
    try {
      const saved=JSON.parse(fs.readFileSync(file,'utf8'));
      // version 1 — единственная схема: sound_id добавлен аддитивно (shared/chatSettings).
      // Отсутствующий/чужой id = дефолтный звук, флаги мастера при этом сохраняются.
      if(saved?.version===1 && validChatFlags(saved)) {
        const flags=saved as Record<string,unknown>;
        this.value={version:1,sound_enabled:saved.sound_enabled,notifications_enabled:saved.notifications_enabled,sound_id:normalizeChatSoundId(flags.sound_id)};
      }
    } catch { /* A missing or corrupt file has the approved enabled defaults. */ }
  }
  get():ChatSettings {return {...this.value};}
  set(flags:unknown):ChatSettings {
    if(!validChatFlags(flags)) throw new Error('INVALID_ARGUMENT');
    const patch=flags as Record<string,unknown>;
    // Звук, которого НЕТ в аргументах, не сбрасывается: иначе переключение галочки
    // («set({sound_enabled, notifications_enabled})») молча меняло бы озвучку мастера.
    const sound_id='sound_id' in patch?normalizeChatSoundId(patch.sound_id):this.value.sound_id;
    const next:ChatSettings={version:1,sound_enabled:flags.sound_enabled,notifications_enabled:flags.notifications_enabled,sound_id};
    const temporary=`${this.file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file),{recursive:true});
      fs.writeFileSync(temporary,JSON.stringify(next),{encoding:'utf8',mode:0o600});
      fs.renameSync(temporary,this.file);
    } catch {
      try {fs.unlinkSync(temporary);} catch { /* Not created, or already moved. */ }
      throw new Error('SETTINGS_WRITE_FAILED');
    }
    this.value=next;
    return this.get();
  }
}
