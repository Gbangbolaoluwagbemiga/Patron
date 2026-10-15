// Re-score every historical application with a candidate model and compare
// against the score llama-3.3-70b actually gave it in production.
const model = process.argv[2]!;
process.env.GROQ_MODEL = model;
process.env.GROQ_FALLBACK_MODEL = model;   // isolate — no silent fallback

const { graphQuery } = await import("./src/graph/client.js");
const { GET_JOB_APPLICATIONS } = await import("./src/graph/queries.js");
const { scoreApplications } = await import("./src/agent/ApplicationScorer.js");

const D = "https://patron-daemon-production.up.railway.app";
const get = async (p: string) => (await fetch(D + p, { signal: AbortSignal.timeout(90_000) })).json() as any;
const rows = (x: any) => (x?.rows ?? x);

const tasks = rows(await get("/api/tasks"));
const decs  = rows(await get("/api/decisions?limit=900"));

// historical score per (escrow, freelancer)
const old = new Map<string, number>();
for (const d of decs) {
  if (d.type === "application_scored" && d.target && d.score != null) {
    old.set(`${d.task_id}:${String(d.target).toLowerCase()}`, Number(d.score));
  }
}

const pairs: { esc: string; addr: string; oldScore: number; newScore: number }[] = [];
let escrowsDone = 0;
const MAX_ESCROWS = Number(process.env.MAX_ESCROWS ?? 12);

for (const t of tasks) {
  if (escrowsDone >= MAX_ESCROWS) break;
  if (!t.escrowId || !t.briefJson) continue;
  const wanted = [...old.keys()].filter((k) => k.startsWith(`${t.escrowId}:`));
  if (!wanted.length) continue;

  let apps: any[] = [];
  try {
    const r: any = await graphQuery(GET_JOB_APPLICATIONS, { escrowId: t.escrowId });
    apps = (r?.escrow?.applications ?? []).map((a: any) => ({
      freelancerAddress: a.freelancer, coverLetter: a.coverLetter, proposedTimeline: Number(a.proposedTimeline) || 1,
    }));
  } catch { continue; }
  if (!apps.length) continue;

  let brief: any; try { brief = JSON.parse(t.briefJson); } catch { continue; }

  try {
    const scored: any[] = await scoreApplications(apps, brief);
    for (const s of scored) {
      const key = `${t.escrowId}:${String(s.application.freelancerAddress).toLowerCase()}`;
      const o = old.get(key);
      if (o != null) pairs.push({ esc: t.escrowId, addr: s.application.freelancerAddress, oldScore: o, newScore: Number(s.score) });
    }
    escrowsDone++;
    process.stderr.write(".");
  } catch { process.stderr.write("x"); }
}

console.log(`\n\n══ ${model} ══  ${pairs.length} applications re-scored across ${escrowsDone} commissions\n`);
if (!pairs.length) { console.log("no overlap found"); process.exit(0); }

const deltas = pairs.map((p) => p.newScore - p.oldScore).sort((a, b) => a - b);
const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
const med  = deltas[Math.floor(deltas.length / 2)];
console.log(`  score delta (new − old):  mean ${mean.toFixed(1)}   median ${med}   range ${deltas[0]} … ${deltas.at(-1)}`);

const hiredOld = pairs.filter((p) => p.oldScore >= 70).length;
console.log(`\n  at the current bar of 70:`);
console.log(`     would have hired under llama : ${hiredOld}`);
console.log(`     would hire under ${model.padEnd(22)}: ${pairs.filter((p) => p.newScore >= 70).length}`);

console.log(`\n  bar that preserves the same hire count under ${model}:`);
for (const bar of [70, 65, 60, 55, 50, 45, 40]) {
  const n = pairs.filter((p) => p.newScore >= bar).length;
  const flag = n === hiredOld ? "  ← matches llama@70" : "";
  console.log(`     ≥ ${String(bar).padEnd(3)} → ${String(n).padStart(3)} hires${flag}`);
}

console.log(`\n  biggest disagreements:`);
for (const p of [...pairs].sort((a, b) => Math.abs(b.newScore - b.oldScore) - Math.abs(a.newScore - a.oldScore)).slice(0, 6)) {
  console.log(`     #${p.esc} ${p.addr.slice(0, 10)}  llama ${String(p.oldScore).padStart(3)} → ${model.split("/").pop()} ${String(p.newScore).padStart(3)}`);
}
