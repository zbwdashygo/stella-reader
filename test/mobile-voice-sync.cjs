const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),puppeteer=require('puppeteer-core');
const {start}=require('../server');
let info,browser;
(async()=>{
 info=await start({port:0,dataDir:fs.mkdtempSync(path.join(os.tmpdir(),'stella-voice-ui-'))});
 const base='http://127.0.0.1:'+info.port;
 await fetch(base+'/api/voice-preferences',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ttsVoice:'edge:zh-CN-YunxiNeural',ttsRate:1.25})});
 const lan=await(await fetch(base+'/api/stella/lan',{method:'POST'})).json();const pair=JSON.parse(Buffer.from(lan.addresses[0].code.slice(12),'base64url'));
 browser=await puppeteer.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:'new',pipe:true,args:['--no-sandbox','--no-first-run']});
 const p=await browser.newPage();await p.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
 await p.evaluateOnNewDocument(pair=>{window.AndroidBridge={};localStorage.setItem('stella.lan.v1',JSON.stringify(pair));},pair);
 let imported;await p.setRequestInterception(true);p.on('request',r=>{if(r.url().endsWith('/api/voice-catalog/import')){imported=JSON.parse(r.postData());r.respond({status:200,contentType:'application/json',body:'{"ok":true}'});}else r.continue();});
 await p.goto(base);await p.evaluate(()=>document.querySelector('[data-voice-sources]').click());await p.waitForSelector('#syncDesktopVoices',{visible:true});await p.click('#syncDesktopVoices');
 await p.waitForFunction(()=>document.querySelector('#desktopVoiceSyncStatus').textContent.startsWith('已同步'),{timeout:20000});
 assert(imported.voices.length>=322);const settings=await p.evaluate(()=>JSON.parse(localStorage.getItem('tingshu:settings:v1')));assert.equal(settings.ttsVoice,'edge:zh-CN-YunxiNeural');assert.equal(settings.ttsRate,1.25);assert.equal(await p.$eval('#syncDesktopVoices',n=>n.disabled),false);
 await p.screenshot({path:path.join(__dirname,'shots/stella-mobile-voice-sync.png')});console.log('PASS 手机实际点击一键同步，保存全部电脑音色并应用所选音色与语速');
 await p.reload();const remembered=await p.evaluate(()=>JSON.parse(localStorage.getItem('tingshu:settings:v1')));assert.equal(remembered.ttsVoice,settings.ttsVoice);assert.equal(remembered.ttsRate,1.25);console.log('PASS 重启后音色与语速保留');
 await fetch(base+'/api/stella/lan',{method:'DELETE'});console.log('MOBILE_VOICE_SYNC_PASS');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(info)info.server.close();setTimeout(()=>process.exit(process.exitCode||0),300);});
