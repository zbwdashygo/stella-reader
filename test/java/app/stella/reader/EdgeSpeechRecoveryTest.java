package app.stella.reader;
import java.io.*;
import javax.net.ssl.SSLHandshakeException;

public class EdgeSpeechRecoveryTest {
 static void require(boolean value,String message){if(!value)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception{
  byte[] audio=new byte[2048];int[] calls={0};
  EdgeSpeech recovered=new EdgeSpeech(null,(text,voice,rate,deadline)->{calls[0]++;if(calls[0]==1)throw new IOException("temporary disconnect");require(rate==2,"rate must be bounded");return audio;});
  require(recovered.synthesize("恢复测试","edge:zh-CN-XiaoxiaoNeural",3)==audio&&calls[0]==2,"transient network failure must recover");
  System.out.println("PASS transient connection failure retries successfully");
  calls[0]=0;EdgeSpeech clock=new EdgeSpeech(null,(text,voice,rate,deadline)->{if(calls[0]++==0)throw new EdgeSpeech.HandshakeFailure(403,"Wed, 28 Oct 2026 00:00:00 GMT");return audio;});
  require(clock.synthesize("时钟校正","zh-CN-YunxiNeural",1)==audio&&calls[0]==2,"403 recovery");System.out.println("PASS service clock rejection retries after adjustment");
  calls[0]=0;EdgeSpeech down=new EdgeSpeech(null,(text,voice,rate,deadline)->{calls[0]++;throw new IOException("offline");});
  try{down.synthesize("断网","zh-CN-XiaoxiaoNeural",1);throw new AssertionError("expected failure");}catch(IOException expected){require(calls[0]==3&&expected.getCause()!=null,"retry must be bounded and retain cause");}
  System.out.println("PASS persistent failure stops after bounded retries");
  calls[0]=0;EdgeSpeech tls=new EdgeSpeech(null,(text,voice,rate,deadline)->{calls[0]++;throw new SSLHandshakeException("certificate mismatch");});
  try{tls.synthesize("证书校验","zh-CN-XiaoxiaoNeural",1);throw new AssertionError("expected TLS failure");}catch(IOException expected){require(calls[0]==1&&expected.getCause() instanceof SSLHandshakeException,"TLS certificate failure must not be bypassed");}
  System.out.println("PASS certificate validation remains enforced");
  calls[0]=0;EdgeSpeech invalid=new EdgeSpeech(null,(text,voice,rate,deadline)->{calls[0]++;throw new EdgeSpeech.HandshakeFailure(400,null);});
  try{invalid.synthesize("无效请求","zh-CN-XiaoxiaoNeural",1);throw new AssertionError("expected bad request");}catch(IOException expected){require(calls[0]==1,"invalid request must not retry");}
  System.out.println("PASS invalid request fails immediately");
  try{EdgeSpeech.remaining(System.nanoTime()-1,8000);throw new AssertionError("deadline must expire");}catch(java.net.SocketTimeoutException expected){}
  System.out.println("EDGE_RECOVERY_PASS 6");
 }
}
