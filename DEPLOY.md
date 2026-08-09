# Deploying Patron

**`git push` deploys nothing.** Neither service is connected to the repository.
Verified against each provider's own API, not assumed:

| Service | Where it runs | Source |
|---|---|---|
| `daemon/` | Railway — `patron-daemon-production.up.railway.app` | **No repo connected.** CLI uploads only. |
| `web/` | Vercel — `patron-guild.vercel.app` | CLI uploads only; every deployment in the list is CLI-triggered. |
| `services/portfolio-check/` | Railway — `patron-portfolio-check-production.up.railway.app` | **No repo connected.** CLI uploads only. |

This cost most of an afternoon once. Two fixes were correct on the first
attempt and looked broken for hours because production was still running old
code, and the same bugs were diagnosed three times against a daemon that had
never received them. Pushing and waiting is not deploying.

## Deploy the daemon

```sh
cd daemon
railway up --detach --service 19932c82-7088-4a4f-a725-1b7d8909fe39
```

The service flag is required — the project has more than one service, and
without it the CLI refuses rather than guessing.

## Deploy the web app

```sh
cd web
npm run build
vercel deploy --prod --yes
```

`--prod` moves the `patron-guild.vercel.app` alias. Confirm with
`vercel inspect <deployment-url>` and check the Aliases block.

## Deploy the portfolio-check service

```sh
cd services/portfolio-check
railway up --detach
```

## Confirm the deploy actually landed

Do not trust that it shipped. Ask the daemon which build is answering:

```sh
curl -s https://patron-daemon-production.up.railway.app/healthz
```

```json
{
  "ok": true,
  "commit": "unknown",
  "startedAt": 1786205610796,
  "uptimeSeconds": 25,
  "disputeBackfill": { "status": "done", "found": 1, "wrote": ["56"] }
}
```

`uptimeSeconds` resetting is the proof a new build is live. `disputeBackfill`
reports what the boot-time repair did, so "the deploy never landed" and "the
repair ran and found nothing" stop being indistinguishable — which is exactly
how a silent failure survived three rounds of fixes.

`commit` reads `unknown` under CLI deploys: Railway only injects
`RAILWAY_GIT_COMMIT_SHA` for git-triggered builds. Since nothing here is
git-triggered, treat `uptimeSeconds` as the signal.

For the web app, compare the served bundle hash with the local build:

```sh
curl -s -A "Mozilla/5.0" https://patron-guild.vercel.app/ | grep -o 'index-[A-Za-z0-9_-]*\.css'
ls web/dist/assets/ | grep css
```

They must match. Note that repeated automated requests trip a Vercel bot
checkpoint that returns 403 to scripted clients while the site stays fine for
real browsers — if a probe suddenly sees no page at all, check for
`Vercel Security Checkpoint` before concluding the deploy broke. The raw
deployment URL (`web-<hash>-<org>.vercel.app`) is not behind that checkpoint and
is the reliable target for automated verification.
