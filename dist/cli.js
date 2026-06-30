#!/usr/bin/env node

// src/load-env.ts
import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
var dir = process.cwd();
for (let depth = 0; depth < 6; depth++) {
  const candidate = resolve(dir, ".env");
  if (existsSync(candidate)) {
    loadDotenv({ path: candidate, override: false });
  }
  const parent = dirname(dir);
  if (parent === dir) break;
  dir = parent;
}

// src/x402core/config.ts
import { defineChain } from "viem";
var CHAIN_ID = 12227332;
var NETWORK = "eip155:12227332";
var RPC_URL = process.env.RPC_URL ?? "https://neoxt4seed1.ngd.network";
var neoxTestnet = defineChain({
  id: CHAIN_ID,
  name: "Neo X Testnet",
  nativeCurrency: { name: "Gas", symbol: "GAS", decimals: 18 },
  rpcUrls: {
    default: { http: [RPC_URL] },
    public: { http: ["https://neoxt4seed1.ngd.network"] }
  },
  blockExplorers: {
    default: { name: "NeoX T4 Scan", url: "https://xt4scan.ngd.network" }
  },
  testnet: true
});
var XGAS = {
  address: "0xD4ac6B385C16cd94A8E54aB422138833804AE443",
  name: "Extended GAS",
  symbol: "xGAS",
  decimals: 18,
  // EIP-712 domain (verified by reading eip712Domain() on-chain and
  // recomputing DOMAIN_SEPARATOR — match confirmed).
  domain: {
    name: "Extended GAS",
    version: "1",
    chainId: CHAIN_ID,
    verifyingContract: "0xD4ac6B385C16cd94A8E54aB422138833804AE443"
  }
};
var FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://ax402.testnet.app.mf.axlabs.net";
var explorer = {
  tx: (hash) => `https://xt4scan.ngd.network/tx/${hash}`,
  address: (addr) => `https://xt4scan.ngd.network/address/${addr}`,
  token: (addr) => `https://xt4scan.ngd.network/token/${addr}`
};
var X402_VERSION = 2;
var X402_SCHEME = "exact";

// src/x402core/signing.ts
import {
  bytesToHex,
  toHex
} from "viem";
var EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" }
  ]
};
function buildAuthorization(params) {
  const now = params.nowSeconds ?? Math.floor(Date.now() / 1e3);
  const validityWindow = params.validitySeconds ?? 120;
  const backWindow = params.backWindowSeconds ?? 600;
  const validAfter = Math.max(0, now - backWindow);
  return {
    from: params.from,
    to: params.to,
    value: params.value.toString(),
    validAfter: validAfter.toString(),
    validBefore: (now + validityWindow).toString(),
    nonce: params.nonce ?? randomNonce()
  };
}
function randomNonce() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}
async function signAuthorization(signer, authorization, account) {
  const message = {
    from: authorization.from,
    to: authorization.to,
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce
  };
  if ("signTypedData" in signer && !("account" in signer)) {
    return signer.signTypedData({
      domain: XGAS.domain,
      types: EIP3009_TYPES,
      primaryType: "TransferWithAuthorization",
      message
    });
  }
  return signer.signTypedData({
    account,
    domain: XGAS.domain,
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message
  });
}
function encodePaymentHeader(authorization, signature, requirement) {
  const payload = {
    x402Version: X402_VERSION,
    accepted: requirement,
    payload: { signature, authorization }
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}
async function signAndEncodePayment(signer, requirement) {
  const authorization = buildAuthorization({
    from: signer.address,
    to: requirement.payTo,
    value: BigInt(requirement.amount),
    validitySeconds: requirement.maxTimeoutSeconds
  });
  const signature = await signAuthorization(signer, authorization);
  const header = encodePaymentHeader(authorization, signature, requirement);
  return { header, authorization, signature };
}
function pickRequirement(accepts, asset = XGAS.address) {
  return accepts.find(
    (r) => r.scheme === X402_SCHEME && r.network === NETWORK && r.asset.toLowerCase() === asset.toLowerCase()
  );
}

// src/x402core/facilitator.ts
var FacilitatorClient = class {
  baseUrl;
  fetch;
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl ?? FACILITATOR_URL).replace(/\/$/, "");
    this.fetch = opts.fetchImpl ?? globalThis.fetch;
  }
  /** GET /supported — used at boot to check the facilitator covers our network. */
  async supported() {
    const res = await this.fetch(`${this.baseUrl}/supported`);
    if (!res.ok) throw new Error(`facilitator /supported failed: ${res.status}`);
    return res.json();
  }
  /** POST /verify — does NOT settle, just validates the signature. */
  async verify(payment, requirement) {
    return this.post("/verify", body(payment, requirement));
  }
  /** POST /settle — submit on-chain, facilitator pays gas. */
  async settle(payment, requirement) {
    return this.post("/settle", body(payment, requirement));
  }
  async post(path, json) {
    const bodyText = JSON.stringify(json);
    if (process.env.X402_DEBUG) {
      console.error(`[facilitator] \u2192 POST ${path}
${bodyText}`);
    }
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bodyText
    });
    const text2 = await res.text();
    if (process.env.X402_DEBUG) {
      console.error(`[facilitator] \u2190 ${res.status}
${text2.slice(0, 500)}`);
    }
    if (!res.ok) {
      throw new Error(
        `facilitator ${path} ${res.status}: ${text2.slice(0, 500)}`
      );
    }
    try {
      return JSON.parse(text2);
    } catch {
      throw new Error(`facilitator ${path}: non-JSON response: ${text2.slice(0, 200)}`);
    }
  }
};
function body(payment, requirement) {
  return {
    x402Version: 2,
    paymentPayload: payment,
    paymentRequirements: requirement
  };
}

// src/cli.ts
import { formatUnits as formatUnits3, isAddress as isAddress2, parseUnits as parseUnits2 } from "viem";

// src/wallet.ts
import { existsSync as existsSync2, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { dirname as dirname2, join } from "node:path";
import { homedir } from "node:os";
import {
  isAddress,
  isHex
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
var DEFAULT_DIR = join(homedir(), ".x402-bridge");
var DEFAULT_PATH = join(DEFAULT_DIR, "wallet.json");
var WalletNotInitialized = class extends Error {
  constructor(path) {
    super(`No wallet found at ${path}. Run \`x402-bridge init\` first.`);
  }
};
var WalletAlreadyExists = class extends Error {
  constructor(path) {
    super(`Wallet already exists at ${path}. Use \`init --force\` to replace.`);
  }
};
function walletExists(path = DEFAULT_PATH) {
  return existsSync2(path);
}
function loadWallet(path = DEFAULT_PATH) {
  if (!existsSync2(path)) throw new WalletNotInitialized(path);
  const raw = readFileSync(path, "utf8");
  const file = JSON.parse(raw);
  if (!isHex(file.privateKey)) throw new Error(`malformed wallet at ${path}: bad privateKey`);
  if (!isAddress(file.address)) throw new Error(`malformed wallet at ${path}: bad address`);
  if (!isAddress(file.owner)) throw new Error(`malformed wallet at ${path}: bad owner`);
  const account = privateKeyToAccount(file.privateKey);
  if (account.address.toLowerCase() !== file.address.toLowerCase()) {
    throw new Error(`wallet file inconsistent: address does not match private key`);
  }
  return { file, account };
}
function createWallet(opts) {
  if (!isAddress(opts.owner)) throw new Error(`invalid owner address: ${opts.owner}`);
  const path = opts.path ?? DEFAULT_PATH;
  if (existsSync2(path) && !opts.force) throw new WalletAlreadyExists(path);
  mkdirSync(dirname2(path), { recursive: true });
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const file = {
    privateKey,
    address: account.address,
    owner: opts.owner,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    network: opts.network ?? "eip155:12227332"
  };
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 384 });
  try {
    chmodSync(path, 384);
  } catch {
  }
  const mode = statSync(path).mode & 511;
  if (mode !== 384) {
    console.warn(`\u26A0 wallet.json permissions are ${mode.toString(8)}, expected 600`);
  }
  return { file, account, path };
}

// src/client.ts
import { createPublicClient, formatUnits, http } from "viem";
var PaymentRefused = class extends Error {
  constructor(message) {
    super(`payment refused by bridge: ${message}`);
  }
};
var GameService = class {
  constructor(baseUrl, account, opts) {
    this.baseUrl = baseUrl;
    this.account = account;
    this.opts = opts;
  }
  baseUrl;
  account;
  opts;
  /**
   * POST to a paid endpoint, handling the 402 → sign → retry flow.
   * Throws PaymentRefused if the requirement violates bridge policy.
   */
  async call(path, init = {}) {
    const url = new URL(path, this.baseUrl).toString();
    const first = await fetch(url, { method: "POST", ...init });
    if (first.status !== 402) {
      const body3 = await first.text();
      let result2;
      try {
        result2 = JSON.parse(body3);
      } catch {
        result2 = { raw: body3 };
      }
      return {
        status: first.status,
        result: result2,
        paid: { amount: "0", amountFormatted: `0 ${XGAS.symbol}`, to: "0x0" }
      };
    }
    const challenge = await first.json();
    const requirement = pickRequirement(challenge.accepts);
    if (!requirement) throw new PaymentRefused(`no acceptable requirement in 402 response`);
    const value = BigInt(requirement.amount);
    if (value > this.opts.maxAmountPerCall) {
      throw new PaymentRefused(
        `requested ${value} > maxAmountPerCall ${this.opts.maxAmountPerCall}`
      );
    }
    if (this.opts.allowedPayees.length > 0) {
      const ok = this.opts.allowedPayees.some(
        (p) => p.address === requirement.payTo.toLowerCase()
      );
      if (!ok) throw new PaymentRefused(`payTo ${requirement.payTo} not in allowlist`);
    }
    if (requirement.network !== "eip155:12227332") {
      throw new PaymentRefused(`unexpected network ${requirement.network}`);
    }
    if (requirement.asset.toLowerCase() !== XGAS.address.toLowerCase()) {
      throw new PaymentRefused(`unexpected asset ${requirement.asset}`);
    }
    const { header } = await signAndEncodePayment(this.account, requirement);
    const second = await fetch(url, {
      method: "POST",
      ...init,
      headers: { ...init.headers ?? {}, "X-PAYMENT": header }
    });
    const body2 = await second.text();
    let result;
    try {
      result = JSON.parse(body2);
    } catch {
      result = { raw: body2 };
    }
    if (!second.ok) {
      throw new Error(`paid call failed (${second.status}): ${body2.slice(0, 300)}`);
    }
    let txHash;
    const receiptHeader = second.headers.get("X-PAYMENT-RESPONSE");
    if (receiptHeader) {
      try {
        const decoded = JSON.parse(Buffer.from(receiptHeader, "base64").toString("utf8"));
        if (typeof decoded?.transaction === "string") txHash = decoded.transaction;
      } catch {
      }
    }
    return {
      status: second.status,
      result,
      paid: {
        amount: requirement.amount,
        amountFormatted: `${formatUnits(value, XGAS.decimals)} ${XGAS.symbol}`,
        to: requirement.payTo
      },
      txHash
    };
  }
};
async function xgasBalance(address) {
  const client = createPublicClient({ chain: neoxTestnet, transport: http() });
  return client.readContract({
    address: XGAS.address,
    abi: [
      {
        inputs: [{ name: "account", type: "address" }],
        name: "balanceOf",
        outputs: [{ type: "uint256" }],
        stateMutability: "view",
        type: "function"
      }
    ],
    functionName: "balanceOf",
    args: [address]
  });
}

// src/mcp.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { formatUnits as formatUnits2, parseUnits } from "viem";
async function runMcpServer(opts) {
  const facilitator = new FacilitatorClient();
  const game = new GameService(opts.gameServiceUrl, opts.account, {
    maxAmountPerCall: opts.maxAmountPerCall ?? parseUnits("1", XGAS.decimals),
    allowedPayees: [{ address: opts.treasury.toLowerCase() }]
  });
  const sessionCap = opts.sessionCap ?? parseUnits("5", XGAS.decimals);
  let sessionSpent = 0n;
  const server = new Server(
    { name: "x402-bridge", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "agent_address",
        description: "Return the agent wallet's Neo X address. Read-only.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }
      },
      {
        name: "agent_balance",
        description: "Return the agent wallet's xGAS balance. Read-only.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }
      },
      {
        name: "do_work",
        description: "Spend xGAS to call the game service's /api/work endpoint. Returns a random fact. Each call pays a fixed price (typically 0.1 xGAS) to the configured game treasury. The bridge will refuse to sign payments that exceed the per-call cap or that go to any address other than the treasury.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }
      },
      {
        name: "withdraw_to_owner",
        description: "Sign an EIP-3009 authorization to send a specified amount of xGAS back to the wallet's owner address (set at init). The facilitator submits the on-chain transfer. Only the pre-registered owner can be the recipient.",
        inputSchema: {
          type: "object",
          properties: {
            amountXgas: {
              type: "string",
              description: 'Amount of xGAS to withdraw, in human units (e.g. "0.25"). Use "all" for the full balance.'
            }
          },
          required: ["amountXgas"],
          additionalProperties: false
        }
      },
      {
        name: "session_spent",
        description: "Return how much xGAS this MCP session has spent so far, and the remaining session cap.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }
      },
      // ---------------------- Dungeon (Flavor B) ----------------------
      {
        name: "game_look",
        description: "Look at your situation. Returns your HP, rooms cleared, the loot menu (with prices and effects), any single-use item you've already bought for this room, and \u2014 crucially \u2014 the WHISPER from your human ally (the 'eye'). The whisper is a FEELING about the danger ahead, not an instruction: 'relief' (calm, likely safe), 'unease' (something's wrong, take care), or 'despair' (deep dread, the unprepared may be punished). You CANNOT see the room itself \u2014 only your ally can, through atmosphere. If `whisperPending` is true, the eye hasn't spoken yet. Read-only, free.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }
      },
      {
        name: "game_await_whisper",
        description: "Wait for your human ally (the 'eye') to whisper about the room ahead. This BLOCKS until they click a whisper on their screen (up to ~25s), then returns it \u2014 so you can play room after room without the human typing anything. If it returns `pending: true` (timeout, no whisper yet), just call it again. Use this instead of repeatedly polling game_look while waiting. Free.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }
      },
      {
        name: "game_open_box",
        description: "Buy ONE single-use item for the NEXT room (it applies to that room only, then it's gone \u2014 no stockpiling). Three strategies:\n  \u2022 weapon \u2014 adds to your d100 roll (Dagger +10 / Sword +20 / Cannon +30), improving your chance to clear UNHARMED.\n  \u2022 potion \u2014 reduces the HP you lose IF you fail (Adrenaline -4 / Poison -8 / Vampire -12). Insurance.\n  \u2022 medic \u2014 restores HP immediately (Bandage +15 / Medkit +30 / Healing Armour +50). Recovery.\nTiers: bronze 0.05 / silver 0.1 / gold 0.2 xGAS. Use the whisper to judge the danger: 'despair' \u2192 consider a strong weapon or save HP with a medic; 'relief' \u2192 maybe save your xGAS and go in raw. You can also go raw (don't call this) to save money. Mind your budget \u2014 you can't buy gold every room. Paid (real x402 settlement on Neo X).",
        inputSchema: {
          type: "object",
          properties: {
            category: {
              type: "string",
              enum: ["weapon", "potion", "medic"],
              description: "weapon (roll), potion (reduce fail damage), or medic (heal)."
            },
            tier: {
              type: "string",
              enum: ["bronze", "silver", "gold"],
              description: "How much to spend / how strong. Defaults to silver."
            }
          },
          required: ["category"],
          additionalProperties: false
        }
      },
      {
        name: "game_enter_room",
        description: "Open the door and face what's inside. REQUIRES your human ally (the eye) to have whispered about THIS room first \u2014 if they haven't, this fails and you must call game_await_whisper and wait. The whisper is cleared after each room, so EVERY room needs a fresh whisper before you can enter; never loop enter_room on your own. Combat is a d100 check: you roll 1\u2013100, add your weapon bonus (if any), against the room's HIDDEN difficulty. Meet or beat it \u2192 clear UNHARMED. Fall short \u2192 survive but lose HP (a potion softens it; a medic heals regardless). The outcome reveals the roll, the difficulty, and the enemy, and advances to the next room if you survive. The run ends when HP hits 0. Free.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }
      },
      {
        name: "game_reset",
        description: "Start a fresh dungeon run (HP back to 100, room 1). Free.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false }
      }
    ]
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = req.params.arguments ?? {};
    try {
      switch (name) {
        case "agent_address":
          return text({
            address: opts.account.address,
            explorer: explorer.address(opts.account.address),
            network: NETWORK
          });
        case "agent_balance": {
          const bal = await xgasBalance(opts.account.address);
          return text({
            balance: bal.toString(),
            balanceFormatted: `${formatUnits2(bal, XGAS.decimals)} ${XGAS.symbol}`
          });
        }
        case "do_work": {
          if (sessionSpent >= sessionCap) {
            return text({
              error: `session spend cap reached (${formatUnits2(sessionSpent, XGAS.decimals)} xGAS). Restart the bridge to begin a new session.`
            });
          }
          const out = await game.call("/api/work");
          sessionSpent += BigInt(out.paid.amount);
          return text({
            result: out.result,
            paid: out.paid.amountFormatted,
            txHash: out.txHash,
            txExplorer: out.txHash ? explorer.tx(out.txHash) : void 0,
            sessionSpent: `${formatUnits2(sessionSpent, XGAS.decimals)} / ${formatUnits2(sessionCap, XGAS.decimals)} ${XGAS.symbol}`
          });
        }
        case "withdraw_to_owner": {
          const amountInput = String(args.amountXgas ?? "");
          if (!amountInput) {
            return text({ error: 'amountXgas is required (e.g. "0.1" or "all")' });
          }
          const balance = await xgasBalance(opts.account.address);
          if (balance === 0n) return text({ error: "agent has zero xGAS to withdraw" });
          const value = amountInput === "all" ? balance : parseUnits(amountInput, XGAS.decimals);
          if (value <= 0n) return text({ error: "amount must be positive" });
          if (value > balance) {
            return text({
              error: `requested ${formatUnits2(value, XGAS.decimals)} xGAS, balance is ${formatUnits2(balance, XGAS.decimals)}`
            });
          }
          const authorization = buildAuthorization({
            from: opts.account.address,
            to: opts.owner,
            value,
            validitySeconds: 120
          });
          const signature = await signAuthorization(opts.account, authorization);
          const requirement = {
            scheme: "exact",
            network: NETWORK,
            asset: XGAS.address,
            payTo: opts.owner,
            amount: value.toString(),
            maxTimeoutSeconds: 120,
            extra: {
              name: XGAS.domain.name,
              version: XGAS.domain.version
            }
          };
          const payment = {
            x402Version: 2,
            accepted: requirement,
            payload: { signature, authorization }
          };
          const verify = await facilitator.verify(payment, requirement);
          if (!verify.isValid) {
            return text({ error: `facilitator rejected verify: ${verify.invalidReason}` });
          }
          const settle = await facilitator.settle(payment, requirement);
          if (!settle.success) {
            return text({ error: `facilitator settle failed: ${settle.errorReason}` });
          }
          return text({
            ok: true,
            from: opts.account.address,
            to: opts.owner,
            amount: `${formatUnits2(value, XGAS.decimals)} ${XGAS.symbol}`,
            txHash: settle.transaction,
            txExplorer: settle.transaction ? explorer.tx(settle.transaction) : void 0
          });
        }
        case "session_spent":
          return text({
            spent: `${formatUnits2(sessionSpent, XGAS.decimals)} ${XGAS.symbol}`,
            cap: `${formatUnits2(sessionCap, XGAS.decimals)} ${XGAS.symbol}`,
            remaining: `${formatUnits2(sessionCap - sessionSpent, XGAS.decimals)} ${XGAS.symbol}`
          });
        // ------------------- Dungeon (Flavor B) -------------------
        case "game_look": {
          const agent = opts.account.address;
          const url = `${opts.gameServiceUrl}/api/game/state?agent=${agent}`;
          const state = await fetch(url).then((r) => r.json());
          return text(state);
        }
        case "game_await_whisper": {
          const agent = opts.account.address;
          const url = `${opts.gameServiceUrl}/api/game/await-whisper?agent=${agent}`;
          const out = await fetch(url).then((r) => r.json());
          return text(out);
        }
        case "game_open_box": {
          if (sessionSpent >= sessionCap) {
            return text({
              error: `session spend cap reached (${formatUnits2(sessionSpent, XGAS.decimals)} xGAS). Restart the bridge for a new session.`
            });
          }
          const category = String(args.category ?? "");
          if (!["weapon", "potion", "medic"].includes(category)) {
            return text({ error: "category must be weapon, potion, or medic" });
          }
          const tier = String(args.tier ?? "silver");
          if (!["bronze", "silver", "gold"].includes(tier)) {
            return text({ error: "tier must be bronze, silver, or gold" });
          }
          const agent = opts.account.address;
          const out = await game.call(`/api/game/open?agent=${agent}&category=${category}&tier=${tier}`);
          if (out.result?.error) {
            return text({ error: out.result.error });
          }
          sessionSpent += BigInt(out.paid.amount);
          return text({
            ...out.result,
            paid: out.paid.amountFormatted,
            txHash: out.txHash,
            txExplorer: out.txHash ? explorer.tx(out.txHash) : void 0,
            sessionSpent: `${formatUnits2(sessionSpent, XGAS.decimals)} / ${formatUnits2(sessionCap, XGAS.decimals)} ${XGAS.symbol}`
          });
        }
        case "game_enter_room": {
          const agent = opts.account.address;
          const out = await game.call(`/api/game/enter?agent=${agent}`);
          return text(out.result);
        }
        case "game_reset": {
          const agent = opts.account.address;
          const url = `${opts.gameServiceUrl}/api/game/reset?agent=${agent}`;
          const state = await fetch(url, { method: "POST" }).then((r) => r.json());
          return text(state);
        }
        default:
          return text({ error: `unknown tool: ${name}` });
      }
    } catch (err) {
      return text({ error: err.message });
    }
  });
  const beat = async () => {
    try {
      await fetch(`${opts.gameServiceUrl}/api/agent/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: opts.account.address })
      });
    } catch {
    }
  };
  void beat();
  const heartbeatTimer = setInterval(() => void beat(), 15e3);
  heartbeatTimer.unref?.();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
function text(payload) {
  return {
    content: [
      { type: "text", text: JSON.stringify(payload, null, 2) }
    ]
  };
}

// src/cli.ts
var argv = process.argv.slice(2);
var command = argv[0];
async function main() {
  switch (command) {
    case "init":
      return cmdInit(argv.slice(1));
    case "status":
      return cmdStatus();
    case "start":
      return cmdStart();
    case "withdraw":
      return cmdWithdraw(argv.slice(1));
    case "help":
    case "--help":
    case "-h":
    case void 0:
      return cmdHelp();
    default:
      console.error(`unknown command: ${command}
`);
      cmdHelp();
      process.exit(1);
  }
}
function cmdHelp() {
  console.log(`x402-bridge \u2014 Neo X x402 agent wallet

usage:
  x402-bridge init [--force]      Generate a fresh agent wallet (stored at ${DEFAULT_PATH})
  x402-bridge status              Show address, xGAS balance, owner
  x402-bridge start               Run the MCP server over stdio (for Claude Desktop)
  x402-bridge withdraw <amt|all>  Send xGAS back to the owner via facilitator
  x402-bridge help                This message

env vars (required where noted):
  BRIDGE_OWNER_ADDRESS    required for init \u2014 recovery / withdraw address
  GAME_TREASURY_ADDRESS   required for start/withdraw \u2014 the game service's treasury
  GAME_SERVICE_URL        default http://localhost:8787
`);
}
async function cmdInit(args) {
  const force = args.includes("--force");
  if (walletExists() && !force) {
    console.error(
      `\u2717 wallet already exists at ${DEFAULT_PATH}. Use \`init --force\` to overwrite.`
    );
    process.exit(1);
  }
  const owner = process.env.BRIDGE_OWNER_ADDRESS;
  if (!owner || !isAddress2(owner)) {
    console.error(`\u2717 BRIDGE_OWNER_ADDRESS env var required and must be a valid 0x address.`);
    console.error(`  This is where \`withdraw\` will send funds \u2014 usually your own EOA.`);
    process.exit(1);
  }
  try {
    const { account, path } = createWallet({ owner, force });
    console.log("\u2713 agent wallet created");
    console.log("");
    console.log(`  address:   ${account.address}`);
    console.log(`  owner:     ${owner}`);
    console.log(`  network:   ${NETWORK}`);
    console.log(`  stored:    ${path}  (chmod 600)`);
    console.log("");
    console.log("  next:");
    console.log("    1. Wrap GAS \u2192 xGAS in your own wallet");
    console.log(`       (call deposit() on ${XGAS.address})`);
    console.log(`    2. Transfer xGAS to the agent address above`);
    console.log(`    3. Run \`x402-bridge status\` to confirm`);
    console.log(`    4. Run \`x402-bridge start\` and wire it into Claude Desktop`);
    console.log("");
    console.log(`  explorer:  ${explorer.address(account.address)}`);
  } catch (err) {
    if (err instanceof WalletAlreadyExists) {
      console.error(`\u2717 ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
async function cmdStatus() {
  try {
    const { file, account } = loadWallet();
    const balance = await xgasBalance(account.address);
    const ready = balance > 0n;
    console.log("");
    console.log(`  address:      ${account.address}`);
    console.log(`  owner:        ${file.owner}`);
    console.log(`  network:      ${file.network}`);
    console.log(`  xGAS balance: ${formatUnits3(balance, XGAS.decimals)} ${XGAS.symbol}`);
    console.log(`  ready:        ${ready ? "\u2713" : "\u2717 (fund with xGAS to start)"}`);
    console.log("");
    console.log(`  explorer:     ${explorer.address(account.address)}`);
    console.log(`  wallet file:  ${DEFAULT_PATH}`);
  } catch (err) {
    if (err instanceof WalletNotInitialized) {
      console.error(`\u2717 ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}
async function cmdStart() {
  const { file, account } = loadWallet();
  const treasury = process.env.GAME_TREASURY_ADDRESS;
  if (!treasury || !isAddress2(treasury)) {
    console.error(`\u2717 GAME_TREASURY_ADDRESS env var required (and must be a valid 0x address).`);
    process.exit(1);
  }
  const gameUrl = process.env.GAME_SERVICE_URL ?? "http://localhost:8787";
  console.error(`x402-bridge MCP server`);
  console.error(`  agent:    ${account.address}`);
  console.error(`  owner:    ${file.owner}`);
  console.error(`  game:     ${gameUrl}`);
  console.error(`  treasury: ${treasury}`);
  console.error(`  listening on stdio\u2026`);
  await runMcpServer({
    account,
    owner: file.owner,
    gameServiceUrl: gameUrl,
    treasury
  });
}
async function cmdWithdraw(args) {
  const amountInput = args[0];
  if (!amountInput) {
    console.error(`\u2717 usage: x402-bridge withdraw <amount|all>`);
    process.exit(1);
  }
  const { file, account } = loadWallet();
  const balance = await xgasBalance(account.address);
  if (balance === 0n) {
    console.error(`\u2717 agent has zero xGAS to withdraw.`);
    process.exit(1);
  }
  const value = amountInput === "all" ? balance : parseUnits2(amountInput, XGAS.decimals);
  if (value <= 0n || value > balance) {
    console.error(
      `\u2717 invalid amount. balance is ${formatUnits3(balance, XGAS.decimals)} ${XGAS.symbol}`
    );
    process.exit(1);
  }
  const facilitator = new FacilitatorClient();
  const authorization = buildAuthorization({
    from: account.address,
    to: file.owner,
    value,
    validitySeconds: 120
  });
  const signature = await signAuthorization(account, authorization);
  const requirement = {
    scheme: "exact",
    network: NETWORK,
    asset: XGAS.address,
    payTo: file.owner,
    amount: value.toString(),
    maxTimeoutSeconds: 120,
    extra: {
      name: XGAS.domain.name,
      version: XGAS.domain.version
    }
  };
  console.log(`\u2192 asking facilitator to settle ${formatUnits3(value, XGAS.decimals)} ${XGAS.symbol} \u2192 ${file.owner}`);
  const payment = {
    x402Version: 2,
    accepted: requirement,
    payload: { signature, authorization }
  };
  const verify = await facilitator.verify(payment, requirement);
  if (!verify.isValid) {
    console.error(`\u2717 facilitator rejected verify: ${verify.invalidReason}`);
    process.exit(1);
  }
  const settle = await facilitator.settle(payment, requirement);
  if (!settle.success) {
    console.error(`\u2717 facilitator settle failed: ${settle.errorReason}`);
    process.exit(1);
  }
  console.log(`\u2713 withdrew ${formatUnits3(value, XGAS.decimals)} ${XGAS.symbol}`);
  if (settle.transaction) {
    console.log(`  tx:       ${settle.transaction}`);
    console.log(`  explorer: ${explorer.tx(settle.transaction)}`);
  }
  void encodePaymentHeader;
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
