import { communityEscape as esc } from '../community';
import type { PresencePage } from '../community';
import { t } from '../i18n';

/** A stable details element keeps expansion and keyboard focus during polling. */
export class CommunityPresence {
  private page:PresencePage | null=null;
  private preview:PresencePage['users']=[];
  private offset=0;
  private epoch=0;
  private loading=false;
  private failed=false;
  constructor(private host:HTMLElement, private load?: (offset:number)=>Promise<PresencePage>) {
    host.hidden=!load;
    host.innerHTML=`<div class="community-presence-top"><h2></h2><span class="community-online-count" role="status"></span></div>
      <p class="community-online-window"></p><p class="community-online-preview"></p>
      <details><summary></summary><div class="community-online-names"></div><div class="community-paging">
      <button type="button" class="btn btn-secondary" data-online-prev></button><button type="button" class="btn btn-secondary" data-online-next></button></div></details>`;
    this.prev.onclick=()=>{if(!this.loading) {this.offset=Math.max(0,this.offset-50);void this.refresh();}};
    this.next.onclick=()=>{if(!this.loading) {this.offset+=50;void this.refresh();}};
    this.applyLang();
  }
  private get prev():HTMLButtonElement {return this.host.querySelector('[data-online-prev]')!;}
  private get next():HTMLButtonElement {return this.host.querySelector('[data-online-next]')!;}
  async refresh():Promise<void> {
    if(!this.load || this.loading) return;
    const epoch=this.epoch; this.loading=true; this.applyLang();
    try {
      let page=await this.load(this.offset);
      if(epoch!==this.epoch) return;
      // Active users may leave while viewing a later page.
      if(!page.users.length && this.offset>0) {
        this.offset=0; page=await this.load(0);
        if(epoch!==this.epoch) return;
      }
      this.page=page; this.failed=false;
      if(this.offset===0) this.preview=page.users.slice(0,6);
    } catch {if(epoch===this.epoch) this.failed=true;}
    finally {if(epoch===this.epoch) {this.loading=false;this.applyLang();}}
  }
  private names(users:PresencePage['users']):string {
    return users.map(u=>`<span class="community-online-name${u.mine?' mine':''}">${esc(u.name)}${u.mine?` <small>(${esc(t('community.online_you'))})</small>`:''}</span>`).join('');
  }
  applyLang():void {
    this.host.querySelector('h2')!.textContent=t('community.online_title');
    this.host.querySelector('.community-online-window')!.textContent=t('community.online_window');
    this.host.querySelector('.community-online-count')!.textContent=this.failed?t('community.online_error'):
      this.page?t('community.online_count',{n:this.page.total}):t('community.loading');
    this.host.querySelector('.community-online-preview')!.innerHTML=this.failed?'':this.preview.length?this.names(this.preview):
      this.page?esc(t('community.online_empty')):'';
    this.host.querySelector('summary')!.textContent=t('community.online_all');
    this.host.querySelector('details')!.hidden=this.failed || !this.page?.total;
    this.host.querySelector('.community-online-names')!.innerHTML=this.names(this.page?.users??[]);
    this.prev.textContent=t('community.previous');this.next.textContent=t('community.next');
    this.prev.disabled=this.loading || this.offset===0;this.next.disabled=this.loading || !this.page?.has_more;
    this.host.querySelector<HTMLElement>('.community-paging')!.hidden=this.offset===0 && !this.page?.has_more;
  }
  reset():void {
    this.epoch++;this.loading=false;this.failed=false;this.page=null;this.preview=[];this.offset=0;
    this.host.querySelector('details')!.open=false;this.applyLang();
  }
}
