EasyHop Solana

Kamino-focused Solana vault app with:
- Live vault discovery and metrics
- Wallet position tracking
- Manual-step funding, withdrawing, and vault hopping

The repo is split into:
- `apps/api`: Express API for vault data and transaction building
- `apps/web`: React + Vite UI for browsing vaults and running actions

## Current scope
- Protocol shown in UI: Kamino Lend
- Vault list in UI is filtered to TVL >= `$100,000`
- Vault actions supported in UI:
  - Fund vault from wallet token
  - Fund vault from SOL (swap via Jupiter)
  - Withdraw vault asset
  - Withdraw to SOL (swap via Jupiter)
  - Hop from one vault to another (withdraw -> swap if needed -> deposit)
  - Preview/create/close token accounts

## Quick start
1. Start API
   - `cd apps/api`
   - `npm install`
   - `cp .env.example .env`
   - fill `.env`
   - `npm run dev`
2. Start Web (new terminal)
   - `cd apps/web`
   - `npm install`
   - `cp .env.example .env`
   - fill `.env`
   - `npm run dev`

## Environment variables

API (`apps/api/.env.example`)
- `PORT`: API port (`4000` default)
- `SOLANA_RPC_URL`: primary Solana mainnet RPC
- `SOLANA_RPC_FALLBACK_URL`: optional fallback RPC
- `JUPITER_API_KEY`: required for SOL/token and cross-asset swaps
- `JUPITER_API_BASE`: optional Jupiter base override (default `https://api.jup.ag/swap/v1`)

Web (`apps/web/.env.example`)
- `VITE_API_URL`: API base URL (default `http://localhost:4000`)
- `VITE_SOLANA_RPC_URL`: optional client RPC override

## API routes (high level)
- `GET /health`
- `GET /vaults`
- `GET /vaults/:id`
- `GET /vaults/:id/history`
- `GET /positions?walletAddress=<pubkey>`
- `GET /protocols`
- `POST /move/deposit/build`
- `POST /move/deposit/sol/quote`
- `POST /move/deposit/sol/build`
- `POST /move/withdraw/build`
- `POST /move/swap/build`
- `POST /move/build` (full hop/move build)
- `POST /move/accounts/preview`
- `POST /move/accounts/create`
- `POST /move/accounts/close`
- `POST /transactions/send`

## Notes
- Swaps depend on Jupiter; set `JUPITER_API_KEY` in API env.
- If your RPC blocks transaction submission from browser RPC endpoints, the web app can relay signed transactions through `POST /transactions/send`.
