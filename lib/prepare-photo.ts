import { detectHeif, photoType, PHOTO_LIMIT } from "./photos";
export type PreparedPhoto = { original: File; preview: File | null };
export async function preparePhoto(file: File, progress: (message:string)=>void, signal: AbortSignal): Promise<PreparedPhoto> {
  if(file.size === 0 || file.size > PHOTO_LIMIT) throw Error("Choose a photo up to 10 MB.");
  const heif = await detectHeif(file);
  if(signal.aborted)throw new DOMException("Cancelled","AbortError");
  if(!heif && !["image/heic","image/heif"].includes(photoType(file))) {
    if(!photoType(file))throw Error("Choose a JPEG, PNG, WebP, HEIC or HEIF photo up to 10 MB.");
    return {original:file,preview:null};
  }
  progress("Preparing HEIC/HEIF photo…");
  if(typeof Worker==="undefined" || typeof WebAssembly==="undefined" || typeof createImageBitmap==="undefined" || typeof OffscreenCanvas==="undefined")throw Error("This browser cannot convert HEIC/HEIF photos. Try a current Safari, Chrome, Firefox or Edge browser, or export the photo as JPEG. Nothing has been uploaded.");
  const converted = await new Promise<Blob>((resolve,reject)=>{
    const worker = new Worker(new URL("./heif-worker.ts",import.meta.url),{type:"module"});
    let settled=false;
    const finish = (blob?:Blob,error?:Error) => {if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener("abort",cancel);worker.terminate();error?reject(error):resolve(blob!)};
    const cancel=()=>finish(undefined,new DOMException("Cancelled","AbortError"));
    const timer=setTimeout(()=>finish(undefined,Error("Photo conversion timed out. Try a smaller photo or export it as JPEG. Nothing has been uploaded.")),120000);
    signal.addEventListener("abort",cancel,{once:true});
    worker.onerror=()=>finish(undefined,Error("The photo converter could not run. Try a current browser or export the photo as JPEG. Nothing has been uploaded."));
    worker.onmessage=e=>{if(e.data.progress)progress(e.data.progress);else if(e.data.error)finish(undefined,Error(e.data.error));else if(e.data.blob)finish(e.data.blob)};
    void file.arrayBuffer().then(bytes=>{if(!settled&&!signal.aborted)worker.postMessage(bytes,[bytes])}).catch(()=>finish(undefined,Error("The selected photo could not be read.")));
  });
  const type = photoType(file)==="image/heif"?"image/heif":"image/heic";
  // Canonical original type/name are based on actual container detection, not MIME alone.
  const original=new File([file],file.name.replace(/\.[^.]+$/,"")+ (type==="image/heif"?".heif":".heic"),{type});
  return {original,preview:new File([converted],"preview.jpg",{type:"image/jpeg"})};
}
