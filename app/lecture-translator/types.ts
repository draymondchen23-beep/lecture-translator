export type ProviderPreference = "auto" | "qwen" | "tencent";
export type ActiveProvider = Exclude<ProviderPreference, "auto">;
export type LectureState =
  | "IDLE"
  | "CONNECTING"
  | "LISTENING"
  | "SPEAKING"
  | "PROCESSING"
  | "PAUSED"
  | "RECONNECTING"
  | "ENDING"
  | "ENDED"
  | "ERROR";

export type TranscriptSegment = {
  id: string;
  paragraphId: string;
  sessionId: string;
  sequence: number;
  startTime: number;
  endTime: number;
  sourceText: string;
  translatedText: string;
  sourceLanguage: string;
  targetLanguage: string;
  provider: ActiveProvider;
  speaker: string;
  confidence: number | null;
  isFinal: true;
  sourceRevision?: number;
  sourceStatus?: "draft" | "final";
  translationRevision?: number;
  translationStatus?: "idle" | "pending" | "draft" | "final" | "error";
  createdAt: string;
  bookmarked: boolean;
  refinementState: "idle" | "refining" | "refined" | "error";
};

export type NoteVisualization = {
  type: "flow" | "concept-map" | "comparison" | "timeline";
  heading: string;
  description?: string;
  items?: string[];
  columns?: string[];
  rows?: string[][];
};

export type LectureNotes = {
  title: string;
  overview: string;
  concepts: Array<{ term: string; chineseTerm: string; explanation: string }>;
  definitions: Array<{ term: string; definition: string; chineseExplanation: string }>;
  keyPoints: string[];
  formulas: Array<{ expression: string; explanation: string }>;
  examples: string[];
  professorEmphasis: string[];
  examTips: string[];
  questions: Array<{ question: string; answer: string }>;
  terminology: Array<{ english: string; chinese: string; explanation: string }>;
  timeline: Array<{ time: number; label: string }>;
  visualizations: NoteVisualization[];
};

export type LectureSession = {
  id: string;
  title: string;
  courseName: string;
  date: string;
  startedAt: string | null;
  endedAt: string | null;
  duration: number;
  sourceLanguage: string;
  targetLanguage: string;
  provider: ProviderPreference;
  status: "draft" | "recording" | "paused" | "ended";
  segments: TranscriptSegment[];
  notes?: LectureNotes;
  terminology: Record<string, string>;
  hasAudio?: boolean;
  pinned?: boolean;
};

export type WorkspaceSettings = {
  provider: ProviderPreference;
  sourceLanguage: "en" | "auto";
  targetLanguage: "zh";
  refinement: boolean;
  vad: boolean;
  autoScroll: boolean;
  autoNotes: boolean;
  noteDetail: "concise" | "standard" | "detailed";
  saveAudio: boolean;
  theme: "light" | "dark" | "system";
};

export type Workspace = {
  version: 2;
  sessions: LectureSession[];
  activeSessionId: string;
  settings: WorkspaceSettings;
};

export type RealtimeServerEvent =
  | { type: "state"; state: LectureState; provider?: ActiveProvider; message?: string }
  | {
    type: "segment.upsert";
    sessionId: string;
    segmentId: string;
    sequence: number;
    startTime: number;
    endTime: number;
    sourceText: string;
    sourceRevision: number;
    sourceStatus: "draft" | "final";
    translationText: string;
    translationRevision: number;
    translationStatus: "idle" | "pending" | "draft" | "final" | "error";
    provider: ActiveProvider;
    speaker?: string;
    requestId?: string;
    itemId?: string;
    responseId?: string;
  }
  | { type: "source.partial"; text: string; sequence: number; startedAt: number; itemId?: string }
  | { type: "source.final"; text: string; sequence: number; startedAt: number; endedAt: number; itemId?: string }
  | { type: "translation.partial"; text: string; sequence: number; startedAt: number; itemId?: string; responseId?: string }
  | { type: "translation.final"; text: string; sequence: number; startedAt: number; endedAt: number; itemId?: string; responseId?: string }
  | { type: "segment.final"; sequence: number; sourceText: string; translatedText: string; startedAt: number; endedAt: number; provider: ActiveProvider; confidence?: number; refined?: boolean; itemId?: string; responseId?: string }
  | { type: "provider.switched"; from: ActiveProvider; to: ActiveProvider; reason: string }
  | { type: "metrics"; audioChunks: number; audioSent: number; audioQueued: number; partialEvents: number; finalEvents: number; latency: number }
  | { type: "error"; message: string; recoverable: boolean };
