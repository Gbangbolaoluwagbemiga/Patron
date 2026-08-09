# Patron — Pitch Deck (Manus-ready)

**Supersedes `PRESENTATION_OUTLINE.md`**, which was written for Checkpoint 2 and
is now materially wrong — it still promises an end-to-end loop as upcoming work,
carries the old headline, and quotes budgets that don't match anything that ran.
Keep the old file for history; present from this one.

All figures below were read from production on **9 Aug 2026 (evening)**. Re-read them off
the Ledger before you present — they move.

---

## Paste this into Manus first

> Build a 14-slide pitch deck for **Patron**, a marketplace where AI agents hire
> and pay human freelancers through on-chain escrow.
>
> **Tone:** confident, technical, understated. This is a working production
> system with real users, not a concept — the deck should feel like evidence,
> not salesmanship. No stock photos of robots shaking hands. No hexagon-grid
> blockchain clip art.
>
> **Visual direction:** dark background (near-black, warm rather than blue).
> One accent colour: antique gold `#C9A227`. Body text off-white `#F2EFE6`.
> A serif display face for headlines (Playfair Display or similar) and a clean
> sans for body (Inter). The feel is a ledger in a guild hall — old-world
> bookkeeping, not neon cyberpunk.
>
> **Layout rules:** one idea per slide. Never more than 5 bullets. Numbers get
> to be huge. Slides carry headlines and evidence; the speaker notes carry the
> argument. Leave real whitespace.

---

## Slide 1 — Title

**On slide:**
> # Patron
> ### AI pays. Human works. Escrow settles.
>
> The human-labour endpoint of the agent economy
>
> Encode Programmable Money Hackathon · Agentic Economy Track

**Notes:** One breath before anything else: *"AI agents can already pay for data,
inference, compute and voice. They can't pay for taste. Patron is where that
changes."*

---

## Slide 2 — The gap

**On slide:**
> ## Circle's Agent Marketplace: 41 services.
> ## Every one of them is a machine.
>
> A logo with an idea in it. A voiceover with warmth. Writing with a point of view.
>
> **There is no shop for that.**

**Notes:** The marketplace is genuinely good — 41 services an agent can hire
autonomously. But walk the list: data feeds, inference, analytics, synthesis.
All machine output. The moment a task needs human judgment, the marketplace has
nothing to offer. That's not a small gap, it's the entire category of work that
still requires a person.

---

## Slide 3 — The pitch, in one sentence

**On slide:**
> AI agents pay Patron via **x402**.
> Patron hires, manages, and pays real humans through **on-chain escrow**.
>
> No human approval step.
> No way for any machine in the chain to steal.

**Notes:** Say it slowly; it's the whole product. Emphasise *"no human approval
step"* — this runs unattended — and *"no way to steal"*, which is the structural
guarantee that makes the first half economically possible.

---

## Slide 4 — This is running in production

**On slide — big numbers, minimal words:**

> ## 27 commissions · 24 humans · 77 applications scored
>
> 14 hires · 10 completed · 2 disputes resolved by a human arbiter
> USDC paid to real people, on Arc
>
> *Live at patron-guild.vercel.app*

**Notes:** Put this early, before the architecture. It changes the question the
judge is asking from *"does this work"* to *"how does this work"* — and the
second question is the one your architecture answers well. Say explicitly:
**nothing on that page is seeded; every figure is read from the contract and the
subgraph at page load.**

---

## Slide 5 — The inversion

**On slide:**
> Most agent demos: an AI **doing** the work.
>
> Patron: an AI **employing a human** —
> who gets paid instantly, provably, un-scammably.

**Notes:** Judges will see a lot of "agent completes task" today. This inverts
it: the agent is the employer. That shape is underexplored, and it's the one
that genuinely needs blockchain rails — a human will not do freelance work for a
bot that might ghost them. Trustless escrow isn't a bolt-on here, it's the
precondition.

---

## Slide 6 — How it works

**On slide — the guild metaphor, as four icons:**
> 🏰 **Quest givers** — AI agents. Humans can walk in too.
> ⚔️ **Adventurers** — freelancers who apply, work, get paid in USDC.
> 🧙 **Guild master** — the agent: writes the brief, scores applicants, reviews work, releases payment.
> 🔒 **The vault** — SecureFlow escrow on Arc. Locked before anyone applies.

**Notes:** The metaphor makes a technical pipeline legible in five seconds. The
line to land: *"the guild master's key turns one way — it can pay the adventurer,
it can never pocket the gold."*

---

## Slide 7 — Architecture

**On slide — render as a clean diagram, not code:**

```
Buyer Agent  (any framework · Circle Agent Wallet)
      │  x402:  request → 402 → sign (gasless) → retry
      ▼
PATRON DAEMON  (Node · runs 24/7 · Railway)
      ├─ x402 seller middleware  →  POST /api/hire
      ├─ Patron Agent Wallet     (Circle MPC · spending policies)
      ├─ Guild-master brain      BriefGenerator → ApplicationScorer → WorkReviewer
      ├─ x402 buyer side         pays marketplace services mid-decision
      ├─ SecureFlow on Arc       createEscrow · acceptFreelancer · approveMilestone
      │                          rejectMilestone · disputeMilestone
      ├─ Subgraph poller         applications & submissions arrive
      └─ SQLite + SSE
      ▼
React command centre (read-only · no keys in browser)  +  Telegram bot
      ▲
Human freelancers — apply / submit / get paid in USDC
```

**Notes:** The decision worth calling out: the agent's brain is a server-side
daemon, not the browser. *"Close the laptop and Patron keeps hiring, reviewing
and paying"* is literally true — which is what 24/7 autonomous economic activity
actually requires.

**If asked about the model:** built on structured-output APIs with the same zod
schemas either way, currently running on Groq. Swapping vendor was an import and
a call shape — zero changes to business logic, prompts, or safety checks. Say it
plainly; it's evidence of provider-agnostic design, not an excuse.

---

## Slide 8 — The trust model *(expect the hardest questions here)*

**On slide:**
> ## Two independent cages. Both Circle primitives.
>
> **1 · SecureFlow escrow — a one-way key.**
> The agent can release funds. It structurally cannot confiscate them.
>
> **2 · Agent Wallet spending policies.**
> Owner-set hard caps, independent of contract logic.

**Notes:** Slow down here. *"No human will work for an AI that might not pay.
Patron's agent can release funds — it can never confiscate them. Rejection
triggers revisions, not theft."* If asked what stops the agent going rogue: this
is the answer, and it's strong because it's structural, not a prompt instruction.
The worst a fully compromised model could do is **pay someone**.

---

## Slide 9 — When it goes wrong *(the credibility slide)*

**On slide:**
> ## Escrow #56 — a real dispute, resolved on-chain
>
> Work delivered → reviewed against the brief → **rejected, with written feedback**
> Revised → **rejected again**
> Agent stopped deciding and **escalated to a human arbiter**
> Arbiter split the disputed milestone: **$1.25 / $1.25**
>
> Worst case for a freelancer: a delay and a human review. Never a scam.

**Notes:** This is the slide that separates you from every deck that only shows
the happy path. It genuinely happened; the reasoning was written into the
dispute on-chain, and the ledger shows the split. Point out that the agent
*knew when to stop deciding* — that's the hard part of agent design, and most
demos never demonstrate it because they never let anything fail.

---

## Slide 10 — Mandatory tool mapping

**On slide — table:**

| Circle tool | How Patron uses it |
|---|---|
| **Agent Wallets** | Patron's treasury — MPC, owner-set spending caps |
| **x402 (sell)** | How agents commission Patron — paywalled `/api/hire` |
| **x402 (buy)** | Patron pays marketplace services mid-decision — 14 calls in production |
| **Circle Gateway** | Batched settlement; cross-chain payout path |
| **Marketplace** | Patron is service #42 — the human-labour endpoint |
| **Circle CLI** | Wallet provisioning, funding, policy management |
| **Circle Skills** | `circlefin/skills` installed and used in the build |
| **Arc** | SecureFlow escrow — every job flows through Arc testnet |

**Notes:** Say it explicitly: *"every row is load-bearing. Remove any one and the
demo stops working."* Plenty of hackathon projects bolt a mandatory tool on to
tick a box; this one doesn't run without any of them.

---

## Slide 11 — Why not just use Upwork?

**On slide:**
> Upwork assumes a human client, a credit card, and business hours.
>
> Our clients are **agents**. They pay per-request in USDC over x402,
> they operate at 3am, and they need **cryptographic — not reputational —**
> guarantees they can't be stiffed and can't stiff.
>
> **Those rails don't exist in Web2.**

**Notes:** Deliver as a rebuttal, not a hedge. Strongest differentiation line in
the deck — don't soften it.

---

## Slide 12 — The hard side of the marketplace

**On slide:**
> ## The clients were never the problem. The humans were.
>
> Agents are programmatic — they arrive over an API.
> **Freelancers have to be reached where they already are.**
>
> ### 11 signed up on the web. 13 signed up through Telegram.
>
> Full second client, not a notification bell: apply, submit work,
> check balance, withdraw, track a commission — 17 commands.
> No wallet extension needed to start. Works on any phone.

**Notes:** This is the slide that answers *"where do the humans come from"*,
which is the question that kills most two-sided marketplace pitches. The supply
side is the hard side, and Telegram is now the larger door — most of Patron's
labour supply never opened the web app at all.

Worth saying out loud: the people who do this work are on their phones, often on
low-end devices, frequently in markets where a browser extension and a seed
phrase is a wall. Telegram removes that wall — you can be earning before you
ever think about a wallet UI. The bot also pushes every event that matters:
hired, revision requested, milestone approved, paid, dispute resolved. Clients
can `/watch` their own commission and get the same trail in chat.

**Don't oversell it as a growth channel** — 24 people is a hackathon, not
traction. Sell it as evidence that the distribution problem was designed for
rather than deferred.

---

## Slide 13 — Status

**On slide — honest, all shipped:**
> ✅ Live in production — daemon on Railway, web on Vercel, escrow on Arc
> ✅ Full loop run end-to-end, repeatedly: 27 commissions, 24 humans, 10 completed
> ✅ x402 both directions — agents pay Patron; Patron pays marketplace services
> ✅ Dispute path proven with a real human arbiter, on-chain
> ✅ Two front doors — most freelancers signed up via Telegram, not the web
> 🔜 Mainnet, and opening the marketplace listing

**Notes:** Every ✅ here was a 🔜 at Checkpoint 2. Say that. Judges have seen
enough overclaimed decks that a precise status slide reads as credibility.
Don't pad the roadmap — two honest future items beat ten aspirational ones.

---

## Slide 14 — Close

**On slide:**
> ## Patron is service #42.
> The human-labour endpoint the agent economy has been missing.
>
> patron-guild.vercel.app
> github.com/Gbangbolaoluwagbemiga/Patron

**Notes:** Restate the inversion in your own words, then **stop**. Let the last
demo beat be what they remember, not a summary.

---

## Q&A cheat sheet — memorise, don't slide

**"What if the agent wrongly rejects good work?"**
> The agent holds a one-way key — it can pay you, it cannot stiff you. Rejection
> triggers a revision round with written feedback. After the revision rounds are
> exhausted, a human arbiter steps in through SecureFlow's dispute system. That
> has actually happened: escrow 56, split $1.25/$1.25 by a human.

**"Why does this need a blockchain?"**
> No human does real work for an AI that might not pay. Escrow with a one-way key
> is the trust bridge. And no agent owner hands a robot a blank cheque — Agent
> Wallet spending policies are the second cage.

**"Is the x402 fee the escrow?"**
> No. The x402 payment is the commission fee that opens the order. The job budget
> is locked separately in SecureFlow escrow on Arc. Fee = pay-per-call;
> escrow = the vault.

**"How do you stop a freelancer lying about the work?"**
> The reviewer inspects the artifact, not the description — image dimensions from
> the file header, SVG source, audio transcribed with Whisper, web pages fetched
> and read, GitHub repos read through the API including the README and licence.
> It's not taste, but you can't get paid for an empty file or a 40px thumbnail
> sold as print-ready.

**"What's the business model?"**
> A platform fee on each escrow, plus the x402 commission fee. Both already flow
> in production.

**"What stops the agent going rogue?"**
> Two independent cages: the one-way escrow key and owner-set wallet spending
> policies. The worst a fully compromised model can do is pay someone.
