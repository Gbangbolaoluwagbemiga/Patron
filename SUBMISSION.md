# Patron — submission copy

**Live:** [web-plum-one-12.vercel.app](https://web-plum-one-12.vercel.app) ·
**Get hired:** [/work](https://web-plum-one-12.vercel.app/work) ·
**Telegram:** [@PatronGuildbot](https://t.me/PatronGuildbot)

---

## The description

Patron is the human-labor endpoint of the agent economy — a service where AI agents hire real humans.

Circle's Agent Marketplace gives agents 41 services to spend USDC on. Every one is a machine. When an agent needs work only a human can do — a logo with taste, a voiceover, an article with a soul — there's no endpoint for that. Patron is that endpoint.

**Any AI agent can commission human work with one x402 request.** It hits Patron's API, gets 402 Payment Required, signs a gasless USDC authorization, and the order is placed. From there Patron does everything a client would: it writes an explicit acceptance checklist, locks the budget in on-chain escrow via SecureFlow, holds the job open so applicants are judged against each other rather than first-come, hires the best one, reviews the delivered work criterion by criterion, and releases USDC the moment it passes. Humans can commission Patron too — same pipeline, either species of client.

**And the other half of a labor market is the labor.** Every other project in this space stops at the agent. Taking a $10 gig on-chain normally means installing a wallet, adding a network by chain ID, sourcing gas and signing twice — eight steps and three foreign concepts before earning a first dollar, which is why marketplaces launch with working software and zero humans. Patron removes all of it: a person picks a name, and Patron silently provisions them a real Circle MPC wallet, funds it for gas, and signs on their instruction. They apply, deliver and get paid without the word "wallet" ever appearing. Two doors — a web page and a Telegram bot — over one identical layer. **Ten real people have joined and applied to real jobs this way.** Their applications land on the same public subgraph as everyone else's; the guild master genuinely cannot tell which door someone came through.

**Vetting reads the work, not the reputation.** When an applicant links a CV, portfolio or GitHub, Patron fetches it and reads it — the scoring weighs what they can demonstrably *do*, roughly 95% on their letter and linked work against the brief's actual criteria, and at most 5% on their history here. That split is deliberate: Patron mints a wallet for every managed worker, so every genuine newcomer starts with no record, and a strong developer must be able to win on their first application. Prompt-injection attempts are caught and scored near zero whether they arrive in a cover letter or inside a fetched portfolio page. Ties break on on-chain reputation, with the reason written to the ledger rather than left looking like a coin toss.

### The trust layer that makes it work

Patron holds a **one-way key** — it can release funds autonomously, but it can never confiscate them. Rejection is never final: it triggers written feedback and revision rounds, then escalation to a human arbiter through SecureFlow's dispute system. **Money nobody earned always comes back** — a commission that attracts no suitable applicant is refunded in full when its deadline passes, automatically. Reputation is written to the contract on completion, so it's verifiable by anyone and can't be quietly recalculated to flatter us. And Patron's own treasury is a Circle Agent Wallet with owner-set spending caps — it can't exceed its budget any more than it can steal the escrow.

Freelancers keep **100%** of what a job pays. Freelancers are always protected. Clients never babysit.

### Built on Arc. Powered by the Circle Agent Stack.

Escrow settles through SecureFlow, a live deployed contract on Arc testnet. Commissions and machine-to-machine payments flow over x402 Nanopayments, batched gaslessly by Circle Gateway — Patron pays other marketplace services mid-job to verify applicants. Agent Wallets do double duty: Patron's treasury is one, and so is every wallet it provisions for a human. Agent Wallets, Nanopayments, Gateway, the CLI and Skills — every piece is load-bearing.

The guild master runs on structured, schema-validated outputs and is provider-agnostic by design: built against Anthropic's API, running on Groq (`llama-3.3-70b-versatile`) today, same schemas either way.

> **No human will work for an AI that might not pay.** Escrow with a one-way key is what changes that — the trust bridge the agentic economy can't exist without. Machines pay Patron. Patron pays humans. Patron is the labor market of the agentic economy.

---

## What a judge can verify without trusting us

- The same jobs on [SecureFlow's own dApp](https://secureflow-arc.vercel.app/jobs) — a third-party interface we don't control
- Every payment on [Arcscan](https://testnet.arcscan.app)
- Ratings read straight off the contract with `getAverageRating`
- **Their own application** — join at [/work](https://web-plum-one-12.vercel.app/work) or the bot and find it on the public subgraph next to everyone else's
- Every decision the AI has ever made, verbatim, at [/decisions](https://web-plum-one-12.vercel.app/decisions)

## Stated plainly

Testnet USDC. The vision reviewer that opens delivered files is built but dark until the LLM budget allows it — until then the reviewer says explicitly that it judged a description rather than an artifact, rather than pretending otherwise. Patron currently fronts the job budget for a flat commission, which is fine for a demo and wrong for a business; the fix is the buying agent funding escrow directly.
