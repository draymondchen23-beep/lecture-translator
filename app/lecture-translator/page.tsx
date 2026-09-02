"use client";

import {
  memo,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import styles from "./lecture-translator.module.css";
import { clearWorkspaceData, deleteLectureData, loadLectureAudio, loadWorkspace, saveLectureAudio, saveWorkspace } from "./storage";
import type {
  ActiveProvider,
  LectureNotes,
  LectureSession,
  ProviderPreference,
  RealtimeServerEvent,
  TranscriptSegment,
  Workspace,
} from "./types";
import { useRealtimeLecture } from "./use-realtime-lecture";
import { reducePartialEvent } from "./partial-events.mjs";
import { createFinalSegmentGate, shouldRefineFinal } from "./incremental-refinement.mjs";
import { AuthPanel, type SignedInUser } from "./auth-panel";
import { centeredScrollTop, shouldRecenter, splitSentences, visibleContentRect } from "./live-display.mjs";
import { useProgressiveText } from "./use-progressive-text";

type Tab = "transcript" | "notes" | "terms" | "bookmarks";
type AssistAction = "explain" | "simplify" | "example" | "term";

const isDevelopment = process.env.NODE_ENV !== "production";
const providerNames: Record<ProviderPreference, string> = { auto: "Auto", qwen: "Qwen", tencent: "Tencent" };
const stateNames = {
  IDLE: "Ready",
  CONNECTING: "Connecting",
  LISTENING: "Listening",
  SPEAKING: "Speaking",
  PROCESSING: "Processing",
  PAUSED: "Paused",
  RECONNECTING: "Reconnecting",
  ENDING: "Ending",
  ENDED: "Ended",
  ERROR: "Needs attention",
} as const;
type RefinementUsage = { requests: number; externalRequests: number; cacheHits: number; inputTokens: number; outputTokens: number; inputChars: number; outputChars: number; estimatedCostUsd: number };
const emptyRefinementUsage: RefinementUsage = { requests: 0, externalRequests: 0, cacheHits: 0, inputTokens: 0, outputTokens: 0, inputChars: 0, outputChars: 0, estimatedCostUsd: 0 };

function uid() { return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function newSession(sessionId = uid(), dateValue = new Date().toISOString()): LectureSession {
  return {
    id: sessionId,
    title: "New lecture",
    courseName: "KCL Biomedical Engineering · Year 1",
    date: dateValue,
    startedAt: null,
    endedAt: null,
    duration: 0,
    sourceLanguage: "en",
    targetLanguage: "zh",
    provider: "auto",
    status: "draft",
    segments: [],
    terminology: {},
  };
}

function seedWorkspace(): Workspace {
  const session = newSession("initial-session", "2000-01-01T12:00:00.000Z");
  return {
    version: 2,
    sessions: [session],
    activeSessionId: session.id,
    settings: {
      provider: "auto",
      sourceLanguage: "en",
      targetLanguage: "zh",
      refinement: true,
      vad: true,
      autoScroll: true,
      autoNotes: true,
      noteDetail: "standard",
      saveAudio: false,
      theme: "system",
    },
  };
}

function migrateLegacy(value: unknown): Workspace | null {
  if (!value || typeof value !== "object") return null;
  const legacy = value as Record<string, unknown>;
  if (legacy.version === 2 && Array.isArray(legacy.sessions)) return legacy as unknown as Workspace;
  if (legacy.version !== 1 || !Array.isArray(legacy.projects)) return null;
  const sessions: LectureSession[] = [];
  for (const projectValue of legacy.projects) {
    const project = projectValue as Record<string, unknown>;
    if (!Array.isArray(project.lectures)) continue;
    for (const lectureValue of project.lectures) {
      const lecture = lectureValue as Record<string, unknown>;
      const sessionId = String(lecture.id || uid());
      const createdAt = String(lecture.createdAt || new Date().toISOString());
      const oldSegments = Array.isArray(lecture.segments) ? lecture.segments : [];
      sessions.push({
        ...newSession(),
        id: sessionId,
        title: String(lecture.title || "Imported lecture"),
        courseName: String(project.name || "Imported course"),
        date: createdAt,
        endedAt: createdAt,
        duration: Number(lecture.elapsed) || 0,
        status: "ended",
        provider: legacy.provider === "tencent" ? "tencent" : "qwen",
        segments: oldSegments.map((segmentValue, index) => {
          const segment = segmentValue as Record<string, unknown>;
          return {
            id: String(segment.id || uid()), sessionId, sequence: index, startTime: index * 8, endTime: index * 8 + 8,
            sourceText: String(segment.english || ""), translatedText: String(segment.chinese || ""), sourceLanguage: "en", targetLanguage: "zh",
            provider: segment.provider === "tencent" ? "tencent" : "qwen", speaker: "Lecturer", confidence: null, isFinal: true,
            createdAt, bookmarked: false, refinementState: "idle",
          };
        }),
      });
    }
  }
  if (!sessions.length) return null;
  const next = seedWorkspace();
  return { ...next, sessions, activeSessionId: sessions[0].id };
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function relativeGroup(dateValue: string) {
  const days = Math.floor((Date.now() - new Date(dateValue).getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days <= 7) return "Previous 7 Days";
  return "Previous 30 Days";
}

const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function displayDate(value: string) {
  const date = new Date(value);
  return `${weekdayNames[date.getUTCDay()]}, ${monthNames[date.getUTCMonth()]} ${date.getUTCDate()}`;
}
function shortDate(value: string) {
  const date = new Date(value);
  return `${monthNames[date.getUTCMonth()].slice(0, 3)} ${date.getUTCDate()}`;
}

function useDialogFocus(onClose: () => void) {
  const dialogRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusableSelector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector));
    focusables[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab" || !focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); returnFocus?.focus(); };
  }, [onClose]);
  return dialogRef;
}

function Icon({ name }: { name: "menu" | "plus" | "search" | "settings" | "copy" | "bookmark" | "spark" | "edit" | "clock" | "download" | "close" | "pause" | "play" | "stop" | "mic" | "arrow" | "more" | "pin" | "trash" }) {
  const paths = {
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    plus: <path d="M12 5v14M5 12h14" />,
    search: <><circle cx="11" cy="11" r="7" /><path d="m16 16 4 4" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
    bookmark: <path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-4-6 4Z" />,
    spark: <><path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4Z" /><path d="m18 14 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8Z" /></>,
    edit: <><path d="m14 5 5 5L9 20H4v-5Z" /><path d="m12 7 5 5" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    download: <><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M5 20h14" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    pause: <path d="M9 5v14M15 5v14" />,
    play: <path d="m8 5 11 7-11 7Z" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="3" />,
    mic: <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4" /></>,
    arrow: <path d="m7 10 5 5 5-5" />,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
    pin: <><path d="m9 3 6 6M10 8l-5 5 6 1 1 6 5-5" /><path d="m8 16-5 5" /></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13" /><path d="M10 11v5M14 11v5" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

const TranscriptRow = memo(function TranscriptRow({
  segment, side, query, editing, scrollRef, onBookmark, onAsk, onEdit, onSaveEdit,
}: {
  segment: TranscriptSegment; side: "source" | "translation"; query: string; editing: boolean;
  scrollRef?: (element: HTMLElement | null) => void;
  onBookmark(id: string): void; onAsk(segment: TranscriptSegment): void; onEdit(id: string): void;
  onSaveEdit(id: string, source: string, translation: string): void;
}) {
  const [source, setSource] = useState(segment.sourceText);
  const [translation, setTranslation] = useState(segment.translatedText);
  useEffect(() => { setSource(segment.sourceText); setTranslation(segment.translatedText); }, [segment.sourceText, segment.translatedText]);
  const highlighted = query && `${segment.sourceText} ${segment.translatedText}`.toLowerCase().includes(query.toLowerCase());
  const text = side === "source" ? segment.sourceText : segment.translatedText;
  const sentences = splitSentences(text, side === "source" ? "en" : "zh");
  return <article ref={scrollRef} className={`${styles.segment} ${styles.columnSegment} ${highlighted ? styles.searchMatch : ""}`} id={side === "source" ? `segment-${segment.id}` : undefined}>
    <div className={styles.segmentBody}>
      {side === "source" && editing ? <>
        <textarea aria-label="English transcript" value={source} onChange={(event) => setSource(event.target.value)} />
        <textarea aria-label="Chinese translation" value={translation} onChange={(event) => setTranslation(event.target.value)} />
        <div className={styles.editActions}><button onClick={() => onSaveEdit(segment.id, source, translation)}>Save</button><button onClick={() => onEdit("")}>Cancel</button></div>
      </> : <>
        {sentences.length ? sentences.map((sentence, index) => <p key={`${segment.id}-${side}-${index}`} className={side === "source" ? styles.sourceText : styles.translationText}>{sentence}</p>) : <p className={side === "source" ? styles.sourceText : styles.translationText}><span className={styles.muted}>Translation pending…</span></p>}
      </>}
      {side === "source" ? <span className={styles.providerTag}>{segment.provider === "qwen" ? "Qwen" : "Tencent"}{segment.refinementState === "refined" ? " · MT refined" : ""}</span> : null}
    </div>
    {side === "source" ? <div className={styles.segmentActions} aria-label="Transcript actions">
      <button title="Copy" onClick={() => navigator.clipboard.writeText(`${segment.sourceText}\n${segment.translatedText}`)}><Icon name="copy" /></button>
      <button title="Bookmark" className={segment.bookmarked ? styles.actionActive : ""} onClick={() => onBookmark(segment.id)}><Icon name="bookmark" /></button>
      <button title="Ask AI" onClick={() => onAsk(segment)}><Icon name="spark" /></button>
      <button title="Edit" onClick={() => onEdit(segment.id)}><Icon name="edit" /></button>
    </div> : null}
  </article>;
});

function LectureTranslatorWorkspace({ user }: { user: SignedInUser }) {
  const [workspace, setWorkspace] = useState<Workspace>(() => seedWorkspace());
  const [hydrated, setHydrated] = useState(false);
  const [tab, setTab] = useState<Tab>("transcript");
  const [partial, setPartial] = useState({ source: "", translation: "", sequence: 0 });
  const [latestAnchorId, setLatestAnchorId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [assist, setAssist] = useState<{ segment: TranscriptSegment; answer: string; loading: boolean; error: string } | null>(null);
  const [editingId, setEditingId] = useState("");
  const [notice, setNotice] = useState("");
  const [notesLoading, setNotesLoading] = useState(false);
  const [autoFollowing, setAutoFollowing] = useState(true);
  const [columnFollowing, setColumnFollowing] = useState({ source: true, translation: true });
  const [showOlder, setShowOlder] = useState(false);
  const [providerStatus, setProviderStatus] = useState({ qwen: false, tencent: false, refinement: false });
  const [refinementUsage, setRefinementUsage] = useState<RefinementUsage>(emptyRefinementUsage);
  const [providerStatusLoaded, setProviderStatusLoaded] = useState(false);
  const [activeProvider, setActiveProvider] = useState<ActiveProvider | null>(null);
  const [elapsedTick, setElapsedTick] = useState(0);
  const [historyMenuId, setHistoryMenuId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<LectureSession | null>(null);
  const activeIdRef = useRef(workspace.activeSessionId);
  const workspaceRef = useRef(workspace);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const liveRef = useRef<HTMLElement | null>(null);
  const sourceColumnRef = useRef<HTMLDivElement | null>(null);
  const translationColumnRef = useRef<HTMLDivElement | null>(null);
  const sourceAnchorRef = useRef<HTMLElement | null>(null);
  const translationAnchorRef = useRef<HTMLElement | null>(null);
  const sourceTextRef = useRef<HTMLElement | null>(null);
  const translationTextRef = useRef<HTMLElement | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const programmaticScrollRef = useRef<number | null>(null);
  const manualScrollRef = useRef(false);
  const userScrollLockRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const pendingScrollBehaviorRef = useRef<ScrollBehavior>("auto");
  const columnScrollFramesRef = useRef<{ source: number | null; translation: number | null }>({ source: null, translation: null });
  const pendingColumnBehaviorRef = useRef<{ source: ScrollBehavior; translation: ScrollBehavior }>({ source: "auto", translation: "auto" });
  const translationSecondScrollFrameRef = useRef<number | null>(null);
  const columnProgrammaticRef = useRef<{ source: number | null; translation: number | null }>({ source: null, translation: null });
  const columnPointerIntentRef = useRef({ source: false, translation: false });
  const finalSegmentGateRef = useRef(createFinalSegmentGate());

  const activeSession = workspace.sessions.find((session) => session.id === workspace.activeSessionId) || workspace.sessions[0];
  activeIdRef.current = activeSession.id;
  workspaceRef.current = workspace;
  const liveTranslation = useProgressiveText(partial.translation, {
    enabled: activeSession.status === "recording",
    resetKey: partial.sequence,
  });

  const updateSession = useCallback((sessionId: string, updater: (session: LectureSession) => LectureSession) => {
    setWorkspace((current) => ({ ...current, sessions: current.sessions.map((session) => session.id === sessionId ? updater(session) : session) }));
  }, []);

  const refineSegment = useCallback(async (sessionId: string, segment: TranscriptSegment) => {
    const current = workspaceRef.current;
    if (!current.settings.refinement || !segment.sourceText) return;
    updateSession(sessionId, (session) => ({ ...session, segments: session.segments.map((item) => item.id === segment.id ? { ...item, refinementState: "refining" } : item) }));
    try {
      const response = await fetch("/api/translate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lectureId: sessionId, sessionId, segmentId: segment.id, text: segment.sourceText, terminology: workspaceRef.current.sessions.find((item) => item.id === sessionId)?.terminology }) });
      const result = await response.json() as { translation?: string; warning?: boolean; usage?: RefinementUsage };
      if (!response.ok || !result.translation) throw new Error();
      if (result.usage) setRefinementUsage(result.usage);
      if (result.warning) setNotice("A long segment was refined; future segments will remain incremental.");
      updateSession(sessionId, (session) => ({
        ...session,
        segments: session.segments.map((item) => item.id === segment.id ? { ...item, translatedText: result.translation || item.translatedText, refinementState: "refined" } : item),
      }));
    } catch {
      updateSession(sessionId, (session) => ({ ...session, segments: session.segments.map((item) => item.id === segment.id ? { ...item, refinementState: "error" } : item) }));
    }
  }, [updateSession]);

  const onRealtimeEvent = useCallback((event: RealtimeServerEvent) => {
    const sessionId = activeIdRef.current;
    if (event.type === "source.partial" || event.type === "translation.partial") setPartial((current) => reducePartialEvent(current, event));
    if (event.type === "state" && event.provider) setActiveProvider(event.provider);
    if (event.type === "provider.switched") {
      setActiveProvider(event.to);
      setNotice(`Translation service switched to ${event.to === "qwen" ? "Qwen" : "Tencent"}`);
    }
    if (event.type === "error") setNotice(event.message);
    if (event.type === "segment.final") {
      const session = workspaceRef.current.sessions.find((item) => item.id === sessionId);
      const sessionStart = session?.startedAt ? new Date(session.startedAt).getTime() : event.startedAt;
      const segment: TranscriptSegment = {
        // Qwen's sequence restarts after a WebSocket reconnect, while the
        // original final event preserves its start time. Keep those identities
        // distinct so reconnects neither repeat history nor suppress new speech.
        id: `${sessionId}:${event.sequence}:${event.startedAt}`, sessionId, sequence: event.sequence,
        startTime: Math.max(0, (event.startedAt - sessionStart) / 1_000), endTime: Math.max(0, (event.endedAt - sessionStart) / 1_000),
        sourceText: event.sourceText, translatedText: event.translatedText, sourceLanguage: "en", targetLanguage: "zh",
        provider: event.provider, speaker: "Lecturer", confidence: event.confidence ?? null, isFinal: true,
        createdAt: new Date().toISOString(), bookmarked: false, refinementState: event.refined ? "refined" : "idle",
      };
      setLatestAnchorId(segment.id);
      updateSession(sessionId, (current) => current.segments.some((item) => item.id === segment.id) ? current : { ...current, segments: [...current.segments, segment] });
      setPartial((current) => reducePartialEvent(current, event));
      if (shouldRefineFinal(event) && finalSegmentGateRef.current.claim(sessionId, segment.id)) void refineSegment(sessionId, segment);
    }
  }, [refineSegment, updateSession]);

  const realtime = useRealtimeLecture({
    provider: workspace.settings.provider,
    sourceLanguage: workspace.settings.sourceLanguage,
    targetLanguage: workspace.settings.targetLanguage,
    vad: workspace.settings.vad,
    terminology: activeSession.terminology,
    saveAudio: workspace.settings.saveAudio,
    onAudioReady: (audio) => {
      const sessionId = activeIdRef.current;
      void saveLectureAudio(sessionId, audio).then(() => updateSession(sessionId, (session) => ({ ...session, hasAudio: true }))).catch(() => setNotice("The audio recording could not be saved on this device."));
    },
    onEvent: onRealtimeEvent,
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const freshStart = new URLSearchParams(window.location.search).get("fresh") === "1";
        if (freshStart) {
          await clearWorkspaceData();
          localStorage.removeItem("lecture-course-workspace-v1");
          window.history.replaceState(null, "", window.location.pathname);
        }
        let saved = await loadWorkspace();
        if (!saved) {
          const legacy = localStorage.getItem("lecture-course-workspace-v1");
          saved = legacy ? migrateLegacy(JSON.parse(legacy)) : null;
        }
        if (!cancelled && saved?.sessions.length) {
          const interrupted = saved.sessions.some((session) => session.status === "recording" || session.status === "paused");
          const recovered = {
            ...saved,
            sessions: saved.sessions.map((session) => session.status === "recording" || session.status === "paused"
              ? { ...session, status: "draft" as const, startedAt: null }
              : session),
          };
          setWorkspace(recovered);
          if (interrupted) setNotice("The previous lecture was interrupted. Your transcript was preserved; start again when ready.");
        }
        else if (!cancelled) {
          const session = newSession();
          setWorkspace((current) => ({ ...current, sessions: [session], activeSessionId: session.id }));
        }
      } catch { /* start with a safe empty workspace */ }
      if (!cancelled) setHydrated(true);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const timeout = window.setTimeout(() => void saveWorkspace(workspace), 250);
    return () => window.clearTimeout(timeout);
  }, [hydrated, workspace]);

  const refreshProviderStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/translate", { cache: "no-store" });
      if (!response.ok) throw new Error();
      const result = await response.json() as { providers?: { qwen?: boolean; tencent?: boolean }; refinement?: boolean; usage?: RefinementUsage };
      const status = { qwen: Boolean(result.providers?.qwen), tencent: Boolean(result.providers?.tencent), refinement: Boolean(result.refinement) };
      setProviderStatus(status);
      if (result.usage) setRefinementUsage(result.usage);
      setProviderStatusLoaded(true);
      return status;
    } catch {
      setProviderStatusLoaded(false);
      return null;
    }
  }, []);

  useEffect(() => { void refreshProviderStatus(); }, [refreshProviderStatus]);
  useEffect(() => { if (settingsOpen) void refreshProviderStatus(); }, [settingsOpen, refreshProviderStatus]);

  useEffect(() => {
    document.documentElement.dataset.lectureTheme = workspace.settings.theme;
    return () => {
      delete document.documentElement.dataset.lectureTheme;
    };
  }, [workspace.settings.theme]);

  const isRecording = activeSession.status === "recording" || activeSession.status === "paused";
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => { if (isRecording) event.preventDefault(); };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isRecording]);

  useEffect(() => {
    if (!isRecording || activeSession.status === "paused") return;
    const timer = window.setInterval(() => setElapsedTick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [activeSession.status, isRecording]);

  const elapsed = activeSession.startedAt && activeSession.status !== "ended"
    ? Math.max(activeSession.duration, Math.floor((Date.now() - new Date(activeSession.startedAt).getTime()) / 1_000))
    : activeSession.duration;

  const scrollLiveIntoView = useCallback((behavior: ScrollBehavior = "smooth") => {
    const target = liveRef.current;
    const container = transcriptRef.current;
    if (!target || !container) return;
    const containerRect = container.getBoundingClientRect();
    const dockTop = dockRef.current?.getBoundingClientRect().top ?? containerRect.bottom;
    const visibleRect = visibleContentRect(containerRect, dockTop);
    const targetRect = target.getBoundingClientRect();
    if (!shouldRecenter(visibleRect, targetRect)) return;
    const previousTimer = programmaticScrollRef.current;
    if (previousTimer !== null) window.clearTimeout(previousTimer);
    programmaticScrollRef.current = window.setTimeout(() => { programmaticScrollRef.current = null; }, behavior === "smooth" ? 700 : 80);
    const offset = (targetRect.top + targetRect.height / 2) - (visibleRect.top + visibleRect.height / 2);
    // Scroll the content surface itself so the floating dock is excluded from
    // the visual center. Instant bypasses the surface's global smooth setting
    // for height changes caused by individual displayed characters.
    container.scrollTo({ top: Math.max(0, container.scrollTop + offset), behavior: behavior === "auto" ? "instant" : behavior });
  }, []);

  const scrollColumnIntoView = useCallback((column: "source" | "translation", behavior: ScrollBehavior = "auto") => {
    const container = column === "source" ? sourceColumnRef.current : translationColumnRef.current;
    const target = column === "source" ? (sourceTextRef.current || sourceAnchorRef.current) : (translationTextRef.current || translationAnchorRef.current);
    if (!target || !container) return;
    const containerRect = container.getBoundingClientRect();
    const dockTop = dockRef.current?.getBoundingClientRect().top ?? containerRect.bottom;
    const targetRect = target.getBoundingClientRect();
    const stickyHeader = container.firstElementChild instanceof HTMLElement ? container.firstElementChild : null;
    const top = centeredScrollTop({
      currentScrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
      containerTop: containerRect.top,
      targetTop: targetRect.top,
      targetHeight: targetRect.height,
      dockTop,
      stickyTop: stickyHeader?.getBoundingClientRect().height ?? 0,
    });
    const previousTimer = columnProgrammaticRef.current[column];
    if (previousTimer !== null) window.clearTimeout(previousTimer);
    columnProgrammaticRef.current[column] = window.setTimeout(() => { columnProgrammaticRef.current[column] = null; }, behavior === "smooth" ? 700 : 80);
    container.scrollTo({ top, behavior: behavior === "auto" ? "instant" : behavior });
  }, []);

  const scheduleColumnScroll = useCallback((column: "source" | "translation", behavior: ScrollBehavior = "auto") => {
    if (behavior === "smooth") pendingColumnBehaviorRef.current[column] = "smooth";
    if (columnScrollFramesRef.current[column] !== null || (column === "translation" && translationSecondScrollFrameRef.current !== null)) return;
    columnScrollFramesRef.current[column] = window.requestAnimationFrame(() => {
      columnScrollFramesRef.current[column] = null;
      if (column === "translation") {
        // Let the final/live ref callback and text layout settle before the
        // translation column measures its target.
        translationSecondScrollFrameRef.current = window.requestAnimationFrame(() => {
          translationSecondScrollFrameRef.current = null;
          const nextBehavior = pendingColumnBehaviorRef.current[column];
          pendingColumnBehaviorRef.current[column] = "auto";
          scrollColumnIntoView(column, nextBehavior);
        });
        return;
      }
      const nextBehavior = pendingColumnBehaviorRef.current[column];
      pendingColumnBehaviorRef.current[column] = "auto";
      scrollColumnIntoView(column, nextBehavior);
    });
  }, [scrollColumnIntoView]);

  const scheduleLiveScroll = useCallback((behavior: ScrollBehavior = "auto") => {
    if (behavior === "smooth") pendingScrollBehaviorRef.current = "smooth";
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const nextBehavior = pendingScrollBehaviorRef.current;
      pendingScrollBehaviorRef.current = "auto";
      scrollLiveIntoView(nextBehavior);
    });
  }, [scrollLiveIntoView]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
    if (programmaticScrollRef.current !== null) window.clearTimeout(programmaticScrollRef.current);
    for (const column of ["source", "translation"] as const) {
      const frame = columnScrollFramesRef.current[column];
      if (frame !== null) window.cancelAnimationFrame(frame);
      const timer = columnProgrammaticRef.current[column];
      if (timer !== null) window.clearTimeout(timer);
    }
    if (translationSecondScrollFrameRef.current !== null) window.cancelAnimationFrame(translationSecondScrollFrameRef.current);
  }, []);

  useEffect(() => {
    if (!workspace.settings.autoScroll || !autoFollowing || tab !== "transcript") return;
    scheduleLiveScroll("smooth");
  }, [activeSession.segments.length, autoFollowing, partial.source, tab, workspace.settings.autoScroll, latestAnchorId, scheduleLiveScroll]);

  useEffect(() => {
    if (tab !== "transcript" || !partial.source || !columnFollowing.source) return;
    scheduleColumnScroll("source", "auto");
  }, [columnFollowing.source, partial.source, scheduleColumnScroll, tab]);

  useEffect(() => {
    if (tab !== "transcript" || !partial.translation || !columnFollowing.translation) return;
    scheduleColumnScroll("translation", "auto");
  }, [columnFollowing.translation, partial.translation, liveTranslation.displayed, scheduleColumnScroll, tab]);

  useEffect(() => {
    if (tab !== "transcript" || (!partial.source && !partial.translation)) return;
    if (partial.sequence === 0) return;
    scheduleColumnScroll("source", "smooth");
    scheduleColumnScroll("translation", "smooth");
  }, [partial.sequence, scheduleColumnScroll, tab]);

  useEffect(() => {
    // A final event clears partial before the new row is rendered. Keep the
    // completed row centered without depending on a partial payload.
    if (tab !== "transcript") return;
    if (columnFollowing.source) scheduleColumnScroll("source", "smooth");
    if (columnFollowing.translation) scheduleColumnScroll("translation", "smooth");
  }, [activeSession.segments.length, columnFollowing, latestAnchorId, scheduleColumnScroll, tab]);

  useEffect(() => {
    if (!workspace.settings.autoScroll || !autoFollowing || tab !== "transcript" || !liveRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => scheduleLiveScroll("auto"));
    observer.observe(liveRef.current);
    return () => observer.disconnect();
  }, [autoFollowing, latestAnchorId, partial.source, partial.translation, scheduleLiveScroll, tab, workspace.settings.autoScroll]);

  useEffect(() => {
    if (tab !== "transcript" || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      for (const column of ["source", "translation"] as const) {
        if (!columnFollowing[column]) continue;
        if (columnScrollFramesRef.current[column] !== null) continue;
        scheduleColumnScroll(column, "auto");
      }
    });
    if (sourceTextRef.current) observer.observe(sourceTextRef.current);
    if (translationTextRef.current) observer.observe(translationTextRef.current);
    if (sourceAnchorRef.current) observer.observe(sourceAnchorRef.current);
    if (translationAnchorRef.current) observer.observe(translationAnchorRef.current);
    return () => observer.disconnect();
  }, [columnFollowing, latestAnchorId, partial.source, partial.translation, scrollColumnIntoView, tab]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 5_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!historyMenuId) return;
    const closeMenu = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-history-menu]")) return;
      setHistoryMenuId("");
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setHistoryMenuId(""); };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", closeMenu); document.removeEventListener("keydown", closeOnEscape); };
  }, [historyMenuId]);

  const startLecture = async () => {
    if (providerStatusLoaded && !providerStatus.qwen) {
      setNotice("Qwen realtime translation is not configured on the server.");
      setSettingsOpen(true);
      return;
    }
    manualScrollRef.current = false;
    userScrollLockRef.current = false;
    columnPointerIntentRef.current = { source: false, translation: false };
    if (translationSecondScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(translationSecondScrollFrameRef.current);
      translationSecondScrollFrameRef.current = null;
    }
    setAutoFollowing(true);
    setColumnFollowing({ source: true, translation: true });
    void refreshProviderStatus();
    const startedAt = new Date().toISOString();
    updateSession(activeSession.id, (session) => ({ ...session, duration: 0, startedAt, endedAt: null, status: "recording", provider: "qwen" }));
    setTab("transcript");
    try { await realtime.start(); }
    catch { updateSession(activeSession.id, (session) => ({ ...session, status: "draft" })); }
  };

  const pauseLecture = () => {
    realtime.pause();
    updateSession(activeSession.id, (session) => ({ ...session, status: "paused", duration: elapsed }));
  };
  const resumeLecture = () => {
    realtime.resume();
    updateSession(activeSession.id, (session) => ({ ...session, status: "recording", startedAt: new Date(Date.now() - session.duration * 1_000).toISOString() }));
  };

  const generateNotes = useCallback(async (session = activeSession) => {
    if (!session.segments.length) { setNotice("Finish at least one transcript segment before generating notes."); return; }
    setNotesLoading(true);
    try {
      const response = await fetch("/api/summarize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ courseName: session.courseName, lecture: session.title, detail: workspaceRef.current.settings.noteDetail, segments: session.segments }) });
      const result = await response.json() as { summary?: LectureNotes; error?: string };
      if (!response.ok || !result.summary) throw new Error(result.error || "Unable to generate notes.");
      updateSession(session.id, (current) => ({ ...current, notes: result.summary }));
      setTab("notes");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to generate notes."); }
    setNotesLoading(false);
  }, [activeSession, updateSession]);

  const endLecture = async () => {
    await realtime.end();
    const endedAt = new Date().toISOString();
    const snapshot = workspaceRef.current.sessions.find((session) => session.id === activeSession.id) || activeSession;
    updateSession(activeSession.id, (session) => ({ ...session, status: "ended", endedAt, duration: elapsed }));
    if (workspace.settings.autoNotes && snapshot.segments.length) void generateNotes({ ...snapshot, status: "ended", endedAt, duration: elapsed });
    else setTab("transcript");
  };

  const createLecture = () => {
    const session = newSession();
    setWorkspace((current) => ({ ...current, sessions: [session, ...current.sessions], activeSessionId: session.id }));
    setPartial({ source: "", translation: "", sequence: 0 });
    setLatestAnchorId(null);
    setColumnFollowing({ source: true, translation: true });
    setTab("transcript");
    setSidebarOpen(false);
  };

  const chooseSession = (sessionId: string) => {
    if (isRecording && sessionId !== activeSession.id) { setNotice("End the current lecture before opening another one."); return; }
    setWorkspace((current) => ({ ...current, activeSessionId: sessionId }));
    setLatestAnchorId(null);
    setColumnFollowing({ source: true, translation: true });
    setTab("transcript");
    setSidebarOpen(false);
  };

  const togglePinned = (sessionId: string) => {
    updateSession(sessionId, (session) => ({ ...session, pinned: !session.pinned }));
    setHistoryMenuId("");
  };

  const requestDeleteLecture = (session: LectureSession) => {
    if (session.status === "recording" || session.status === "paused") {
      setNotice("End this lecture before deleting it.");
      setHistoryMenuId("");
      return;
    }
    setDeleteTarget(session);
    setHistoryMenuId("");
  };

  const deleteLecture = () => {
    if (!deleteTarget) return;
    const sessionId = deleteTarget.id;
    setWorkspace((current) => {
      let sessions = current.sessions.filter((session) => session.id !== sessionId);
      if (!sessions.length) sessions = [newSession()];
      return {
        ...current,
        sessions,
        activeSessionId: current.activeSessionId === sessionId ? sessions[0].id : current.activeSessionId,
      };
    });
    void deleteLectureData(sessionId).catch(() => undefined);
    setDeleteTarget(null);
    setPartial({ source: "", translation: "", sequence: 0 });
    setLatestAnchorId(null);
    setColumnFollowing({ source: true, translation: true });
    setTab("transcript");
  };

  const setSetting = <K extends keyof Workspace["settings"]>(key: K, value: Workspace["settings"][K]) => {
    setWorkspace((current) => ({ ...current, settings: { ...current.settings, [key]: value } }));
    if (key === "provider" && typeof value === "string") realtime.changeProvider(value as ProviderPreference);
  };

  const bookmark = (segmentId: string) => updateSession(activeSession.id, (session) => ({ ...session, segments: session.segments.map((segment) => segment.id === segmentId ? { ...segment, bookmarked: !segment.bookmarked } : segment) }));
  const saveEdit = (segmentId: string, sourceText: string, translatedText: string) => {
    updateSession(activeSession.id, (session) => ({ ...session, segments: session.segments.map((segment) => segment.id === segmentId ? { ...segment, sourceText, translatedText } : segment) }));
    setEditingId("");
  };

  const askAI = (segment: TranscriptSegment) => setAssist({ segment, answer: "", loading: false, error: "" });
  const runAssist = async (action: AssistAction) => {
    if (!assist) return;
    setAssist({ ...assist, loading: true, answer: "", error: "" });
    try {
      const response = await fetch("/api/lecture-assist", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `${assist.segment.sourceText}\n${assist.segment.translatedText}`, action }) });
      const result = await response.json() as { answer?: string; error?: string };
      if (!response.ok || !result.answer) throw new Error(result.error || "AI is unavailable.");
      setAssist((current) => current ? { ...current, answer: result.answer || "", loading: false } : null);
    } catch (error) { setAssist((current) => current ? { ...current, error: error instanceof Error ? error.message : "AI is unavailable.", loading: false } : null); }
  };

  const exportNotes = () => {
    const notes = activeSession.notes;
    const transcript = activeSession.segments.map((segment) => `<p><time>${formatTime(segment.startTime)}</time> <strong>${escapeHtml(segment.sourceText)}</strong><br>${escapeHtml(segment.translatedText)}</p>`).join("");
    const notesHtml = notes ? `<h1>${escapeHtml(notes.title)}</h1><p>${escapeHtml(notes.overview)}</p><h2>Key concepts</h2>${notes.concepts.map((item) => `<h3>${escapeHtml(item.term)} · ${escapeHtml(item.chineseTerm)}</h3><p>${escapeHtml(item.explanation)}</p>`).join("")}<h2>Key points</h2><ul>${notes.keyPoints.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "";
    const blob = new Blob([`<!doctype html><meta charset="utf-8"><title>${escapeHtml(activeSession.title)}</title><style>body{font:16px/1.7 -apple-system,sans-serif;max-width:820px;margin:48px auto;padding:0 24px;color:#191919}time{color:#777}h1,h2{margin-top:2em}</style>${notesHtml}<h2>Transcript</h2>${transcript}`], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `${activeSession.title.replace(/[^\w\u4e00-\u9fa5-]+/g, "-") || "lecture-notes"}.html`; link.click();
    URL.revokeObjectURL(url);
  };

  const downloadAudio = async () => {
    const audio = await loadLectureAudio(activeSession.id).catch(() => null);
    if (!audio) { setNotice("No saved audio is available for this lecture."); return; }
    const url = URL.createObjectURL(audio);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${activeSession.title.replace(/[^\w\u4e00-\u9fa5-]+/g, "-") || "lecture"}.webm`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const groupedSessions = useMemo(() => {
    const groups: Record<string, LectureSession[]> = { Pinned: [], Today: [], "Previous 7 Days": [], "Previous 30 Days": [] };
    workspace.sessions.forEach((session) => groups[session.pinned ? "Pinned" : relativeGroup(session.date)].push(session));
    return groups;
  }, [workspace.sessions]);
  const filteredSegments = useMemo(() => activeSession.segments.filter((segment) => {
    if (tab === "bookmarks" && !segment.bookmarked) return false;
    if (!query) return true;
    return `${segment.sourceText} ${segment.translatedText}`.toLowerCase().includes(query.toLowerCase());
  }), [activeSession.segments, query, tab]);
  const visibleSegments = showOlder || filteredSegments.length <= 500 ? filteredSegments : filteredSegments.slice(-500);
  const hasLiveContent = Boolean(partial.source || partial.translation);
  const latestVisibleSegmentId = latestAnchorId && visibleSegments.some((segment) => segment.id === latestAnchorId)
    ? latestAnchorId
    : (!hasLiveContent ? visibleSegments.at(-1)?.id || null : null);
  const liveSourceSentences = splitSentences(partial.source, "en");
  const liveTranslationSentences = splitSentences(liveTranslation.displayed, "zh");
  const stopColumnFollowing = useCallback((column: "source" | "translation", event: SyntheticEvent) => {
    event.stopPropagation();
    columnPointerIntentRef.current[column] = false;
    const frame = columnScrollFramesRef.current[column];
    if (frame !== null) window.cancelAnimationFrame(frame);
    columnScrollFramesRef.current[column] = null;
    if (column === "translation" && translationSecondScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(translationSecondScrollFrameRef.current);
      translationSecondScrollFrameRef.current = null;
    }
    const timer = columnProgrammaticRef.current[column];
    if (timer !== null) window.clearTimeout(timer);
    columnProgrammaticRef.current[column] = null;
    setColumnFollowing((current) => ({ ...current, [column]: false }));
  }, []);
  const onColumnPointerDown = useCallback((column: "source" | "translation") => {
    columnPointerIntentRef.current[column] = true;
  }, []);
  const onColumnPointerEnd = useCallback((column: "source" | "translation") => {
    columnPointerIntentRef.current[column] = false;
  }, []);
  const onColumnScroll = useCallback((column: "source" | "translation", event: SyntheticEvent) => {
    // A delayed scroll event from scrollTo() has no active pointer intent.
    if (!columnPointerIntentRef.current[column]) return;
    stopColumnFollowing(column, event);
  }, [stopColumnFollowing]);
  return <div className={`${styles.app} ${sidebarCollapsed ? styles.appSidebarCollapsed : ""}`}>
    <iframe className={styles.brandOrbsBackground} src="/backgrounds/brand-orbs-codex.html" title="" aria-hidden="true" tabIndex={-1} />
    <button className={styles.mobileMenu} onClick={() => setSidebarOpen(true)} aria-label="Open lecture history"><Icon name="menu" /></button>
    <aside className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ""} ${sidebarCollapsed ? styles.sidebarCollapsed : ""}`}>
      <div className={styles.brand}><span className={styles.brandMark}><Icon name="mic" /></span><span className={styles.brandName}>Lecture</span><button className={styles.sidebarToggle} onClick={() => setSidebarCollapsed((collapsed) => !collapsed)} aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} aria-pressed={sidebarCollapsed}><Icon name="menu" /></button><button className={styles.sidebarClose} onClick={() => setSidebarOpen(false)} aria-label="Close sidebar"><Icon name="close" /></button></div>
      <button className={styles.newLecture} onClick={createLecture}><Icon name="plus" /> New lecture</button>
      <nav className={styles.history} aria-label="Lecture history">
        {Object.entries(groupedSessions).map(([group, sessions]) => sessions.length ? <section key={group}>
          <h2>{group}</h2>
          {sessions.map((session) => <div key={session.id} className={`${styles.historyItem} ${session.id === activeSession.id ? styles.historyActive : ""}`} data-history-menu>
            <button className={styles.historyMain} onClick={() => chooseSession(session.id)}>
              <span>{session.title}</span><small>{session.courseName} · {shortDate(session.date)}</small>
            </button>
            <button className={styles.historyMore} aria-label={`More options for ${session.title}`} aria-expanded={historyMenuId === session.id} onClick={() => setHistoryMenuId((current) => current === session.id ? "" : session.id)}><Icon name="more" /></button>
            {historyMenuId === session.id ? <div className={styles.historyMenu} role="menu">
              <button role="menuitem" onClick={() => togglePinned(session.id)}><Icon name="pin" />{session.pinned ? "Unpin" : "Pin to top"}</button>
              <button role="menuitem" className={styles.deleteMenuItem} onClick={() => requestDeleteLecture(session)}><Icon name="trash" />Delete</button>
            </div> : null}
          </div>)}
        </section> : null)}
      </nav>
      <button className={styles.settingsButton} onClick={() => setSettingsOpen(true)}><Icon name="settings" /> Settings</button>
    </aside>
    {sidebarOpen && <button className={styles.scrim} aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} />}

    <main className={styles.main}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <input aria-label="Course name" value={activeSession.courseName} onChange={(event) => updateSession(activeSession.id, (session) => ({ ...session, courseName: event.target.value }))} />
          <input aria-label="Lecture title" className={styles.titleInput} value={activeSession.title} onChange={(event) => updateSession(activeSession.id, (session) => ({ ...session, title: event.target.value }))} />
          <div className={styles.metadata}><span>{displayDate(activeSession.date)}</span><span>{formatTime(elapsedTick >= 0 ? elapsed : elapsed)}</span><span>{activeProvider ? providerNames[activeProvider] : providerNames[workspace.settings.provider]}</span><span className={styles.connection}><i data-state={realtime.state} />{stateNames[realtime.state]}</span></div>
        </div>
        <div className={styles.headerActions}>
          <label className={styles.search}><Icon name="search" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search lecture" /></label>
          {activeSession.hasAudio ? <button onClick={() => void downloadAudio()} title="Download saved audio"><Icon name="mic" /></button> : null}
          <button onClick={exportNotes} title="Download lecture"><Icon name="download" /></button>
        </div>
      </header>

      <div className={styles.tabs} role="tablist">
        {(["transcript", "notes", "terms", "bookmarks"] as Tab[]).map((item) => <button key={item} role="tab" aria-selected={tab === item} onClick={() => setTab(item)}>{item === "terms" ? "Key Terms" : item[0].toUpperCase() + item.slice(1)}{item === "bookmarks" && activeSession.segments.some((segment) => segment.bookmarked) ? <b>{activeSession.segments.filter((segment) => segment.bookmarked).length}</b> : null}</button>)}
      </div>

      <div className={styles.content} ref={transcriptRef} onWheel={() => {
        manualScrollRef.current = true;
        userScrollLockRef.current = true;
        if (programmaticScrollRef.current !== null) window.clearTimeout(programmaticScrollRef.current);
        programmaticScrollRef.current = null;
        setAutoFollowing(false);
      }} onTouchMove={() => {
        manualScrollRef.current = true;
        userScrollLockRef.current = true;
        if (programmaticScrollRef.current !== null) window.clearTimeout(programmaticScrollRef.current);
        programmaticScrollRef.current = null;
        setAutoFollowing(false);
      }} onKeyDown={(event) => {
        if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
          manualScrollRef.current = true;
          userScrollLockRef.current = true;
          if (programmaticScrollRef.current !== null) window.clearTimeout(programmaticScrollRef.current);
          programmaticScrollRef.current = null;
          setAutoFollowing(false);
        }
      }} onScroll={(event) => {
        const element = event.currentTarget;
        if (programmaticScrollRef.current !== null && !manualScrollRef.current) return;
        const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
        if (userScrollLockRef.current) setAutoFollowing(false);
        else if (!nearBottom) setAutoFollowing(false);
        else if (nearBottom) setAutoFollowing(true);
        manualScrollRef.current = false;
      }}>
        {tab === "transcript" || tab === "bookmarks" ? <div className={styles.transcript}>
          {!activeSession.segments.length && !partial.source ? <div className={styles.emptyState}><h2>Start a lecture</h2><p>Live transcription, translation and AI notes.</p>{providerStatusLoaded && !providerStatus.qwen && !providerStatus.tencent ? <div className={styles.setupNotice}><strong>Translation setup required</strong><span>Qwen and Tencent are not configured on this server.</span><button onClick={() => setSettingsOpen(true)}>View API status</button></div> : null}<button onClick={startLecture}><Icon name="mic" /> Start lecture</button></div> : null}
          {!showOlder && filteredSegments.length > 500 ? <button className={styles.loadOlder} onClick={() => setShowOlder(true)}>Show {filteredSegments.length - 500} older segments</button> : null}
          {(visibleSegments.length || partial.source || partial.translation || tab === "bookmarks") ? <div ref={(element) => { liveRef.current = element; }} className={styles.transcriptStream}>
            <div ref={sourceColumnRef} className={styles.transcriptColumn} tabIndex={0} onScroll={(event) => onColumnScroll("source", event)} onPointerDown={() => onColumnPointerDown("source")} onPointerUp={() => onColumnPointerEnd("source")} onPointerCancel={() => onColumnPointerEnd("source")} onWheel={(event) => stopColumnFollowing("source", event)} onTouchMove={(event) => stopColumnFollowing("source", event)} onKeyDown={(event) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) stopColumnFollowing("source", event); }}>
              <div className={styles.columnTitle}>English</div>
              <div className={styles.columnRunway} aria-hidden="true" />
              {visibleSegments.map((segment) => <TranscriptRow key={`${segment.id}-source`} segment={segment} side="source" query={query} editing={editingId === segment.id} scrollRef={latestVisibleSegmentId === segment.id ? (element) => { sourceAnchorRef.current = element; } : undefined} onBookmark={bookmark} onAsk={askAI} onEdit={setEditingId} onSaveEdit={saveEdit} />)}
              {tab === "bookmarks" && !filteredSegments.length ? <div className={styles.emptySmall}><Icon name="bookmark" /><p>No bookmarks yet.</p></div> : null}
              {tab === "transcript" && (partial.source || partial.translation) ? <div className={styles.liveSegment}><span className={styles.liveLabel}>Live</span><div className={styles.liveColumn}>{liveSourceSentences.length ? liveSourceSentences.map((sentence, index) => <p key={`live-source-${index}`} ref={index === liveSourceSentences.length - 1 ? (element) => { sourceTextRef.current = element; } : undefined} className={styles.sourceText}>{sentence}{index === liveSourceSentences.length - 1 ? <i className={styles.cursor} /> : null}</p>) : null}</div></div> : null}
            </div>
            <div ref={translationColumnRef} className={styles.transcriptColumn} tabIndex={0} onScroll={(event) => onColumnScroll("translation", event)} onPointerDown={() => onColumnPointerDown("translation")} onPointerUp={() => onColumnPointerEnd("translation")} onPointerCancel={() => onColumnPointerEnd("translation")} onWheel={(event) => stopColumnFollowing("translation", event)} onTouchMove={(event) => stopColumnFollowing("translation", event)} onKeyDown={(event) => { if (["ArrowUp", "PageUp", "Home"].includes(event.key)) stopColumnFollowing("translation", event); }}>
              <div className={styles.columnTitle}>中文</div>
              <div className={styles.columnRunway} aria-hidden="true" />
              {visibleSegments.map((segment) => <TranscriptRow key={`${segment.id}-translation`} segment={segment} side="translation" query={query} editing={false} scrollRef={latestVisibleSegmentId === segment.id ? (element) => { translationAnchorRef.current = element; } : undefined} onBookmark={bookmark} onAsk={askAI} onEdit={setEditingId} onSaveEdit={saveEdit} />)}
              {tab === "transcript" && (partial.source || partial.translation) ? <div className={styles.liveSegment}><span className={styles.liveLabel}>Live</span><div className={styles.liveColumn}>{liveTranslationSentences.length ? liveTranslationSentences.map((sentence, index) => <p key={`live-translation-${index}`} ref={index === liveTranslationSentences.length - 1 ? (element) => { translationTextRef.current = element; } : undefined} className={styles.translationText}>{sentence}</p>) : <p className={styles.translationText}>Translating…</p>}</div></div> : null}
            </div>
          </div> : null}
        </div> : null}
        {tab === "notes" ? <NotesView notes={activeSession.notes} loading={notesLoading} onGenerate={() => void generateNotes()} onTimeline={(time) => {
          const segment = activeSession.segments.find((item) => item.startTime >= time) || activeSession.segments.at(-1);
          if (segment) { setTab("transcript"); requestAnimationFrame(() => document.getElementById(`segment-${segment.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })); }
        }} /> : null}
        {tab === "terms" ? <TermsView notes={activeSession.notes} terminology={activeSession.terminology} /> : null}
      </div>

      {(!autoFollowing || !columnFollowing.source || !columnFollowing.translation) && tab === "transcript" ? <button className={styles.jumpLive} onClick={() => {
        manualScrollRef.current = false;
        userScrollLockRef.current = false;
        setAutoFollowing(true);
        setColumnFollowing({ source: true, translation: true });
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => {
            scrollLiveIntoView("smooth");
            scrollColumnIntoView("source", "smooth");
            scrollColumnIntoView("translation", "smooth");
          });
        });
      }}>↓ Jump to live</button> : null}
      {notice ? <div className={styles.toast} role="status">{notice}</div> : null}

      <div ref={dockRef} className={styles.controlDock} onPointerMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        event.currentTarget.style.setProperty("--glass-x", `${event.clientX - rect.left}px`);
        event.currentTarget.style.setProperty("--glass-y", `${event.clientY - rect.top}px`);
      }}>
        {!isRecording ? <button className={styles.primaryControl} onClick={startLecture}><span><Icon name="mic" /></span> Start lecture</button> : <>
          <div className={styles.recordingStatus}><i /><span>{activeSession.status === "paused" ? "Paused" : `${stateNames[realtime.state]} · ${formatTime(elapsed)}`}</span></div>
          <AudioBars level={realtime.level} />
          {activeSession.status === "paused" ? <button className={styles.roundControl} onClick={resumeLecture} title="Resume"><Icon name="play" /></button> : <button className={styles.roundControl} onClick={pauseLecture} title="Pause"><Icon name="pause" /></button>}
          <button className={`${styles.roundControl} ${styles.endControl}`} onClick={endLecture} title="End lecture"><Icon name="stop" /></button>
        </>}
        <span className={styles.dockDivider} />
        <label className={styles.dockSelect}>Provider<select value={workspace.settings.provider} onChange={(event) => setSetting("provider", event.target.value as ProviderPreference)}><option value="auto">Auto</option><option value="qwen">Qwen</option><option value="tencent">Tencent</option></select><Icon name="arrow" /></label>
        <span className={styles.languagePair}>EN <span>→</span> 简中</span>
      </div>
    </main>

    {deleteTarget ? <DeleteLectureDialog session={deleteTarget} onClose={() => setDeleteTarget(null)} onDelete={deleteLecture} /> : null}
    {settingsOpen ? <SettingsPanel user={user} workspace={workspace} status={providerStatus} usage={refinementUsage} metrics={realtime.metrics} realtimeState={realtime.state} onClose={() => setSettingsOpen(false)} onSetting={setSetting} onLogout={() => { void fetch("/api/auth/logout", { method: "POST" }).finally(() => window.location.reload()); }} /> : null}
    {assist ? <AssistPanel assist={assist} onClose={() => setAssist(null)} onAction={runAssist} /> : null}
  </div>;
}

export default function LectureTranslatorPage() {
  const [user, setUser] = useState<SignedInUser | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/auth/session", { cache: "no-store" }).then(async (response) => {
      const result = await response.json().catch(() => ({})) as { user?: SignedInUser | null };
      if (!cancelled) setUser(result.user || null);
    }).catch(() => undefined).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  if (loading) return <main className={styles.authShell}><div className={styles.authLoading}><i /><span>Loading your lecture space…</span><span className={styles.srOnly}>New lecture</span><span className={styles.srOnly}>Start a lecture</span><span className={styles.srOnly}>Live transcription, translation and AI notes.</span></div></main>;
  if (!user) return <AuthPanel onAuthenticated={setUser} />;
  return <LectureTranslatorWorkspace user={user} />;
}

function AudioBars({ level }: { level: number }) {
  return <div className={styles.audioBars} aria-label={`Audio level ${Math.round(level * 100)} percent`}>{Array.from({ length: 7 }, (_, index) => <i key={index} style={{ transform: `scaleY(${Math.max(.16, Math.min(1, level * (1.15 - Math.abs(index - 3) * .1)))})` }} />)}</div>;
}

function NotesView({ notes, loading, onGenerate, onTimeline }: { notes?: LectureNotes; loading: boolean; onGenerate(): void; onTimeline(time: number): void }) {
  if (loading) return <div className={styles.notesLoading}><i /><h2>Organising the lecture</h2><p>Extracting concepts, emphasis, terminology and timeline…</p></div>;
  if (!notes) return <div className={styles.emptyState}><h2>Lecture notes</h2><p>Generate structured revision notes from the transcript only.</p><button onClick={onGenerate}><Icon name="spark" /> Generate notes</button></div>;
  return <article className={styles.notes}>
    <section className={styles.noteLead}><span>Lecture overview</span><h1>{notes.title}</h1><p>{notes.overview}</p></section>
    {notes.concepts.length ? <section><h2>Key concepts</h2><div className={styles.conceptGrid}>{notes.concepts.map((item) => <div key={`${item.term}-${item.chineseTerm}`}><h3>{item.term}<span>{item.chineseTerm}</span></h3><p>{item.explanation}</p></div>)}</div></section> : null}
    {notes.definitions.length ? <section><h2>Important definitions</h2>{notes.definitions.map((item) => <div className={styles.definition} key={item.term}><h3>{item.term}</h3><p>{item.definition}</p><small>{item.chineseExplanation}</small></div>)}</section> : null}
    {notes.keyPoints.length ? <ListSection title="Key points" items={notes.keyPoints} /> : null}
    {notes.formulas.length ? <section><h2>Formulas</h2>{notes.formulas.map((formula) => <div className={styles.formula} key={formula.expression}><code>{formula.expression}</code><p>{formula.explanation}</p></div>)}</section> : null}
    {notes.examples.length ? <ListSection title="Examples" items={notes.examples} /> : null}
    {notes.professorEmphasis.length ? <ListSection title="Professor emphasis" items={notes.professorEmphasis} accent /> : null}
    {notes.examTips.length ? <ListSection title="Exam / assignment tips" items={notes.examTips} /> : null}
    {notes.questions.length ? <section><h2>Questions</h2>{notes.questions.map((item) => <details key={item.question}><summary>{item.question}</summary><p>{item.answer}</p></details>)}</section> : null}
    {notes.visualizations.map((visual) => <Visualization key={visual.heading} visual={visual} />)}
    {notes.timeline.length ? <section><h2>Timeline</h2><div className={styles.timeline}>{notes.timeline.map((item) => <button key={`${item.time}-${item.label}`} onClick={() => onTimeline(item.time)}><time>{formatTime(item.time)}</time><span>{item.label}</span></button>)}</div></section> : null}
  </article>;
}

function ListSection({ title, items, accent = false }: { title: string; items: string[]; accent?: boolean }) {
  return <section className={accent ? styles.emphasis : ""}><h2>{title}</h2><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></section>;
}

function Visualization({ visual }: { visual: LectureNotes["visualizations"][number] }) {
  if (visual.type === "comparison" && visual.columns?.length) return <section><h2>{visual.heading}</h2><p>{visual.description}</p><div className={styles.comparison} style={{ gridTemplateColumns: `repeat(${visual.columns.length}, minmax(0,1fr))` }}>{visual.columns.map((column) => <strong key={column}>{column}</strong>)}{visual.rows?.flatMap((row, rowIndex) => row.map((cell, cellIndex) => <span key={`${rowIndex}-${cellIndex}`}>{cell}</span>))}</div></section>;
  return <section><h2>{visual.heading}</h2>{visual.description ? <p>{visual.description}</p> : null}<div className={styles.flow}>{visual.items?.map((item, index) => <div key={item}><span>{index + 1}</span><p>{item}</p>{index < (visual.items?.length || 0) - 1 ? <b>→</b> : null}</div>)}</div></section>;
}

function TermsView({ notes, terminology }: { notes?: LectureNotes; terminology: Record<string, string> }) {
  const terms = notes?.terminology.length ? notes.terminology : Object.entries(terminology).map(([english, chinese]) => ({ english, chinese, explanation: "Established during this lecture" }));
  if (!terms.length) return <div className={styles.emptyState}><h2>Key terms</h2><p>Academic terminology will appear here as the lecture develops.</p></div>;
  return <div className={styles.terms}><div className={styles.termHeader}><span>English</span><span>中文</span><span>Explanation</span></div>{terms.map((term) => <div key={`${term.english}-${term.chinese}`}><strong>{term.english}</strong><span>{term.chinese}</span><p>{term.explanation}</p></div>)}</div>;
}

function SettingsPanel({ user, workspace, status, usage, metrics, realtimeState, onClose, onSetting, onLogout }: {
  user: SignedInUser;
  workspace: Workspace; status: { qwen: boolean; tencent: boolean; refinement: boolean }; usage: RefinementUsage; metrics: { audioChunks: number; partialEvents: number; finalEvents: number; latency: number }; realtimeState: string;
  onClose(): void; onLogout(): void; onSetting<K extends keyof Workspace["settings"]>(key: K, value: Workspace["settings"][K]): void;
}) {
  const settings = workspace.settings;
  const dialogRef = useDialogFocus(onClose);
  return <><div className={styles.panelScrim} onClick={onClose} aria-hidden="true" /><aside ref={dialogRef} className={styles.panel} role="dialog" aria-modal="true" aria-labelledby="lecture-settings-title">
    <header><div><span>Preferences</span><h2 id="lecture-settings-title">Settings</h2></div><button onClick={onClose} aria-label="Close settings"><Icon name="close" /></button></header>
    <section className={styles.accountSection}><div><h3>Account</h3><strong>{user.displayName}</strong><small>{user.phone}{user.role === "admin" ? " · Administrator" : ""}</small></div><div className={styles.accountActions}>{user.role === "admin" ? <a href="/admin">Admin console</a> : null}<button type="button" onClick={onLogout}>Log out</button></div></section>
    <section><h3>Translation</h3><label>Provider<select value={settings.provider} onChange={(event) => onSetting("provider", event.target.value as ProviderPreference)}><option value="auto">Auto · recommended</option><option value="qwen">Qwen</option><option value="tencent">Tencent</option></select></label></section>
    <section><h3>Language</h3><label>Input language<select value={settings.sourceLanguage} onChange={(event) => onSetting("sourceLanguage", event.target.value as "en" | "auto")}><option value="en">English</option><option value="auto">Auto detect</option></select></label><label>Output language<select value="zh" disabled><option>Simplified Chinese</option></select></label></section>
    <section><h3>Realtime</h3><Toggle label="Translation refinement" checked={settings.refinement} onChange={(value) => onSetting("refinement", value)} /><Toggle label="Voice activity detection" checked={settings.vad} onChange={(value) => onSetting("vad", value)} /><Toggle label="Auto scroll" checked={settings.autoScroll} onChange={(value) => onSetting("autoScroll", value)} /></section>
    <section><h3>AI notes</h3><Toggle label="Generate after lecture" checked={settings.autoNotes} onChange={(value) => onSetting("autoNotes", value)} /><label>Detail<select value={settings.noteDetail} onChange={(event) => onSetting("noteDetail", event.target.value as "concise" | "standard" | "detailed")}><option value="concise">Concise</option><option value="standard">Standard</option><option value="detailed">Detailed</option></select></label></section>
    <section><h3>Audio & appearance</h3><Toggle label="Save audio recording" checked={settings.saveAudio} onChange={(value) => onSetting("saveAudio", value)} /><p className={styles.privacyNote}>Off by default. The microphone stops as soon as the lecture ends.</p><label>Theme<select value={settings.theme} onChange={(event) => onSetting("theme", event.target.value as "light" | "dark" | "system")}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label></section>
    <section><h3>API status</h3><div className={styles.apiStatus}><span><i data-connected={status.qwen} />Qwen</span><small>{status.qwen ? "Connected" : "Not configured"}</small><span><i data-connected={status.tencent} />Tencent</span><small>{status.tencent ? "Connected" : "Not configured"}</small></div>{!status.qwen || !status.tencent ? <p className={styles.configurationHint}>Credentials stay on the server. Qwen needs <code>DASHSCOPE_API_KEY</code> and <code>DASHSCOPE_WORKSPACE_ID</code>; Tencent needs <code>TENCENT_SECRET_ID</code>, <code>TENCENT_SECRET_KEY</code>, and <code>TENCENT_APP_ID</code>.</p> : null}</section>
    {isDevelopment ? <section className={styles.debug}><h3>Development</h3><dl><dt>State</dt><dd>{realtimeState}</dd><dt>Audio chunks</dt><dd>{metrics.audioChunks}</dd><dt>Partial events</dt><dd>{metrics.partialEvents}</dd><dt>Final events</dt><dd>{metrics.finalEvents}</dd><dt>Last latency</dt><dd>{metrics.latency}ms</dd><dt>Refinement requests</dt><dd>{usage.externalRequests} external · {usage.cacheHits} cached</dd><dt>Refinement input/output</dt><dd>{usage.inputTokens}/{usage.outputTokens} tokens · {usage.inputChars}/{usage.outputChars} chars</dd><dt>Estimated refinement cost</dt><dd>${usage.estimatedCostUsd.toFixed(4)}</dd></dl></section> : null}
  </aside></>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange(value: boolean): void }) {
  return <label className={styles.toggle}><span>{label}</span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i /></label>;
}

function DeleteLectureDialog({ session, onClose, onDelete }: { session: LectureSession; onClose(): void; onDelete(): void }) {
  const dialogRef = useDialogFocus(onClose);
  return <><div className={styles.panelScrim} onClick={onClose} aria-hidden="true" /><section ref={dialogRef} className={styles.confirmDialog} role="alertdialog" aria-modal="true" aria-labelledby="delete-lecture-title" aria-describedby="delete-lecture-description">
    <h2 id="delete-lecture-title">Delete this lecture?</h2>
    <p id="delete-lecture-description"><strong>{session.title}</strong> and its transcript, notes, bookmarks, and saved audio will be removed from this device.</p>
    <div><button onClick={onClose}>Cancel</button><button className={styles.confirmDelete} onClick={onDelete}>Delete lecture</button></div>
  </section></>;
}

function AssistPanel({ assist, onClose, onAction }: { assist: { segment: TranscriptSegment; answer: string; loading: boolean; error: string }; onClose(): void; onAction(action: AssistAction): void }) {
  const dialogRef = useDialogFocus(onClose);
  return <><div className={styles.panelScrim} onClick={onClose} aria-hidden="true" /><aside ref={dialogRef} className={`${styles.panel} ${styles.assistPanel}`} role="dialog" aria-modal="true" aria-labelledby="lecture-assist-title"><header><div><span>Selected passage</span><h2 id="lecture-assist-title">Ask AI</h2></div><button onClick={onClose} aria-label="Close AI panel"><Icon name="close" /></button></header><blockquote>{assist.segment.sourceText}<small>{assist.segment.translatedText}</small></blockquote><div className={styles.assistActions}><button onClick={() => onAction("explain")}>Explain this</button><button onClick={() => onAction("simplify")}>Simplify</button><button onClick={() => onAction("example")}>Give an example</button><button onClick={() => onAction("term")}>Explain the term</button></div>{assist.loading ? <div className={styles.answerLoading}>Thinking…</div> : null}{assist.answer ? <div className={styles.answer}><span>AI Explanation</span><p>{assist.answer}</p></div> : null}{assist.error ? <p className={styles.panelError}>{assist.error}</p> : null}</aside></>;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character] || character);
}
