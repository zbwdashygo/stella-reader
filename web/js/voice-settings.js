import {updateSettings} from './settings.js';
import {toast} from './util.js';
export function setupVoiceSettings(){
 const $=id=>document.getElementById(id),dialog=$('voiceSources');
 document.querySelectorAll('[data-voice-sources]').forEach(b=>b.onclick=async()=>{
  dialog.showModal();$('desktopCloud').hidden=!!window.AndroidBridge;$('androidVoiceHelp').hidden=!window.AndroidBridge;
  if(!window.AndroidBridge){try{const x=await(await fetch('/api/voice-config')).json();for(const k of ['provider','endpoint','region','model','voices'])$('cloud-'+k).value=x[k]||'';$('cloud-key').placeholder=x.hasKey?'密钥已保存；留空保留':'服务密钥';}catch{}}
 });
 $('syncDesktopVoices').onclick=async()=>{const button=$('syncDesktopVoices'),status=$('desktopVoiceSyncStatus');button.disabled=true;status.textContent='正在同步电脑音色与朗读设置…';try{if(!window.stellaRemote)throw new Error('请先在同步小说中连接电脑');const response=await window.stellaRemote('/voice-sync');const catalog=await response.json();const saved=await fetch('/api/voice-catalog/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({voices:catalog.voices||[]})});if(!saved.ok)throw new Error('音色保存失败，请更新手机到最新版本');const voice=catalog.preferences?.ttsVoice||'';if(voice&&(catalog.voices||[]).some(v=>v.voiceURI===voice))updateSettings({ttsVoice:voice,ttsRate:catalog.preferences.ttsRate||1});else updateSettings({ttsRate:catalog.preferences?.ttsRate||1});window.dispatchEvent(new Event('stella-voices-refresh'));status.textContent='已同步 '+(catalog.voices||[]).length+' 个电脑音色与语速。Edge 音色可在手机独立联网使用；电脑系统及私有服务声音需电脑在线。';toast('电脑音色已同步到手机','success');}catch(e){status.textContent=e.message+'；请先在「同步小说」连接电脑。';}finally{button.disabled=false;}};
 $('closeVoiceSources').onclick=()=>dialog.close();
 $('androidVoiceSettings').onclick=()=>window.AndroidBridge?.voiceSettings();
 $('refreshVoices').onclick=()=>{window.dispatchEvent(new CustomEvent('stella-voices-refresh',{detail:{force:true}}));$('voiceSourceStatus').textContent='正在获取可用声音…';};
 window.addEventListener('stella-voices-status',e=>{$('voiceSourceStatus').textContent=`已发现 ${e.detail.count} 个声音${e.detail.directOnlineCount?'，其中 '+e.detail.directOnlineCount+' 个手机在线音色':''}。${e.detail.warning||''}`;});
 $('saveCloud').onclick=async()=>{try{const x={};for(const k of ['provider','endpoint','region','model','voices','key'])x[k]=$('cloud-'+k).value;const r=await fetch('/api/voice-config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(x)});if(!r.ok)throw new Error('配置保存失败，请检查地址和区域');$('cloud-key').value='';toast('声音配置已保存','success');window.dispatchEvent(new Event('stella-voices-refresh'));}catch(e){toast(e.message,'error');}};
}
