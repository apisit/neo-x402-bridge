# neo-x402-bridge

Local **x402 agent bridge** for the Neo X *Infinity* demo. It spawns a disposable
agent wallet on your machine and exposes it to **Claude Desktop** (or any
MCP-aware client) so an AI can make **real on-chain micropayments** on Neo X —
without the AI ever holding arbitrary signing power (payments only go to the game
treasury; withdrawals only to your own owner address).

The wallet's private key lives only on your machine, at
`~/.x402-bridge/wallet.json` (chmod 600). This is why the bridge runs **locally**
and is never deployed to a server.

## Use it (no clone, no npm account)

Needs **Node 18+**.

```bash
# 1. create your agent wallet (owner = your own wallet, the safe recovery address)
BRIDGE_OWNER_ADDRESS=0xYourWallet npx -y github:apisit/neo-x402-bridge init

# 2. fund the printed agent address with xGAS (see the game's setup page), then:
npx -y github:apisit/neo-x402-bridge status
```

### Wire it into Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "x402-bridge": {
      "command": "npx",
      "args": ["-y", "github:apisit/neo-x402-bridge", "start"],
      "env": {
        "GAME_TREASURY_ADDRESS": "0x002dD52c108A8CF557234F046B88f7f763916ba8",
        "GAME_SERVICE_URL": "https://neo-x402-service-production.up.railway.app"
      }
    }
  }
}
```

Fully quit Claude Desktop (⌘Q) and reopen — the `x402-bridge` tools appear in the 🔌 menu.

## Env vars

| var | when | what |
|---|---|---|
| `BRIDGE_OWNER_ADDRESS` | `init` | your own wallet — recovery / withdraw address |
| `GAME_TREASURY_ADDRESS` | `start` / `withdraw` | the game service's treasury |
| `GAME_SERVICE_URL` | `start` | the game service URL (default `http://localhost:8787`) |

## Source

`dist/cli.js` is a prebuilt bundle. Source lives in the monorepo:
[apisit/neo-x402](https://github.com/apisit/neo-x402) under `packages/bridge`.
