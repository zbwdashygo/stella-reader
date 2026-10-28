import {api} from './api.js';
import {toast, fileToBase64} from './util.js';
const KEY='stella.lan.v1';
function timeoutSignal(ms){const controller=new AbortController();setTimeout(()=>controller.abort(),ms);return controller.signal;}
function b64(s){return btoa(Array.from(new TextEncoder().encode(s),b=>String.fromCharCode(b)).join('')).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function un64(s){s=s.replace(/-/g,'+').replace(/_/g,'/');return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(s),c=>c.charCodeAt(0)));}
function checksum(s){let n=2166136261;for(const c of new TextEncoder().encode(s)){n^=c;n=Math.imul(n,16777619);}return (n>>>0).toString(16).padStart(8,'0');}
export function encodeProgress(book,progress){const s=b64(JSON.stringify({v:1,f:book.fingerprint,t:book.title,p:progress}));return `STELLA1.${s}.${checksum(s)}`;}
export function decodeProgress(raw){
 const match=String(raw).trim().match(/^STELLA1\.([A-Za-z0-9_-]{1,8000})\.([a-f0-9]{8})$/);
 if(!match||checksum(match[1])!==match[2])throw new Error('进度码不完整或校验失败，请重新复制');
 const x=JSON.parse(un64(match[1]));
 if(x.v!==1||!/^\w{64}$/.test(x.f)||!x.p||!Number.isInteger(x.p.spineIndex)||x.p.spineIndex<0||!Number.isFinite(x.p.scrollRatio)||x.p.scrollRatio<0||x.p.scrollRatio>1)throw new Error('进度码版本或位置无效');
 return x;
}
export function setupStella({reader,library,tts}){
 const $=id=>document.getElementById(id);let pairing=null,busy=false,lastState='',pairGeneration=0;
 try{pairing=JSON.parse(localStorage.getItem(KEY));}catch{}
 const panel=$('stellaPanel'),status=$('syncStatus');
 const report=s=>{status.textContent=s;lastState=s;};
 function open(){panel.showModal();if(window.AndroidBridge){$('lanHost').hidden=true;}else showHost();}
 document.querySelectorAll('[data-stella]').forEach(b=>b.onclick=open);
 document.querySelectorAll('[data-stella-library]').forEach(b=>b.onclick=()=>{open();$('stellaBookSync').scrollIntoView({block:'start'});if(pairing)refreshRemote();});
 $('closeStella').onclick=()=>panel.close();
 panel.addEventListener('click',e=>{if(e.target===panel)panel.close();});
 async function copy(s){try{await navigator.clipboard.writeText(s);toast('已复制，可通过 Stella/QQ 发送','success');}catch{toast('请长按或选中上方代码复制','info');}}
 $('exportProgress').onclick=async()=>{
  if(!reader.isOpen()){report('请先打开要同步的书，再生成进度码');return;}
  await reader.saveProgress();const b=reader.getBook();
  if(!b.fingerprint){report('这本书缺少原始 EPUB，无法生成可靠进度码');return;}
  $('progressCode').value=encodeProgress(b,reader.getProgress());report(`已生成《${b.title}》进度码`);await copy($('progressCode').value);
 };
 $('copyProgress').onclick=()=>copy($('progressCode').value);
 $('applyProgress').onclick=async()=>{try{
  const x=decodeProgress($('progressCode').value);const books=(await api.listBooks()).books;const b=books.find(b=>b.fingerprint===x.f);
  if(!b)throw new Error(`请先导入同一份《${x.t||'书籍'}》EPUB；进度码不包含小说内容`);
  if(x.p.spineIndex>=b.spineCount)throw new Error('本机 EPUB 章节与进度码不一致，请导入同一版本');
  await reader.saveProgress();await api.updateBook(b.id,{progress:x.p,progressUpdatedAt:Date.now()});
  await reader.applyRemote(b.id);await library.refresh({quiet:true});panel.close();toast('已定位到进度码对应段落','success');
 }catch(e){report(e.message);}};
 async function host(method='GET'){const r=await fetch('/api/stella/lan',{method});if(!r.ok)throw new Error('局域网服务启动失败');return r.json();}
 async function showHost(method){try{const x=await host(method);$('lanHostCode').value=x.enabled?(x.addresses||[]).map(x=>x.code).join('\n'):'';$('lanHostStatus').textContent=x.enabled?(x.addresses.length?'已开启 · 手机粘贴下方配对码（如有多个，逐个尝试）':'未发现局域网地址，请先连接 Wi-Fi'):'尚未开启';}catch(e){report(e.message);}}
 $('enableLan').onclick=()=>showHost('POST');$('disableLan').onclick=()=>showHost('DELETE');$('copyPair').onclick=()=>copy($('lanHostCode').value.split('\n')[0]);
 function parsePair(raw){if(raw.length>5000||!raw.startsWith('STELLA-LAN1.'))throw new Error('请粘贴电脑端生成的 Wi-Fi 配对码');const p=JSON.parse(un64(raw.slice(12)));const u=new URL(p.url);if(u.protocol!=='http:'||!/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)||! /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname)||!/^\d{1,5}$/.test(u.port)||! /^[a-f0-9]{48}$/.test(p.token))throw new Error('配对码不是受支持的局域网地址');return p;}
 async function remote(route,opts={},p=pairing){
  if(!p)throw new Error('请先配对电脑');const {timeoutMs,signal,...request}=opts;const controller=new AbortController();let timer;const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};const abort=()=>{controller.abort();cleanup();};signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,timeoutMs||(route==='/tts'?60000:15000));if(signal?.aborted)abort();
  try{const r=await fetch(p.url+route,{...request,headers:{Authorization:'Bearer '+p.token,'Content-Type':'application/json',...request.headers},signal:controller.signal});if(!r.ok)throw new Error(r.status===401?'配对已失效，请在电脑重新生成配对码':'电脑连接失败（'+r.status+'）');return r;}catch(error){cleanup();throw error;}
 }
 $('pairLan').onclick=async()=>{try{const p=parsePair($('lanPairCode').value.trim());await remote('/sync',{},p);pairing=p;pairGeneration++;localStorage.setItem(KEY,JSON.stringify(p));report('已配对 · 正在同步');await sync();await refreshRemote();window.dispatchEvent(new Event('stella-voices-refresh'));}catch(e){report(e.message+'；请确认两端同一 Wi-Fi，且电脑已允许本程序通过私人网络防火墙');}};
 $('unpairLan').onclick=()=>{pairing=null;pairGeneration++;localStorage.removeItem(KEY);$('remoteBooks').replaceChildren();report('已断开配对，本机书库保留');};
 $('syncNow').onclick=()=>sync(true);
 let remoteBooks=[];const downloadErrors=new Map();
 window.addEventListener('stella-download-error',e=>downloadErrors.set(e.detail?.id,e.detail?.message||'手机导入失败'));
 async function refreshRemote(){try{const x=await (await remote('/sync')).json();remoteBooks=x.books;const local=(await api.listBooks()).books;const select=$('remoteBooks'),list=$('remoteBookList');select.replaceChildren();list.replaceChildren();let missing=0;for(const b of x.books){const present=local.some(l=>l.fingerprint===b.fingerprint);if(!present)missing++;const opt=document.createElement('option');opt.value=b.id;opt.textContent=b.title+(present?' · 已在本机':'');select.append(opt);const row=document.createElement('div');row.className='remote-book-row';const title=document.createElement('span');title.textContent=b.title;const badge=document.createElement('small');badge.textContent=present?'已在本机':'待下载';row.append(title,badge);list.append(row);}$('bookDownloadStatus').textContent='电脑 '+x.books.length+' 本 · 本机缺少 '+missing+' 本';$('downloadMissing').disabled=!missing;}catch(e){report(e.message);}}
 $('refreshRemote').onclick=refreshRemote;
 async function downloadOne(book){
   if(window.AndroidBridge){
     downloadErrors.delete(book.id);window.AndroidBridge.downloadBook(pairing.url,pairing.token,book.id);
     for(let i=0;i<120;i++){await new Promise(r=>setTimeout(r,750));if(downloadErrors.has(book.id))throw new Error(downloadErrors.get(book.id));const books=(await api.listBooks()).books;if(books.some(b=>b.fingerprint===book.fingerprint))return;}
     throw new Error('下载未完成，请检查电脑连接后重试；已下载的书籍会保留');
   }
   const r=await remote('/book/'+encodeURIComponent(book.id));const blob=await r.blob();if(blob.size>128*1024*1024)throw new Error('文件超过 128 MB，请在手机本地导入');await api.importByBytes(book.title+'.epub',await fileToBase64(new File([blob],'book.epub')));
 }
 async function downloadBooks(all){if(busy)return;busy=true;$('downloadMissing').disabled=true;$('downloadRemote').disabled=true;let completed=0;try{
  if(!pairing)throw new Error('请先粘贴配对码连接电脑');
  remoteBooks=(await(await remote('/sync')).json()).books;const local=(await api.listBooks()).books;
  const selected=all?remoteBooks.filter(b=>!local.some(l=>l.fingerprint===b.fingerprint)):remoteBooks.filter(b=>b.id===$('remoteBooks').value);
  if(!selected.length){report(all?'本机已经有电脑上的全部小说':'请先选择一本小说');return;}
  for(const book of selected){const text='正在下载 '+(completed+1)+'/'+selected.length+' · '+book.title;$('bookDownloadStatus').textContent=text;report(text);await downloadOne(book);completed++;await library.refresh({quiet:true});}
  report('小说同步完成 · 已下载 '+completed+' 本，可离线阅读。电脑原书保留。');
 }catch(e){report('已完成 '+completed+' 本 · '+e.message);}finally{busy=false;$('downloadMissing').disabled=false;$('downloadRemote').disabled=false;await refreshRemote();await sync();}}
 $('downloadRemote').onclick=()=>downloadBooks(false);$('downloadMissing').onclick=()=>downloadBooks(true);
 async function sync(manual=false){if(!pairing||busy||document.visibilityState==='hidden')return;busy=true;const generation=pairGeneration;
  try{
   if(reader.isOpen())await reader.saveProgress();
   const peers=(await (await remote('/sync')).json()).books;const local=(await api.listBooks()).books;let n=0;
   for(const b of local){if(generation!==pairGeneration)break;const p=peers.find(p=>p.fingerprint&&p.fingerprint===b.fingerprint);if(!p)continue;
    if((b.progressUpdatedAt||0)>(p.progressUpdatedAt||0)){const x=await(await remote('/sync',{method:'POST',body:JSON.stringify({fingerprint:b.fingerprint,progress:b.progress,progressUpdatedAt:b.progressUpdatedAt})})).json();if(x.book.progressUpdatedAt!==b.progressUpdatedAt)continue;n++;}
    else if((p.progressUpdatedAt||0)>(b.progressUpdatedAt||0)){
     // 若等待网络期间本机又翻页，保留本机的新操作，下轮再同步。
     const latest=(await api.getBook(b.id)).book;if(latest.progressUpdatedAt!==b.progressUpdatedAt)continue;
     await api.updateBook(b.id,{progress:p.progress,progressUpdatedAt:p.progressUpdatedAt});
     if(reader.isOpen()&&reader.getBook()?.id===b.id)await reader.applyRemote(b.id);n++;
    }
   }
   if(n)await library.refresh({quiet:true});report('Wi-Fi 已连接 · 进度已同步'+(n?`（${n} 本）`:''));
  }catch(e){report('暂时无法连接电脑 · 本机进度已保留'+(manual?' · '+e.message:''));}finally{busy=false;}
 }
 // 桌面打开的书也会收到手机修改，不依赖桌面配对自身。
 async function desktopPull(){if(window.AndroidBridge||!reader.isOpen()||busy||reader.isDirty())return;const b=reader.getBook();try{const x=(await api.getBook(b.id)).book;if((x.progressUpdatedAt||0)>(b.progressUpdatedAt||0))await reader.applyRemote(b.id);}catch{}}
 setInterval(()=>{sync();desktopPull();},5000);window.addEventListener('online',()=>sync());window.addEventListener('focus',()=>sync());
 if(pairing)report('已保存配对 · 连接电脑后自动同步');else report('本机离线阅读可用 · 进度码可随时互通');
 window.stellaRemote=remote;
 window.addEventListener('stella-imported',async e=>{await library.refresh({quiet:true});if(e.detail?.id&&!busy)await reader.open(e.detail.id);});
 window.addEventListener('stella-library-downloaded',async()=>{await library.refresh({quiet:true});});
 window.addEventListener('stella-back',()=>{if(panel.open){panel.close();return;}if(reader.isOpen()){reader.close();return;}window.AndroidBridge?.background();});
 return {sync};
}
