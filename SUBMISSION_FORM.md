# Tameion submission form — paste-ready answers

Every figure here was read from production or the chain on 15 Oct 2026, not estimated.

---

## Github Handle *
```
Gbangbolaoluwagbemiga
```

## Which team members have already participated in previous Canteen x Arc hackathons (e.g. Lepton, Agora)? *

> **Correct the "Lepton" currently in this field.** It asks specifically about
> **Canteen × Arc** events. Encode's Programmable Money hackathon was neither —
> different organiser, different programme. Claiming Lepton would be a false
> statement on the form and is easily checked.

```
None. This is my first Canteen x Arc hackathon.
```

---

## Is this a continued project from a prior hackathon? Or part of a longer term business or project you have been building? *

```
Yes — but not from a Canteen or Arc event. Patron was built for Encode's
Programmable Money hackathon in August 2026 (shortlisted, not placed). It has
never been submitted to Lepton or Agora. I have received no awards or grants
from Circle or Canteen.

The longer-term project is actually SecureFlow, the escrow protocol underneath
it, which I built and shipped as its own product with its own front end
(secureflow.work) and its own users. Patron is an AI agent built on top of
rails that already existed — not a contract scaffolded for a hackathon.

What I built during Tameion:

Patron moved from Arc testnet to Arc MAINNET and now runs on real USDC. That
meant a Circle Agent Wallet on the ARC blockchain, an upgradeable UUPS
SecureFlow proxy (0xbdeb44945979a01584fd7d796a71C707D2F83372, version
3.10.1-overdue-fix), and an agent that could be trusted with live money.

Getting there surfaced eight real bugs, each of which could silently move or
misreport money, and each is now fixed and committed with its reasoning:

1. Circle Gateway and the entire x402 buy path were hardcoded to arcTestnet
   while the daemon ran on mainnet. The testnet GatewayWallet has NO CODE on
   mainnet, and a call to a codeless address does not revert — it succeeds as a
   no-op. deposit() approved real USDC, called a dead address, got a successful
   receipt, and reported the money was in Gateway when it had never left.
2. The spend caps config.ts had always defined were read by nothing. The amount
   handed to the MPC signature was whatever a seller put in its 402 response.
3. The escrow status enum had drifted into a hybrid of two orderings, so an
   EXPIRED escrow still holding money was recorded as refunded.
4. getLogs used a 9,000-block window measured against a different RPC than the
   one configured, so every log scan silently failed — including the
   DisputeResolved reader that is the only authority on how a disputed escrow
   was split.
5. The ABI described an older build of the contract, so the yield controller
   the escrow has had attached all along was unreachable by the agent.
6. Task rows carried no chain id, so after the cutover the agent began
   escalating and reclaiming 31 testnet escrows against mainnet.
7. Hiring read applicants from a subgraph bound to one deployment, behind a
   config gate that could silently stop the entire poller.
8. The job board asked our own database which jobs existed, so two funded open
   commissions on mainnet were invisible to every freelancer.

Then two new capabilities: CCTP v2 cross-chain payouts, and productive escrow —
idle budget supplied to Aave v4 on Arc with 60% of the yield going to the
contractor.

19 commits, 33 files, +4,016 / -274 lines during the event window.
```

---

## Problem Statement *

```
A business with contractors runs the same loop every time: decide what is
needed, find someone, judge whether they can do it, check the work, release the
money, and remember whether they were any good. Every step needs a person, and
the budget sits idle in an account the whole time.

Finance tools automate the PAYMENT. They do not make the DECISION. Someone
still reads the proposal, forms a view on the deliverable, and decides whether
this invoice gets paid today. That judgement is the work, and it is the part
nobody has automated — because to automate it you have to let software move
money on its own conclusion.

Patron is willing to. The reason that is safe is the second half of the build:
it can release the escrow to the contractor and it can never route the escrow
to itself. Not by bug, not by prompt injection, not by operator error. The
contract will not let it, and it refuses to let a job manager hire itself as
the worker.

The problem is not "paying people is slow". It is that no human will work for
an AI that might not pay, and no business will let an AI spend without a cage.
Escrow with a one-way key is what makes both sides possible at once.
```

---

## Project Description *

```
Patron is an AI agent that runs a company's contractor spend. It holds the
budget in USDC, writes the brief, screens applicants, reviews what comes back,
pays on delivery, and leaves an audit trail of every decision it made about the
money.

WHAT IT DECIDES (not automates — decides, and writes down why):

- What the job is: a sentence of intent becomes a brief with acceptance
  criteria and priced milestones.
- Who gets hired: applicants are ranked against EACH OTHER, not against a
  threshold in arrival order. It has declined to hire anyone 11 times because
  nobody was good enough.
- Whether the work passes: it fetches the actual deliverable. An SVG's source
  is read, image dimensions come from the file header, audio is transcribed. A
  submission with no artifact is never approved, on any model.
- Whether to pay, revise, or escalate: release, or written feedback and a
  revision round, or hand the call to a human arbiter. 7 rejections so far,
  each naming the unmet criteria, and 21 escalations rather than guess.
- What the contractor is worth next time: a rating written to the contract
  after payout, so the next hiring decision is informed by the last one.

HOW IT WORKS

Settles on Arc, where USDC is the native gas token, so escrow, fees and payouts
are one asset. Escrow is SecureFlow, an upgradeable UUPS proxy I wrote and
deployed (0xbdeb44945979a01584fd7d796a71C707D2F83372).

Idle budget is put to work: a SecureFlowYield controller supplies it to Aave v4
on Arc (adapter 0x65317ec4060c195f94C22CfD62C40742a21301Fe, ~35.1M USDC of
available liquidity), with 60% of anything earned going to the contractor.
Nothing is lent while a job is still open, because an open job is refundable in
full at any instant — so the contract keeps it in cash and earning begins at
hire.

Contractors can be paid on whichever chain they use. CCTP v2 burns USDC on Arc
(domain 26) and mints native USDC on Base, Arbitrum, Ethereum and six others —
no bridge, no wrapped asset, no pool to drain.

A human can take a paid job without touching crypto: they pick a name and
Patron silently provisions them a real Circle MPC wallet, funds its gas, and
signs on their instruction. Two doors — a web page and a Telegram bot — over
one identical layer.

CIRCLE / ARC STACK — all load-bearing
- Circle Agent Wallets (developer-controlled MPC): the treasury is one, and so
  is every wallet provisioned for a human. 26 created to date.
- x402 Nanopayments, BOTH directions: agents commission Patron behind a 402
  paywall, and Patron pays a portfolio-verification service mid-job.
- Circle Gateway: gasless batching of those authorizations.
- CCTP v2: cross-chain contractor payouts.
- Arc: USDC-native gas, upgradeable escrow, Aave v4 for yield.

TECH: TypeScript, node:sqlite on a persistent volume, viem, Foundry/Solidity
(UUPS proxy), Groq (openai/gpt-oss-120b, falling back to gpt-oss-20b) with
zod-validated structured outputs and prompt-injection defences, React/Vite,
Railway + Vercel.
```

---

## Traction *

```
Measured from the production daemon and the chain, not estimated.

- 26 people onboarded to EARN — 12 via the web, 14 via Telegram — each with a
  real Circle MPC wallet provisioned for them.
- $121.70 locked into escrow across 29 commissions.
- $32.51 paid out to humans: $17.00 on Arc testnet, and $15.51 in REAL USDC on
  Arc mainnet.
- 10 jobs completed end to end.
- 100 agent decisions logged with their reasoning: 39 applicant scorings, 8
  hires, 7 rejections with written feedback, 21 escalations to a human, 11
  times it declined to hire anyone, 3 disputes resolved.
- 8 ratings written to the contract, readable by anyone without trusting us.
- 27 days of continuous unattended uptime.

During Tameion specifically: the agent opened its first escrow on Arc MAINNET
with real USDC (escrow #6, tx 0x1febfa20b545965539bfc4519da625a422a38faee049fba
5f96b0fe44400c071), opted it into yield on chain, and executed two CCTP v2
burns to Base, both attested by Circle (the second in 11 seconds).

Honest shape of it: the supply side is real — 26 contractors — and the demand
side is where the work is. Two paying client addresses so far. I would rather
state that than inflate it.
```

---

## Project Source Code *
```
https://github.com/Gbangbolaoluwagbemiga/Patron
```

## Required if continuing an existing project: comparison link (diff) *
```
https://github.com/Gbangbolaoluwagbemiga/Patron/compare/727f8c1...main
```
> 19 commits, 33 files, +4,016 / −274. Baseline `727f8c1` is the last commit
> before the event window opened on 27 Sept.

## Project Live
```
https://patron-guild.vercel.app
```

## Project Video Demo *
```
NOT YET RECORDED — this is the one remaining blocker.
```

---

## (Arc OSS) Why should we choose your project? What primitives are you exposing?

```
Patron is built on SecureFlow, an escrow protocol I wrote and deployed myself,
and the pieces other Arc builders would actually reuse are in the open:

1. A UUPS-upgradeable escrow with milestone payments, multi-arbiter dispute
   resolution, on-chain ratings, and a job-manager role — an agent can be
   appointed to manage a job it cannot hire itself for. That self-dealing guard
   is enforced at two separate points in the contract.

2. A yield layer with a deliberately tiny adapter interface (deposit, withdraw,
   totalAssets, maxWithdrawable, availableLiquidity). Escrow holds other
   people's money, so it is allowed to know as little about a venue as
   possible. The investable ceiling is derived from the largest claim that
   could arrive next, not from a percentage — a fuzzer broke the percentage
   version in a few thousand calls. An Aave v4 adapter for Arc is included.

3. Patterns for Arc specifically that cost me real time to learn:
   - USDC is the native asset at 18 decimals AND an ERC-20 at 6 decimals, the
     same balance at two scales. Getting this wrong is a 1e12 error.
   - The public RPC caps getLogs at 10,000 blocks (~3 hours at ~1s blocks), so
     any backfill must be chunked, anchored and resumable.
   - Circle's EIP-1193 provider REJECTS an EIP-712 domain carrying chainId.
   - Choosing the Gateway chain config by name rather than by chain id points
     you at contracts with no code, which succeed as no-ops.

4. Verification scripts that are the actual lesson: verify-abi (does our ABI
   decode the contract we are pointed at), verify-circle (can the entity secret
   actually SIGN, which authenticating does not prove), verify-mainnet (is this
   a proxy, which version, is a yield venue attached), and a wallet diagnostic
   page for EIP-6963 multi-wallet conflicts.

Compared to circlefin/arc-* I add the layer above the primitives: an escrow
with a real dispute system, a yield layer safe enough to point at live escrow,
and an agent that makes money decisions inside a cage it cannot open.
```

---

## Circle / Arc Feedback

```
WHAT WORKED

- Agent Wallets through viem's WalletClient is the right shape. One code path
  signs both EIP-712 payment authorizations and arbitrary contract writes, so
  no hybrid custody (MPC for payments, hot wallet for contracts) was needed.
- USDC as native gas removes an entire class of problem. A worker funded with
  one transfer has both gas and asset.
- CCTP v2 on Arc was the smoothest part of this build. Correct first try,
  attested in 11 seconds, fees quoted at 0bps.

WHERE IT COULD IMPROVE — each of these cost me hours

1. CHAIN_CONFIGS in @circle-fin/x402-batching is keyed by NAME ("arc" vs
   "arcTestnet"). Picking the wrong one silently points at addresses with no
   code on that chain, and an EVM call to a codeless address SUCCEEDS as a
   no-op — so deposits reported success while moving nothing. Please key these
   by chain id, or have the client assert the contract has code at startup.

2. The entity secret is registered PER ENVIRONMENT, and testnet and mainnet are
   separate entities. Nothing in the API surfaces this until you attempt a
   signature: the key authenticates, GET entity/publicKey returns a key, and
   only signing fails with "The provided entity secret is invalid" — at the
   exact moment you are locking a client's money. A preflight endpoint that
   answers "can this key+secret sign for this wallet" would have saved a day.

3. Circle's EIP-1193 provider rejects an EIP-712 domain containing chainId with
   a generic "Invalid parameters were provided to the RPC method". The message
   does not say which parameter. It also does not implement personal_sign.

4. Arc's native/ERC-20 decimal split (18 vs 6 for the same balance) needs to be
   louder in the docs. It is correct and sensible, and it is a 1e12 error
   waiting to happen in any code that formats gas.

5. The public Arc RPC rate-limits with "Request exceeds defined limit", which
   viem surfaces as a contract revert. A revert implies the CONTRACT refused;
   this is the node refusing. A distinguishable error code would stop people
   debugging their contract when the problem is their request rate.

6. getLogs caps at exactly 10,000 blocks. At ~1s blocks that is under 3 hours
   of history, which makes raw getLogs unusable for any backfill. Worth saying
   plainly in the docs next to an indexer recommendation.

7. On Arc, `finalized` can be AHEAD of `latest` (measured: latest 0x18e0b3f,
   finalized 0x18e0b41). It follows from single-slot finality, but any code
   computing confirmation depth as latest - txBlock will go negative.

8. USYC is listed as Arc's yield option but has totalSupply 0 on Arc mainnet
   and is permissioned with a $100k minimum. Aave v4 IS live and permissionless
   there with ~$10M of deposit headroom — that is the usable answer, and it is
   much harder to find than USYC.
```
