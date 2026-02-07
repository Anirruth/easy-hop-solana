import { Client } from "rpc-websockets";

const createRpc = (url: string, options?: Record<string, unknown>) =>
  new Client(url, options);

export default createRpc;
