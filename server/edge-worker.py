import sys,pathlib,json,asyncio
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent.parent/'vendor'/'pydeps'))
import edge_tts
async def main():
 request=json.loads(sys.stdin.buffer.read().decode('utf-8'))
 if request.get('list'):
  print(json.dumps(await edge_tts.list_voices(),ensure_ascii=True));return
 voice=request.get('voice','zh-CN-XiaoxiaoNeural')
 rate=f"{round((float(request.get('rate',1))-1)*100):+d}%"
 tts=edge_tts.Communicate(request['text'],voice,rate=rate)
 async for chunk in tts.stream():
  if chunk['type']=='audio':sys.stdout.buffer.write(chunk['data'])
asyncio.run(main())
