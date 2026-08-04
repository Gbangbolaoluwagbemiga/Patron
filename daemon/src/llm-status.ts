// llm-status.ts — is the guild master currently able to think?
//
// Shared by the poller (which discovers a rate limit) and the surfaces people
// actually talk to (which have to set expectations honestly). Its own module
// rather than an export from index.ts, because telegram.ts already imports the
// worker service and index.ts imports telegram.ts — putting this in index would
// make that a cycle.
//
// Why this exists at all: everything a WORKER does — joining, browsing, applying,
// submitting, withdrawing — is completely LLM-free. Someone can get a real wallet
// and put a real application on-chain with the model entirely dead. What needs the
// model is Patron's RESPONSE: scoring applicants, hiring, reviewing work.
//
// So the failure isn't that the door is shut. It's that a person walks through it,
// is told "I'll message you either way", and then hears nothing. Telling them the
// truth costs one sentence and is the difference between a queue and a black hole.

let pausedUntil = 0;

/** Called by the poller when the model reports a rate limit. */
export function setLlmPausedUntil(timestamp: number): void {
  pausedUntil = timestamp;
}

/** True while the guild master cannot score or review. */
export function llmPaused(): boolean {
  return Date.now() < pausedUntil;
}

/** Roughly how long the pause has left, for telling someone what to expect. */
export function llmPauseRemaining(): string {
  const ms = pausedUntil - Date.now();
  if (ms <= 0) return "";
  const mins = Math.ceil(ms / 60_000);
  return mins <= 1 ? "about a minute" : `about ${mins} minutes`;
}
