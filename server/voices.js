'use strict';
const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const python=path.join(__dirname,'../vendor/python/python.exe');
let cache=null,cacheAt=0;
function edge(request){return new Promise((resolve,reject)=>{const p=spawn(python,[path.join(__dirname,'edge-worker.py')],{windowsHide:true});const chunks=[];let err='';const timer=setTimeout(()=>{p.kill();reject(new Error('在线声音超时，请切换离线声音'));},45000);p.on('error',e=>{clearTimeout(timer);reject(e);});p.stdout.on('data',c=>chunks.push(c));p.stderr.on('data',c=>{err+=c.toString();});p.on('close',code=>{clearTimeout(timer);if(code)reject(new Error('Edge 在线语音暂时不可用，请切换系统声音'));else resolve(Buffer.concat(chunks));});p.stdin.end(JSON.stringify(request));});}
function load(dir){try{return JSON.parse(fs.readFileSync(path.join(dir,'voice-config.json'),'utf8'));}catch{return {};}}
function save(dir,x){const old=load(dir);const c={provider:['azure','openai'].includes(x.provider)?x.provider:'',endpoint:String(x.endpoint||''),region:String(x.region||''),model:String(x.model||'tts-1'),voices:String(x.voices||'alloy,nova,shimmer'),key:x.key?String(x.key):old.key||''};if(c.endpoint && !/^https:\/\//i.test(c.endpoint))throw new Error('语音服务地址必须使用 HTTPS');if(c.region&&!/^[a-z0-9-]+$/.test(c.region))throw new Error('Azure 区域格式无效');fs.writeFileSync(path.join(dir,'voice-config.json'),JSON.stringify(c));return safe(c);}
function safe(c){const {key,...x}=c;return {...x,hasKey:!!key};}
async function list(dir){let voices=[],warning='';try{if(!cache||Date.now()-cacheAt>3600000){cache=JSON.parse((await edge({list:true})).toString('utf8'));cacheAt=Date.now();}voices=cache.map(v=>({voiceURI:'edge:'+v.ShortName,name:'Edge 在线 · '+v.FriendlyName,lang:v.Locale,source:'edge'}));}catch(e){warning=e.message;}
 const c=load(dir);if(c.provider==='azure'&&c.key&&c.region){try{const r=await fetch(`https://${c.region}.tts.speech.microsoft.com/cognitiveservices/voices/list`,{headers:{'Ocp-Apim-Subscription-Key':c.key},signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error();for(const v of await r.json())voices.push({voiceURI:'azure:'+v.ShortName,name:'Azure · '+v.DisplayName,lang:v.Locale,source:'azure'});}catch{warning+=' Azure 配置连接失败';}}
 if(c.provider==='openai'&&c.key&&c.endpoint)for(const name of c.voices.split(',').map(s=>s.trim()).filter(Boolean))voices.push({voiceURI:'openai:'+name,name:'API 在线 · '+name,lang:'zh-CN',source:'openai'});
 try{for(const voice of await require('./tts').listVoices())voices.push({...voice,name:'电脑系统 · '+voice.voiceURI.slice(3)+'（需电脑在线）'});}catch{warning+=' 电脑系统音色列表暂不可用';}
 return {voices,warning};
}
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
async function synthesize(dir,{text,voice,rate=1}){
 if(typeof text!=='string'||!text.trim()||text.length>5000)throw new Error('朗读文本需为 1 至 5000 字');
 const [provider,...parts]=String(voice||'').split(':');const name=parts.join(':');
 if(provider==='pc'){const available=await require('./tts').listVoices();if(!available.some(v=>v.voiceURI===voice))throw new Error('电脑未安装该系统声音');return {buffer:await require('./tts').synthesize(text,rate,name),mime:'audio/wav'};}
 if(provider==='edge'){if(!/^[a-zA-Z0-9-]{3,100}$/.test(name))throw new Error('音色无效');return {buffer:await edge({text,voice:name,rate}),mime:'audio/mpeg'};}
 const c=load(dir);if(!c.key||c.provider!==provider)throw new Error('请先在声音来源中配置该服务');let r;
 if(provider==='azure')r=await fetch(`https://${c.region}.tts.speech.microsoft.com/cognitiveservices/v1`,{method:'POST',headers:{'Ocp-Apim-Subscription-Key':c.key,'Content-Type':'application/ssml+xml','X-Microsoft-OutputFormat':'audio-24khz-48kbitrate-mono-mp3'},body:`<speak version="1.0" xml:lang="zh-CN"><voice name="${esc(name)}"><prosody rate="${Math.round((Number(rate)-1)*100)}%">${esc(text)}</prosody></voice></speak>`,signal:AbortSignal.timeout(45000)});
 else if(provider==='openai')r=await fetch(c.endpoint.replace(/\/$/,'')+'/audio/speech',{method:'POST',headers:{Authorization:'Bearer '+c.key,'Content-Type':'application/json'},body:JSON.stringify({model:c.model,input:text,voice:name,speed:rate,response_format:'mp3'}),signal:AbortSignal.timeout(45000)});
 else throw new Error('未知声音来源');
 if(!r.ok)throw new Error('语音服务返回 '+r.status+'，请检查额度、密钥和音色名称');return {buffer:Buffer.from(await r.arrayBuffer()),mime:'audio/mpeg'};
}
module.exports={list,synthesize,load,save,safe};
