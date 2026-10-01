// Explicit operator recovery. No general auto-repair or relaxed worker guards.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { serviceDb, decrypt, encrypt, DOCUMENT_ID } from "../lib/docs/server.ts";
import { Google, exchangeToken, ensurePrivateEditors } from "../lib/docs/google.ts";
import { missingStartSeparator, verifySeparatorRepair } from "../lib/docs/boundary-repair.ts";

const apply=process.argv.includes("--apply"),credentials=JSON.parse(await readFile(".credentials/google.json","utf8"));
Object.assign(process.env,{NEXT_PUBLIC_SUPABASE_URL:"https://rnilakqmyanujehtqbuk.supabase.co",GOOGLE_CLIENT_ID:credentials.clientId,GOOGLE_CLIENT_SECRET:credentials.clientSecret,GOOGLE_PROJECT_NUMBER:String(credentials.projectNumber),GOOGLE_PICKER_API_KEY:credentials.pickerApiKey});
for(const key of ["SUPABASE_SERVICE_ROLE_KEY","DOCS_TOKEN_ENCRYPTION_KEY"])process.env[key]=(await readFile(".credentials/"+key,"utf8")).trim();
const db=serviceDb(),owner=randomUUID();
const lock=await db.rpc("acquire_docs_lease",{p_owner:owner});if(lock.error||!lock.data)throw Error("A worker owns the connection; retry after it finishes.");
let connection:any,google:Google;
try{
  const read=await db.from("docs_connections").select("*").eq("lease_owner",owner).single();if(read.error)throw Error("Protected connection unavailable.");connection=read.data;
  if(connection.document_id!==DOCUMENT_ID||!connection.enabled||connection.state!=="recovery_required")throw Error("The live connection is not the expected paused recovery case.");
  const prepared=await db.from("docs_sync_intents").select("id",{count:"exact",head:true}).eq("state","prepared");if(prepared.error||prepared.count!==0)throw Error("A prepared write needs separate recovery; separator repair stopped.");
  const token=await exchangeToken({grant_type:"refresh_token",refresh_token:decrypt(connection.refresh_token_encrypted)});
  if(token.refresh_token){const stored=await db.from("docs_connections").update({refresh_token_encrypted:encrypt(token.refresh_token)}).eq("lease_owner",owner);if(stored.error)throw Error("Token rotation failed.");}
  google=new Google(token.access_token);ensurePrivateEditors(await google.permissions(DOCUMENT_ID));
  if(!apply){await db.rpc("release_docs_lease",{p_owner:owner});}
  const before=await google.read(DOCUMENT_ID),plan=missingStartSeparator(before,connection.id);
  await mkdir(".credentials/docs-repair",{recursive:true,mode:0o700});
  if(!apply){
    const copied=await(await google.request("drive",`/files/${DOCUMENT_ID}/copy`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"Moments TEMPORARY separator repair "+randomUUID()})})).json();
    if(!copied.id||copied.id===DOCUMENT_ID)throw Error("Temporary copy identity was not verified.");
    const permissions=await google.permissions(copied.id);if(permissions.some(p=>!p.deleted&&(p.type!=="user"||!["feranmidyro@gmail.com","kieragreen50@gmail.com"].includes(p.emailAddress?.toLowerCase()))))throw Error("Temporary copy sharing is not private.");
    const copyBefore=await google.read(copied.id),candidate=missingStartSeparator(copyBefore,connection.id);
    const written=await google.write(copied.id,copyBefore.revisionId,candidate.requests);
    const copyAfter=await google.read(copied.id);if(copyAfter.revisionId!==written.writeControl.requiredRevisionId)throw Error("Temporary document changed before verification.");
    const model=verifySeparatorRepair(copyBefore,copyAfter,connection.id);
    const originalAfter=await google.read(DOCUMENT_ID);if(originalAfter.revisionId!==before.revisionId)throw Error("The original changed during testing; repeat the temporary repair review.");
    await writeFile(".credentials/docs-repair/temporary-before.json",JSON.stringify(copyBefore),{mode:0o600});await writeFile(".credentials/docs-repair/temporary-after.json",JSON.stringify(copyAfter),{mode:0o600});
    const report={temporary_id:copied.id,original_revision:before.revisionId,connection_id:connection.id,automated:"passed",photos_preserved:model.ordered.length,layout_review:"pending",applied:false,tested_at:new Date().toISOString()};
    await writeFile(".credentials/docs-repair/report.json",JSON.stringify(report,null,2),{mode:0o600});console.log({temporary_repair:"passed",photos_preserved:model.ordered.length,all_captions_and_other_paragraphs_preserved:true,real_document_unchanged:true,layout_review:"pending"});
  }else{
    const report=JSON.parse(await readFile(".credentials/docs-repair/report.json","utf8"));
    if(report.automated!=="passed"||report.layout_review!=="passed"||report.applied||report.connection_id!==connection.id||report.original_revision!==before.revisionId)throw Error("Actual temporary tests/layout or unchanged-revision requirements are not met.");
    const recoveryKey="repairs/"+randomUUID()+"-before.json";
    const backup=await db.storage.from("docs-recovery").upload(recoveryKey,Buffer.from(JSON.stringify(before)),{contentType:"application/json",upsert:false});if(backup.error)throw Error("Private recovery backup failed; no document repair attempted.");
    const lease=await db.from("docs_connections").select("lease_until").eq("lease_owner",owner).single();if(lease.error||Date.parse(lease.data.lease_until)<Date.now()+30000)throw Error("Recovery lock expired; no document repair attempted.");
    await writeFile(".credentials/docs-repair/live-before.json",JSON.stringify(before),{mode:0o600});
    const written=await google.write(DOCUMENT_ID,before.revisionId,plan.requests),after=await google.read(DOCUMENT_ID);
    if(after.revisionId!==written.writeControl.requiredRevisionId)throw Error("Document changed before repair verification; queued writes remain paused.");
    const model=verifySeparatorRepair(before,after,connection.id);
    await writeFile(".credentials/docs-repair/live-after.json",JSON.stringify(after),{mode:0o600});
    // Keep baselines intact: genuine direct edits still conflict with website edits.
    const retry=await db.from("docs_sync_events").update({status:"pending",attempts:0,error:null}).in("status",["failed","syncing"]);if(retry.error)throw Error("Document repaired; queue reset requires retry.");
    const resumed=await db.from("docs_connections").update({state:"connected",last_error:null}).eq("lease_owner",owner).gt("lease_until",new Date().toISOString()).select("id");if(resumed.error||resumed.data?.length!==1)throw Error("Document repaired; connection lock changed before resume.");
    report.applied=true;report.applied_at=new Date().toISOString();report.recovery_key=recoveryKey;
    await writeFile(".credentials/docs-repair/report.json",JSON.stringify(report,null,2),{mode:0o600});
    const baseline=await db.from("docs_sync_baselines").select("block_hash").eq("entry_id",plan.firstEntry).maybeSingle();
    console.log({live_separator_repaired:true,photos_preserved:model.ordered.length,first_page_matches_prior_baseline:model.blocks.get(plan.firstEntry)?.hash===baseline.data?.block_hash,baseline_records_unchanged:true,queue_resumed:true});
  }
}finally{await db.rpc("release_docs_lease",{p_owner:owner});}
