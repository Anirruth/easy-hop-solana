import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const nativeFetch = globalThis.fetch;

if (nativeFetch) {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("file://")) {
      const filePath = fileURLToPath(url);
      const data = await readFile(filePath);
      return new Response(data);
    }
    return nativeFetch(input, init);
  };
}
