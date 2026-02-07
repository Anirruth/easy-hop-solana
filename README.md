EasyHop Solana

Hopper-style Solana lending vault aggregator focused on:
- Solend
- Kamino Lend

This repo contains a lightweight API for vault/metrics data and a simple
web UI to browse vaults and initiate a one-click move (withdraw -> deposit).

Structure
- apps/api: Express API with protocol adapters and normalized vault metrics
- apps/web: React UI (Vite) showing vaults across protocols

Quick start
1) API
   cd apps/api
   npm install
   npm run dev

2) Web
   cd apps/web
   npm install
   npm run dev

Environment
Copy the example files and fill in real values:

API (`apps/api/.env.example`)
- `SOLANA_RPC_URL` (recommended) Dedicated mainnet RPC to avoid 429s.
- `SOLANA_RPC_FALLBACK_URL` Optional fallback RPC.
- `JUPITER_API_KEY` Required for swaps (get one at https://portal.jup.ag).
- `JUPITER_API_BASE` Optional override (default: https://api.jup.ag/swap/v1).

Web (`apps/web/.env.example`)
- `VITE_API_URL` Base URL for the API (default: http://localhost:4000).
- `VITE_SOLANA_RPC_URL` Optional custom RPC for the web app.

Notes
- The API fetches live vault metrics for Solend and Kamino Lend.
- The API builds withdraw/swap/deposit transactions and the UI signs
  and submits them with the user wallet.
- Cross-asset moves and SOL->token deposits use Jupiter swaps.
