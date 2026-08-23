import type {
  AuthStatus,
  Capsule,
  Episode,
  Me,
  ModelInfo,
  PageRecord,
  ProviderId,
  Seq,
  ThreadStats,
} from "@pylos/protocol";
import { DEFAULT_BUDGET } from "@pylos/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ApiError, api, onSessionExpired, resolveBase, session, setSession, streamTurn } from "./api.ts";
import { Account } from "./components/Account.tsx";
import { Archive } from "./components/Archive.tsx";
import { Composer } from "./components/Composer.tsx";
import { Connect } from "./components/Connect.tsx";
import { EvidenceFigures } from "./components/Evidence.tsx";
import { Exchange } from "./components/Exchange.tsx";
import { Gate } from "./components/Gate.tsx";
import { Presence, type Pulse } from "./components/Presence.tsx";
import { SignIn } from "./components/SignIn.tsx";
import { ConfirmSheet, PassphraseSheet, ThreadMenu } from "./components/ThreadMenu.tsx";
import type { StreamingTurn } from "./components/Transcript.tsx";
import { Xray } from "./components/Xray.tsx";
import { PULSE_MS } from "./ring.ts";
import { inTauri, isMac, pickBundle, saveBytes, showWindow } from "./tauri.ts";

const PAGE = 60;
const MAX_LOADED = 400;
const THREAD_KEY = "pylos.threadId";

/** The evidence counts what came back, not what was tried: a fault recovers nothing. */
const resolvedPages = (pages: PageRecord[]): number => pages.filter((page) => page.resolved).length;

interface Window_ {
  episodes: Episode[];
  hasOlder: boolean;
  hasNewer: boolean;
}

type Sheet =
  | { kind: "connect"; provider: ProviderId | undefined; select: string | undefined }
  | { kind: "export" }
  | { kind: "import"; name: string; bytes: Uint8Array }
  | { kind: "forget"; episode: Episode }
  /** KERNEL A10.6: replies that quoted the removed text, named but never removed on a guess. */
  | { kind: "echoes"; seqs: Seq[]; reason: string }
  | undefined;

export function App(): React.JSX.Element {
  const [booted, setBooted] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [offline, setOffline] = useState(false);
  const [me, setMe] = useState<Me | undefined>(undefined);
  const [signedIn, setSignedIn] = useState(false);
  const [stats, setStats] = useState<ThreadStats | undefined>(undefined);
  const [threads, setThreads] = useState<ThreadStats[]>([]);
  const [window_, setWindow] = useState<Window_>({
    episodes: [],
    hasOlder: false,
    hasNewer: false,
  });
  const [capsules, setCapsules] = useState<Capsule[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [auth, setAuth] = useState<AuthStatus[]>([]);
  const [grokCli, setGrokCli] = useState(false);
  const [model, setModel] = useState("grok-4.6");
  const [budget, setBudget] = useState(DEFAULT_BUDGET);
  const [streaming, setStreaming] = useState<StreamingTurn | undefined>(undefined);
  const [viewTokens, setViewTokens] = useState<number | undefined>(undefined);
  const [viewRounds, setViewRounds] = useState<number | undefined>(undefined);
  const [building, setBuilding] = useState<number | undefined>(undefined);
  const [recovered, setRecovered] = useState(0);
  const [pulses, setPulses] = useState<Pulse[]>([]);
  const [faults, setFaults] = useState<number[]>([]);
  const [flickerAt, setFlickerAt] = useState<number | undefined>(undefined);
  const [lastTurnSeq, setLastTurnSeq] = useState<number | undefined>(undefined);
  const [attachments, setAttachments] = useState<Episode[]>([]);
  const [sheet, setSheet] = useState<Sheet>(undefined);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetError, setSheetError] = useState<string | undefined>(undefined);
  const [xray, setXray] = useState(false);
  const [archive, setArchive] = useState(false);
  const [titleMenu, setTitleMenu] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone?: "bad" } | undefined>(undefined);
  const [view, setView] = useState({ firstSeq: 1, lastSeq: 1 });
  const [jumpTo, setJumpTo] = useState<number | undefined>(undefined);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pendingText, setPendingText] = useState<string | undefined>(undefined);

  const turn = useRef<{ abort: () => void } | undefined>(undefined);
  const threadId = stats?.threadId;
  const hosted = me?.hosted === true;

  const say = useCallback((text: string, tone?: "bad"): void => {
    setToast(tone === undefined ? { text } : { text, tone });
    setTimeout(() => setToast(undefined), tone === "bad" ? 6500 : 3200);
  }, []);

  const currentTurn = useRef<number | undefined>(undefined);

  /** Every span that came back lights its own angle on the ring. */
  const light = useCallback((pages: PageRecord[]): void => {
    const at = performance.now();
    const lit = pages.flatMap((page) => (page.resolved ? page.seqs.map((seq) => ({ seq, at })) : []));
    if (lit.length > 0) {
      setPulses((current) => [...current.filter((pulse) => at - pulse.at < PULSE_MS), ...lit]);
    }
    // KERNEL A11.1: a fault the model's own recall did not answer stays on the
    // rim at this turn's angle — the receipt that no route reached the archive.
    const seq = currentTurn.current;
    const answered = pages.some((page) => page.resolved && page.trigger === "model");
    if (seq !== undefined && !answered && pages.some((page) => page.trigger === "fault")) {
      setFaults((current) => (current.includes(seq) ? current : [...current, seq]));
    }
  }, []);

  // ---------- boot ----------

  const openThread = useCallback(async (id: string): Promise<void> => {
    const [thread, episodes, capsuleList] = await Promise.all([
      api.thread(id),
      api.episodes(id, { limit: PAGE }),
      api.capsules(id).catch(() => []),
    ]);
    localStorage.setItem(THREAD_KEY, id);
    setStats(thread);
    setCapsules(capsuleList);
    setWindow({
      episodes,
      hasOlder: (episodes[0]?.seq ?? 1) > 1,
      hasNewer: false,
    });
    setAttachments([]);
    setViewTokens(thread.lastPacket?.tokens);
    setViewRounds(undefined);
    setRecovered(thread.lastPacket?.pages ?? 0);
    setPulses([]);
    setFaults([]);
    const lastUser = [...episodes].reverse().find((episode) => episode.role === "user");
    setLastTurnSeq(lastUser?.seq);
    if (thread.models.length > 0) {
      const latest = thread.models.at(-1);
      if (latest !== undefined) setModel(latest);
    }
    setView({ firstSeq: episodes[0]?.seq ?? 1, lastSeq: episodes.at(-1)?.seq ?? 1 });
  }, []);

  const refreshAuth = useCallback(async (): Promise<AuthStatus[]> => {
    const [statuses, grok] = await Promise.all([
      api.auth(),
      api.grokCliAvailable().catch(() => ({ available: false })),
    ]);
    setAuth(statuses);
    setGrokCli(grok.available);
    return statuses;
  }, []);

  const openWorkspace = useCallback(async (): Promise<void> => {
    const list = await api.listThreads();
    setThreads(list);
    const remembered = localStorage.getItem(THREAD_KEY);
    const target =
      list.find((thread) => thread.threadId === remembered) ?? list[0] ?? (await api.createThread());
    await openThread(target.threadId);
    setSignedIn(true);
    void refreshAuth();
    void api
      .models()
      .then(setModels)
      .catch(() => undefined);
  }, [openThread, refreshAuth]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the boot; it is never read
  useEffect(() => {
    void (async () => {
      await resolveBase();
      onSessionExpired(() => {
        setSignedIn(false);
        setStats(undefined);
        setWindow({ episodes: [], hasOlder: false, hasNewer: false });
      });

      let identity: Me | undefined;
      for (let tries = 0; tries < 40 && identity === undefined; tries += 1) {
        try {
          identity = await api.me();
        } catch (error) {
          const failure = error as ApiError;
          if (failure.code === "unauthorized") {
            identity = { hosted: true };
          } else if (failure.code !== "offline" || tries === 39) {
            setOffline(true);
            setBooted(true);
            void showWindow();
            return;
          } else {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
      }
      if (identity === undefined) return;
      setMe(identity);
      setOffline(false);

      if (identity.hosted && session() === null) {
        setBooted(true);
        void showWindow();
        return;
      }
      try {
        await openWorkspace();
      } catch (error) {
        // A rejected session drops through to the sign-in screen, not to "unreachable".
        if ((error as ApiError).code !== "unauthorized") setOffline(true);
      }
      setBooted(true);
      void showWindow();
    })();
  }, [openWorkspace, attempt]);

  const refreshThread = useCallback(async (): Promise<void> => {
    if (threadId === undefined) return;
    const [thread, capsuleList, list] = await Promise.all([
      api.thread(threadId),
      api.capsules(threadId).catch(() => capsules),
      api.listThreads().catch(() => threads),
    ]);
    setStats(thread);
    setCapsules(capsuleList);
    setThreads(list);
  }, [threadId, capsules, threads]);

  // ---------- paging ----------

  const loadOlder = useCallback((): void => {
    const first = window_.episodes[0];
    if (threadId === undefined || first === undefined || !window_.hasOlder || loadingOlder) return;
    setLoadingOlder(true);
    void api
      .episodes(threadId, { before: first.seq, limit: PAGE })
      .then((older) => {
        if (older.length === 0) {
          setWindow((current) => ({ ...current, hasOlder: false }));
          return;
        }
        setWindow((current) => {
          const merged = [...older, ...current.episodes];
          const trimmed = merged.slice(0, MAX_LOADED);
          return {
            episodes: trimmed,
            hasOlder: (older[0]?.seq ?? 1) > 1,
            hasNewer: current.hasNewer || trimmed.length < merged.length,
          };
        });
      })
      .catch(() => undefined)
      .finally(() => setLoadingOlder(false));
  }, [threadId, window_, loadingOlder]);

  const jump = useCallback(
    (seq: number): void => {
      if (threadId === undefined || stats === undefined) return;
      const loaded = window_.episodes;
      const first = loaded[0]?.seq ?? 1;
      const last = loaded.at(-1)?.seq ?? 1;
      if (seq >= first && seq <= last) {
        setJumpTo(seq);
        setTimeout(() => setJumpTo(undefined), 60);
        return;
      }
      void api
        .episodes(threadId, { before: Math.min(stats.turns + 1, seq + PAGE / 2), limit: PAGE })
        .then((episodes) => {
          if (episodes.length === 0) return;
          setWindow({
            episodes,
            hasOlder: (episodes[0]?.seq ?? 1) > 1,
            hasNewer: (episodes.at(-1)?.seq ?? 0) < stats.turns,
          });
          setJumpTo(seq);
          setTimeout(() => setJumpTo(undefined), 120);
        })
        .catch(() => undefined);
    },
    [threadId, stats, window_.episodes],
  );

  const jumpToNow = useCallback((): void => {
    if (threadId === undefined) return;
    void api.episodes(threadId, { limit: PAGE }).then((episodes) => {
      setWindow({ episodes, hasOlder: (episodes[0]?.seq ?? 1) > 1, hasNewer: false });
      setJumpTo(episodes.at(-1)?.seq);
      setTimeout(() => setJumpTo(undefined), 120);
    });
  }, [threadId]);

  // ---------- sending ----------

  const providerConfigured = useCallback(
    (modelId: string): boolean => {
      const info = models.find((entry) => entry.id === modelId);
      if (info === undefined) return auth.some((status) => status.ok);
      if (info.provider === "ollama") return true;
      return auth.find((status) => status.provider === info.provider)?.ok === true;
    },
    [models, auth],
  );

  const providerOf = useCallback(
    (modelId: string): ProviderId | undefined => models.find((entry) => entry.id === modelId)?.provider,
    [models],
  );

  const send = useCallback(
    (text: string): void => {
      if (threadId === undefined || streaming !== undefined) return;
      if (!providerConfigured(model)) {
        setPendingText(text);
        setSheet({ kind: "connect", provider: providerOf(model), select: undefined });
        return;
      }
      setStreaming({ text: "", model, pages: [] });
      setBuilding(0.08);
      setRecovered(0);
      setViewRounds(undefined);
      setFaults([]);

      const handle = streamTurn(threadId, { text, model, budget }, (event) => {
        if (event.type === "episode") {
          if (event.episode.role === "user") {
            setLastTurnSeq(event.episode.seq);
            currentTurn.current = event.episode.seq;
          }
          if (event.episode.role === "handoff") setFlickerAt(performance.now());
          setWindow((current) =>
            current.hasNewer
              ? current
              : { ...current, episodes: [...current.episodes, event.episode].slice(-MAX_LOADED) },
          );
          setAttachments([]);
        } else if (event.type === "packet") {
          setViewTokens(event.tokens);
          setBuilding(Math.min(1, event.tokens / Math.max(1, event.budget)));
          setRecovered(resolvedPages(event.pages));
          light(event.pages);
          if (event.pages.length > 0) {
            setStreaming((current) => (current === undefined ? current : { ...current, pages: event.pages }));
          }
        } else if (event.type === "page") {
          const page: PageRecord = event.page;
          setRecovered((count) => count + (page.resolved ? 1 : 0));
          light([page]);
          setStreaming((current) =>
            current === undefined ? current : { ...current, pages: [...current.pages, page] },
          );
        } else if (event.type === "delta") {
          setBuilding(undefined);
          setStreaming((current) =>
            current === undefined ? current : { ...current, text: current.text + event.text },
          );
        } else if (event.type === "check") {
          // The draft named lost values: everything streamed so far is void,
          // and the deltas after this one are the answer that was checked.
          setRecovered((count) => count + resolvedPages(event.pages));
          light(event.pages);
          setStreaming((current) =>
            current === undefined
              ? current
              : {
                  ...current,
                  text: "",
                  check: { names: event.names },
                  pages: [...current.pages, ...event.pages],
                },
          );
        } else if (event.type === "done") {
          const finished = event.episode;
          setWindow((current) =>
            current.hasNewer
              ? current
              : { ...current, episodes: [...current.episodes, finished].slice(-MAX_LOADED) },
          );
          setStreaming(undefined);
          setBuilding(undefined);
          void refreshThread();
        } else if (event.type === "error") {
          setStreaming(undefined);
          setBuilding(undefined);
          if (event.code === "no_provider") {
            setPendingText(text);
            setSheet({ kind: "connect", provider: providerOf(model), select: undefined });
          } else if (event.code !== "unauthorized") {
            say(event.message, "bad");
          }
          void refreshThread();
        }
      });
      turn.current = handle;
      void handle.done.then(() => {
        turn.current = undefined;
      });
    },
    [threadId, streaming, model, budget, providerConfigured, providerOf, refreshThread, say, light],
  );

  const stop = useCallback((): void => {
    turn.current?.abort();
    turn.current = undefined;
    setStreaming(undefined);
    setBuilding(undefined);
    void refreshThread();
  }, [refreshThread]);

  // ---------- actions ----------

  /** The handoff line is the server's to write, once the next turn actually runs. */
  const pickModel = useCallback(
    (next: string): void => {
      if (next === model) return;
      setModel(next);
      if (threadId === undefined) return;
      void api.settings(threadId, { model: next }).catch(() => undefined);
    },
    [model, threadId],
  );

  const attach = useCallback(
    (files: File[]): void => {
      if (threadId === undefined) return;
      void api
        .attach(threadId, files)
        .then((episodes) => {
          setAttachments((current) => [...current, ...episodes]);
          setWindow((current) =>
            current.hasNewer
              ? current
              : { ...current, episodes: [...current.episodes, ...episodes].slice(-MAX_LOADED) },
          );
          void refreshThread();
        })
        .catch((error: Error) => say(error.message, "bad"));
    },
    [threadId, refreshThread, say],
  );

  const doExport = useCallback(
    (passphrase: string): void => {
      if (threadId === undefined) return;
      setSheetBusy(true);
      setSheetError(undefined);
      void api
        .exportBundle(threadId, passphrase)
        .then(async (bytes) => {
          const name = `pylos-${threadId.slice(0, 8)}-${stats?.turns ?? 0}.pylos`;
          const path = await saveBytes(name, bytes);
          setSheet(undefined);
          if (path !== undefined) say(`Exported ${name}`);
        })
        .catch((error: Error) => setSheetError(error.message))
        .finally(() => setSheetBusy(false));
    },
    [threadId, stats?.turns, say],
  );

  const doImport = useCallback(
    (passphrase: string, name: string, bytes: Uint8Array): void => {
      setSheetBusy(true);
      setSheetError(undefined);
      void api
        .importBundle(bytes, name, passphrase)
        .then(async (imported) => {
          setSheet(undefined);
          await openThread(imported.threadId);
          setThreads(await api.listThreads());
          say(`Imported ${imported.turns} turns · chain verified`);
        })
        .catch((error: Error) => setSheetError(error.message))
        .finally(() => setSheetBusy(false));
    },
    [openThread, say],
  );

  /**
   * An assistant turn that restated the removed text is an episode of its own,
   * so the kernel names it rather than guessing (KERNEL A10.6). `offerEchoes` is
   * false when the user is already answering that question.
   */
  const doForget = useCallback(
    (seqs: Seq[], reason: string, offerEchoes: boolean): void => {
      if (threadId === undefined) return;
      void api
        .forget(threadId, seqs, reason)
        .then(async (result) => {
          const refreshed = await Promise.all(seqs.map((seq) => api.episode(threadId, seq)));
          setWindow((current) => ({
            ...current,
            episodes: current.episodes.map(
              (entry) => refreshed.find((item) => item.seq === entry.seq) ?? entry,
            ),
          }));
          void refreshThread();
          if (offerEchoes && result.echoes.length > 0) {
            setSheet({ kind: "echoes", seqs: result.echoes, reason });
            return;
          }
          setSheet(undefined);
          say("Forgotten, and recorded as forgotten.");
        })
        .catch((error: Error) => say(error.message, "bad"));
    },
    [threadId, refreshThread, say],
  );

  const signOut = useCallback((): void => {
    void api
      .signOut()
      .catch(() => undefined)
      .finally(() => {
        setSession(null);
        localStorage.removeItem(THREAD_KEY);
        globalThis.location.reload();
      });
  }, []);

  // ---------- derived ----------

  const handoffs = useMemo(
    () => window_.episodes.filter((episode) => episode.role === "handoff"),
    [window_.episodes],
  );

  const dateFor = useCallback(
    (seq: number): number | undefined => {
      const list = window_.episodes;
      if (list.length === 0) return undefined;
      let best = list[0];
      for (const episode of list) {
        if (episode.seq <= seq) best = episode;
        else break;
      }
      return best?.ts;
    },
    [window_.episodes],
  );

  /** The exchange on screen: the last thing you said, and the answer to it. */
  const exchange = useMemo(() => {
    const list = window_.episodes;
    let question: Episode | undefined;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const episode = list[i];
      if (episode?.role === "user") {
        question = episode;
        break;
      }
    }
    const answer =
      question === undefined
        ? undefined
        : [...list].reverse().find((item) => item.role === "assistant" && item.seq > question.seq);
    return { question, answer };
  }, [window_.episodes]);

  /** KERNEL A6: a user turn with no answer after it renders as *no reply*. */
  const awaitingReply =
    streaming === undefined &&
    !window_.hasNewer &&
    exchange.question !== undefined &&
    exchange.answer === undefined;

  const empty = window_.episodes.length === 0 && streaming === undefined;
  const presenceState = streaming === undefined ? "idle" : building === undefined ? "streaming" : "building";

  // KERNEL A10.3: a turn may cost more than one request. The receipt says how
  // many, so the view figure can say it too once the turn has settled.
  useEffect(() => {
    if (threadId === undefined || lastTurnSeq === undefined || streaming !== undefined) return;
    let cancelled = false;
    void api
      .packet(threadId, lastTurnSeq)
      .then((packet) => {
        if (!cancelled) setViewRounds(packet.rounds?.length);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [threadId, lastTurnSeq, streaming]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === "i") {
        event.preventDefault();
        setXray((value) => !value);
      }
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, []);

  if (!booted) {
    return (
      <div className="app solo">
        <Gate label="Pylos">
          <p className="gate-note">Opening the archive…</p>
        </Gate>
      </div>
    );
  }

  if (offline) {
    const local = inTauri || me?.hosted === false;
    return (
      <div className="app solo">
        <Gate label="Pylos is unreachable">
          <p className="gate-note">
            {local
              ? "The Pylos server is not running. Start it with pylos serve, then try again."
              : "Retrying the connection."}
          </p>
          <button
            type="button"
            className="pill gate-cta"
            onClick={() => {
              setOffline(false);
              setBooted(false);
              setAttempt((value) => value + 1);
            }}
          >
            Retry
          </button>
        </Gate>
      </div>
    );
  }

  if (hosted && !signedIn) {
    return (
      <div className="app solo">
        <SignIn
          onSignedIn={(token, identity) => {
            setSession(token);
            setMe(identity);
            setBooted(false);
            setAttempt((value) => value + 1);
          }}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <header className={`titlebar${isMac && inTauri ? " macos" : ""}`}>
        <span className="menu-anchor title-slot">
          <button type="button" className="thread-title" onClick={() => setTitleMenu((value) => !value)}>
            {stats?.title ?? "Pylos"}
          </button>
          {titleMenu ? (
            <ThreadMenu
              stats={stats}
              threads={threads}
              onClose={() => setTitleMenu(false)}
              onNew={() => {
                setTitleMenu(false);
                void api.createThread().then(async (created) => {
                  await openThread(created.threadId);
                  setThreads(await api.listThreads());
                });
              }}
              onOpen={(id) => {
                setTitleMenu(false);
                void openThread(id);
              }}
              onExport={() => {
                setTitleMenu(false);
                setSheetError(undefined);
                setSheet({ kind: "export" });
              }}
              onImport={() => {
                setTitleMenu(false);
                void pickBundle().then((picked) => {
                  if (picked === undefined) return;
                  setSheetError(undefined);
                  setSheet({ kind: "import", name: picked.name, bytes: picked.bytes });
                });
              }}
            />
          ) : null}
        </span>
        <span className="titlebar-spacer" />
        {hosted && me !== undefined ? <Account me={me} onSignOut={signOut} /> : null}
      </header>

      <main className="stage">
        <div className="presence-stage">
          <div className="presence-frame">
            <Presence
              turns={stats?.turns ?? 0}
              state={presenceState}
              fill={building ?? 0}
              pulses={pulses}
              faults={faults}
              flickerAt={flickerAt}
            />
          </div>
          <EvidenceFigures
            stats={stats}
            recovered={recovered}
            viewTokens={viewTokens}
            viewRounds={viewRounds}
            budget={budget}
            onOpen={() => setXray(true)}
          />
        </div>

        {empty ? (
          <p className="coldstart-line">Say anything. It will be kept.</p>
        ) : (
          <Exchange
            threadId={threadId ?? ""}
            question={exchange.question}
            answer={exchange.answer}
            streaming={streaming}
            awaitingReply={awaitingReply}
            hasEarlier={window_.hasOlder || window_.episodes.length > 2}
            onEarlier={() => setArchive(true)}
          />
        )}
      </main>

      <Composer
        models={models}
        model={model}
        budget={budget}
        busy={streaming !== undefined}
        attachments={attachments}
        onSend={send}
        onStop={stop}
        onPickModel={pickModel}
        onConnectModel={(provider, next) => {
          setSheetError(undefined);
          setSheet({ kind: "connect", provider, select: next });
        }}
        onEarlier={() => setArchive(true)}
        onAttach={attach}
        onRemoveAttachment={(seq) => setAttachments((current) => current.filter((item) => item.seq !== seq))}
        onBudget={(next) => {
          setBudget(next);
          if (threadId !== undefined) void api.settings(threadId, { budget: next });
        }}
        onRefreshModels={() => {
          void api
            .models()
            .then(setModels)
            .catch(() => undefined);
        }}
      />

      {archive ? (
        <Archive
          threadId={threadId ?? ""}
          turns={stats?.turns ?? 0}
          episodes={window_.episodes}
          capsules={capsules}
          handoffs={handoffs}
          hasOlder={window_.hasOlder}
          hasNewer={window_.hasNewer}
          loadingOlder={loadingOlder}
          streaming={streaming}
          jumpTo={jumpTo}
          view={view}
          dateFor={dateFor}
          onNearTop={loadOlder}
          onViewportChange={setView}
          onForget={(episode) => setSheet({ kind: "forget", episode })}
          onJump={jump}
          onNow={jumpToNow}
          onClose={() => setArchive(false)}
        />
      ) : null}

      {xray && threadId !== undefined ? (
        <Xray
          threadId={threadId}
          stats={stats}
          turnSeq={lastTurnSeq}
          onClose={() => setXray(false)}
          onVerified={() => void refreshThread()}
        />
      ) : null}

      {sheet?.kind === "connect" ? (
        <Connect
          statuses={auth}
          grokCliAvailable={grokCli}
          focus={sheet.provider}
          onClose={() => {
            setSheet(undefined);
            setPendingText(undefined);
          }}
          onDone={() => {
            const next = sheet.select;
            void (async () => {
              await refreshAuth();
              const list = await api.models(true).catch(() => models);
              setModels(list);
              setSheet(undefined);
              if (next !== undefined) pickModel(next);
              const text = pendingText;
              setPendingText(undefined);
              if (text !== undefined) setTimeout(() => send(text), 60);
            })();
          }}
        />
      ) : null}

      {sheet?.kind === "export" ? (
        <PassphraseSheet
          title="Export this thread"
          note="The bundle is encrypted with this passphrase, and carries the receipts — what each turn was compiled from — so the X-ray survives the move. Credentials are never included."
          confirm="Export"
          busy={sheetBusy}
          error={sheetError}
          onCancel={() => setSheet(undefined)}
          onSubmit={doExport}
        />
      ) : null}

      {sheet?.kind === "import" ? (
        <PassphraseSheet
          title={`Import ${sheet.name}`}
          note="The hash chain is verified before anything is accepted."
          confirm="Import"
          busy={sheetBusy}
          error={sheetError}
          onCancel={() => setSheet(undefined)}
          onSubmit={(passphrase) => doImport(passphrase, sheet.name, sheet.bytes)}
        />
      ) : null}

      {sheet?.kind === "forget" ? (
        <ConfirmSheet
          title="Forget this?"
          note={`Turn #${sheet.episode.seq} will be replaced by a tombstone. The hash chain stays valid, and Pylos records that it forgot.`}
          confirm="Forget it"
          onCancel={() => setSheet(undefined)}
          onConfirm={() => doForget([sheet.episode.seq], "user request", true)}
        />
      ) : null}

      {sheet?.kind === "echoes" ? (
        <ConfirmSheet
          title={`${sheet.seqs.length === 1 ? "One reply" : `${sheet.seqs.length} replies`} quoted it.`}
          note={`${sheet.seqs.map((seq) => `#${seq}`).join(", ")} — a model's own words, so Pylos left them alone. Forget those too?`}
          confirm="Forget those too"
          cancel="Leave them"
          onCancel={() => {
            setSheet(undefined);
            say("Forgotten, and recorded as forgotten.");
          }}
          onConfirm={() => doForget(sheet.seqs, sheet.reason, false)}
        />
      ) : null}

      {toast !== undefined ? (
        <div className="toast" data-tone={toast.tone}>
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}
