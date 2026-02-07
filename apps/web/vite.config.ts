import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import wasm from "vite-plugin-wasm";

export default defineConfig({
  plugins: [react(), wasm()],
  resolve: {
    alias: [
      {
        find: "rpc-websockets/dist/lib/client/websocket.browser.cjs",
        replacement: path.resolve(
          __dirname,
          "src/shims/rpc-websockets-websocket.ts"
        )
      },
      {
        find: "rpc-websockets/dist/lib/client/websocket.browser",
        replacement: path.resolve(
          __dirname,
          "src/shims/rpc-websockets-websocket.ts"
        )
      },
      {
        find: "rpc-websockets/dist/lib/client",
        replacement: path.resolve(
          __dirname,
          "src/shims/rpc-websockets-client.ts"
        )
      },
      {
        find: /^@kamino-finance\/kliquidity-sdk\/dist(?:\/.*)?$/,
        replacement: path.resolve(
          __dirname,
          "src/shims/kliquidity.ts"
        )
      },
      {
        find: "@kamino-finance/kliquidity-sdk",
        replacement: path.resolve(
          __dirname,
          "src/shims/kliquidity.ts"
        )
      },
      {
        find: "@orca-so/whirlpools-core",
        replacement: path.resolve(
          __dirname,
          "src/shims/orca-whirlpools.ts"
        )
      }
    ]
  },
  server: {
    port: 5173
  }
});
