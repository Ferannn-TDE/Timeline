import initialize from "libheif-js/libheif-wasm/libheif-bundle.mjs";
import { checkPixels } from "./photos";

// A worker is destroyed after each conversion, releasing the decoder's WASM heap.
self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  try {
    self.postMessage({ progress: "Loading HEIC decoder…" });
    const lib = await initialize({ print: () => {}, printErr: () => {} });
    const images = new lib.HeifDecoder().decode(new Uint8Array(event.data));
    const image = images.find(item => item.is_primary()) || images[0];
    if (!image) throw Error("This HEIC/HEIF file has no readable still photo.");
    const width = image.get_width(), height = image.get_height();
    checkPixels(width,height); // Before allocating the RGBA pixel buffer.
    self.postMessage({ progress: "Decoding and converting photo…" });
    const decoded = await new Promise<{data:Uint8ClampedArray;width:number;height:number}>((resolve,reject) => image.display({data:new Uint8ClampedArray(width*height*4),width,height}, result => result ? resolve(result) : reject(Error("This HEIC/HEIF file is corrupt or uses an unsupported codec."))));
    const scale = Math.min(1, 2000 / Math.max(width,height));
    const w = Math.max(1,Math.round(width*scale)), h = Math.max(1,Math.round(height*scale));
    const bitmap = await createImageBitmap(new ImageData(decoded.data as Uint8ClampedArray<ArrayBuffer>,width,height), {resizeWidth:w,resizeHeight:h,resizeQuality:"high"});
    const canvas = new OffscreenCanvas(w,h), context = canvas.getContext("2d");
    if (!context) throw Error("This browser cannot convert photos. Try a current Safari, Chrome, Firefox or Edge browser.");
    context.fillStyle = "white"; context.fillRect(0,0,w,h); context.drawImage(bitmap,0,0); bitmap.close();
    const blob = await canvas.convertToBlob({type:"image/jpeg",quality:0.92});
    for(const item of images)item.free();
    self.postMessage({ blob, width:w, height:h });
  } catch(error) {
    self.postMessage({error: error instanceof Error && /limit|no readable|unsupported|browser/i.test(error.message) ? error.message : "This HEIC/HEIF photo could not be decoded. It may be damaged or unsupported. Export it as JPEG and try again; nothing has been uploaded."});
  }
};
