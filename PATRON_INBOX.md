# Patron Inbox — the human front door

**A proposal for the last feature before submission.**
Written Aug 2, 2026 · Submission deadline Aug 10 · Demo Day Aug 20

---

## TL;DR

Patron lets AI agents hire and pay real humans. The AI side is finished and deployed. The
**human side is locked behind a crypto wall** that no real freelancer will ever climb — which is
why our marketplace currently contains three fake test wallets instead of people.

**Patron Inbox is a Telegram bot that lets a real person apply for jobs, submit work, and get paid
in USDC — without ever creating a wallet, installing anything, or learning what a blockchain is.**

It is a **bolt-on**. It does not change a single line of the system we already have. If it broke
completely on Demo Day we could unplug it and the current demo would still run exactly as it does
today.

Estimated cost: **~500 lines of code, 2–3 days.**

---

## 1. Where we are today

Patron is live and public:

- Daemon (the brain, 24/7): `https://patron-daemon-production.up.railway.app` — Railway, persistent volume
- Command center (the dashboard): `https://web-plum-one-12.vercel.app` — Vercel
- Escrow: SecureFlow `0x6142bf4855D4F9dbC1cD8109377d4F4E2AF1ab59` on Arc testnet

The full loop works end to end and has been run live: an AI agent pays us over x402 → our LLM
"guild master" writes a brief → money is locked in on-chain escrow → applicants are scored
(including catching a prompt-injection attempt) → one is hired → work is reviewed criterion by
criterion → escrow releases USDC to the worker. The dispute/escalation path has been proven live
too, with a real on-chain `disputeMilestone` transaction.

**That's genuinely good. Here's the hole.**

---

## 2. The problem: we built a beautiful front door for machines and left the human entrance locked

Look at the asymmetry between our two sides of the market:

| Side | How they arrive |
|---|---|
| **AI agents** (demand) | One HTTP call to `/api/hire`. x402 handles payment automatically. ~30 seconds. |
| **Humans** (supply) | Install MetaMask → add "Arc Testnet, chain ID 5042002" as a custom network → acquire testnet USDC for gas → find the SecureFlow dApp → connect wallet → locate the right escrow ID → sign `applyToJob` → come back later → sign `submitMilestone` |

**Eight steps and three foreign concepts before earning their first $1.**

Among crypto-native people, maybe 10% finish that. Among our *actual* target user — a designer, a
copywriter, a voice artist — it is approximately zero.

This is not a marketing problem. It's structural. The SecureFlow contract requires
`applyToJob(uint256 escrowId, string coverLetter, uint256 proposedTimeline)` and
`submitMilestone(uint256 escrowId, uint256 milestoneIndex, string description)` to be signed
**by the freelancer's own wallet**. To take a $10 gig, a human must first become a crypto user.

### Why this specifically loses us the hackathon

Our entire pitch is *"the human-labor endpoint of the agent economy."* The single sharpest
question a judge can ask is:

> **"Would a real freelancer actually use this? How many have you onboarded?"**

Right now the honest answer is **zero, and they structurally can't.** That question kills
marketplace projects. Patron Inbox is the answer to it.

---

## 3. The solution, told as a story

### Today

Blessing is a graphic designer. She sees a tweet: *"An AI will pay you $10 for a logo."*

She clicks. The site says **"Connect Wallet."** She doesn't have one. It tells her to install
MetaMask, then add a network called Arc Testnet, then get something called gas.

She closes the tab. **We just lost our only user.**

### With Patron Inbox

Blessing taps a Telegram link.

```
🏰 Patron: Hey! What kind of work do you do?

👤 Graphic design, logos mostly.

🏰 You're in the guild. I'll message you when a job matches.

    — 3 minutes later —

🏰 New quest: Logo for a coffee shop. $10 USDC, 3 days.
   [ Apply ]  [ Skip ]

👤 (taps Apply)

🏰 You got it. $10 is locked in escrow — it can't be taken back,
   not even by me. Send the logo when you're ready.

👤 (sends logo.png)

🏰 Reviewed against all 7 acceptance criteria ✅ Approved.
   💰 $10 USDC sent to you.
```

She never heard the word *wallet*. She never heard the word *blockchain*. She sent a picture in a
chat and got paid.

---

## 4. "But where did her wallet come from?"

The instant she tapped **Start**, Patron quietly asked Circle to create an MPC wallet and wrote one
row in its database:

```
Blessing's Telegram ID  →  wallet #4471
```

Two seconds. She was never told, because why would you tell her.

> **Analogy — the salary account.** In many companies, when you're hired, HR opens a bank account
> in your name for your salary. You never walked into a bank. You never filled out a form. But
> that account is completely real, and every naira in it is completely yours. HR did the
> paperwork so you could just start working.
>
> **Patron is HR. The wallet is the salary account.**

## 5. "But applying is a blockchain transaction — who signs it?"

Patron does, on her behalf, because Patron holds the wallet. Her tapping **[Apply]** *is* the
instruction to sign.

> **Analogy — the stockbroker.** You call your broker and say "buy me 10 Apple shares." You didn't
> go to the New York Stock Exchange. You didn't sign anything there. Your broker executed it in
> your name — and the shares are 100% yours.
>
> **Tapping [Apply] in the bot = calling your broker.**

---

## 6. Why this is cheap to build — the architectural break

**This is the most important technical point in the document.**

Our daemon **does not watch applicants. It watches the chain.** The background poller
(`daemon/src/index.ts`, ~line 270) queries the GoldSky SecureFlow subgraph every 15 seconds for new
applications and milestone submissions. It has no idea who or what produced them.

> **Analogy — the noticeboard.** The subgraph is a public noticeboard. Our guild master doesn't
> watch the door — he reads the board every 15 seconds. Right now the only things pinning notes to
> that board are our three seed scripts. The bot just means *more people walking up to the same
> board*. The daemon structurally cannot tell the difference, and doesn't need to.

**The consequence:** a Telegram bot that calls `applyToJob` on-chain flows straight into
`reviewApplications` → `acceptFreelancer` → `reviewMilestone` → `approveMilestone` with **zero
changes** to:

- `agent/ApplicationScorer.ts`
- `agent/WorkReviewer.ts`
- `agent/BriefGenerator.ts`
- `agent/AgentClient.ts`
- `store.ts`
- the SSE event stream
- the command center frontend

This is why it's a genuinely additive feature and not a rewrite. **Nothing that works today
changes behaviour.**

### Three things that happen to fall our way

**(a) On Arc, gas money and earnings are literally the same balance.**
Arc's native currency is USDC, and it's also exposed as an ERC-20 at
`0x3600000000000000000000000000000000000000`. I verified this against two live addresses on the
public RPC — both views return the identical number:

```
SecureFlow contract:   native 303.435    |  token 303.435
A funded test wallet:  native 0.495975   |  token 0.495975
```

On any other chain, onboarding N users means sourcing a separate gas token for each one — the
tedious part of custodial onboarding. Here, one small USDC transfer covers gas *and* is the same
asset they get paid in. It also means **a freelancer can never get stuck** in the classic beginner
trap of *"I have $47 in tokens but no gas to move them."*

**(b) We already wrote the reference implementation.**
`daemon/scripts/seed-freelancers.ts` already creates wallets and calls `applyToJob` — the exact
flow, already working. The bot is that script with a chat interface in front of it and real people
instead of hardcoded cover letters.

**(c) Long-polling means no infrastructure.**
Telegram bots can run in long-poll mode (`getUpdates`) — no webhook, no public callback URL, no new
service. It runs inside the daemon we already have on Railway, with nothing but a bot token.

---

## 7. Two modes — because some people *do* want their own wallet

A crypto-native freelancer should not be forced into a managed wallet. **They already aren't** —
and this costs us nothing, because of the noticeboard property above.

SecureFlow has its own live public web app at `https://secureflow-arc.vercel.app/jobs` (verified
live). A crypto-native freelancer can go there today, connect MetaMask, and apply with their own
wallet. Our guild master scores them identically — it cannot tell which door they came through.

Inside the bot, we support both explicitly:

| | **Mode A — Managed** (default) | **Mode B — Bring your own wallet** |
|---|---|---|
| Who it's for | has never touched crypto | already has MetaMask |
| Wallet | Patron creates a Circle MPC wallet | theirs |
| Who signs | Patron, when they tap | they do |
| Key access | none exists (see §9) | full — it's their wallet |
| Getting paid out | `/withdraw 0x...` | already in their wallet |
| Build cost | ~450 LOC | **~40 LOC** — mostly already works |

Mode B is just: `/link 0xTheirAddress` → the bot DMs them when a job matches → they tap a deep link
into the SecureFlow UI → they sign it themselves. The bot is a **notifier and coordinator**, not a
custodian.

> **Analogy — PayPal vs. a bank transfer.** Most people want PayPal; someone else handles the
> plumbing. Some people want to wire it themselves from their own bank. We support both. We don't
> force everyone into one.

### Graduation — Mode A is a ramp, not a trap

The day a Mode A user gets curious and installs a real wallet:

- `/withdraw 0xTheirNewAddress` → their earnings move to their own wallet
- `/switch-to-own-wallet 0x...` → all *future* jobs pay them directly; they're now Mode B

**Pitch line:** *"We onboard people who've never heard of a wallet, and give them a clean path to
full self-custody the moment they want it. Nobody is locked in."*

---

## 8. How does she actually get her money out?

**Key point: Patron never holds her money.** There is nothing to withdraw *from Patron*. When the
guild master approves the work, the **escrow contract pays her wallet directly**, in one on-chain
move. Patron is not in the middle at any point.

> **Analogy.** On Upwork, your money sits in *Upwork's* bank account and you request a payout,
> which they can hold, delay, or freeze. Patron is not that. It's closer to an employer paying
> straight into your account — the second it's approved, it's already yours and Patron cannot touch
> it.

So "withdraw" really means *"move it somewhere I control"*, at three levels:

**Level 1 — she doesn't.** `/balance` shows `$47.00`. It's already hers. Most people will just
leave it and keep working. (This is what actually happened with M-Pesa — most balances were never
cashed out; people just paid each other with them.)

**Level 2 — send it to her own wallet.** `/withdraw 0xABC...` — she pastes an address, Patron signs
one transfer. **~30 lines of code.** This is the graduation path.

**Level 3 — turn it into spendable cash.** On mainnet this is an off-ramp — Circle Mint, a local
exchange, or a mobile-money partner. **This is out of hackathon scope.** But it's the answer we
need ready when a judge asks *"okay, but how does she buy rice with it?"* We don't pretend it's
solved — we say it's the next integration, and that USDC is the easiest asset in the world to
off-ramp.

**Testnet caveat, said plainly:** right now this is testnet USDC — play money. Levels 1 and 2 work
identically on mainnet with no code change. Level 3 is the real gap. **We should say this before a
judge says it for us.**

---

## 9. Can she see her private key?

**No — and it's a stronger answer than "we won't show it."**

I searched the entire Circle Developer-Controlled Wallets SDK API surface. The wallet methods are:

```
createWallet · getWallet · getWallets · deriveWallet
signMessage · signTransaction · signTypedData
```

There is **no export, no reveal, no getPrivateKey** — because with MPC the key is never assembled
in one place to begin with. It exists as split shares. There is no single secret sitting anywhere
for anyone to hand over: not to her, not to us, not to Circle.

The precise framing:

> **Her money is fully hers and fully extractable. The key is not extractable by anyone.**

> **Analogy — the hotel safe.** Your valuables in a hotel safe are 100% yours. You can take them
> out any time, no permission needed. But you don't get to walk off with the hotel's safe.

This is exactly Coinbase, Venmo, and Revolut — you've never seen Coinbase's private keys either;
you withdraw to an address you control. **The escape hatch is `/withdraw`, not `/export`.**

**We must say this precisely if asked**, because a crypto-savvy judge will ask this exact question,
and a fuzzy answer looks like we don't understand our own custody model. A crisp one — *"MPC, no
key exists to export, value exits via withdrawal"* — reads as people who've thought about it.

### The alternative we're deliberately not taking

We could use generated hot wallets encrypted at rest in SQLite instead, which would make `/export`
possible.

| | Circle MPC | Encrypted hot wallet |
|---|---|---|
| Key export | impossible | possible |
| Security story | strong — no raw key exists anywhere | weaker — **we** hold raw keys |
| Circle judging table | strengthens it | neutral |
| Scale | Circle's quota | unlimited |

**Recommendation: stay with Circle MPC.** The whole promise of managed mode is *"you never have to
manage a key."* Handing that user a private key isn't a feature — it's the exact burden we removed.
Someone who wants their own key wants Mode B, not managed mode with an export button.

---

## 10. Does the job still show on the SecureFlow dashboard?

**Yes. Automatically. All of it.**

Patron doesn't run its own escrow — it calls the real SecureFlow contract. So every job Patron
posts already appears on:

- the SecureFlow web app — `https://secureflow-arc.vercel.app/jobs` (verified live)
- the SecureFlow GoldSky subgraph
- Arcscan — `https://testnet.arcscan.app`

Three consequences, all good:

**(a) Two doors into the same job.** Crypto-native people apply via SecureFlow's site with their own
wallet; normal people apply via Telegram. Same escrow, same subgraph, same guild master scoring
both.

> **Analogy.** SecureFlow's website is the bank branch. The bot is the mobile app. Same accounts,
> same money, two ways in. You don't close the branch when you launch the app — you serve the
> people the branch was never going to reach.

**(b) Free credibility with judges.** We can say: *"Don't take our word for it — here's our job on a
third-party interface we don't control, and here it is on the block explorer."* Independent
verification is rare in hackathon demos and it lands hard.

**(c) Distribution.** Any freelancer already using SecureFlow sees our jobs.

**One thing to watch:** because jobs are public, *anyone* can apply — including people we never
onboarded. That's mostly great (real supply, and genuinely untrusted cover letters for our
injection defense to chew on), but it means our scorer will meet applicants we didn't script. We
should test that before Demo Day rather than discover it live.

---

## 11. The edge — why this is worth the last 3 days

### Against our own current build

| | Today | With Inbox |
|---|---|---|
| Freelancers | 3 scripted test wallets | real people, onboardable live |
| "Untrusted input" defense | one rehearsed injection we wrote ourselves | actual strangers writing actual cover letters |
| Reputation | barely there | `submitRating` / `getAverageRating` are already in the SecureFlow ABI — real humans accumulating **on-chain** ratings |
| *"Would a real freelancer use this?"* | no good answer | a QR code on the slide |
| Demo finale | a dashboard incrementing | a person's phone buzzes on the projector and they get paid |

The reputation row matters more than it looks. Plenty of projects *claim* behaviour-based
reputation while deriving it from a hardcoded table. Real humans rating each other on-chain is the
real thing, and it falls out of this almost for free.

The injection row matters too: *"we didn't script this one — a real applicant tried it"* beats a
rehearsed beat with every security-literate judge in the room.

### Against the other ~7,600 hackathon participants

Everyone in the agentic-economy track is building **agents paying agents**, and every demo ends on
a dashboard. Ours ends on a human being.

And more practically: **nobody can copy this in the final week.** A competitor can clone a smart
contract over a weekend. They cannot clone twenty real people who already have our bot installed.

### Against the theme

The hackathon theme is *programmable money*. The most interesting thing money can do is **reach a
person**. Right now our money circulates between wallets we control. This is the exit ramp.

---

## 12. What we'd actually build

Nothing existing gets rewritten. New code:

| File | Purpose | ~LOC |
|---|---|---|
| `daemon/src/telegram/bot.ts` | long-poll `getUpdates`, command routing, file uploads | 200 |
| `daemon/src/telegram/wallets.ts` | Telegram ID → Circle wallet, gas drip on signup | 100 |
| `daemon/src/web3/secureflow.ts` | add `applyToJob` + `submitMilestone`, **parameterized by signer** | 60 |
| `daemon/src/store.ts` | `users` table | 40 |
| notify hook | new quest → broadcast to subscribers; approval → DM the freelancer | 50 |
| Mode B | `/link`, deep-link to SecureFlow, lookup by address | 40 |

**~500 LOC total. 2–3 focused days.**

### The one real refactor

`daemon/src/web3/secureflow.ts` currently writes through a single module-level treasury signer.
We need to thread a signer parameter through so calls can be made *as a freelancer* rather than as
Patron. It's contained — but it touches a file that currently works, so **it goes first**, while
there's still room to fix it.

---

## 13. Risks — stated honestly

| Risk | Reality | Mitigation |
|---|---|---|
| **Testnet USDC isn't money** | 20 "real freelancers" working for play tokens is a fair thing for a judge to push on | Say it before they do. Consider paying two people something real out of band so we can say that honestly too. |
| **Circle wallet quota / latency on testnet** | unknown | Test with 10 wallets on day one, **not on Aug 19**. Fallback: encrypted hot wallets (§9). |
| **Sybil** — one person makes 10 accounts | trivial with a bot | One Telegram ID = one wallet; lean on per-address on-chain rating history. Have the answer ready; someone will ask. |
| **Live bot on stage depends on wifi** | real | Record a clean run as backup and play it if the room is bad. |
| **Custodial model** | "not your keys, not your coins" | §9. Correct in principle, wrong for a user earning their first $10. Every neobank started here. |
| **The signer refactor breaks working code** | the only invasive change | Do it first, on day one, with the e2e script as the check. |

---

## 14. The plan

| When | What |
|---|---|
| **Aug 3–5** | Signer refactor → `users` table + Circle wallet provisioning → bot with `/start`, `/quests`, apply, submit. Test with two personal Telegram accounts. |
| **Aug 6** | **Vision reviewer.** Once uploads flow through the bot, pipe the actual image into a vision model. Right now `WorkReviewer.ts` grades a *paragraph about* a logo — our pitch says "a logo with taste." Half a day, closes the sharpest hole in our AI story. |
| **Aug 7–8** | **Onboard 10 real people.** Friends, a design Discord, a student group. Run real quests through them. Whatever breaks here would have broken on stage. |
| **Aug 9** | Reconcile docs (Groq vs Anthropic story, model names), rehearse, submit. |
| **Aug 10** | Submission deadline. |
| **Aug 10–20** | Keep onboarding. Every person added before Demo Day is live traction we can cite on stage. |

---

## 15. Open questions for you

1. **Do we agree the "zero real freelancers" hole is our biggest risk?** If you think something else
   is bigger, say so — the 3 days should go there instead.
2. **Circle MPC or encrypted hot wallets** for the managed wallets? (§9 — I lean Circle.)
3. **Who do we onboard first?** We need ~10 real people by Aug 8. Who do you know?
4. **Do we also want `patron-mcp`** — an MCP server so Claude Code / Cursor can hire a human with
   one config line? ~1 day, and it makes the demo one unbroken loop: type "I need a logo" in a
   terminal → a human's phone buzzes → work comes back → USDC releases. Strong, but the bot comes
   first.

---

## 16. One line, if you read nothing else

> **Today, a human has to become a crypto user before they can earn $1 from Patron.
> With Patron Inbox, they just need Telegram.**
