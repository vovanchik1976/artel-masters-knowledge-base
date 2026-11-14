import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {ChatSettingsStore} from '../electron/chat-settings';
import {CHAT_SOUND_IDS,DEFAULT_CHAT_SOUND_ID} from '../shared/chatSettings';

const DEFAULTS={version:1,sound_enabled:true,notifications_enabled:true,sound_id:'drop'} as const;

test('chat settings: enabled defaults, independent switches and persistence without touching beacon',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-settings-'));
 try {
  const file=path.join(dir,'chat-settings.json'); const beacon=path.join(dir,'config.json');
  fs.writeFileSync(beacon,'beacon');
  const store=new ChatSettingsStore(file);
  assert.deepEqual(store.get(),{...DEFAULTS});
  for(const sound_enabled of [false,true]) for(const notifications_enabled of [false,true]) {
   store.set({sound_enabled,notifications_enabled});
   assert.deepEqual(new ChatSettingsStore(file).get(),{...DEFAULTS,sound_enabled,notifications_enabled});
  }
  assert.equal(fs.readFileSync(beacon,'utf8'),'beacon');
  fs.writeFileSync(file,'bad json'); assert.equal(new ChatSettingsStore(file).get().sound_enabled,true);
  fs.writeFileSync(file,JSON.stringify({version:7,sound_enabled:false,notifications_enabled:false}));
  assert.equal(new ChatSettingsStore(file).get().notifications_enabled,true);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('chat settings: invalid flags and write failures cannot change active preferences',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-settings-'));
 try {
  const file=path.join(dir,'settings'); const store=new ChatSettingsStore(file);
  assert.throws(()=>store.set({sound_enabled:'false',notifications_enabled:true}),/INVALID_ARGUMENT/);
  store.set({sound_enabled:true,notifications_enabled:true,sound_id:'chime'});
  // Ломаем запись: на месте файла — каталог (rename в него не пройдёт).
  fs.unlinkSync(file); fs.mkdirSync(file);
  assert.throws(()=>store.set({sound_enabled:false,notifications_enabled:false,sound_id:'alert'}),/SETTINGS_WRITE_FAILED/);
  assert.deepEqual(store.get(),{...DEFAULTS,sound_id:'chime'});
  assert.deepEqual(fs.readdirSync(dir),['settings']);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('chat settings: chosen sound survives restart, a broken or foreign id never leaves the master without a signal',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-settings-'));
 try {
  const file=path.join(dir,'chat-settings.json');
  const store=new ChatSettingsStore(file);
  for(const sound_id of CHAT_SOUND_IDS) {
   store.set({sound_enabled:true,notifications_enabled:true,sound_id});
   assert.equal(new ChatSettingsStore(file).get().sound_id,sound_id);
  }
  // Чужой id в файле: звук уходит в дефолт, но флаги мастера НЕ теряются.
  fs.writeFileSync(file,JSON.stringify({version:1,sound_enabled:false,notifications_enabled:false,sound_id:'bogus'}));
  assert.deepEqual(new ChatSettingsStore(file).get(),{version:1,sound_enabled:false,notifications_enabled:false,sound_id:DEFAULT_CHAT_SOUND_ID});
  // Старый файл (схема без sound_id): флаги сохраняются, звук = дефолт.
  fs.writeFileSync(file,JSON.stringify({version:1,sound_enabled:false,notifications_enabled:true}));
  assert.deepEqual(new ChatSettingsStore(file).get(),{version:1,sound_enabled:false,notifications_enabled:true,sound_id:DEFAULT_CHAT_SOUND_ID});
  // Вызов без sound_id НЕ сбрасывает выбор: иначе переключение галочки молча меняло бы озвучку.
  store.set({sound_enabled:true,notifications_enabled:true,sound_id:'knock'});
  assert.equal(store.set({sound_enabled:false,notifications_enabled:true}).sound_id,'knock');
  assert.equal(new ChatSettingsStore(file).get().sound_id,'knock');
  // Мусор вместо id (число/объект) — не исключение: сигнал обязан звучать.
  assert.equal(store.set({sound_enabled:true,notifications_enabled:true,sound_id:42}).sound_id,DEFAULT_CHAT_SOUND_ID);
  assert.equal(store.set({sound_enabled:true,notifications_enabled:true,sound_id:{x:1}}).sound_id,DEFAULT_CHAT_SOUND_ID);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

