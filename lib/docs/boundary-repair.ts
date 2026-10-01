import { createHash } from "node:crypto";
import { documentModel } from "./merge.ts";
import type { GoogleDocument, Json } from "./types.ts";

function refuse(): never { throw Error("The document does not match the reviewed missing-separator case. No repair was attempted."); }
function normalized(value: any): any {
  if(Array.isArray(value))return value.map(normalized);
  if(!value||typeof value!=="object")return value;
  return Object.fromEntries(Object.keys(value).sort().filter(k=>!["startIndex","endIndex","contentUri"].includes(k)).map(k=>[k,normalized(value[k])]));
}
const fingerprint=(value:any)=>createHash("sha256").update(JSON.stringify(normalized(value)) ?? "undefined").digest("hex");
function dateStyleRequests(paragraph:Json,start:number,tabId:string) {
  const requests:Json[]=[];let skip=1,cursor=start;
  for(const element of paragraph.elements){
    const run=element.textRun,length=run.content.length-skip;skip=0;
    if(length<=0)continue;
    const textStyle=run.textStyle||{},fields=Object.keys(textStyle).join(",");
    if(fields)requests.push({updateTextStyle:{range:{startIndex:cursor,endIndex:cursor+length,tabId},textStyle,fields}});
    cursor+=length;
  }
  return requests;
}
function characterStyles(paragraph:Json) {
  return paragraph.elements.flatMap((element:Json)=>Array.from(element.textRun.content).map(()=>element.textRun.textStyle||{}));
}
export function missingStartSeparator(document: GoogleDocument, connection: string) {
  if(!document.revisionId||document.tabs.length!==1||document.tabs[0].childTabs?.length)refuse();
  const tab=document.tabs[0],body=tab.documentTab?.body?.content;
  if(!body)refuse();
  const name="moments.start."+connection,collection=tab.documentTab.namedRanges?.[name];
  if(collection?.namedRanges?.length!==1||collection.namedRanges[0].ranges?.length!==1)refuse();
  const start=collection.namedRanges[0],range=start.ranges[0];
  if(range.endIndex!==range.startIndex+1)refuse();
  const paragraph=body.find((item:Json)=>item.startIndex===range.startIndex);
  const text=paragraph?.paragraph?.elements?.map((element:Json)=>element.textRun?.content||"").join("");
  if(!/^\u2060\d{4}-\d{2}-\d{2}\n$/.test(text||"")||paragraph.paragraph.elements.some((e:Json)=>!e.textRun))refuse();
  const entries=Object.entries(tab.documentTab.namedRanges||{}).filter(([key])=>key.startsWith("moments.entry."));
  const first=entries.find(([,value]:[string,any])=>value.namedRanges?.[0]?.ranges?.[0]?.startIndex===range.endIndex) as [string,any]|undefined;
  if(!first||!/^moments\.entry\.[0-9a-f-]{36}$/i.test(first[0])||first[1].namedRanges.length!==1||first[1].namedRanges[0].ranges.length!==1)refuse();
  const entry=first[1].namedRanges[0],entryRange=entry.ranges[0];
  if(entryRange.endIndex<paragraph.endIndex||!body.some((item:Json)=>item.endIndex===entryRange.endIndex))refuse();
  const tabId=tab.tabProperties.tabId,index=range.endIndex;
  const r=(startIndex:number,endIndex:number)=>({startIndex,endIndex,tabId});
  // Restore one missing newline and only the two ranges touching that insertion.
  // Google shifts later indices automatically. Images and captions are untouched.
  const requests:Json[]=[
    {deleteNamedRange:{namedRangeId:start.namedRangeId,tabsCriteria:{tabIds:[tabId]}}},
    {deleteNamedRange:{namedRangeId:entry.namedRangeId,tabsCriteria:{tabIds:[tabId]}}},
    {insertText:{location:{index,tabId},text:"\n"}},
    {createNamedRange:{name,range:r(range.startIndex,range.endIndex+1)}},
    {createNamedRange:{name:first[0],range:r(entryRange.startIndex+1,entryRange.endIndex+1)}},
    {updateTextStyle:{range:r(range.startIndex,range.endIndex+1),textStyle:{fontSize:{magnitude:1,unit:"PT"}},fields:"fontSize"}},
    {updateParagraphStyle:{range:r(range.startIndex,range.endIndex+1),paragraphStyle:{pageBreakBefore:false,keepWithNext:false},fields:"pageBreakBefore,keepWithNext"}},
    // Joining a marker and date loses the date's paragraph layout. Restore its
    // normal generated page break; retain all date character styling/direct edits.
    {updateParagraphStyle:{range:r(index+1,paragraph.endIndex+1),paragraphStyle:{namedStyleType:"NORMAL_TEXT",alignment:"START",lineSpacing:100,spaceAbove:{magnitude:0,unit:"PT"},spaceBelow:{magnitude:6,unit:"PT"},indentStart:{magnitude:0,unit:"PT"},indentEnd:{magnitude:0,unit:"PT"},indentFirstLine:{magnitude:0,unit:"PT"},keepLinesTogether:true,keepWithNext:true,pageBreakBefore:true},fields:"namedStyleType,alignment,lineSpacing,spaceAbove,spaceBelow,indentStart,indentEnd,indentFirstLine,keepLinesTogether,keepWithNext,pageBreakBefore"}}
  ];
  // Splitting a paragraph can reset the following text's explicit font styling.
  // Replay the saved date styles, including any direct edits, after the split.
  requests.push(...dateStyleRequests(paragraph.paragraph,index+1,tabId));
  return {requests,index,date:text.slice(1,11),firstEntry:first[0].slice("moments.entry.".length),paragraphStart:paragraph.startIndex,paragraphEnd:paragraph.endIndex};
}
export function verifySeparatorRepair(before:GoogleDocument,after:GoogleDocument,connection:string) {
  const plan=missingStartSeparator(before,connection),model=documentModel(after,connection);
  const oldTab=before.tabs[0].documentTab,newTab=after.tabs[0].documentTab;
  const oldContent=oldTab.body.content.filter((item:Json)=>item.startIndex!==plan.paragraphStart);
  const newContent=newTab.body.content.filter((item:Json)=>item.startIndex!==plan.paragraphStart&&item.startIndex!==plan.index+1);
  if(fingerprint(oldContent)!==fingerprint(newContent)||fingerprint(oldTab.inlineObjects)!==fingerprint(newTab.inlineObjects))throw Error("Repair verification detected a changed image, caption or unrelated paragraph. Sync remains paused for review.");
  for(const key of ["namedStyles","headers","footers"])if(fingerprint(oldTab[key])!==fingerprint(newTab[key]))throw Error("Unrelated document formatting changed during repair.");
  if(fingerprint(before.documentStyle)!==fingerprint(after.documentStyle))throw Error("Document page settings changed during repair.");
  const oldDate=oldTab.body.content.find((item:Json)=>item.startIndex===plan.paragraphStart).paragraph.elements.map((e:Json)=>e.textRun.content).join("").slice(1);
  const newDate=newTab.body.content.find((item:Json)=>item.startIndex===plan.index+1).paragraph.elements.map((e:Json)=>e.textRun?.content||"").join("");
  if(oldDate!==newDate||model.ordered[0]?.id!==plan.firstEntry)throw Error("Date or entry identity changed during repair.");
  const oldParagraph=oldTab.body.content.find((item:Json)=>item.startIndex===plan.paragraphStart).paragraph;
  const newParagraph=newTab.body.content.find((item:Json)=>item.startIndex===plan.index+1).paragraph;
  if(fingerprint(characterStyles(oldParagraph).slice(1))!==fingerprint(characterStyles(newParagraph)))throw Error("Date character formatting changed during repair.");
  const oldNames=Object.keys(oldTab.namedRanges||{}).sort(),newNames=Object.keys(newTab.namedRanges||{}).sort();
  if(JSON.stringify(oldNames)!==JSON.stringify(newNames))throw Error("Repair changed named-range identities.");
  return model;
}
export function separatorDateStyleRequests(before:GoogleDocument,current:GoogleDocument,connection:string) {
  const plan=missingStartSeparator(before,connection),model=documentModel(current,connection);
  const block=model.blocks.get(plan.firstEntry);
  const paragraph=before.tabs[0].documentTab.body.content.find((item:Json)=>item.startIndex===plan.paragraphStart).paragraph;
  if(!block||!block.text.startsWith(plan.date+"\n"))refuse();
  return dateStyleRequests(paragraph,block.start,model.tabId);
}
