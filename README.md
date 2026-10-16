# Patron

**An AI agent that runs a company's contractor spend.** It holds the budget in
USDC, writes the brief, screens applicants, reviews what comes back, pays on
delivery, and leaves an audit trail of every decision it made about the money.

Settled on [Arc](https://arc.io), Circle's stablecoin-native L1, on escrow rails
I built and deployed myself.

| | |
|---|---|
| 🖥️ **Command centre** | **[patron-guild.vercel.app](https://patron-guild.vercel.app)** — live, no login |
| 💬 **Telegram bot** | **[@PatronGuildbot](https://t.me/PatronGuildbot)** — find work, deliver and get paid in a chat |
| 🙋 **Take a paid job** | [/work](https://patron-guild.vercel.app/work) — no wallet, no crypto |
| 📓 **Every decision, verbatim** | [/decisions](https://patron-guild.vercel.app/decisions) |
| 🔒 **Escrow (Arc mainnet)** | [`0xbdeb…3372`](https://explorer.arc.io/address/0xbdeb44945979a01584fd7d796a71C707D2F83372) — SecureFlow, UUPS proxy |
| 🌱 **Yield controller** | [`0x92a0…aa37`](https://explorer.arc.io/address/0x92a0C47e819b84069eb95776497421850103aa37) → Aave v4 |
| ⚙️ **Daemon health** | [/healthz](https://patron-daemon-production.up.railway.app/healthz) |
| 🌐 **Third-party view** | [secureflow.work/jobs](https://secureflow.work/jobs) — the same jobs, an interface I don't control |

---

## The problem

A business with contractors runs the same loop every time: decide what's needed,
find someone, judge whether they can do it, check the work, release the money,
remember whether they were any good. Every step needs a person, and the budget
sits idle the whole time.

Finance tools automate the **payment**. They don't make the **decision**.
Someone still reads the proposal, forms a view on the deliverable, and decides
whether this invoice gets paid today. That judgement is the work, and it's the
part nobody has automated — because to automate it you have to let software move
money on its own conclusion.

Patron is willing to. What makes that safe is the second half of the build: it
can release the escrow to the contractor, and it can **never route the escrow to
itself**. Not by bug, not by prompt injection, not by operator error. The
contract refuses, and it refuses twice — a job manager cannot hire itself as the
worker either.

## What it decides

Not *automates* — decides, and writes down why. Every row below is a public
ledger entry with its reasoning attached.

| Decision | What it weighs | So far |
|---|---|---|
| **What the job is** | Turns a sentence of intent into a brief with acceptance criteria and priced milestones | — |
| **Who gets hired** | Ranks applicants against *each other*, not against a bar in arrival order | 39 scored, 8 hired |
| **Whether to hire at all** | Declines when nobody is good enough, rather than settling | **11 times** |
| **Whether the work passes** | Fetches the deliverable: reads SVG source, image headers, transcribes audio. Never approves a submission with no artifact, on any model | 7 rejected with written feedback |
| **When to stop deciding** | Hands the call to a human arbiter at the policy threshold | **21 escalations**, 3 disputes resolved |
| **What a contractor is worth next time** | Writes a rating to the contract after payout | 8 ratings on chain |

## What's live right now

Measured from the production daemon and the chain, not estimated.

| | |
|---|---|
| People onboarded to earn | **26** — 12 web, 14 Telegram, each a real Circle MPC wallet |
| USDC locked into escrow | **$121.75** across 31 commissions |
| Paid out to humans | **$32.51** — $17.00 Arc testnet, **$15.51 Arc mainnet** |
| Agent decisions logged | **100**, each with its reasoning |
| Uptime | 27 days unattended |
| Model | `openai/gpt-oss-120b`, falling back to `openai/gpt-oss-20b` |

---

## The Telegram bot

[**@PatronGuildbot**](https://t.me/PatronGuildbot) is a complete second front
door, not a notifier. **14 of the 26 people who have earned through Patron never
opened the website.**

A person types `/start`, picks a name, and Patron provisions them a real Circle
MPC wallet and funds its gas. They never see a seed phrase, install an
extension, or learn what a chain ID is.

| Command | |
|---|---|
| `/start` | Join — provisions a wallet behind the scenes |
| `/jobs` | Open commissions, read off the contract |
| `/apply <id>` | Apply with a cover letter |
| `/submit <id>` | Deliver work — a link or a file |
| `/mine` | Your jobs and where each one stands |
| `/balance` | What you've earned |
| `/withdraw <addr>` | Cash out, on Arc or any CCTP chain |

Push, not polling: applicants hear the moment they're hired, when work is
approved, when a revision is requested and why, and when money lands. Clients
can link a chat and get the same trail for commissions they funded.

Their applications land on the same contract as everyone else's — the agent
cannot tell which door someone came through, and neither can the chain.

---

## How it works

```
Client (human wallet, or an AI agent paying via x402)
   │
   ▼
Patron daemon ──────────────────────────────────────────────┐
   │  brief → escrow → score → hire → review → pay → rate   │
   │  every step written to a public decision ledger        │
   ▼                                                        │
SecureFlow (UUPS proxy, Arc mainnet)                        │
   │  milestones · disputes · ratings · job managers        │
   ├── SecureFlowYield ──► Aave v4 on Arc                   │
   │      idle budget earns; 60% of it to the contractor    │
   └── CCTP v2 (domain 26) ──► Base, Arbitrum, Ethereum, +6 │
          contractor paid in native USDC on their own chain │
                                                            │
Two front doors over one layer: web + Telegram ◄────────────┘
```

**Why a daemon and not a browser app:** the agent runs server-side, 24/7. Close
the laptop and it keeps hiring, reviewing and paying. No private key ever
reaches a browser bundle.

### Circle stack — all load-bearing

| | How it's used |
|---|---|
| **Agent Wallets** (dev-controlled MPC) | Patron's treasury is one; so is every wallet provisioned for a human. 26 created. |
| **x402 Nanopayments** | Both directions: agents commission Patron behind a 402 paywall, and Patron pays a portfolio-verification service mid-job. |
| **Circle Gateway** | Gasless batching of those authorizations. |
| **CCTP v2** | Cross-chain contractor payouts. Arc is domain 26. |
| **Arc** | USDC is the native gas token, so escrow, fees and payouts are one asset. |

### Productive escrow

Idle budget is supplied to **Aave v4 on Arc** (adapter
[`0x65317ec4…01Fe`](https://explorer.arc.io/address/0x65317ec4060c195f94C22CfD62C40742a21301Fe),
~35M USDC of available liquidity). **60% of anything earned goes to the
contractor**, not to us.

Nothing is lent while a job is still open, because an open job is refundable in
full at any instant — the contract keeps it in cash and the investable ceiling
is derived from the largest claim that could arrive next, not from a percentage.
Earning begins when someone is hired.

---

## What a judge can verify without trusting us

- **The same jobs on an interface I don't control** —
  [secureflow.work/jobs](https://secureflow.work/jobs). A separate application,
  separate deployment, same contract. Patron's board reads the chain, so a job
  posted there appears here and vice versa.
- **Every payment** on [explorer.arc.io](https://explorer.arc.io).
- **Ratings** straight off the contract with `getAverageRating`.
- **Every decision the agent has made**, verbatim, at
  [/decisions](https://patron-guild.vercel.app/decisions).
- **Your own application** — join at
  [/work](https://patron-guild.vercel.app/work) or the bot and find it on chain
  next to everyone else's.

## Correctness guardrails

The interesting engineering here is what stops the agent being confidently
wrong about money. Each of these exists because it went wrong once:

- **Nothing is approved without an artifact.** A model once scored "I finished
  it, trust me" at 100/100. The guard is model-independent and tested against
  every model before it ships.
- **Prompt injection is caught and scored near zero**, whether it arrives in a
  cover letter or inside a fetched portfolio page.
- **Unreadable ≠ unqualified.** If we can't fetch a deliverable or a cover
  letter, the applicant is reported unassessed rather than scored zero — the
  limitation is ours, not theirs.
- **Status comes from the chain, never from our own database.** Applicants,
  milestones, the job board and dispute settlement all read the contract.
- **Every commission knows which chain its escrow id means something on.**
  Escrow ids are per-deployment counters; a row from another network names a
  different job.
- **Verification scripts over assumptions** — `verify-abi` (does our ABI decode
  the contract we're pointed at), `verify-circle` (can the entity secret
  actually *sign*, which authenticating does not prove), `verify-mainnet` (is
  this a proxy, which version, is a venue attached), `e2e-agent` (21 payout
  guards that must hold on every model), `e2e-cctp` (10 checks, real burn, real
  attestation).

## Run it

```bash
# daemon — the agent
cd daemon && npm ci && cp .env.example .env   # fill in the Circle + Groq keys
npm run dev                                   # http://localhost:8787

# command centre
cd web && npm ci && npm run dev               # http://localhost:5173

# before trusting any of it with money
cd daemon
npx tsx scripts/verify-mainnet.ts   # contract, proxy, version, yield venue
npx tsx scripts/verify-circle.ts    # can this key + entity secret sign?
npx tsx scripts/e2e-agent.ts        # 21 payout guards
```

`npm run build` is the typecheck that matters in `web/` — it runs `tsc -b`
against the project config and catches what `tsc --noEmit` does not.

**Chain facts.**

| | Arc mainnet | Arc testnet |
|---|---|---|
| Chain ID | `5042` | `5042002` |
| RPC | `https://rpc.mainnet.arc.io` | `https://rpc.testnet.arc.io` |
| Explorer | `https://explorer.arc.io` | `https://explorer.testnet.arc.io` |
| SecureFlow | `0xbdeb44945979a01584fd7d796a71C707D2F83372` | `0x6142bf4855D4F9dbC1cD8109377d4F4E2AF1ab59` |

USDC is the native gas token on both, and also an ERC-20 at
`0x3600000000000000000000000000000000000000` — the **same balance at two
scales**: 18 decimals native, 6 as the token. Getting that wrong is a 1e12
error.

## Stated plainly

**What's real:** the escrow is live on Arc mainnet and upgradeable, real USDC
has been paid to real people, and the agent has run unattended for a month.

**What hasn't happened yet:** no escrow has actually *earned* a cent. The venue
is attached and jobs opt in, but an open job's investable ceiling is zero by
design, so yield begins at hire and no hired job has run its course on mainnet.

**What's taken on trust:** taste, originality and licensing can't be checked
from bytes. Those are taken at the contractor's word, marked as such, and backed
by revision rounds and a human arbiter.

**What's wrong with the business today:** Patron fronts the job budget for a
flat commission. Fine for a demo, wrong for a company — the fix is the buying
agent funding escrow directly.

**Where it's thin:** 26 contractors and 2 paying clients. The supply side is
real; the demand side is the work.

---

Built by [Gbangbola Oluwagbemiga](https://x.com/GbangbolaPhilip) on
[SecureFlow](https://secureflow.work), an escrow protocol I wrote and shipped as
its own product. Patron didn't scaffold a contract for a hackathon — it's an
agent built on rails that already existed.
