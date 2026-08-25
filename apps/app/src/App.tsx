import type {
  AuthStatus,
  CapsuleView,
  DemoSummary,
  Episode,
  Me,
  ModelInfo,
  PageRecord,
  ProviderId,
  Seq,
  ThreadStats,
} from "@pylos/protocol";
import { DEFAULT_BUDGET, MAX_THREAD_LIST_ROWS } from "@pylos/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ApiError, api, onSessionExpired, resolveBase, session, setSession, streamTurn } from "./api.ts";
import { Account } from "./components/Account.tsx";
import { Archive } from "./components/Archive.tsx";
import { Composer } from "./components/Composer.tsx";
import { Connect } from "./components/Connect.tsx";
import { EvidenceFigures } from "./components/Evidence.tsx";
import { Exchange } from "./components/Exchange.tsx";
import {
  CompactionBanner,
  FragmentBanner,
  isReadOnlyFragment,
  isReadOnlySource,
  SourceReadinessBanner,
} from "./components/FragmentBanner.tsx";
import { Gate } from "./components/Gate.tsx";
import { type Arrival, Presence, type Pulse } from "./components/Presence.tsx";
import { isProofDemoThread, ProofDemoPrompt, ProofDemoReentry, ProofTour } from "./components/ProofTour.tsx";
import { SignIn } from "./components/SignIn.tsx";
import { ConfirmSheet, PassphraseSheet, ThreadMenu } from "./components/ThreadMenu.tsx";
import type { StreamingTurn } from "./components/Transcript.tsx";
import { Xray } from "./components/Xray.tsx";
import { ARRIVAL_MS, PULSE_MS } from "./ring.ts";
import {
  type BundleTransfer,
  chooseBundleOpenPath,
  chooseBundleSavePath,
  inTauri,
  isMac,
  pickBundle,
  saveBytes,
  showWindow,
} from "./tauri.ts";
import { selectedBudgetForThread, selectedModelForThread } from "./thread-selection.ts";

const PAGE = 60;
const MAX_LOADED = 400;
const MAX_THREAD_PAGE_HISTORY = 64;
const MAX_THREAD_MENU_ROWS = MAX_THREAD_LIST_ROWS + 1;
const THREAD_KEY = "pylos.threadId";

/** How long the sent words take to shrink into the ring. */
const ENTERING_MS = 700;

const reducedMotion = (): boolean =>
  globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

/** The evidence counts what came back, not what was tried: a fault recovers nothing. */
const resolvedPages = (pages: PageRecord[]): number => pages.filter((page) => page.resolved).length;

function boundedThreadWindow(page: ThreadStats[], pinned: ThreadStats | undefined): ThreadStats[] {
  if (pinned === undefined || page.some((thread) => thread.threadId === pinned.threadId)) return page;
  return [pinned, ...page].slice(0, MAX_THREAD_MENU_ROWS);
}

interface Window_ {
  episodes: Episode[];
  hasOlder: boolean;
  hasNewer: boolean;
}

type Sheet =
  | { kind: "connect"; provider: ProviderId | undefined; select: string | undefined }
  | { kind: "export"; partial?: boolean }
  | { kind: "import"; name: string; path?: string; bytes?: Uint8Array }
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
  const [threadNextCursor, setThreadNextCursor] = useState<string | undefined>(undefined);
  const [threadHasMore, setThreadHasMore] = useState(false);
  const [threadPageAfter, setThreadPageAfter] = useState<string | undefined>(undefined);
  const [threadPageHistory, setThreadPageHistory] = useState<Array<string | undefined>>([]);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [window_, setWindow] = useState<Window_>({
    episodes: [],
    hasOlder: false,
    hasNewer: false,
  });
  const [capsules, setCapsules] = useState<CapsuleView[]>([]);
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
  const [arrivals, setArrivals] = useState<Arrival[]>([]);
  /** The newest turn whose arrival has landed on the ring; the count follows it. */
  const [landedSeq, setLandedSeq] = useState(0);
  const [entering, setEntering] = useState<{ text: string; at: number } | undefined>(undefined);
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
  const [proofDemo, setProofDemo] = useState<DemoSummary | undefined>(undefined);
  const [proofDemoBusy, setProofDemoBusy] = useState(false);
  const [proofDemoError, setProofDemoError] = useState<string | undefined>(undefined);

  const turn = useRef<{ abort: () => void } | undefined>(undefined);
  const maintenanceThread = useRef<string | undefined>(undefined);
  const bundleTransfer = useRef<Pick<BundleTransfer<unknown>, "abort"> | undefined>(undefined);
  const threadId = stats?.threadId;
  const hosted = me?.hosted === true;
  const fragmentReadOnly = isReadOnlyFragment(stats);
  const sourceReadiness = stats?.sourceReadiness;
  const sourceReadOnly = isReadOnlySource(stats);
  const mutationReadOnly = fragmentReadOnly || sourceReadOnly;
  const compactionPending = stats?.compaction?.pending === true || stats?.compactionPending === true;
  const writeBlocked = mutationReadOnly || compactionPending;
  const proofDemoAvailable = !writeBlocked && isProofDemoThread(stats);

  const say = useCallback((text: string, tone?: "bad"): void => {
    setToast(tone === undefined ? { text } : { text, tone });
    setTimeout(() => setToast(undefined), tone === "bad" ? 6500 : 3200);
  }, []);

  const currentTurn = useRef<number | undefined>(undefined);
  /** The answer's own arrival is lit once, on its first delta. */
  const answerArrived = useRef(false);

  /**
   * A turn has been written: its slot on the ring lights and spreads outward,
   * and the archive figure counts it at the moment the light settles.
   */
  const arrive = useCallback((seq: number): void => {
    const at = performance.now();
    setArrivals((current) => [...current.filter((item) => at - item.at < ARRIVAL_MS), { seq, at }]);
    setTimeout(() => setLandedSeq((current) => Math.max(current, seq)), reducedMotion() ? 0 : ARRIVAL_MS);
  }, []);

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
    setProofDemo(undefined);
    setProofDemoError(undefined);
    setViewTokens(thread.lastPacket?.tokens);
    setBudget(selectedBudgetForThread(thread));
    setViewRounds(undefined);
    setRecovered(thread.lastPacket?.pages ?? 0);
    setPulses([]);
    setArrivals([]);
    setLandedSeq(0);
    setEntering(undefined);
    setFaults([]);
    const lastUser = [...episodes].reverse().find((episode) => episode.role === "user");
    setLastTurnSeq(lastUser?.seq);
    setModel(selectedModelForThread(thread));
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
    const page = await api.listThreadsPage();
    const remembered = localStorage.getItem(THREAD_KEY);
    let target = page.threads.find((thread) => thread.threadId === remembered);
    if (target === undefined && remembered !== null) {
      target = await api.thread(remembered).catch(() => undefined);
    }
    target ??= page.threads[0] ?? (await api.createThread());
    setThreads(boundedThreadWindow(page.threads, target));
    setThreadNextCursor(page.nextCursor);
    setThreadHasMore(page.hasMore);
    setThreadPageAfter(undefined);
    setThreadPageHistory([]);
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
        setThreads([]);
        setThreadNextCursor(undefined);
        setThreadHasMore(false);
        setThreadPageAfter(undefined);
        setThreadPageHistory([]);
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
    const [thread, capsuleList, page] = await Promise.all([
      api.thread(threadId),
      api.capsules(threadId).catch(() => capsules),
      api
        .listThreadsPage()
        .catch(() => ({ threads, nextCursor: threadNextCursor, hasMore: threadHasMore, byteLength: 0 })),
    ]);
    setStats(thread);
    setCapsules(capsuleList);
    setThreads(boundedThreadWindow(page.threads, thread));
    setThreadNextCursor(page.nextCursor);
    setThreadHasMore(page.hasMore);
    setThreadPageAfter(undefined);
    setThreadPageHistory([]);
  }, [threadId, capsules, threads, threadNextCursor, threadHasMore]);

  // Imported zero-capsule backlogs can be very large. Drive one fixed-size
  // maintenance request at a time and yield to the browser between passes;
  // no user click or turn retry is needed, and no provider lane is touched.
  useEffect(() => {
    if (threadId === undefined || !compactionPending || mutationReadOnly) {
      if (threadId === undefined || maintenanceThread.current === threadId) {
        maintenanceThread.current = undefined;
      }
      return;
    }
    if (maintenanceThread.current === threadId) return;
    maintenanceThread.current = threadId;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const advance = async (): Promise<void> => {
      try {
        const next = await api.maintenance(threadId);
        if (cancelled) return;
        setStats(next);
        const pending = next.compaction?.pending === true || next.compactionPending === true;
        if (pending) {
          timer = setTimeout(() => void advance(), 16);
        } else {
          maintenanceThread.current = undefined;
        }
      } catch (error) {
        if (!cancelled) {
          say(
            `Archive index rebuilding paused: ${error instanceof Error ? error.message : String(error)}`,
            "bad",
          );
        }
        maintenanceThread.current = undefined;
      }
    };
    void advance();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (maintenanceThread.current === threadId) maintenanceThread.current = undefined;
    };
  }, [threadId, compactionPending, mutationReadOnly, say]);

  const loadOlderThreads = useCallback((): void => {
    if (loadingThreads || !threadHasMore || threadNextCursor === undefined) return;
    const after = threadNextCursor;
    setLoadingThreads(true);
    void api
      .listThreadsPage({ after })
      .then((page) => {
        setThreads(boundedThreadWindow(page.threads, stats));
        setThreadNextCursor(page.nextCursor);
        setThreadHasMore(page.hasMore);
        setThreadPageHistory((current) => [...current, threadPageAfter].slice(-MAX_THREAD_PAGE_HISTORY));
        setThreadPageAfter(after);
      })
      .finally(() => setLoadingThreads(false));
  }, [loadingThreads, threadHasMore, threadNextCursor, stats, threadPageAfter]);

  const loadNewerThreads = useCallback((): void => {
    if (loadingThreads || threadPageHistory.length === 0) return;
    const previousAfter = threadPageHistory.at(-1);
    setLoadingThreads(true);
    void api
      .listThreadsPage(previousAfter === undefined ? {} : { after: previousAfter })
      .then((page) => {
        setThreads(boundedThreadWindow(page.threads, stats));
        setThreadNextCursor(page.nextCursor);
        setThreadHasMore(page.hasMore);
        setThreadPageHistory((current) => current.slice(0, -1));
        setThreadPageAfter(previousAfter);
      })
      .finally(() => setLoadingThreads(false));
  }, [loadingThreads, threadPageHistory, stats]);

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
      if (threadId === undefined || streaming !== undefined || writeBlocked) return;
      if (!providerConfigured(model)) {
        setPendingText(text);
        setSheet({ kind: "connect", provider: providerOf(model), select: undefined });
        return;
      }
      setProofDemo(undefined);
      setStreaming({ text: "", model, pages: [] });
      setBuilding(0.08);
      setRecovered(0);
      setViewRounds(undefined);
      setFaults([]);
      // What you just said leaves the composer and goes into the ring.
      answerArrived.current = false;
      setEntering({ text, at: performance.now() });
      setTimeout(() => setEntering(undefined), ENTERING_MS);

      const handle = streamTurn(threadId, { text, model, budget }, (event) => {
        if (event.type === "episode") {
          if (event.episode.role === "user") {
            setLastTurnSeq(event.episode.seq);
            currentTurn.current = event.episode.seq;
            arrive(event.episode.seq);
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
          setStreaming((current) =>
            current === undefined
              ? current
              : {
                  ...current,
                  ...(event.pages.length > 0 ? { pages: event.pages } : {}),
                  ...(event.coverage === undefined ? {} : { coverage: event.coverage }),
                  ...(event.reachability === undefined ? {} : { reachability: event.reachability }),
                },
          );
        } else if (event.type === "page") {
          const page: PageRecord = event.page;
          setRecovered((count) => count + (page.resolved ? 1 : 0));
          light([page]);
          setStreaming((current) =>
            current === undefined ? current : { ...current, pages: [...current.pages, page] },
          );
        } else if (event.type === "delta") {
          if (!answerArrived.current) {
            answerArrived.current = true;
            arrive((currentTurn.current ?? stats?.turns ?? 0) + 1);
          }
          // The gate is the only release point. A provider or adapter that
          // leaks an early delta must not put provisional prose in the view.
          setStreaming((current) => {
            if (current === undefined || current.gate === undefined) return current;
            return { ...current, text: current.text + event.text };
          });
          setBuilding((current) => (current === undefined ? current : undefined));
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
        } else if (event.type === "gate") {
          // Clear any draft that may have arrived before the gate. Only deltas
          // after this receipt are committed to the live answer surface.
          setStreaming((current) =>
            current === undefined ? current : { ...current, gate: event.receipt, text: "" },
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
    [
      threadId,
      streaming,
      writeBlocked,
      model,
      budget,
      stats?.turns,
      providerConfigured,
      providerOf,
      refreshThread,
      say,
      light,
      arrive,
    ],
  );

  const openProofDemo = useCallback((): void => {
    if (
      threadId === undefined ||
      writeBlocked ||
      proofDemoBusy ||
      (stats?.turns !== 0 && !proofDemoAvailable)
    )
      return;
    setProofDemoBusy(true);
    setProofDemoError(undefined);
    const summary = stats?.turns === 0 ? api.demo(threadId) : api.demoSummary(threadId);
    void summary
      .then(async (summary) => {
        await openThread(summary.thread.threadId);
        // `GET /threads/:id` is intentionally cheap and does not run full
        // verification. The demo response has just verified the entire proof
        // chain, so keep that witnessed summary instead of replacing it with
        // the cheaper unverified refresh performed by `openThread`.
        setStats(summary.thread);
        setProofDemo(summary);
        const page = await api.listThreadsPage();
        setThreads(boundedThreadWindow(page.threads, summary.thread));
        setThreadNextCursor(page.nextCursor);
        setThreadHasMore(page.hasMore);
        setThreadPageAfter(undefined);
        setThreadPageHistory([]);
      })
      .catch((error: unknown) => {
        setProofDemoError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setProofDemoBusy(false));
  }, [threadId, stats?.turns, writeBlocked, proofDemoBusy, proofDemoAvailable, openThread]);

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
      if (writeBlocked || next === model) return;
      setModel(next);
      if (threadId === undefined) return;
      void api.settings(threadId, { model: next }).catch(() => undefined);
    },
    [writeBlocked, model, threadId],
  );

  const attach = useCallback(
    (files: File[]): void => {
      if (writeBlocked || threadId === undefined) return;
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
    [writeBlocked, threadId, refreshThread, say],
  );

  const doExport = useCallback(
    (passphrase: string, partial = false): void => {
      const fragment = stats?.fragment;
      if (threadId === undefined || (fragmentReadOnly && !partial)) return;
      if (partial && fragment === undefined) return;
      setSheetBusy(true);
      setSheetError(undefined);
      void (async () => {
        const range: [Seq, Seq] | undefined =
          partial && fragment !== undefined ? [fragment.fromSeq, fragment.toSeq] : undefined;
        const name = partial
          ? `pylos-fragment-${threadId.slice(0, 8)}-${fragment?.fromSeq ?? 0}-${fragment?.toSeq ?? 0}.pylos`
          : `pylos-${threadId.slice(0, 8)}-${stats?.turns ?? 0}.pylos`;
        let transfer: Pick<BundleTransfer<unknown>, "abort"> | undefined;
        try {
          if (inTauri && !partial) {
            const path = await chooseBundleSavePath(name);
            if (path === undefined) return;
            const native = api.exportBundleToFile(threadId, passphrase, path);
            transfer = native;
            bundleTransfer.current = native;
            await native.done;
            setSheet(undefined);
            say(`Exported ${name}`);
            return;
          }
          const bytes = await api.exportBundle(threadId, passphrase, range);
          const path = await saveBytes(name, bytes);
          setSheet(undefined);
          if (path !== undefined) say(`Exported ${name}`);
        } catch (error) {
          setSheetError(error instanceof Error ? error.message : String(error));
        } finally {
          if (bundleTransfer.current === transfer) bundleTransfer.current = undefined;
          setSheetBusy(false);
        }
      })();
    },
    [threadId, stats?.turns, stats?.fragment, fragmentReadOnly, say],
  );

  const doImport = useCallback(
    (passphrase: string, name: string, selection: { path?: string; bytes?: Uint8Array }): void => {
      setSheetBusy(true);
      setSheetError(undefined);
      void (async () => {
        let transfer: Pick<BundleTransfer<unknown>, "abort"> | undefined;
        try {
          let imported: ThreadStats;
          if (inTauri && selection.path !== undefined) {
            const native = api.importBundleFromFile(selection.path, name, passphrase);
            transfer = native;
            bundleTransfer.current = native;
            imported = await native.done;
          } else if (selection.bytes !== undefined) {
            imported = await api.importBundle(selection.bytes, name, passphrase);
          } else {
            throw new Error("No bundle file was selected.");
          }
          setSheet(undefined);
          await openThread(imported.threadId);
          const page = await api.listThreadsPage();
          setThreads(boundedThreadWindow(page.threads, imported));
          setThreadNextCursor(page.nextCursor);
          setThreadHasMore(page.hasMore);
          setThreadPageAfter(undefined);
          setThreadPageHistory([]);
          say(
            imported.fragment === undefined
              ? imported.sourceReadiness === undefined
                ? `Imported ${imported.turns} turns · chain verified`
                : `Imported ${imported.turns} turns · read-only quarantine at #${imported.sourceReadiness.seq}`
              : `Imported ${imported.turns} turns · read-only fragment #${imported.fragment.fromSeq}-#${imported.fragment.toSeq}`,
          );
        } catch (error) {
          setSheetError(error instanceof Error ? error.message : String(error));
        } finally {
          if (bundleTransfer.current === transfer) bundleTransfer.current = undefined;
          setSheetBusy(false);
        }
      })();
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
      if (fragmentReadOnly || threadId === undefined) return;
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
          say(
            result.cleanupPending
              ? "Forgotten and recorded; attachment cleanup is pending the next vault recovery."
              : "Forgotten, and recorded as forgotten.",
          );
        })
        .catch((error: Error) => say(error.message, "bad"));
    },
    [fragmentReadOnly, threadId, refreshThread, say],
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
  /** Local first run: models are listed but none of their providers holds credentials yet. */
  const noProviderConnected = !hosted && models.length > 0 && !models.some((entry) => entry.available);
  /** A turn is counted when its light settles on the ring, not when it is asked for. */
  const shownTurns = Math.max(stats?.turns ?? 0, landedSeq);
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
        <span className="mark" aria-hidden="true">
          <img src={`${import.meta.env.BASE_URL}art/empyrean.webp`} alt="" />
        </span>
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
                  const page = await api.listThreadsPage();
                  setThreads(boundedThreadWindow(page.threads, created));
                  setThreadNextCursor(page.nextCursor);
                  setThreadHasMore(page.hasMore);
                  setThreadPageAfter(undefined);
                  setThreadPageHistory([]);
                });
              }}
              hasMore={threadHasMore}
              loadingMore={loadingThreads}
              hasNewer={threadPageHistory.length > 0}
              onLoadOlder={loadOlderThreads}
              onLoadNewer={loadNewerThreads}
              onOpen={(id) => {
                setTitleMenu(false);
                void openThread(id);
              }}
              onExport={() => {
                setTitleMenu(false);
                setSheetError(undefined);
                setSheet({ kind: "export" });
              }}
              onExportPartial={() => {
                setTitleMenu(false);
                setSheetError(undefined);
                setSheet({ kind: "export", partial: true });
              }}
              onImport={() => {
                setTitleMenu(false);
                void (async () => {
                  try {
                    if (inTauri) {
                      const path = await chooseBundleOpenPath();
                      if (path === undefined) return;
                      setSheetError(undefined);
                      setSheet({
                        kind: "import",
                        name: path.split(/[\\/]/).pop() ?? "thread.pylos",
                        path,
                      });
                      return;
                    }
                    const picked = await pickBundle();
                    if (picked === undefined) return;
                    setSheetError(undefined);
                    setSheet({ kind: "import", name: picked.name, bytes: picked.bytes });
                  } catch (error) {
                    say(error instanceof Error ? error.message : String(error), "bad");
                  }
                })();
              }}
            />
          ) : null}
        </span>
        <span className="titlebar-spacer" />
        {hosted && me !== undefined ? <Account me={me} onSignOut={signOut} /> : null}
      </header>

      <main className="stage" data-proof-tour={proofDemo === undefined ? undefined : "true"}>
        {stats?.fragment !== undefined ? <FragmentBanner fragment={stats.fragment} /> : null}
        {sourceReadOnly && stats?.sourceReadiness !== undefined ? (
          <SourceReadinessBanner readiness={stats.sourceReadiness} />
        ) : null}
        {stats?.compaction !== undefined ? <CompactionBanner status={stats.compaction} /> : null}
        <div className="presence-stage" data-empty={empty ? "true" : undefined}>
          <div className="presence-frame">
            <Presence
              turns={shownTurns}
              state={presenceState}
              fill={building ?? 0}
              pulses={pulses}
              arrivals={arrivals}
              faults={faults}
              flickerAt={flickerAt}
            />
          </div>
          <EvidenceFigures
            stats={stats}
            turns={shownTurns}
            recovered={recovered}
            viewTokens={viewTokens}
            viewRounds={viewRounds}
            budget={budget}
            onOpen={() => setXray(true)}
          />
        </div>

        {empty ? (
          writeBlocked ? (
            <div className="empty fragment-empty" data-fragment-read-only="true">
              {sourceReadiness
                ? "This legacy source is quarantined until its offending episode is remediated."
                : "This authenticated fragment has no writable continuation."}
            </div>
          ) : (
            <ProofDemoPrompt
              busy={proofDemoBusy}
              error={proofDemoError}
              onOpen={openProofDemo}
              onConnect={
                noProviderConnected
                  ? () => {
                      setSheetError(undefined);
                      setSheet({ kind: "connect", provider: providerOf(model), select: undefined });
                    }
                  : undefined
              }
            />
          )
        ) : (
          <>
            {proofDemo !== undefined ? (
              <ProofTour summary={proofDemo} onClose={() => setProofDemo(undefined)} />
            ) : null}
            {proofDemo === undefined ? (
              <>
                {proofDemoAvailable ? (
                  <ProofDemoReentry busy={proofDemoBusy} error={proofDemoError} onOpen={openProofDemo} />
                ) : null}
                <Exchange
                  threadId={threadId ?? ""}
                  question={exchange.question}
                  answer={exchange.answer}
                  streaming={streaming}
                  awaitingReply={awaitingReply}
                  hasEarlier={window_.hasOlder || window_.episodes.length > 2}
                  onEarlier={() => setArchive(true)}
                />
              </>
            ) : null}
          </>
        )}
      </main>

      {entering === undefined ? null : (
        <p className="entering" key={entering.at} aria-hidden="true">
          {entering.text}
        </p>
      )}

      {proofDemo === undefined ? (
        <Composer
          readOnly={writeBlocked}
          readOnlyMessage={
            compactionPending
              ? "The bounded archive index is rebuilding; questions, attachments, handoffs, and settings will unlock automatically."
              : sourceReadOnly
                ? "This legacy source is quarantined; questions, attachments, handoffs, and settings are disabled until remediation."
                : undefined
          }
          models={models}
          model={model}
          budget={budget}
          busy={streaming !== undefined}
          attachments={attachments}
          onSend={send}
          onStop={stop}
          onError={(message) => say(message, "bad")}
          onPickModel={pickModel}
          onConnectModel={(provider, next) => {
            setSheetError(undefined);
            setSheet({ kind: "connect", provider, select: next });
          }}
          onEarlier={() => setArchive(true)}
          onAttach={attach}
          onRemoveAttachment={(seq) =>
            setAttachments((current) => current.filter((item) => item.seq !== seq))
          }
          onBudget={(next) => {
            if (writeBlocked) return;
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
      ) : null}

      {archive ? (
        <Archive
          readOnly={fragmentReadOnly}
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
          onForget={(episode) => {
            if (!fragmentReadOnly) setSheet({ kind: "forget", episode });
          }}
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
          title={sheet.partial ? "Export this fragment range" : "Export this thread"}
          note={
            sheet.partial
              ? `Only the authenticated range #${stats?.fragment?.fromSeq ?? 0}–#${stats?.fragment?.toSeq ?? 0} will be exported. The original thread provenance is retained.`
              : "The bundle is encrypted with this passphrase, and carries the receipts — what each turn was compiled from — so the X-ray survives the move. Credentials are never included."
          }
          confirm="Export"
          busy={sheetBusy}
          error={sheetError}
          onCancel={() => {
            bundleTransfer.current?.abort();
            bundleTransfer.current = undefined;
            setSheet(undefined);
          }}
          onSubmit={(passphrase) => doExport(passphrase, sheet.partial === true)}
        />
      ) : null}

      {sheet?.kind === "import" ? (
        <PassphraseSheet
          title={`Import ${sheet.name}`}
          note="The hash chain is verified before anything is accepted."
          confirm="Import"
          busy={sheetBusy}
          error={sheetError}
          onCancel={() => {
            bundleTransfer.current?.abort();
            bundleTransfer.current = undefined;
            setSheet(undefined);
          }}
          onSubmit={(passphrase) => doImport(passphrase, sheet.name, sheet)}
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
