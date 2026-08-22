import type { AuthStatus, Capsule, Episode, Me, ModelInfo, PageRecord, ThreadStats } from "@pylos/protocol";
import { DEFAULT_BUDGET } from "@pylos/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ApiError, api, onSessionExpired, resolveBase, session, setSession, streamTurn } from "./api.ts";
import { Account } from "./components/Account.tsx";
import { Composer } from "./components/Composer.tsx";
import { Connect } from "./components/Connect.tsx";
import { EvidenceBar, SealMark } from "./components/Seal.tsx";
import { SignIn } from "./components/SignIn.tsx";
import { ConfirmSheet, PassphraseSheet, ThreadMenu } from "./components/ThreadMenu.tsx";
import { TimelineRail } from "./components/TimelineRail.tsx";
import { type StreamingTurn, Transcript } from "./components/Transcript.tsx";
import { Xray } from "./components/Xray.tsx";
import { inTauri, isMac, pickBundle, saveBytes, showWindow } from "./tauri.ts";

const PAGE = 60;
const MAX_LOADED = 400;
const THREAD_KEY = "pylos.threadId";

interface Window_ {
  episodes: Episode[];
  hasOlder: boolean;
  hasNewer: boolean;
}

type Sheet =
  | { kind: "connect" }
  | { kind: "export" }
  | { kind: "import"; name: string; bytes: Uint8Array }
  | { kind: "forget"; episode: Episode }
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
  const [building, setBuilding] = useState<number | undefined>(undefined);
  const [recovered, setRecovered] = useState(0);
  const [lastTurnSeq, setLastTurnSeq] = useState<number | undefined>(undefined);
  const [attachments, setAttachments] = useState<Episode[]>([]);
  const [sheet, setSheet] = useState<Sheet>(undefined);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetError, setSheetError] = useState<string | undefined>(undefined);
  const [xray, setXray] = useState(false);
  const [titleMenu, setTitleMenu] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone?: "bad" } | undefined>(undefined);
  const [view, setView] = useState({ firstSeq: 1, lastSeq: 1 });
  const [jumpTo, setJumpTo] = useState<number | undefined>(undefined);
  const [scrolled, setScrolled] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pendingText, setPendingText] = useState<string | undefined>(undefined);

  const turn = useRef<{ abort: () => void } | undefined>(undefined);
  const threadId = stats?.threadId;
  const hosted = me?.hosted === true;

  const say = useCallback((text: string, tone?: "bad"): void => {
    setToast(tone === undefined ? { text } : { text, tone });
    setTimeout(() => setToast(undefined), tone === "bad" ? 6500 : 3200);
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
    setRecovered(thread.lastPacket?.pages ?? 0);
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
      } catch {
        setOffline(true);
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

  const send = useCallback(
    (text: string): void => {
      if (threadId === undefined || streaming !== undefined) return;
      if (!providerConfigured(model)) {
        setPendingText(text);
        setSheet({ kind: "connect" });
        return;
      }
      setStreaming({ text: "", model, pages: [] });
      setBuilding(0.08);
      setRecovered(0);

      const handle = streamTurn(
        threadId,
        { text, model, budget, attachmentSeqs: attachments.map((item) => item.seq) },
        (event) => {
          if (event.type === "episode") {
            if (event.episode.role === "user") setLastTurnSeq(event.episode.seq);
            setWindow((current) =>
              current.hasNewer
                ? current
                : { ...current, episodes: [...current.episodes, event.episode].slice(-MAX_LOADED) },
            );
            setAttachments([]);
          } else if (event.type === "packet") {
            setViewTokens(event.tokens);
            setBuilding(undefined);
            setRecovered(event.pages.length);
            if (event.pages.length > 0) {
              setStreaming((current) =>
                current === undefined ? current : { ...current, pages: event.pages },
              );
            }
          } else if (event.type === "page") {
            const page: PageRecord = event.page;
            setRecovered((count) => count + 1);
            setStreaming((current) =>
              current === undefined ? current : { ...current, pages: [...current.pages, page] },
            );
          } else if (event.type === "delta") {
            setStreaming((current) =>
              current === undefined ? current : { ...current, text: current.text + event.text },
            );
          } else if (event.type === "check") {
            // The draft named lost values: everything streamed so far is void,
            // and the deltas after this one are the answer that was checked.
            setRecovered((count) => count + event.pages.length);
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
              setSheet({ kind: "connect" });
            } else if (event.code !== "unauthorized") {
              say(event.message, "bad");
            }
            void refreshThread();
          }
        },
      );
      turn.current = handle;
      void handle.done.then(() => {
        turn.current = undefined;
      });
    },
    [threadId, streaming, model, budget, attachments, providerConfigured, refreshThread, say],
  );

  const stop = useCallback((): void => {
    turn.current?.abort();
    turn.current = undefined;
    setStreaming(undefined);
    setBuilding(undefined);
    void refreshThread();
  }, [refreshThread]);

  // ---------- actions ----------

  const pickModel = useCallback(
    (next: string): void => {
      if (next === model) return;
      const previous = model;
      setModel(next);
      if (threadId === undefined) return;
      void api.settings(threadId, { model: next }).catch(() => undefined);
      if ((stats?.turns ?? 0) > 0) {
        void api
          .handoff(threadId, next)
          .then((episode) => {
            setWindow((current) =>
              current.hasNewer
                ? current
                : { ...current, episodes: [...current.episodes, episode].slice(-MAX_LOADED) },
            );
            void refreshThread();
          })
          .catch((error: Error) => {
            setModel(previous);
            say(error.message, "bad");
          });
      }
    },
    [model, threadId, stats?.turns, refreshThread, say],
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

  const doForget = useCallback(
    (episode: Episode): void => {
      if (threadId === undefined) return;
      void api
        .forget(threadId, [episode.seq], "user request")
        .then(async () => {
          setSheet(undefined);
          const refreshed = await api.episode(threadId, episode.seq);
          setWindow((current) => ({
            ...current,
            episodes: current.episodes.map((entry) => (entry.seq === refreshed.seq ? refreshed : entry)),
          }));
          void refreshThread();
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

  /** KERNEL A6: a user turn with no answer after it renders as *no reply*. */
  const danglingTurn = useMemo(() => {
    if (streaming !== undefined || window_.hasNewer) return undefined;
    const last = window_.episodes.at(-1);
    return last?.role === "user" ? last : undefined;
  }, [streaming, window_]);

  const empty = window_.episodes.length === 0 && streaming === undefined;

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
      <div className="app">
        <div className="coldstart">
          <SealMark className="seal-emblem" />
        </div>
      </div>
    );
  }

  if (offline) {
    const local = inTauri || me?.hosted === false;
    return (
      <div className="app">
        <div className="coldstart">
          <SealMark className="seal-emblem" />
          <h1>Pylos is unreachable.</h1>
          <p>
            {local
              ? "The Pylos server is not running. Start it with pylos serve, then try again."
              : "Retrying the connection."}
          </p>
          <button
            type="button"
            className="pill"
            onClick={() => {
              setOffline(false);
              setBooted(false);
              setAttempt((value) => value + 1);
            }}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (hosted && !signedIn) {
    return (
      <div className="app">
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
      <header className={`titlebar${isMac && inTauri ? " macos" : ""}`} data-scrolled={scrolled}>
        <span className="menu-anchor">
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
        {window_.hasNewer ? (
          <button type="button" className="ghost" onClick={jumpToNow}>
            Now
          </button>
        ) : null}
        <EvidenceBar
          stats={stats}
          building={building}
          recovered={recovered}
          viewTokens={viewTokens}
          budget={budget}
          open={xray}
          onOpen={() => setXray(true)}
        />
        {hosted && me !== undefined ? <Account me={me} onSignOut={signOut} /> : null}
      </header>

      <div className="transcript-wrap">
        {empty ? (
          <div className="coldstart">
            <SealMark className="seal-emblem" />
            <h1>Talk forever.</h1>
            <ul className="thesis">
              <li>The archive is exact.</li>
              <li>The view is bounded.</li>
              <li>Nothing is forgotten silently.</li>
            </ul>
          </div>
        ) : (
          <>
            <Transcript
              threadId={threadId ?? ""}
              episodes={window_.episodes}
              capsules={capsules}
              hasOlder={window_.hasOlder}
              loadingOlder={loadingOlder}
              streaming={streaming}
              jumpTo={jumpTo}
              onNearTop={loadOlder}
              onViewportChange={(next) => setView({ firstSeq: next.firstSeq, lastSeq: next.lastSeq })}
              onForget={(episode) => setSheet({ kind: "forget", episode })}
              onScrolledChange={setScrolled}
            />
            <TimelineRail
              turns={stats?.turns ?? 1}
              capsules={capsules}
              handoffs={handoffs}
              view={view}
              onJump={jump}
              dateFor={dateFor}
            />
          </>
        )}
        {danglingTurn !== undefined ? (
          <div className="measure dangling">
            <div className="no-reply">no reply · send again to retry this turn</div>
          </div>
        ) : null}
      </div>

      <Composer
        models={models}
        model={model}
        budget={budget}
        busy={streaming !== undefined}
        attachments={attachments}
        onSend={send}
        onStop={stop}
        onPickModel={pickModel}
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

      {xray && threadId !== undefined ? (
        <Xray threadId={threadId} stats={stats} turnSeq={lastTurnSeq} onClose={() => setXray(false)} />
      ) : null}

      {sheet?.kind === "connect" ? (
        <Connect
          statuses={auth}
          grokCliAvailable={grokCli}
          onClose={() => {
            setSheet(undefined);
            setPendingText(undefined);
          }}
          onDone={() => {
            void (async () => {
              await refreshAuth();
              const list = await api.models(true).catch(() => models);
              setModels(list);
              setSheet(undefined);
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
          note="The bundle is encrypted with this passphrase. Credentials are never included."
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
          onConfirm={() => doForget(sheet.episode)}
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
