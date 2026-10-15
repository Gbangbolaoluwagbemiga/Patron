# Patron — Tameion submission

**An AI agent that runs a company's contractor spend.**

| | |
|---|---|
| 🖥️ Command center | [patron-guild.vercel.app](https://patron-guild.vercel.app) — live, no login |
| 🙋 Take a paid job | [/work](https://patron-guild.vercel.app/work) — no wallet needed |
| 💬 Telegram | [@PatronGuildbot](https://t.me/PatronGuildbot) |
| 📓 Every decision, verbatim | [/decisions](https://patron-guild.vercel.app/decisions) |
| 🔒 Escrow (Arc mainnet) | [`0xbdeb…3372`](https://explorer.arc.io/address/0xbdeb44945979a01584fd7d796a71C707D2F83372) — UUPS proxy |
| 🌱 Yield controller | [`0x92a0…aa37`](https://explorer.arc.io/address/0x92a0C47e819b84069eb95776497421850103aa37) |
| 💻 Repo | [github.com/Gbangbolaoluwagbemiga/Patron](https://github.com/Gbangbolaoluwagbemiga/Patron) |

---

## Requests for Builders

**RFB 03 — Contractor & Vendor Network Manager** *(primary)*. Its four asks, and
where each one lives:

| The RFB asks for | Patron |
|---|---|
| Milestone payments tied to completed work | Escrow releases per milestone, only after the deliverable is fetched and judged |
| Contractors scored on delivery | A rating is written to the contract after payout — **8 ratings on chain** across 3 contractors today |
| Screening at onboarding | Applicants scored comparatively on capability, brief fit, timeline and on-chain history; injection attempts caught and zeroed |
| Matching vendors to new needs | Hiring reads `getAverageRating` from the contract, so the last job informs the next one |

**RFB 04 — Autonomous Business Operator.** Holds USDC, weighs obligations against
liquidity, pays for services inside an owner-set spend cap, logs its reasoning
on every call, and escalates to a human arbiter at the policy threshold — which
it has done **21 times** rather than guess.

**RFB 01 — Intelligent Business Treasury.** Idle escrow is put to work through
the yield controller above and unwound when an obligation comes due, with the
return split 60/40 to the contractor.

## What it actually decides

The distinction Tameion draws is *decides* versus *automates*. Patron's calls
are the ones a finance lead would make, and each is a row in a public ledger
with the reasoning attached:

- **What the job is** — a sentence of intent becomes a brief with acceptance
  criteria and priced milestones.
- **Who gets hired** — applicants are ranked against *each other*, not against a
  threshold in arrival order. It has declined to hire anyone **11 times** because
  nobody was good enough.
- **Whether the work passes** — it fetches the actual deliverable. An SVG's
  source is read, image dimensions come from the file header, audio is
  transcribed. A submission with no artifact is never approved, on any model.
- **Whether to pay, revise, or escalate** — release, or written feedback and a
  revision round, or hand the call to a human. **7 rejections** so far, each with
  the unmet criteria named.
- **What the contractor is worth next time** — a rating on the contract, which
  nobody can quietly recalculate to flatter us.

## The trust layer

Patron holds a **one-way key**: it can release the escrow to the contractor and
it can never route the escrow to itself. Not by bug, not by prompt injection,
not by operator error — the contract enforces it, including refusing to let a
job manager hire itself as the worker.

Money nobody earned comes back. A job that attracts no suitable applicant is
cancelled and refunded when its deadline passes. A job that runs overdue goes to
a human arbiter, not to an automatic ruling against a contractor who may have
delivered.

## Circle tools, all load-bearing

- **Agent Wallets** — Patron's treasury is one, and so is every wallet it
  provisions for a human. 26 provisioned to date.
- **x402 Nanopayments** — both directions: agents commission Patron, and Patron
  pays other services mid-job to verify applicants.
- **Circle Gateway** — gasless batching of those authorizations.
- **Arc** — USDC is the native gas token; escrow, fees and payouts are one asset.
- **Arc Studio CLI + Circle Skills** — used to build against the chain.

## Traction

Measured from the production daemon and the chain, not estimated.

| | |
|---|---|
| People onboarded to earn | **26** — 12 via web, 14 via Telegram, every one a real Circle MPC wallet |
| USDC locked into escrow | **$121.70** across 29 jobs |
| USDC paid out to humans | **$32.51** — $17.00 on Arc testnet, **$15.51 on Arc mainnet** |
| Jobs completed | **10** |
| Agent decisions logged | **100** — 39 scorings, 8 hires, 7 rejections, 21 escalations, 3 disputes resolved |
| Ratings written to the contract | **8** |
| Continuous uptime | 27 days unattended |

The honest shape of it: **26 contractors, 2 paying clients.** The supply side of
this market is real and the demand side is where the work is.

## What a judge can verify without trusting us

- **The same jobs on an interface we don't control** —
  [SecureFlow's own dApp](https://secureflow-arc.vercel.app/jobs), a separate
  application on a separate deployment reading the same contract. What you see
  there is the chain, not our rendering of it.
- **Every payment** on [explorer.arc.io](https://explorer.arc.io).
- **Ratings** straight off the contract with `getAverageRating`.
- **Every decision the AI has ever made**, verbatim, at
  [/decisions](https://patron-guild.vercel.app/decisions).
- **Their own application** — join at [/work](https://patron-guild.vercel.app/work)
  and find it on chain next to everyone else's.

## Stated plainly

What is real: the escrow is live on Arc mainnet and upgradeable, real USDC has
been paid to real people, and the agent has run unattended for a month.

What is real but unproven: **escrowed funds can earn, and none has yet.** The
yield controller `0x92a0…aa37` is attached to the escrow in both directions,
with an **Aave v4 adapter** at `0x65317ec4…01Fe` holding reserve 0 against
**35.1M USDC of available liquidity** on Arc mainnet. The opt-in path works and
two mainnet escrows have taken it. The freelancer's share of whatever is earned
is 60%.

What has not happened is a single cent actually being deployed, and the contract
is right to refuse. An open job is refundable in full by `cancelJob` at any
instant, so its investable ceiling is exactly zero until a freelancer is
assigned — the cap is derived from the largest claim that could arrive next, not
from a percentage. So yield begins at the moment someone is hired, and every
escrow that has opted in so far either finished or is still open.

We checked this the wrong way first, and the mistake is worth stating because it
is the one this whole system is built against: the adapter map is keyed by
token, we read `yieldAdapter(address(0))` on the reasoning that USDC is Arc's
native asset, got a zero, and concluded there was no venue. SecureFlow files
USDC under the ERC-20 precompile `0x3600…`. The lookup answered a different
question than the one asked and returned a plausible zero.

What is taken on trust: taste, originality and licensing cannot be checked from
bytes. Those are taken at the contractor's word, marked as such, and backed by
revision rounds and a human arbiter.

What is wrong with the business today: Patron fronts the job budget for a flat
commission. That is fine for a demo and wrong for a company — the fix is the
buying agent funding escrow directly.
