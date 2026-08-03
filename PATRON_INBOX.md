# Patron Inbox — the human front door

**Revised Aug 3, 2026** — rewritten against the code as it actually stands today.
Submission Aug 10 · Demo Day Aug 20.

---

## The reframe: the bot is a surface, not the feature

The original draft described this as "a Telegram bot." That undersells it and, more
practically, it mis-sequences the work.

**The feature is a managed-worker layer**: a human identity that owns a real Circle MPC
wallet, applies to real escrows on-chain, and gets paid — without that human ever holding a
key, installing a wallet, or learning what a chain is. That layer is ~70% of the build and
is completely **surface-agnostic**.

Telegram is one way to reach it. A page on our own site is another. Both are thin once the
layer exists, which means the surface decision is *reversible* and should not block the
start of the work.

```
                    ┌──────────────────────────────┐
  Telegram bot ────▶│   THE WORKER LAYER           │
                    │   users table                │──▶ applyToJob
  /work web page ──▶│   Circle MPC wallet per user │──▶ submitMilestone   ON-CHAIN
                    │   gas drip on signup         │──▶ (existing escrow)
  SecureFlow dApp ─▶│   signer-parameterised writes│
  (own wallet)      └──────────────────────────────┘
                                  │
                                  ▼
                    the daemon's existing poller reads
                    the subgraph and cannot tell which
                    door any applicant came through
```

---

## Why it's worth the remaining week

**The hole it fills.** Our pitch is *"the human-labor endpoint of the agent economy."* The
sharpest question a judge can ask is *"would a real freelancer use this — how many have you
onboarded?"* Today the honest answer is **zero, and structurally zero**: taking a $10 gig
currently requires installing MetaMask, adding a custom network by chain ID, sourcing gas,
finding the right escrow, and signing two transactions. Our "marketplace" is three test
wallets we created ourselves.

**What it converts:**

| | Today | With the worker layer |
|---|---|---|
| Freelancers | 3 scripted test wallets | real people, onboardable on stage |
| Injection defense | one attempt we wrote ourselves | strangers writing real cover letters |
| Reputation | derived from our own run history | `submitRating` / `getAverageRating` — **already in the ABI**, real humans rating each other on-chain |
| *"Would anyone use this?"* | no answer | a QR code |
| Demo ending | a dashboard incrementing | a person getting paid |

The reputation row is the one people underrate. Plenty of projects claim behaviour-based
reputation and compute it from a hardcoded table. `submitRating` is already in the contract
we're using — real humans accumulating on-chain ratings falls out of this nearly free, and
it's the difference between a claim and a fact.

**Why nobody can copy it in the final week.** A competitor can clone a contract over a
weekend. They cannot clone twenty real people who already have accounts.

---

## How it fits the code we actually have

Verified against the repo today, not assumed:

**1. The poller watches the chain, not applicants.** `daemon/src/index.ts` queries the
GoldSky subgraph every 15s for applications and submissions. It has no concept of who
produced them. **Consequence:** a new door into `applyToJob` flows into
`reviewApplications` → `acceptFreelancer` → `reviewMilestone` → `approveMilestone` with
zero changes to `ApplicationScorer`, `WorkReviewer`, `BriefGenerator`, `AgentClient`,
`store.ts`, the SSE stream, or the frontend.

**2. The ABI already has everything.** Confirmed present in `SecureFlowABI.json`:
`applyToJob`, `submitMilestone`, `startWork`, `submitRating`, `getAverageRating`.
No contract work. None.

**3. The signer refactor is genuinely contained.** `secureflow.ts` calls
`createCircleSigner()` in **5 places**, each at the top of a write function. Threading an
optional signer parameter through is mechanical. It is still the one change that touches
working code, so it goes first, with `npm run e2e` as the check.

**4. On Arc, gas and earnings are the same balance.** Arc's native currency is USDC, also
exposed as an ERC-20. One small transfer covers gas *and* is the asset they get paid in —
so a new worker can never hit the classic trap of holding tokens with no gas to move them.
On any other chain this feature needs a separate gas-sourcing story per user.

**5. We already wrote the reference implementation.**
`daemon/scripts/seed-freelancers.ts` creates wallets and calls `applyToJob` today. The
worker layer is that script with real people instead of hardcoded cover letters.

---

## Custody, stated precisely

A crypto-literate judge will ask this, and a fuzzy answer reads as not understanding your
own model.

- Wallets are **Circle MPC**. The SDK surface is `createWallet` / `signMessage` /
  `signTransaction` / `signTypedData` — there is **no export and no reveal**, because with
  MPC no assembled key exists anywhere to hand over.
- **Patron never holds their money.** On approval the escrow contract pays the worker's
  wallet directly. Patron is not a custodian of funds; it is a signer of instructions.
- The exit is `/withdraw <address>`, not `/export`. One transfer, ~30 lines.

> **Her money is fully hers and fully extractable. The key is not extractable by anyone.**

**Two modes, because forcing everyone into managed custody is wrong:**

| | Managed (default) | Bring your own wallet |
|---|---|---|
| For | never touched crypto | already has MetaMask |
| Signs | Patron, on their tap | they do |
| Cost to build | the layer above | ~40 LOC — already works via SecureFlow's own dApp |

Mode B costs almost nothing *because of the noticeboard property*: a crypto-native
freelancer can already apply through `secureflow-arc.vercel.app` today and our guild master
scores them identically. Graduation is `/withdraw` then `/switch-to-own-wallet`.

**Say the testnet caveat before a judge does:** this is testnet USDC. Levels 1–2 (leave it,
move it) work identically on mainnet with no code change. Turning it into spendable local
cash is an off-ramp integration and is genuinely out of scope — but USDC is the easiest
asset in the world to off-ramp, and that's the honest answer.

---

## So — are we still doing a Telegram bot?

**Yes, and it should not be the only door.** Given what we now have, I'd ship the web
surface first and Telegram alongside it:

| | `/work` page on our own site | Telegram bot |
|---|---|---|
| Install required | **none** — it's a URL | Telegram |
| Judge can try it live | scans a QR, works in 20s | only if they have Telegram |
| Reuses the new UI | yes, entirely | no, separate surface |
| Push notification | needs opt-in | **native, and dramatic** |
| Where freelancers already are | nowhere yet | crypto freelancers, yes |
| Build cost after the layer | ~0.5 day | ~1 day |

The web page is the better *demo* — zero install, works on any screen, and a judge in the
audience can become a real freelancer from their own phone during the pitch. Telegram is the
better *product* — native push is what makes "her phone buzzes and she gets paid" real, and
it's genuinely where crypto-adjacent freelancers live.

They are not competing: after the worker layer, the second surface is about a day. My
recommendation is web first (it de-risks the demo), Telegram second (it wins the story).

---

## Plan, adjusted for our real blockers

Two things gate this, and neither is code:

- 🔴 **Groq quota.** Ten real people running real quests is far more scoring than
  100k tokens/day. Onboarding before the tier is fixed means the bot fails in front of real
  users. **This must be sorted before onboarding day.**
- 🔴 **Treasury.** $3.27. Real workers need real escrows funded, plus a gas drip per signup.

| When | What |
|---|---|
| **Aug 3** | Signer refactor (5 call sites) + `applyToJob`/`submitMilestone` in `secureflow.ts`. `npm run e2e` is the gate. No quota or funds needed. |
| **Aug 4** | `users` table, Circle wallet provisioning, gas drip. Test with 10 wallets — **now, not on the 19th**, since Circle testnet quota is unknown. |
| **Aug 5** | `/work` page on the existing site: claim identity → see open quests → apply → submit. Reuses the UI. |
| **Aug 6** | **Vision reviewer.** `WorkReviewer` currently grades *a paragraph describing* a logo; our pitch says "a logo with taste." Once uploads flow through a real surface, pipe the actual image into a vision model. Half a day, closes the sharpest hole in the AI story. |
| **Aug 7** | Telegram bot as the second door + notification channel. |
| **Aug 8** | Onboard ~10 real people. Whatever breaks here would have broken on stage. |
| **Aug 9** | Seed production, rehearse, record the video. |
| **Aug 10** | Submit. |

**Cut to make room** (all genuinely optional): second-agent chain, Gateway cross-chain
withdraw, marketplace listing, `patron-mcp`. Inbox + vision beats all four combined.

---

## Risks

| Risk | Mitigation |
|---|---|
| Signer refactor breaks working code | It goes first, on day one, with the e2e loop as the check. |
| Circle wallet quota/latency on testnet | Provision 10 on day two. Fallback: encrypted hot wallets in SQLite (weaker custody story, but it ships). |
| Sybil — one person, ten accounts | One identity = one wallet; lean on per-address on-chain rating history. Have the answer ready. |
| "Testnet USDC isn't money" | Say it first. Consider paying two people something real out of band so we can say that honestly too. |
| Live demo depends on wifi | Record a clean run as backup and play it if the room is bad. |
| Public jobs mean unscripted applicants | Mostly a feature — real untrusted input for the injection defense. But test it before Demo Day rather than discovering it live. |

---

## One line

> **Today a human must become a crypto user before earning $1 from Patron. After this, they
> need a link.**
