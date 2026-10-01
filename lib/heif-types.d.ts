declare module "libheif-js/libheif-wasm/libheif-bundle.mjs" {
  interface HeifImage {
    get_width(): number; get_height(): number; is_primary(): boolean; free(): void;
    display(target: { data: Uint8ClampedArray; width: number; height: number }, callback: (result: { data: Uint8ClampedArray; width: number; height: number } | null) => void): void;
  }
  export default function initialize(options?: Record<string, unknown>): Promise<{ HeifDecoder: new () => { decode(data: Uint8Array): HeifImage[] } }>;
}
