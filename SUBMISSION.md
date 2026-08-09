# Patron — submission copy

**Live:** [patron-guild.vercel.app](https://patron-guild.vercel.app) ·
**Get hired:** [/work](https://patron-guild.vercel.app/work) ·
**Telegram:** [@PatronGuildbot](https://t.me/PatronGuildbot)

---

## The description

Patron is the human-labor endpoint of the agent economy — a service where AI agents hire real humans.

Circle's Agent Marketplace gives agents 41 services to spend USDC on. Every one is a machine. When an agent needs work only a human can do — a logo with taste, a voiceover, an article with a soul — there's no endpoint for that. Patron is that endpoint.

**Any AI agent can commission human work with one x402 request.** It hits Patron's API, gets 402 Payment Required, signs a gasless USDC authorization, and the order is placed. From there Patron does everything a client would: it writes an explicit acceptance checklist, locks the budget in on-chain escrow via SecureFlow, holds the job open so applicants are judged against each other rather than first-come, hires the best one, reviews the delivered work criterion by criterion, and releases USDC the moment it passes. Humans can commission Patron too — same pipeline, either species of client.

**And the other half of a labor market is the labor.** Every other project in this space stops at the agent. Taking a $10 gig on-chain normally means installing a wallet, adding a network by chain ID, sourcing gas and signing twice — eight steps and three foreign concepts before earning a first dollar, which is why marketplaces launch with working software and zero humans. Patron removes all of it: a person picks a name, and Patron silently provisions them a real Circle MPC wallet, funds it for gas, and signs on their instruction. They apply, deliver and get paid without the word "wallet" ever appearing. Two doors — a web page and a Telegram bot — over one identical layer. **Twenty-four real people have joined and applied to real jobs this way — eleven through the web, thirteen through Telegram.** Their applications land on the same public subgraph as everyone else's; the guild master genuinely cannot tell which door someone came through.

**The client watches the whole thing, and collects at the end.** Every commission has its own page: the applicants as they arrive, each score with the guild master's reasoning verbatim, the hire, every review round, each payment — and the delivered work itself, with the file one click away. That last part is read straight from the subgraph rather than from anything Patron stores, so a client can check every word of it against the chain. Patron still settles autonomously; the client is shown everything and given SecureFlow's dispute path, not a veto that would make the one-way key meaningless.

**Vetting reads the work, not the reputation.** When an applicant links a CV, portfolio or GitHub, Patron fetches it and reads it — the scoring weighs what they can demonstrably *do*, roughly 95% on their letter and linked work against the brief's actual criteria, and at most 5% on their history here. That split is deliberate: Patron mints a wallet for every managed worker, so every genuine newcomer starts with no record, and a strong developer must be able to win on their first application. Prompt-injection attempts are caught and scored near zero whether they arrive in a cover letter or inside a fetched portfolio page. Ties break on on-chain reputation, with the reason written to the ledger rather than left looking like a coin toss.

### The trust layer that makes it work

Patron holds a **one-way key** — it can release funds autonomously, but it can never confiscate them. Rejection is never final: it triggers written feedback and revision rounds, then escalation to a human arbiter through SecureFlow's dispute system. **Money nobody earned always comes back** — a commission that attracts no suitable applicant is refunded in full when its deadline passes, automatically. Reputation is written to the contract on completion, so it's verifiable by anyone and can't be quietly recalculated to flatter us. And Patron's own treasury is a Circle Agent Wallet with owner-set spending caps — it can't exceed its budget any more than it can steal the escrow.

Freelancers keep **100%** of what a job pays. Freelancers are always protected. Clients never babysit.

### Built on Arc. Powered by the Circle Agent Stack.

Escrow settles through **SecureFlow** — an escrow protocol I built and shipped as its own product, live on Arc today at [secureflow-arc.vercel.app](https://secureflow-arc.vercel.app/). Patron did not scaffold a contract for a hackathon; it is built on infrastructure that already existed, with its own front end, its own users and its own dispute system. Commissions and machine-to-machine payments flow over x402 Nanopayments, batched gaslessly by Circle Gateway — Patron pays other marketplace services mid-job to verify applicants. Agent Wallets do double duty: Patron's treasury is one, and so is every wallet it provisions for a human. Agent Wallets, Nanopayments, Gateway, the CLI and Skills — every piece is load-bearing.

The guild master runs on structured, schema-validated outputs and is provider-agnostic by design: built against Anthropic's API, running on Groq (`llama-3.3-70b-versatile`) today, same schemas either way.

> **No human will work for an AI that might not pay.** Escrow with a one-way key is what changes that — the trust bridge the agentic economy can't exist without. Machines pay Patron. Patron pays humans. Patron is the labor market of the agentic economy.

---

## What a judge can verify without trusting us

- The same jobs on [SecureFlow's own dApp](https://secureflow-arc.vercel.app/jobs) — a separate application on a separate deployment, reading the same contract. Not Patron's UI, so what you see there is the chain, not our rendering of it.
- Every payment on [Arcscan](https://testnet.arcscan.app)
- Ratings read straight off the contract with `getAverageRating`
- **Their own application** — join at [/work](https://patron-guild.vercel.app/work) or the bot and find it on the public subgraph next to everyone else's
- Every decision the AI has ever made, verbatim, at [/decisions](https://patron-guild.vercel.app/decisions)

## Stated plainly

Testnet USDC. **Patron never pays out on a freelancer's word alone.** It fetches the delivered file and establishes what it can without a vision model: an SVG's source is read directly, so a blank file or one carrying another brand's name is caught; image dimensions come out of the file header, so "2400px, print-ready" is checked rather than believed; audio is transcribed with Whisper, so a voiceover is judged on what it actually says. The full vision pass that looks at a raster image is built and dark until the LLM budget allows it — and when it can't run, the review says so plainly and still reports every fact the bytes gave up, rather than pretending it inspected the work or punishing the freelancer for our missing credit. What remains genuinely unverifiable — taste, originality, licensing — is taken at the freelancer's word and marked as such, then backed by revision rounds and escalation to a human arbiter through SecureFlow's dispute system. Patron currently fronts the job budget for a flat commission, which is fine for a demo and wrong for a business; the fix is the buying agent funding escrow directly.
