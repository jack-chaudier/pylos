import { atomize, compact, openVault } from "@pylos/core";

const vault = openVault({ home: "/tmp/pylos-demo" });
const thread = vault.threads.create("The Linear B archive");

const topics = [
  [
    "Where did the Pylos tablets come from?",
    "They came from the palace at Ano Englianos, excavated by Carl Blegen in 1939.",
  ],
  ["How many tablets survived?", "About 1,100 tablets survived the fire, baked hard by it."],
  ["What script are they in?", "Linear B, deciphered by Michael Ventris in 1952 as an early form of Greek."],
  ["What do they record?", "Palace administration: rations, textiles, bronze, offerings to Poseidon."],
  [
    "Never send a production migration before the dry-run database is verified.",
    "Recorded as a standing rule.",
  ],
  [
    "What was the palace destroyed by?",
    "A fire around 1200 BCE, at the end of the Late Helladic IIIB period.",
  ],
  ["Who was the last wanax?", "Unknown by name; the tablets record the office, not a successor."],
  ["What is the Ta series?", "An inventory of furniture and vessels, prepared for a ceremony."],
  [
    "What does o-pi-a-ra mean?",
    "Probably 'coastal districts' — the watcher tablets list men posted to them.",
  ],
  [
    "Why did the archive survive at all?",
    "Because clay that would have crumbled was fired by the blaze that destroyed the palace.",
  ],
];

let n = 0;
for (let round = 0; round < 12; round += 1) {
  for (const [question, answer] of topics) {
    const suffix = round === 0 ? "" : ` (asked again, round ${round + 1})`;
    const user = vault.episodes.append(thread.id, { role: "user", content: question + suffix });
    const assistant = vault.episodes.append(thread.id, {
      role: "assistant",
      content: answer,
      model: round < 6 ? "grok-4.6" : "claude-opus-4-5-20251101",
      provider: round < 6 ? "xai" : "anthropic",
    });
    atomize(vault, thread.id, [user.seq, assistant.seq]);
    n += 2;
  }
  if (round === 5) {
    vault.episodes.append(thread.id, {
      role: "handoff",
      content: "Grok stopped here. Claude continued from the same thread.",
      meta: { from: "grok-4.6", to: "claude-opus-4-5-20251101" },
    });
    n += 1;
  }
}
compact(vault, thread.id, {});
vault.threads.setSettings(thread.id, { model: "grok-4.6", budget: 32768 });
const stats = await import("@pylos/core").then((m) => m.stats(vault, thread.id));
console.log(JSON.stringify({ episodes: n, ...stats }, null, 1).slice(0, 700));
vault.close();
