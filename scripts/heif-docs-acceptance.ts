// Tests real HEIF derivatives in a NEW Google Doc, never the live journal/Doc.
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import assert from "node:assert/strict";
import {serviceDb,decrypt,DOCUMENT_ID} from "../lib/docs/server.ts";
import {Google,exchangeToken} from "../lib/docs/google.ts";
import {prepareDocsImage} from "../lib/docs/image.ts";
import {photoDisplayKey} from "../lib/photos.ts";
import {planDocument,finishBaselines,inspectDocument,documentModel} from "../lib/docs/merge.ts";
import type {Baseline} from "../lib/docs/types.ts";
import type {Row} from "../lib/journal.ts";

const credentials=JSON.parse(await readFile(".credentials/google.json","utf8"));
Object.assign(process.env,{NEXT_PUBLIC_SUPABASE_URL:"https://rnilakqmyanujehtqbuk.supabase.co",GOOGLE_CLIENT_ID:credentials.clientId,GOOGLE_CLIENT_SECRET:credentials.clientSecret,GOOGLE_PROJECT_NUMBER:String(credentials.projectNumber),GOOGLE_PICKER_API_KEY:credentials.pickerApiKey});
for(const key of ["SUPABASE_SERVICE_ROLE_KEY","DOCS_TOKEN_ENCRYPTION_KEY"])process.env[key]=(await readFile(".credentials/"+key,"utf8")).trim();
const db=serviceDb(),connection=(await db.from("docs_connections").select("refresh_token_encrypted,id").single()).data;
if(!connection)throw Error("Saved connection missing.");
const token=await exchangeToken({grant_type:"refresh_token",refresh_token:decrypt(connection.refresh_token_encrypted)});
const google=new Google(token.access_token),original=await google.read(DOCUMENT_ID);
const temporary=await(await google.request("drive","/files",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"Moments TEMPORARY HEIC acceptance "+randomUUID(),mimeType:"application/vnd.google-apps.document"})})).json();
if(!temporary.id||temporary.id===DOCUMENT_ID)throw Error("Temporary identity not verified.");
const target=temporary.id,managed=randomUUID(),originalKey="heif-tests/"+randomUUID()+".heic",previewKey=photoDisplayKey(originalKey),imageKey="heif-tests/"+randomUUID()+".png";
async function write(revision:string,requests:any[]){
  if(target===DOCUMENT_ID||target!==temporary.id)throw Error("Real-document write forbidden.");
  return google.write(target,revision,requests);
}
async function pdfBytes() {
  // Genuine photos can exceed files.export's 10 MB limit. This read-only LRO
  // uses the same narrow drive.file grant and never prints its download URI.
  let operation=await(await google.request("drive",`/files/${target}/download?mimeType=application%2Fpdf`,{method:"POST"})).json();
  for(let i=0;!operation.done&&i<5;i++){
    await new Promise(resolve=>setTimeout(resolve,10000));
    operation=await(await google.request("drive","/"+operation.name.replace(/^\//,""))).json();
  }
  if(!operation.done||operation.error||!operation.response?.downloadUri)throw Error("Temporary PDF download did not complete.");
  let url=operation.response.downloadUri;
  for(let i=0;i<6;i++){
    const host=new URL(url).hostname;
    if(!["docs.google.com","drive.google.com","www.googleapis.com"].includes(host)&&!host.endsWith(".googleusercontent.com"))throw Error("Unexpected Google download host.");
    const headers:Record<string,string>={Authorization:"Bearer "+token.access_token};
    if(operation.metadata?.resourceKey)headers["X-Goog-Drive-Resource-Keys"]=target+"/"+operation.metadata.resourceKey;
    const response=await fetch(url,{headers,redirect:"manual",signal:AbortSignal.timeout(30000)});
    if([301,302,303,307,308].includes(response.status)){url=new URL(response.headers.get("location")!,url).href;continue;}
    if(!response.ok)throw Error("Temporary PDF retrieval failed.");
    const bytes=new Uint8Array(await response.arrayBuffer());if(new TextDecoder().decode(bytes.slice(0,4))!=="%PDF")throw Error("Google returned unexpected PDF content.");return bytes;
  }
  throw Error("Temporary PDF redirect limit exceeded.");
}
const originals:string[]=[],staged:string[]=[];
try{
  const heic=await readFile("tests/fixtures/iphone_13_pro_max.HEIC"),jpeg=await readFile("artifacts/heif/iphone_13_pro_max.HEIC.jpg");
  for(const [key,bytes,type] of [[originalKey,heic,"image/heic"],[previewKey,jpeg,"image/jpeg"]] as const){const uploaded=await db.storage.from("photo-journal").upload(key,bytes,{contentType:type,upsert:false});if(uploaded.error)throw Error("Private original/derivative upload failed.");originals.push(key);}
  const stored=await db.storage.from("photo-journal").download(previewKey);if(stored.error)throw Error("Private preview retrieval failed.");
  const image=await prepareDocsImage(new Uint8Array(await stored.data.arrayBuffer()));assert.equal(image.info.width,1500);assert.equal(image.info.height,2000);
  const png=await db.storage.from("docs-images").upload(imageKey,image.data,{contentType:"image/png",upsert:false});if(png.error)throw Error("Docs preparation upload failed.");staged.push(imageKey);
  const signed=await db.storage.from("docs-images").createSignedUrl(imageKey,600);if(signed.error)throw Error("Private signing failed.");
  const signedUrl=signed.data.signedUrl;
  const publicRead=await fetch(process.env.NEXT_PUBLIC_SUPABASE_URL+"/storage/v1/object/public/docs-images/"+imageKey);assert.ok(!publicRead.ok,"Photo bucket became public");
  let current=await google.read(target),baselines:Baseline[]=[];
  await write(current.revisionId,[{insertText:{location:{index:1,tabId:current.tabs[0].tabProperties.tabId},text:"Temporary HEIC opening material — preserve this manual content.\n"}}]);
  const recent:Row={id:randomUUID(),photo_date:"2026-01-01",caption:"Genuine iPhone 13 Pro Max HEIC, decoded and resized without cropping",image_key:originalKey,author_email:"feranmidyro@gmail.com",created_at:new Date().toISOString()};
  const older={...recent,id:randomUUID(),photo_date:"2000-01-01",caption:"Older temporary HEIF derivative"};
  async function patch(desired:Map<string,Row|null>){
    current=await google.read(target);
    const plan=await planDocument({document:current,connection:managed,operation:randomUUID(),desired,baselines,allowCreateRegion:true,photo:async()=>({key:imageKey,width:image.info.width,height:image.info.height})});
    const next=plan.changed?null:plan.baselines;
    let after=next;
    if(plan.changed){const requests=structuredClone(plan.requests);for(const request of requests)if(request.insertInlineImage)request.insertInlineImage.uri=signedUrl;await write(current.revisionId,requests);current=await google.read(target);after=finishBaselines(plan,current,managed);}
    // Match production's baseline upserts: a conflict must retain its previous
    // baseline, not lose it just because the planner omitted it from this update.
    const saved=new Map(baselines.map(item=>[item.entry_id,item]));for(const item of after||[])saved.set(item.entry_id,item);baselines=[...saved.values()];
    return plan;
  }
  await patch(new Map([[recent.id,recent],[older.id,older]]));assert.deepEqual(inspectDocument(current,managed).entry_ids,[recent.id,older.id]);
  assert.equal((await patch(new Map([[recent.id,recent],[older.id,older]]))).changed,false);
  const edited={...older,photo_date:"2026-02-01",caption:"Edited HEIF date and caption"};await patch(new Map([[older.id,edited]]));assert.deepEqual(inspectDocument(current,managed).entry_ids,[older.id,recent.id]);
  await mkdir(".credentials/heif-acceptance",{recursive:true,mode:0o700});
  await writeFile(".credentials/heif-acceptance/layout.pdf",await pdfBytes(),{mode:0o600});
  const block=documentModel(current,managed).blocks.get(older.id)!;const from=block.start+13,tabId=current.tabs[0].tabProperties.tabId;
  await write(current.revisionId,[{deleteContentRange:{range:{startIndex:from,endIndex:from+edited.caption.length,tabId}}},{insertText:{location:{index:from,tabId},text:"Manual HEIF caption preserved"}}]);
  assert.equal((await patch(new Map())).changed,false);current=await google.read(target);assert.match(documentModel(current,managed).blocks.get(older.id)!.text,/Manual HEIF caption preserved/);
  assert.equal((await patch(new Map([[older.id,{...edited,caption:"Conflicting edit"}]]))).conflicts.length,1);
  await patch(new Map([[recent.id,null]]));assert.deepEqual(inspectDocument(current,managed).entry_ids,[older.id]);assert.match(inspectDocument(current,managed).text_preview,/preserve this manual content/);
  const after=await google.read(DOCUMENT_ID);
  const report={temporary_url:"https://docs.google.com/document/d/"+target+"/edit",actual_heic_decode:true,private_original_and_derivative:true,docs_image_preparation:true,google_image_insertion:true,sorting_edits_deletion_duplicates_manual_preservation:true,live_journal_fixture_entries:0,real_document_writes:0,real_document_revision_unchanged:after.revisionId===original.revisionId,tested_at:new Date().toISOString()};
  await writeFile(".credentials/heif-acceptance/report.json",JSON.stringify(report,null,2),{mode:0o600});console.log(report);
}finally{
  if(originals.length){const removed=await db.storage.from("photo-journal").remove(originals);if(removed.error)throw Error("Temporary original/preview cleanup requires retry.");}
  if(staged.length){const removed=await db.storage.from("docs-images").remove(staged);if(removed.error)throw Error("Temporary Docs image cleanup requires retry.");}
}
