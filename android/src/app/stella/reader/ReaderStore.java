package app.stella.reader;
import android.content.Context;
import org.json.*;
import org.w3c.dom.*;
import javax.xml.parsers.*;
import java.io.*;
import java.util.*;
import java.util.zip.*;
import java.security.*;
import java.net.*;
import java.nio.charset.Charset;
import android.util.AtomicFile;

public final class ReaderStore {
 final Context context; final File dir; JSONObject library; final Map<String,JSONObject> metas=new HashMap<>();
 ReaderStore(Context c)throws Exception{context=c;dir=new File(c.getFilesDir(),"library");dir.mkdirs();File f=new File(dir,"library.json");if(f.exists())library=new JSONObject(new String(read(new FileInputStream(f),8*1024*1024),"UTF-8"));else library=new JSONObject().put("version",1).put("books",new JSONArray());}
 static byte[] read(InputStream in,int limit)throws IOException{try(InputStream stream=in;ByteArrayOutputStream out=new ByteArrayOutputStream()){byte[] b=new byte[32768];int n,total=0;while((n=stream.read(b))!=-1){total+=n;if(total>limit)throw new IOException("文件超过大小限制");out.write(b,0,n);}return out.toByteArray();}}
 synchronized void save()throws Exception{AtomicFile af=new AtomicFile(new File(dir,"library.json"));FileOutputStream out=af.startWrite();try{out.write(library.toString().getBytes("UTF-8"));af.finishWrite(out);}catch(Exception e){af.failWrite(out);throw e;}}
 synchronized JSONObject get(String id)throws Exception{JSONArray a=library.getJSONArray("books");for(int i=0;i<a.length();i++){JSONObject b=a.getJSONObject(i);if(b.getString("id").equals(id))return b;}throw new IOException("书籍不存在");}
 synchronized JSONObject list()throws Exception{JSONArray a=library.getJSONArray("books");List<JSONObject> sorted=new ArrayList<>();for(int i=0;i<a.length();i++)sorted.add(a.getJSONObject(i));Collections.sort(sorted,(x,y)->Long.compare(y.optLong("lastReadAt"),x.optLong("lastReadAt")));JSONArray r=new JSONArray();for(JSONObject b:sorted)r.put(b);return new JSONObject().put("books",r);}
 static Document xml(byte[] b)throws Exception{
  String source=html(b);if(source.toUpperCase(Locale.ROOT).contains("<!ENTITY"))throw new IOException("EPUB 元数据包含不支持的自定义实体");
  DocumentBuilderFactory f=DocumentBuilderFactory.newInstance();f.setNamespaceAware(true);f.setValidating(false);
  // Android Harmony only supports namespace and validation features. Its parser does not fetch external DTDs.
  for(String feature:new String[]{"http://xml.org/sax/features/external-general-entities","http://xml.org/sax/features/external-parameter-entities","http://apache.org/xml/features/nonvalidating/load-external-dtd"})try{f.setFeature(feature,false);}catch(ParserConfigurationException unsupported){}
  DocumentBuilder d=f.newDocumentBuilder();d.setEntityResolver((p,system)->new org.xml.sax.InputSource(new StringReader("")));return d.parse(new ByteArrayInputStream(source.getBytes("UTF-8")));
 }
 static List<Element> elements(Node n,String name){List<Element> r=new ArrayList<>();NodeList all=((n instanceof Document)?((Document)n).getElementsByTagNameNS("*",name):((Element)n).getElementsByTagNameNS("*",name));for(int i=0;i<all.getLength();i++)r.add((Element)all.item(i));return r;}
 static String text(Node n,String name,String fallback){List<Element> a=elements(n,name);return a.isEmpty()?fallback:a.get(0).getTextContent().trim();}
 static String resolve(String base,String href)throws Exception{String raw=href.replace(" ","%20");URI u=new URI("http","stella", "/"+base,null).resolve(raw).normalize();if(!"stella".equals(u.getHost()))throw new IOException("不支持外部章节");String p=u.getPath();if(p.startsWith("/"))p=p.substring(1);return p+(u.getFragment()!=null?"#"+u.getFragment():"");}
 static byte[] entry(ZipFile z,String p)throws Exception{ZipEntry e=z.getEntry(p.split("#",2)[0]);if(e==null||e.isDirectory())throw new IOException("EPUB 资源不存在："+p);return read(z.getInputStream(e),24*1024*1024);}
 JSONObject parse(File file,String id)throws Exception{
  try(ZipFile z=new ZipFile(file)){
   if(z.size()>20000)throw new IOException("EPUB 资源数量过多");Document container=xml(entry(z,"META-INF/container.xml"));String opf=elements(container,"rootfile").get(0).getAttribute("full-path");Document doc=xml(entry(z,opf));Map<String,Element> manifest=new HashMap<>();for(Element e:elements(doc,"item"))manifest.put(e.getAttribute("id"),e);
   JSONArray spine=new JSONArray(),toc=new JSONArray();Map<String,String> titles=new HashMap<>();String cover="",nav="",ncx="";
   for(Element e:manifest.values()){String p=resolve(opf,e.getAttribute("href"));if(e.getAttribute("properties").contains("nav"))nav=p;if(e.getAttribute("media-type").contains("ncx"))ncx=p;if(e.getAttribute("properties").contains("cover-image"))cover=p;}
   for(Element e:elements(doc,"meta"))if(e.getAttribute("name").equals("cover")){Element item=manifest.get(e.getAttribute("content"));if(item!=null)cover=resolve(opf,item.getAttribute("href"));}
   if(!nav.isEmpty())try{Document n=xml(entry(z,nav));Element root=n.getDocumentElement();for(Element section:elements(n,"nav"))if(section.getAttribute("epub:type").contains("toc")||section.getAttributeNS("http://www.idpf.org/2007/ops","type").contains("toc")){root=section;break;}for(Element a:elements(root,"a")){String href=a.getAttribute("href");if(href.isEmpty())continue;String p=resolve(nav,href);String t=a.getTextContent().trim();int depth=-1;for(Node parent=a.getParentNode();parent!=null&&parent!=root;parent=parent.getParentNode())if("ol".equals(parent.getLocalName()))depth++;toc.put(new JSONObject().put("title",t).put("path",p).put("depth",Math.max(0,depth)));titles.put(p.split("#",2)[0],t);}}catch(Exception ignored){}
   if(toc.length()==0&&!ncx.isEmpty())try{Document n=xml(entry(z,ncx));for(Element point:elements(n,"navPoint")){String t="",href="";for(Node child=point.getFirstChild();child!=null;child=child.getNextSibling())if(child instanceof Element){if("navLabel".equals(child.getLocalName()))t=child.getTextContent().trim();if("content".equals(child.getLocalName()))href=((Element)child).getAttribute("src");}if(href.isEmpty())continue;String p=resolve(ncx,href);int depth=0;for(Node parent=point.getParentNode();parent!=null;parent=parent.getParentNode())if("navPoint".equals(parent.getLocalName()))depth++;toc.put(new JSONObject().put("title",t).put("path",p).put("depth",depth));titles.put(p.split("#",2)[0],t);}}catch(Exception ignored){}
   for(Element ref:elements(doc,"itemref")){Element item=manifest.get(ref.getAttribute("idref"));if(item==null)continue;String p=resolve(opf,item.getAttribute("href"));spine.put(new JSONObject().put("path",p).put("title",titles.containsKey(p)?titles.get(p):"第 "+(spine.length()+1)+" 章"));}
   if(spine.length()==0)throw new IOException("这本 EPUB 没有可读章节");
   return new JSONObject().put("title",text(doc,"title","未命名书籍")).put("author",text(doc,"creator","未知作者")).put("spine",spine).put("toc",toc).put("coverHref",cover);
  }
 }
 synchronized JSONObject importStream(InputStream in)throws Exception{
  File tmp=File.createTempFile("import-",".epub",dir);try{MessageDigest hash=MessageDigest.getInstance("SHA-256");try(InputStream stream=in;OutputStream out=new FileOutputStream(tmp)){byte[] buf=new byte[32768];int n,total=0;while((n=stream.read(buf))!=-1){total+=n;if(total>128*1024*1024)throw new IOException("EPUB 最大支持 128 MB");hash.update(buf,0,n);out.write(buf,0,n);}}
   StringBuilder hex=new StringBuilder();for(byte b:hash.digest())hex.append(String.format("%02x",b&255));String fingerprint=hex.toString(),id=fingerprint.substring(0,16);JSONArray a=library.getJSONArray("books");for(int i=0;i<a.length();i++)if(a.getJSONObject(i).getString("fingerprint").equals(fingerprint))return a.getJSONObject(i);
   JSONObject m=parse(tmp,id);File dest=new File(dir,id+".epub");if(!tmp.renameTo(dest))throw new IOException("无法保存 EPUB");long now=System.currentTimeMillis();JSONObject b=new JSONObject().put("id",id).put("fingerprint",fingerprint).put("path",dest.getAbsolutePath()).put("title",m.getString("title")).put("author",m.getString("author")).put("spineCount",m.getJSONArray("spine").length()).put("addedAt",now).put("lastReadAt",now).put("progressUpdatedAt",0).put("progress",new JSONObject().put("spineIndex",0).put("scrollRatio",0).put("percent",0).put("chapterTitle",""));if(!m.getString("coverHref").isEmpty())b.put("cover","/api/books/"+id+"/cover");a.put(b);metas.put(id,m);save();return b;
  }finally{tmp.delete();}
 }
 synchronized JSONObject meta(String id)throws Exception{if(!metas.containsKey(id))metas.put(id,parse(new File(get(id).getString("path")),id));return metas.get(id);}
 synchronized JSONObject request(String method,String path,JSONObject data)throws Exception{
  String[] p=path.split("\\?")[0].split("/");
  if(path.startsWith("/api/health"))return new JSONObject().put("ok",true).put("platform","android").put("version","2.0.0");
  if(path.equals("/api/books"))return list();
  if(path.equals("/api/books/import-bytes"))return new JSONObject().put("book",importStream(new ByteArrayInputStream(android.util.Base64.decode(data.getString("dataBase64"),android.util.Base64.DEFAULT))));
  if(p.length<4)throw new IOException("接口不存在");String id=p[3];JSONObject b=get(id);
  if(p.length==5&&p[4].equals("search")){String q="";for(String kv:path.substring(path.indexOf('?')+1).split("&"))if(kv.startsWith("q="))q=URLDecoder.decode(kv.substring(2),"UTF-8");JSONArray result=new JSONArray();JSONArray spine=meta(id).getJSONArray("spine");if(!q.trim().isEmpty())try(ZipFile z=new ZipFile(b.getString("path"))){for(int i=0;i<spine.length()&&result.length()<50;i++){JSONObject c=spine.getJSONObject(i);String text=html(entry(z,c.getString("path"))).replaceAll("(?is)<(script|style).*?</\\1>"," ").replaceAll("<[^>]+>"," ").replaceAll("\\s+"," ");int from=0,index;while((index=text.toLowerCase(Locale.ROOT).indexOf(q.toLowerCase(Locale.ROOT),from))>=0&&result.length()<50){result.put(new JSONObject().put("spineIndex",i).put("chapterTitle",c.getString("title")).put("snippet",text.substring(Math.max(0,index-40),Math.min(text.length(),index+q.length()+80))));from=index+q.length();}}}return new JSONObject().put("results",result);}
  if(method.equals("PATCH")){if(data.has("progress")){JSONObject pg=data.getJSONObject("progress");int index=pg.optInt("spineIndex",-1);if(index<0||index>=b.getInt("spineCount"))throw new IOException("阅读位置无效");b.put("progress",pg).put("progressUpdatedAt",data.optLong("progressUpdatedAt",System.currentTimeMillis()));}b.put("lastReadAt",data.optLong("lastReadAt",System.currentTimeMillis()));save();return new JSONObject().put("book",b);}
  if(method.equals("DELETE")){JSONArray a=library.getJSONArray("books");for(int i=0;i<a.length();i++)if(a.getJSONObject(i).getString("id").equals(id)){a.remove(i);break;}save();metas.remove(id);new File(dir,id+".epub").delete();return new JSONObject().put("ok",true);}
  JSONObject m=meta(id);return new JSONObject().put("book",b).put("spine",m.getJSONArray("spine")).put("toc",m.getJSONArray("toc"));
 }
 static String html(byte[] b)throws Exception{String head=new String(b,0,Math.min(b.length,300),"ISO-8859-1");java.util.regex.Matcher m=java.util.regex.Pattern.compile("(?i)(?:encoding|charset)\\s*=\\s*[\"']?([a-zA-Z0-9_-]+)").matcher(head);String enc=m.find()?m.group(1):"UTF-8";if(!Charset.isSupported(enc))enc="UTF-8";String s=new String(b,enc);if(s.contains("\uFFFD")&&enc.equalsIgnoreCase("UTF-8"))s=new String(b,"GB18030");return s.replaceFirst("(?i)encoding\\s*=\\s*[\"'][^\"']+[\"']","encoding=\"UTF-8\"");}
 synchronized byte[] resource(String id,String p)throws Exception{JSONObject b=get(id);if(p==null)p=meta(id).getString("coverHref");if(p.isEmpty()||p.contains("..")||p.startsWith("/"))throw new IOException("资源路径无效");try(ZipFile z=new ZipFile(b.getString("path"))){byte[] buf=entry(z,p);if(p.matches("(?i).*\\.(xhtml|html|htm|xml|css)$"))return html(buf).getBytes("UTF-8");return buf;}}
}
