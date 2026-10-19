'use strict';
const http = require('http');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
function saved(app){try{return JSON.parse(fs.readFileSync(path.join(app.dataDir,'sync-config.json'),'utf8'));}catch{return {};}}
function persist(app,x){const p=path.join(app.dataDir,'sync-config.json');fs.writeFileSync(p+'.tmp',JSON.stringify(x));fs.renameSync(p+'.tmp',p);}
const sessions = new Map();
function fingerprint(b) {
  if (!b.fingerprint && fs.existsSync(b.path)) b.fingerprint = crypto.createHash('sha256').update(fs.readFileSync(b.path)).digest('hex');
  return b.fingerprint || '';
}
function summary(b) { return { id:b.id, fingerprint:fingerprint(b), title:b.title, author:b.author, spineCount:b.spineCount, progress:b.progress, progressUpdatedAt:b.progressUpdatedAt||0 }; }
function json(res,status,value) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
function body(req) {return new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c;if(s.length>65536){reject(new Error('请求过大'));req.destroy();}});req.on('end',()=>{try{resolve(JSON.parse(s||'{}'));}catch{reject(new Error('JSON 无效'));}});req.on('error',reject);});}
async function enable(app) {
  if (sessions.has(app.dataDir)) return info(app);
  const previous=saved(app);
  const state={token:previous.enabled&&/^[a-f0-9]{48}$/.test(previous.token||'')?previous.token:crypto.randomBytes(24).toString('hex'),server:null,port:0};
  state.server=http.createServer(async(req,res)=>{
    res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
    const token=String(req.headers.authorization||'').replace(/^Bearer /,'');
    if(token.length!==state.token.length || !crypto.timingSafeEqual(Buffer.from(token),Buffer.from(state.token))){json(res,401,{error:'配对已失效，请重新配对'});return;}
    try {
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/voice-sync' && req.method==='GET'){const catalog=await require('./voices').list(app.dataDir);let preferences={ttsVoice:'',ttsRate:1};try{preferences=JSON.parse(fs.readFileSync(path.join(app.dataDir,'voice-preferences.json'),'utf8'));}catch{}if(preferences.ttsVoice&&!catalog.voices.some(v=>v.voiceURI===preferences.ttsVoice)){const words=preferences.ttsVoice.toLowerCase().split(/[^a-z]+/).filter(w=>w.length>3&&!['microsoft','desktop','chinese','english','simplified','united','states'].includes(w));const match=catalog.voices.find(v=>v.voiceURI.startsWith('pc:')&&words.some(w=>v.voiceURI.toLowerCase().includes(w)));preferences.ttsVoice=match?match.voiceURI:'';}json(res,200,{...catalog,preferences});return;}
      if(url.pathname==='/voices' && req.method==='GET'){json(res,200,await require('./voices').list(app.dataDir));return;}
      if(url.pathname==='/tts' && req.method==='POST'){const x=await require('./voices').synthesize(app.dataDir,await body(req));res.writeHead(200,{'Content-Type':x.mime,'Access-Control-Allow-Origin':'*'});res.end(x.buffer);return;}
      if(url.pathname==='/sync' && req.method==='GET'){json(res,200,{books:app.library.list().map(summary)});return;}
      if(url.pathname==='/sync' && req.method==='POST'){
        const p=await body(req);const b=app.library.list().find(b=>fingerprint(b)===p.fingerprint);
        if(!b){json(res,404,{error:'电脑上没有同一本 EPUB'});return;}
        if(!p.progress || !Number.isInteger(p.progress.spineIndex) || p.progress.spineIndex<0 || p.progress.spineIndex>=b.spineCount){json(res,400,{error:'阅读位置无效'});return;}
        const stamp=Number(p.progressUpdatedAt);
        if(!Number.isFinite(stamp)||stamp<=0||stamp>Date.now()+300000){json(res,400,{error:'设备时间不准确，请校准手机时间'});return;}
        if(stamp>(b.progressUpdatedAt||0)) app.library.patch(b.id,{progress:p.progress,progressUpdatedAt:stamp});
        json(res,200,{book:summary(b)});return;
      }
      if(url.pathname.startsWith('/book/')&&req.method==='GET'){
        const b=app.library.get(decodeURIComponent(url.pathname.slice(6)));
        if(!b || !fs.existsSync(b.path)){json(res,404,{error:'原 EPUB 不存在'});return;}
        res.writeHead(200,{'Content-Type':'application/epub+zip','Cache-Control':'no-store'});fs.createReadStream(b.path).pipe(res);return;
      }
      json(res,404,{error:'接口不存在'});
    } catch(e){json(res,400,{error:e.message});}
  });
  await new Promise((resolve,reject)=>{state.server.once('error',reject);state.server.listen(Number(previous.port)||0,'0.0.0.0',resolve);});
  state.port=state.server.address().port;sessions.set(app.dataDir,state);persist(app,{enabled:true,token:state.token,port:state.port});return info(app);
}
function info(app){
  const s=sessions.get(app.dataDir);if(!s)return {enabled:false};
  const ips=Object.values(os.networkInterfaces()).flat().filter(n=>n&&n.family==='IPv4'&&!n.internal&&/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(n.address)).map(n=>n.address);
  return {enabled:true,addresses:ips.map(ip=>({url:`http://${ip}:${s.port}`,code:'STELLA-LAN1.'+Buffer.from(JSON.stringify({url:`http://${ip}:${s.port}`,token:s.token})).toString('base64url')}))};
}
function disable(app){const s=sessions.get(app.dataDir);if(s)s.server.close();sessions.delete(app.dataDir);persist(app,{enabled:false,port:s?s.port:saved(app).port||0});return {enabled:false};}
async function restore(app){if(saved(app).enabled)try{await enable(app);}catch(e){console.error('[stella] Wi-Fi 服务启动失败：'+e.message);}}
module.exports={enable,info,disable,fingerprint,restore};
