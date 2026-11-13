import { useEffect, useMemo, useRef, useState } from "react";

type Channel = {
  id: number;
  name: string;
  url: string;
  mode: "auto" | "manual";
  status: "監視中" | "待機中";
  recording: boolean;
};

type AppSettings = {
  autoRecordOnStreamStart: boolean;
  autoReceiveChat: boolean;
  autoReceiveChatForRecordingOnly: boolean;
  saveChat: boolean;
  outputDirectory: string;
  autoMonitorEnabled: boolean;
  monitorIntervalSeconds: number;
  autoRecordRecordingOnlyOnStreamStart: boolean;
  launchAtLogin: boolean;
  preventSystemSleep: boolean;
  recordingRetryCount: number;
  recordingRetryDelaySeconds: number;
  notifyOnLive: boolean;
  showRecordingPreview: boolean;
  aiArticleEnabled: boolean;
  aiArticleProvider: "ollama" | "openai";
  aiArticleOllamaUrl: string;
  aiArticleModel: string;
  aiArticleIntervalSeconds: number;
  aiArticleAudioEnabled: boolean;
  aiArticleAudioModel: string;
};

type PersistedState = {
  channels: Channel[];
  recordingOnlyChannels: Channel[];
  settings: AppSettings;
};

type ChannelCheck = {
  slug: string;
  found: boolean;
  isLive: boolean;
  displayName: string;
  profilePicture: string | null;
  broadcasterUserId: number | null;
  streamTitle: string;
  categoryName: string;
  categoryThumbnail: string | null;
  viewerCount: number;
  startedAt: string | null;
};

type BackgroundMonitorStatus = {
  enabled: boolean; running: boolean; monitoredChannels: number; intervalSeconds: number;
  lastCheckAt: string | null; lastError: string; message: string; results: ChannelCheck[];
};

type UpdateStatus = {
  status: "idle" | "checking" | "available" | "downloading" | "downloaded" | "not-available" | "error";
  currentVersion: string;
  availableVersion?: string;
  percent?: number;
  releaseNotes?: string;
  releaseDate?: string;
  message: string;
};

type RecordingFile = {
  path: string;
  name: string;
  extension: string;
  size: number;
  modifiedAt: string;
};

type ChatMessage = {
  eventId: string;
  messageId: string;
  channelSlug: string;
  broadcasterUserId: number | null;
  senderUsername: string;
  senderUserId: number | null;
  content: string;
  createdAt: string;
  receivedAt: string;
  usernameColor: string | null;
  badges: string[];
  emotes: Array<{ emoteId: string; positions: Array<{ start: number; end: number }> }>;
  replyToMessageId: string | null;
};

type ChatReceiverStatus = {
  running: boolean;
  connectedChannels: number;
  messageCount: number;
  lastMessageAt: string | null;
  message: string;
};

type RecordingEvent = {
  slug: string;
  status: "starting" | "recording" | "stopped" | "error";
  filePath?: string;
  message?: string;
  isVod?: boolean;
};
type CommentLogFile = { path: string; name: string; channelSlug: string; kind: "LIVE" | "VOD"; size: number; modifiedAt: string };
type StreamArticle = {
  id: string; slug: string; displayName: string; headline: string; category: string; startedAt: string;
  durationSeconds: number; commentCount: number; uniqueCommenters: number; keywords: string[];
  paragraphs: string[]; sourceVideo: string; sourceLogs: string[]; createdAt: string;
  status?: "live" | "completed"; aiGenerated?: boolean; aiSummary?: string; highlights?: string[];
  lastAiUpdateAt?: string | null; viewerCount?: number; peakViewerCount?: number; aiError?: string;
  videoAnalyzed?: boolean; videoFrameCount?: number; videoSummary?: string; videoScenes?: string[]; videoAnalyzedAt?: string | null;
  audioAnalyzed?: boolean; audioSegmentCount?: number; audioSummary?: string; audioTranscript?: string;
  audioTranscriptSegments?: Array<{ startSeconds: number; endSeconds: number; text: string }>;
  audioAnalyzedAt?: string | null; audioError?: string;
};
type AiArticleStatus = {
  configured: boolean; encryptionAvailable: boolean;
  aiArticleEnabled: boolean; aiArticleProvider: "ollama" | "openai"; aiArticleOllamaUrl: string; aiArticleModel: string; aiArticleIntervalSeconds: number;
};
type CommentVideoEvent = { status: "starting" | "encoding" | "completed" | "cancelled" | "error"; percent: number; message: string; outputPath?: string; generatedComments?: number; skippedComments?: number };
type CommentVideoPreviewData = {
  width: number;
  height: number;
  durationSeconds: number;
  totalComments: number;
  malformedLines: number;
  outsideVideoCount: number;
  comments: Array<{ seconds: number; content: string; username: string; color: string; position?: "scroll" | "top" | "bottom" }>;
};

const APP_VERSION = "0.1.0-beta.49";
const COMMENT_VIDEO_PREVIEW_ITEMS: Array<{ text: string; color: string; lane: number; delay: number; repeatLane?: boolean; position?: "scroll" | "top" | "bottom" }> = [
  { text: "きたあああああ！", color: "#ffffff", lane: 0, delay: 0 },
  { text: "うぽつ！！！！！！", color: "#ffffff", lane: 1, delay: 0.7, position: "top" },
  { text: "まってた", color: "#ffffff", lane: 2, delay: 1.3, position: "bottom" },
  { text: "888888888", color: "#ffffff", lane: 3, delay: 0.25, position: "top" },
  { text: "すき！", color: "#ffffff", lane: 4, delay: 1.7 },
  { text: "うぽつ", color: "#ffffff", lane: 5, delay: 0.85 },
  { text: "これはすごい", color: "#ffffff", lane: 6, delay: 1.9 },
  { text: "ナイス！", color: "#ffffff", lane: 7, delay: 0.45 },
  { text: "おめでとう！", color: "#ffffff", lane: 8, delay: 1.5 },
  { text: "88888888", color: "#ffffff", lane: 9, delay: 0.9 },
  { text: "わこつ！", color: "#ffffff", lane: 10, delay: 1.2 },
  { text: "草ｗｗｗ", color: "#ffffff", lane: 11, delay: 0.3 },
  { text: "最高！", color: "#ffffff", lane: 12, delay: 1.6 },
  { text: "いいね！", color: "#ffffff", lane: 13, delay: 0.55 },
  { text: "神回", color: "#ffffff", lane: 14, delay: 1.4 },
  { text: "これは熱い", color: "#ffffff", lane: 15, delay: 0.8 },
  { text: "待ってました", color: "#ffffff", lane: 16, delay: 1.8 },
  { text: "ナイスコメント", color: "#ffffff", lane: 17, delay: 0.4 },
  { text: "おおおお！", color: "#ffffff", lane: 18, delay: 1.1 },
  { text: "888888", color: "#ffffff", lane: 19, delay: 0.65 },
  { text: "最高！", color: "#ffffff", lane: 0, delay: 2.4, repeatLane: true },
  { text: "わこつ！", color: "#ffffff", lane: 3, delay: 2.1, repeatLane: true },
  { text: "草ｗｗｗ", color: "#ffffff", lane: 6, delay: 2.7, repeatLane: true },
  { text: "いいね！", color: "#ffffff", lane: 9, delay: 2.3, repeatLane: true }
];
const VERSION_HISTORY = [
  {
    version: "0.1.0-beta.49",
    title: "映像・音声・コメントを統合した配信記事",
    changes: [
      "録画済み動画とLIVE配信から音声を45秒単位で抽出し、OllamaのQwen3-ASRで日本語文字起こし",
      "映像フレーム・時刻付き音声文字起こし・視聴者コメントを別々に分析し、AIが相互に照合して新聞記事風に統合",
      "記事カードに音声の要約・文字起こし・分析エラーを表示。LIVE終了時は音声認識キューを処理してから記事を最終化",
      "無料ローカル音声認識のON／OFFとモデル名を設定可能に"
    ]
  },
  {
    version: "0.1.0-beta.48",
    title: "コメントごとのue・naka・shita指定に対応",
    changes: [
      "mail・commandsなどの位置コマンド情報と、本文先頭の@ue／/shita／[naka]指定を読み取り",
      "1本の動画内で上部固定・中央スクロール・下部固定をコメントごとに混在可能に",
      "上部固定と下部固定の重なり管理を分離し、最大表示行数の初期値を14行へ拡大",
      "実ログプレビューでコメント別の表示位置を確認可能に"
    ]
  },
  {
    version: "0.1.0-beta.47",
    title: "ニコ生風コメント表示を改善",
    changes: [
      "Kickのユーザー名色をコメント本文色に誤用せず、白文字＋太い黒フチを標準化",
      "長文も短文と同じ画面上の速度で流れるようにし、文字幅に応じて移動時間を調整",
      "同じ行の重なり判定を先行コメントの実際の幅に合わせ、コメント間隔とプレビューを改善"
    ]
  },
  {
    version: "0.1.0-beta.46",
    title: "未登録チャンネルのLIVE記事専用モードを追加",
    changes: [
      "KickのURLまたはチャンネル名を入力するだけで、チャンネル登録・録画なしにLIVE記事を生成可能に",
      "LIVEコメントを一時受信し、録画ファイルを作らず25秒間隔で映像を継続解析（AIには直近8枚を使用）",
      "終了時に一時コメント受信を解除し、既存の自動受信チャンネル設定は維持"
    ]
  },
  {
    version: "0.1.0-beta.45",
    title: "録画映像からの記事生成に対応",
    changes: [
      "録画動画から代表フレームを最大8枚抽出し、画像対応AIで映像の場面・画面表示を記事へ反映",
      "コメントログがない配信でも映像解析だけで記事を生成可能に。コメント分析との併用にも対応",
      "記事カードに映像要約・時刻付き場面説明・分析フレーム数を表示"
    ]
  },
  {
    version: "0.1.0-beta.44",
    title: "配信記事の管理・削除機能を強化",
    changes: [
      "保存済み配信記事を記事カードから個別削除できるようにし、削除前に確認を表示",
      "LIVE更新中の記事は誤削除や再生成を防ぐため削除不可にし、配信終了後に削除可能",
      "記事ファイルのみを削除し、元動画・コメントログは保持"
    ]
  },
  {
    version: "0.1.0-beta.43",
    title: "無料ローカルAI（Ollama）で配信記事を生成",
    changes: [
      "AIエンジンにOllamaを追加。OpenAI APIキーや従量課金なしで、PC内のモデルを使ってLIVE記事・録画済み配信記事を生成",
      "Ollamaの接続URL・モデル名・接続テストを追加。従来のOpenAI APIも選択式で継続利用可能",
      "コメント本文はローカルOllamaへ送信し、外部AIサービスへ送らないプライバシー説明とセットアップ案内を追加"
    ]
  },
  {
    version: "0.1.0-beta.42",
    title: "長文コメントの表示幅計算を改善",
    changes: [
      "非常に長いコメントでも元の文字幅を省略せずに計算し、横スクロールの移動速度・衝突判定を正確化",
      "上部固定・下部固定の長文コメントは、画面幅に合わせてより小さい倍率まで縮小して表示領域からはみ出しにくく改善"
    ]
  },
  {
    version: "0.1.0-beta.41",
    title: "Saccubusを参考にコメントの表示位置を拡張",
    changes: [
      "中央スクロールに加えて、Saccubusのue/shita風の上部固定・下部固定を選択可能に",
      "固定コメントは表示時間中の行占有を管理し、同じ行での重なりを防止。幅が長い固定コメントは画面内へ縮小",
      "プレビューも選択した表示位置に合わせて切り替え。Kickログにはニコ生の位置コマンドがないため、選択モードを全コメントへ適用"
    ]
  },
  {
    version: "0.1.0-beta.40",
    title: "実際のコメントログを使った生成前プレビュー",
    changes: [
      "選択した録画動画とコメントJSONLを読み取り、実際のコメント本文・投稿者名・色をプレビューへ反映",
      "動画の再生時間内に表示できるコメント数、サンプル件数、対象外コメント、読み取り不能な行を生成前に確認",
      "フォントや速度などの表示設定はそのままリアルタイム反映。プレビュー確認だけでは元動画・コメントログを変更しない"
    ]
  },
  {
    version: "0.1.0-beta.39",
    title: "コメントプレビューのリアルタイム反映を強化",
    changes: [
      "設定変更のたびにプレビューを即時再描画し、流れるコメントのアニメーションも先頭から再生",
      "フォント・文字サイズ・速度・表示時間・行数・コメント間隔・不透明度・投稿者名表示をプレビューへ反映",
      "変更中の設定値をプレビューの上部に表示し、今の設定がひと目でわかるように改善"
    ]
  },
  {
    version: "0.1.0-beta.38",
    title: "コメント表示プレビューを追加",
    changes: [
      "生成前にコメントの流れ方・フォント・色・文字サイズを画面上で確認可能に",
      "フォント・文字サイズ・速度・表示時間・不透明度・表示行数の設定変更をプレビューへ即時反映",
      "実際の動画合成で使う参考スタイルをアニメーション表示し、設定調整を簡単に"
    ]
  },
  {
    version: "0.1.0-beta.37",
    title: "コメントの縦配置・重なり判定を改善",
    changes: [
      "コメントを画面の上下余白を除く高さ全体へ均等に分散し、参考動画のように画面内の幅広い位置から流れるように調整",
      "衝突判定を修正し、新しく流れ込むコメント自身の文字幅と速度差を使って必要な間隔を計算",
      "動画の終端付近でコメントの移動が不自然に加速しないよう、表示時間と移動時間を分離"
    ]
  },
  {
    version: "0.1.0-beta.36",
    title: "参考動画に合わせたコメント配置",
    changes: [
      "コメントの縦位置をランダムに分散し、上部の同じ行に偏らないニコ生風表示へ改善",
      "動画の高さ・文字サイズから表示可能な行数を自動計算し、下にはみ出す字幕を防止",
      "参考動画に近いメイリオ太字・黒縁取りを標準にし、文字サイズ48・標準12行へ調整"
    ]
  },
  {
    version: "0.1.0-beta.35",
    title: "ニコ生風コメント表示を調整",
    changes: [
      "ＭＳ Ｐゴシックを標準に、メイリオ・游ゴシック・Arialも選択可能に",
      "コメントの文字サイズ・流れる速度・コメント同士の最小間隔を個別調整",
      "コメントの幅と速度差を考慮した重なり防止の行割り当てを改善"
    ]
  },
  {
    version: "0.1.0-beta.34",
    title: "LIVE中の配信者一覧から手動録画",
    changes: [
      "LIVE中の配信者カードに手動録画開始・停止ボタンを追加",
      "各配信者の録画中／録画停止中ステータスをカード内に表示",
      "自動録画設定に関係なく、配信中の登録チャンネルを個別に録画操作可能に"
    ]
  },
  {
    version: "0.1.0-beta.33",
    title: "配信記事のAI分析を強化",
    changes: [
      "録画済み配信の記事生成にもAI分析を適用。保存済みコメントログから記事本文・要約・注目ポイントを作成",
      "アプリ再起動後も同じLIVEの記事を復元し、途中までのAI要約や集計値を引き継いで更新",
      "AI分析に送信するデータの説明とプライバシー上の注意を追加"
    ]
  },
  {
    version: "0.1.0-beta.32",
    title: "LIVE中のリアルタイムAI配信記事",
    changes: [
      "配信開始時に記事を自動作成し、コメントの流れからAIが記事を段階的に更新",
      "配信終了時に記事を最終化し、視聴者数・コメント数・話題・ハイライトを保存",
      "OpenAI APIキーをWindows暗号化ストレージへ安全に保存する設定を追加"
    ]
  },
  {
    version: "0.1.0-beta.31",
    title: "バージョン更新画面を追加",
    changes: [
      "現在のバージョン・更新状況・ダウンロード進捗を専用画面で確認可能に",
      "GitHub Releasesのリリースノートと過去の更新履歴を表示",
      "更新確認・ダウンロード完了後の再起動更新を一か所に集約"
    ]
  },
  {
    version: "0.1.0-beta.30",
    title: "登録配信者の放送内容記事",
    changes: [
      "配信者ごとの放送内容記事を生成・保存する機能を追加",
      "コメント数・投稿者数・頻出キーワード・コメント例を記事に掲載"
    ]
  },
  {
    version: "0.1.0-beta.29",
    title: "24時間バックグラウンド監視",
    changes: [
      "通知領域常駐中も登録チャンネルのLIVE監視を継続",
      "配信開始時の自動録画・コメント自動接続を強化",
      "Windowsログイン時の自動起動とスリープ抑止を追加"
    ]
  },
  {
    version: "0.1.0-beta.28",
    title: "コメント付き動画の同期改善",
    changes: [
      "日付をまたいだ配信の複数コメントログをまとめて利用可能に",
      "ログの並び順と不正行の集計を改善"
    ]
  },
  {
    version: "0.1.0-beta.27",
    title: "コメント付き動画生成",
    changes: [
      "コメントを右から左へ流して録画動画へ合成する機能を追加",
      "文字サイズ・表示時間・行数・画質の調整に対応"
    ]
  }
];
const STORAGE_KEY = "kick-recorder-state-v1";

const DEFAULT_SETTINGS: AppSettings = {
  autoRecordOnStreamStart: true,
  autoReceiveChat: true,
  autoReceiveChatForRecordingOnly: true,
  saveChat: true,
  outputDirectory: "",
  autoMonitorEnabled: true,
  monitorIntervalSeconds: 10,
  autoRecordRecordingOnlyOnStreamStart: true,
  launchAtLogin: true,
  preventSystemSleep: true,
  recordingRetryCount: 5,
  recordingRetryDelaySeconds: 10,
  notifyOnLive: true,
  showRecordingPreview: true,
  aiArticleEnabled: false,
  aiArticleProvider: "ollama",
  aiArticleOllamaUrl: "http://127.0.0.1:11434",
  aiArticleModel: "qwen2.5vl:3b",
  aiArticleIntervalSeconds: 120,
  aiArticleAudioEnabled: true,
  aiArticleAudioModel: "frozenlab/qwen3-asr:0.6b"
};

function normalizeState(value: unknown): PersistedState {
  if (!value || typeof value !== "object") {
    return { channels: [], recordingOnlyChannels: [], settings: DEFAULT_SETTINGS };
  }

  const source = value as Partial<PersistedState>;
  const channels = Array.isArray(source.channels)
    ? source.channels.filter((channel): channel is Channel =>
        Boolean(channel) &&
        typeof channel === "object" &&
        typeof channel.id === "number" &&
        typeof channel.name === "string" &&
        /^[a-zA-Z0-9_]{1,25}$/.test(channel.name) &&
        (channel.mode === "auto" || channel.mode === "manual")
      ).map(channel => ({
        id: channel.id,
        name: channel.name,
        url: `https://kick.com/${channel.name}`,
        mode: channel.mode,
        status: "待機中" as const,
        recording: false
      }))
    : [];

  const recordingOnlyChannels = Array.isArray(source.recordingOnlyChannels)
    ? source.recordingOnlyChannels.filter((channel): channel is Channel =>
        Boolean(channel) &&
        typeof channel === "object" &&
        typeof channel.id === "number" &&
        typeof channel.name === "string" &&
        /^[a-zA-Z0-9_]{1,25}$/.test(channel.name)
      ).map(channel => ({
        id: channel.id,
        name: channel.name,
        url: `https://kick.com/${channel.name}`,
        mode: "manual" as const,
        status: "待機中" as const,
        recording: false
      }))
    : [];
  const settings = source.settings ?? DEFAULT_SETTINGS;
  return {
    channels,
    recordingOnlyChannels,
    settings: {
      autoRecordOnStreamStart: settings.autoRecordOnStreamStart !== false,
      autoReceiveChat: settings.autoReceiveChat !== false,
      autoReceiveChatForRecordingOnly: settings.autoReceiveChatForRecordingOnly !== false,
      saveChat: settings.saveChat !== false,
      outputDirectory: typeof settings.outputDirectory === "string" ? settings.outputDirectory : "",
      autoMonitorEnabled: settings.autoMonitorEnabled !== false,
      monitorIntervalSeconds: typeof settings.monitorIntervalSeconds === "number"
        ? Math.max(10, Math.min(3600, Math.round(settings.monitorIntervalSeconds)))
        : 10,
      autoRecordRecordingOnlyOnStreamStart: settings.autoRecordRecordingOnlyOnStreamStart !== false,
      launchAtLogin: settings.launchAtLogin !== false,
      preventSystemSleep: settings.preventSystemSleep !== false,
      recordingRetryCount: typeof settings.recordingRetryCount === "number"
        ? Math.max(0, Math.min(10, Math.round(settings.recordingRetryCount)))
        : 5,
      recordingRetryDelaySeconds: typeof settings.recordingRetryDelaySeconds === "number"
        ? Math.max(5, Math.min(60, Math.round(settings.recordingRetryDelaySeconds)))
        : 10,
      notifyOnLive: settings.notifyOnLive !== false,
      showRecordingPreview: settings.showRecordingPreview !== false,
      aiArticleEnabled: settings.aiArticleEnabled === true,
      aiArticleProvider: settings.aiArticleProvider === "openai" ? "openai" : "ollama",
      aiArticleOllamaUrl: typeof settings.aiArticleOllamaUrl === "string" ? settings.aiArticleOllamaUrl.slice(0, 300) : "http://127.0.0.1:11434",
      aiArticleModel: typeof settings.aiArticleModel === "string" && /^[a-zA-Z0-9._:-]{1,100}$/.test(settings.aiArticleModel)
        ? (settings.aiArticleProvider !== "openai" && settings.aiArticleModel === "qwen2.5:3b" ? "qwen2.5vl:3b" : settings.aiArticleModel) : (settings.aiArticleProvider === "openai" ? "gpt-6-luna" : "qwen2.5vl:3b"),
      aiArticleIntervalSeconds: typeof settings.aiArticleIntervalSeconds === "number"
        ? Math.max(30, Math.min(600, Math.round(settings.aiArticleIntervalSeconds))) : 120,
      aiArticleAudioEnabled: settings.aiArticleAudioEnabled !== false,
      aiArticleAudioModel: typeof settings.aiArticleAudioModel === "string" &&
        /^[a-zA-Z0-9._:/-]{1,120}$/.test(settings.aiArticleAudioModel)
        ? settings.aiArticleAudioModel : "frozenlab/qwen3-asr:0.6b"
    }
  };
}

function formatLiveStartTime(value: string | null): string {
  if (!value) return "開始時刻不明";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "開始時刻不明";
  return date.toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatLiveElapsed(value: string | null, now: number): string {
  if (!value) return "計測できません";
  const startedAt = Date.parse(value);
  if (!Number.isFinite(startedAt)) return "計測できません";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map(part => String(part).padStart(2, "0")).join(":");
}

async function loadState(): Promise<PersistedState> {
  if (window.kickRecorder) {
    return normalizeState(await window.kickRecorder.loadState());
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeState(JSON.parse(raw) as unknown) : { channels: [], recordingOnlyChannels: [], settings: DEFAULT_SETTINGS };
  } catch {
    return { channels: [], recordingOnlyChannels: [], settings: DEFAULT_SETTINGS };
  }
}

export default function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [recordingOnlyChannels, setRecordingOnlyChannels] = useState<Channel[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [newChannel, setNewChannel] = useState("");
  const [newRecordingOnlyChannel, setNewRecordingOnlyChannel] = useState("");
  const [vodUrl, setVodUrl] = useState("");
  const [vodSlug, setVodSlug] = useState("");
  const vodSlugRef = useRef("");
  const [vodDownloadStatus, setVodDownloadStatus] = useState("");
  const [vodDownloadActive, setVodDownloadActive] = useState(false);
  const [vodChatStatus, setVodChatStatus] = useState("");
  const [vodChatActive, setVodChatActive] = useState(false);
  const [tab, setTab] = useState<"dashboard" | "recording" | "library" | "comment-video" | "articles" | "updates" | "settings">("dashboard");
  const [isReady, setIsReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [appDataDirectory, setAppDataDirectory] = useState("");
  const [isDesktop, setIsDesktop] = useState(false);
  const [kickClientId, setKickClientId] = useState("");
  const [kickClientSecret, setKickClientSecret] = useState("");
  const [kickCredentialsConfigured, setKickCredentialsConfigured] = useState(false);
  const [kickEncryptionAvailable, setKickEncryptionAvailable] = useState(false);
  const [kickMessage, setKickMessage] = useState("");
  const [isTestingKickConnection, setIsTestingKickConnection] = useState(false);
  const [chatStatus, setChatStatus] = useState<ChatReceiverStatus>({
    running: false,
    connectedChannels: 0,
    messageCount: 0,
    lastMessageAt: null,
    message: "チャット受信サーバーは停止中です。"
  });
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatSetupMessage, setChatSetupMessage] = useState("");
  const [isStartingChat, setIsStartingChat] = useState(false);
  const [channelChecks, setChannelChecks] = useState<Record<string, ChannelCheck>>({});
  const [liveClock, setLiveClock] = useState(() => Date.now());
  const [isCheckingChannels, setIsCheckingChannels] = useState(false);
  const [lastChannelCheck, setLastChannelCheck] = useState("");
  const [monitorError, setMonitorError] = useState("");
  const [backgroundMonitorStatus, setBackgroundMonitorStatus] = useState<BackgroundMonitorStatus>({
    enabled: true, running: false, monitoredChannels: 0, intervalSeconds: 10,
    lastCheckAt: null, lastError: "", message: "監視状態を読み込み中...", results: []
  });
  const previousChecksRef = useRef<Record<string, ChannelCheck>>({});
  const [appVersion, setAppVersion] = useState(APP_VERSION);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({
    status: "idle",
    currentVersion: APP_VERSION,
    message: "起動時に自動で更新を確認します。"
  });
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [recordingRequests, setRecordingRequests] = useState<Record<string, boolean>>({});
  const [recordingFiles, setRecordingFiles] = useState<RecordingFile[]>([]);
  const [isLoadingRecordings, setIsLoadingRecordings] = useState(false);
  const [deletingRecordingPath, setDeletingRecordingPath] = useState<string | null>(null);
  const [recordingMessage, setRecordingMessage] = useState("");
  const [libraryRefreshKey, setLibraryRefreshKey] = useState(0);
  const [commentLogFiles, setCommentLogFiles] = useState<CommentLogFile[]>([]);
  const [selectedCommentVideoPath, setSelectedCommentVideoPath] = useState("");
  const [selectedCommentLogPaths, setSelectedCommentLogPaths] = useState<string[]>([]);
  const [isLoadingCommentLogs, setIsLoadingCommentLogs] = useState(false);
  const [commentVideoDelay, setCommentVideoDelay] = useState(0);
  const [commentVideoPosition, setCommentVideoPosition] = useState<"scroll" | "top" | "bottom" | "command">("scroll");
  const [commentVideoFontFamily, setCommentVideoFontFamily] = useState<"ms-pgothic" | "meiryo" | "yu-gothic" | "arial">("ms-pgothic");
  const [commentVideoFontSize, setCommentVideoFontSize] = useState(48);
  const [commentVideoDuration, setCommentVideoDuration] = useState(6);
  const [commentVideoSpeed, setCommentVideoSpeed] = useState(100);
  const [commentVideoRows, setCommentVideoRows] = useState(14);
  const [commentVideoGap, setCommentVideoGap] = useState(24);
  const [commentVideoOpacity, setCommentVideoOpacity] = useState(100);
  const [commentVideoQuality, setCommentVideoQuality] = useState<"high" | "standard" | "compact">("standard");
  const [commentVideoShowUsername, setCommentVideoShowUsername] = useState(false);
  const [commentVideoBusy, setCommentVideoBusy] = useState(false);
  const [commentVideoEvent, setCommentVideoEvent] = useState<CommentVideoEvent | null>(null);
  const [commentVideoPreviewResult, setCommentVideoPreviewResult] = useState<CommentVideoPreviewData | null>(null);
  const [commentVideoPreviewLoading, setCommentVideoPreviewLoading] = useState(false);
  const [commentVideoPreviewError, setCommentVideoPreviewError] = useState("");
  const [commentVideoOutputPath, setCommentVideoOutputPath] = useState("");
  const [streamArticles, setStreamArticles] = useState<StreamArticle[]>([]);
  const [articleSearch, setArticleSearch] = useState("");
  const [articleStatusFilter, setArticleStatusFilter] = useState<"all" | "live" | "archive">("all");
  const [articleSlug, setArticleSlug] = useState("");
  const [articleVideoPath, setArticleVideoPath] = useState("");
  const [articleHeadline, setArticleHeadline] = useState("");
  const [articleBusy, setArticleBusy] = useState(false);
  const [deletingArticleId, setDeletingArticleId] = useState<string | null>(null);
  const [articleMessage, setArticleMessage] = useState("");
  const [manualLiveArticleInput, setManualLiveArticleInput] = useState("");
  const [manualLiveArticleBusy, setManualLiveArticleBusy] = useState(false);
  const [manualLiveArticleSlug, setManualLiveArticleSlug] = useState("");
  const [liveArticleCaptureStatus, setLiveArticleCaptureStatus] = useState<{ slug: string; status: "starting" | "capturing" | "completed" | "stopped" | "error"; frameCount: number; message: string } | null>(null);
  const [aiArticleApiKey, setAiArticleApiKey] = useState("");
  const [aiArticleStatus, setAiArticleStatus] = useState<AiArticleStatus>({
    configured: false, encryptionAvailable: false, aiArticleEnabled: false,
    aiArticleProvider: "ollama", aiArticleOllamaUrl: "http://127.0.0.1:11434", aiArticleModel: "qwen2.5vl:3b", aiArticleIntervalSeconds: 120
  });
  const [aiArticleBusy, setAiArticleBusy] = useState(false);
  const [aiArticleMessage, setAiArticleMessage] = useState("");

  const filteredStreamArticles = useMemo(() => {
    const query = articleSearch.trim().toLocaleLowerCase("ja-JP");
    return streamArticles.filter(article => {
      const isLive = article.status === "live";
      if (articleStatusFilter === "live" && !isLive) return false;
      if (articleStatusFilter === "archive" && isLive) return false;
      if (!query) return true;
      return [
        article.displayName, article.slug, article.headline, article.category, article.aiSummary ?? "",
        ...(article.paragraphs ?? []), ...(article.keywords ?? []), ...(article.highlights ?? []),
        article.videoSummary ?? "", ...(article.videoScenes ?? []), article.audioSummary ?? "",
        article.audioTranscript ?? ""
      ].join(" ").toLocaleLowerCase("ja-JP").includes(query);
    });
  }, [streamArticles, articleSearch, articleStatusFilter]);

  const articleDateGroups = useMemo(() => {
    const groups = new Map<string, StreamArticle[]>();
    for (const article of filteredStreamArticles) {
      const date = new Date(article.startedAt);
      const label = Number.isNaN(date.getTime())
        ? "日付不明"
        : date.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
      const items = groups.get(label) ?? [];
      items.push(article);
      groups.set(label, items);
    }
    return [...groups.entries()];
  }, [filteredStreamArticles]);

  const activeCount = useMemo(() => [...channels, ...recordingOnlyChannels].filter(c => c.recording).length, [channels, recordingOnlyChannels]);
  const activeRecordingChannels = useMemo(() => {
    const unique = new Map<string, Channel>();
    for (const channel of [...channels, ...recordingOnlyChannels]) {
      if (channel.recording) unique.set(channel.name.toLowerCase(), channel);
    }
    return [...unique.values()];
  }, [channels, recordingOnlyChannels]);
  const liveChannelCards = useMemo(() => {
    const watchedChannels = [
      ...channels.map(channel => ({ channel, isRecordingOnly: false })),
      ...recordingOnlyChannels.map(channel => ({ channel, isRecordingOnly: true }))
    ];
    const uniqueChannels = new Map<string, (typeof watchedChannels)[number]>();
    for (const item of watchedChannels) uniqueChannels.set(item.channel.name.toLowerCase(), item);

    return [...uniqueChannels.values()].flatMap(({ channel, isRecordingOnly }) => {
      const live = channelChecks[channel.name.toLowerCase()];
      return live?.found && live.isLive ? [{ channel, live, isRecordingOnly }] : [];
    }).sort((a, b) => {
      const aStart = a.live.startedAt ? Date.parse(a.live.startedAt) : 0;
      const bStart = b.live.startedAt ? Date.parse(b.live.startedAt) : 0;
      return bStart - aStart;
    });
  }, [channels, recordingOnlyChannels, channelChecks]);
  const [previewSelection, setPreviewSelection] = useState("");
  const previewChannel = activeRecordingChannels.find(channel => channel.name === previewSelection) ?? activeRecordingChannels[0] ?? null;

  useEffect(() => {
    let active = true;
    let unsubscribeUpdate: (() => void) | undefined;
    let unsubscribeRecording: (() => void) | undefined;
    let unsubscribeChatMessage: (() => void) | undefined;
    let unsubscribeChatStatus: (() => void) | undefined;
    let unsubscribeVodChat: (() => void) | undefined;
    let unsubscribeCommentVideo: (() => void) | undefined;
    let unsubscribeBackgroundMonitor: (() => void) | undefined;
    void loadState().then(state => {
      if (!active) return;
      setChannels(state.channels);
      setRecordingOnlyChannels(state.recordingOnlyChannels);
      setSettings(state.settings);
    }).catch(() => {
      if (active) setStorageError("保存データを読み込めませんでした。");
    }).finally(() => {
      if (active) setIsReady(true);
    });

    if (window.kickRecorder) {
      setIsDesktop(true);
      unsubscribeUpdate = window.kickRecorder.onUpdateStatus(status => {
        if (active) setUpdateStatus(status);
      });
      unsubscribeChatMessage = window.kickRecorder.onChatMessage(message => {
        if (!active) return;
        setChatMessages(previous => [message, ...previous.filter(item => item.eventId !== message.eventId)].slice(0, 100));
      });
      unsubscribeChatStatus = window.kickRecorder.onChatStatus(status => {
        if (active) setChatStatus(status);
      });
      void window.kickRecorder.getChatReceiverStatus().then(status => {
        if (active) setChatStatus(status);
      }).catch(() => undefined);
      void window.kickRecorder.listChatMessages(50).then(messages => {
        if (active) setChatMessages(messages);
      }).catch(() => undefined);
      unsubscribeVodChat = window.kickRecorder.onVodChatStatus(event => {
        if (!active) return;
        setVodChatStatus(event.message);
        setVodChatActive(event.status === "starting" || event.status === "progress");
        if (event.status === "completed") setLibraryRefreshKey(value => value + 1);
      });
      unsubscribeCommentVideo = window.kickRecorder.onCommentVideoStatus(event => {
        if (!active) return;
        setCommentVideoEvent(event);
        setCommentVideoBusy(event.status === "starting" || event.status === "encoding");
        if (event.outputPath) setCommentVideoOutputPath(event.outputPath);
        if (event.status === "completed") setLibraryRefreshKey(value => value + 1);
      });
      const applyMonitorStatus = (status: BackgroundMonitorStatus) => {
        setBackgroundMonitorStatus(status);
        if (status.lastCheckAt) setLastChannelCheck(new Date(status.lastCheckAt).toLocaleString("ja-JP"));
        setMonitorError(status.lastError);
        if (status.results.length > 0) {
          const next = Object.fromEntries(status.results.map(result => [result.slug.toLowerCase(), result]));
          previousChecksRef.current = next;
          setChannelChecks(next);
        }
      };
      unsubscribeBackgroundMonitor = window.kickRecorder.onBackgroundMonitorStatus(applyMonitorStatus);
      void window.kickRecorder.getBackgroundMonitorStatus().then(status => {
        if (active) applyMonitorStatus(status);
      }).catch(() => undefined);
      unsubscribeRecording = window.kickRecorder.onRecordingStatus((event: RecordingEvent) => {
        if (!active) return;
        const isRecording = event.status === "starting" || event.status === "recording";
        if (event.isVod && vodSlugRef.current && event.slug === vodSlugRef.current) {
          setVodDownloadStatus(event.message ?? "過去配信を処理しています。");
          if (event.status === "recording") setVodDownloadActive(true);
          if (event.status === "stopped" || event.status === "error") setVodDownloadActive(false);
        }
        if (!event.isVod) setChannels(previous => previous.map(channel =>
          channel.name.toLowerCase() === event.slug ? { ...channel, recording: isRecording } : channel
        ));
        if (!event.isVod) setRecordingOnlyChannels(previous => previous.map(channel =>
          channel.name.toLowerCase() === event.slug ? { ...channel, recording: isRecording } : channel
        ));
        if (!event.isVod) setRecordingRequests(previous => ({ ...previous, [event.slug]: false }));
        if (event.status === "error") {
          setRecordingMessage(`${event.slug}：${event.message ?? "録画に失敗しました。"}`);
        } else if (event.status === "starting") {
          setRecordingMessage(`${event.slug}：${event.message ?? "録画を準備しています。"}`);
        } else if (event.status === "recording") {
          setRecordingMessage(`${event.slug}：${event.message ?? "録画を開始しました。"}`);
        } else if (event.status === "stopped") {
          setRecordingMessage(`${event.slug}：${event.message ?? "録画を終了しました。"}`);
        }
        setLibraryRefreshKey(value => value + 1);
      });
      void window.kickRecorder.getAppInfo().then(info => {
        if (!active) return;
        setAppDataDirectory(info.dataDirectory);
        setAppVersion(info.version);
        setSettings(previous => previous.outputDirectory
          ? previous
          : { ...previous, outputDirectory: info.defaultOutputDirectory });
      }).catch(() => undefined);
      void window.kickRecorder.getUpdateStatus().then(status => {
        if (active) setUpdateStatus(status);
      }).catch(() => undefined);
      void window.kickRecorder.getKickCredentialsStatus().then(status => {
        if (!active) return;
        setKickCredentialsConfigured(status.configured);
        setKickEncryptionAvailable(status.encryptionAvailable);
        setKickClientId(status.clientId);
      }).catch(() => undefined);
    }

    return () => {
      active = false;
      unsubscribeUpdate?.();
      unsubscribeRecording?.();
      unsubscribeChatMessage?.();
      unsubscribeChatStatus?.();
      unsubscribeVodChat?.();
      unsubscribeCommentVideo?.();
      unsubscribeBackgroundMonitor?.();
    };
  }, []);

  const monitorSlugs = useMemo(
    () => [...new Set([...channels, ...recordingOnlyChannels].map(channel => channel.name.toLowerCase()))].slice(0, 200),
    [channels, recordingOnlyChannels]
  );

  const recordingOnlyMessages = useMemo(
    () => chatMessages.filter(message =>
      recordingOnlyChannels.some(channel => channel.name.toLowerCase() === message.channelSlug.toLowerCase())
    ),
    [chatMessages, recordingOnlyChannels]
  );

  useEffect(() => {
    if ((tab !== "library" && tab !== "dashboard" && tab !== "comment-video" && tab !== "articles") || !isDesktop || !window.kickRecorder) return;
    let active = true;
    setIsLoadingRecordings(true);
    void window.kickRecorder.listRecordings().then(files => {
      if (active) setRecordingFiles(files);
    }).catch(error => {
      if (active) setRecordingMessage(error instanceof Error ? error.message : "録画一覧を取得できませんでした。");
    }).finally(() => {
      if (active) setIsLoadingRecordings(false);
    });
    return () => { active = false; };
  }, [tab, isDesktop, libraryRefreshKey, settings.outputDirectory]);

  useEffect(() => {
    if (!isDesktop || !window.kickRecorder) return;
    return window.kickRecorder.onLiveArticleCaptureStatus(status => setLiveArticleCaptureStatus(status));
  }, [isDesktop]);

  useEffect(() => {
    if (tab !== "articles" || !isDesktop || !window.kickRecorder) return;
    let active = true;
    Promise.all([window.kickRecorder.listStreamArticles(), window.kickRecorder.listCommentLogFiles()])
      .then(([articles, logs]) => {
        if (!active) return;
        setStreamArticles(articles);
        setCommentLogFiles(logs);
      })
      .catch(error => setArticleMessage(error instanceof Error ? error.message : "記事データを読み込めませんでした。"));
    return () => { active = false; };
  }, [tab, isDesktop, libraryRefreshKey, settings.outputDirectory]);

  useEffect(() => {
    if (!isDesktop || !window.kickRecorder) return;
    let active = true;
    void window.kickRecorder.getAiArticleStatus().then(status => {
      if (active) setAiArticleStatus(status);
    }).catch(error => {
      if (active) setAiArticleMessage(error instanceof Error ? error.message : "AI記事の設定を取得できませんでした。");
    });
    const unsubscribe = window.kickRecorder.onStreamArticleUpdate(article => {
      if (!active) return;
      setStreamArticles(current => [article, ...current.filter(item => item.id !== article.id)]
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)));
    });
    return () => { active = false; unsubscribe(); };
  }, [isDesktop]);

  useEffect(() => {
    if (tab !== "comment-video" || !isDesktop || !window.kickRecorder) return;
    let active = true;
    setIsLoadingCommentLogs(true);
    void window.kickRecorder.listCommentLogFiles().then(files => {
      if (active) setCommentLogFiles(files);
    }).catch(error => {
      if (active) setRecordingMessage(error instanceof Error ? error.message : "コメントファイル一覧を取得できませんでした。");
    }).finally(() => {
      if (active) setIsLoadingCommentLogs(false);
    });
    return () => { active = false; };
  }, [tab, isDesktop, libraryRefreshKey, settings.outputDirectory]);

  useEffect(() => {
    if (tab !== "comment-video" || !isDesktop || !window.kickRecorder) return;
    if (!selectedCommentVideoPath || selectedCommentLogPaths.length === 0) {
      setCommentVideoPreviewResult(null);
      setCommentVideoPreviewError("");
      setCommentVideoPreviewLoading(false);
      return;
    }

    let active = true;
    setCommentVideoPreviewLoading(true);
    setCommentVideoPreviewError("");
    void window.kickRecorder.previewCommentVideo({
      videoPath: selectedCommentVideoPath,
      chatPaths: selectedCommentLogPaths,
      delaySeconds: commentVideoDelay
    }).then(result => {
      if (!active) return;
      setCommentVideoPreviewResult(result);
    }).catch(error => {
      if (!active) return;
      setCommentVideoPreviewResult(null);
      setCommentVideoPreviewError(error instanceof Error ? error.message : "実際のコメントを読み込めませんでした。");
    }).finally(() => {
      if (active) setCommentVideoPreviewLoading(false);
    });
    return () => { active = false; };
  }, [tab, isDesktop, selectedCommentVideoPath, selectedCommentLogPaths, commentVideoDelay, libraryRefreshKey, settings.outputDirectory]);

  useEffect(() => {
    if (!selectedCommentVideoPath && recordingFiles.length > 0) setSelectedCommentVideoPath(recordingFiles[0].path);
    else if (selectedCommentVideoPath && !recordingFiles.some(file => file.path === selectedCommentVideoPath)) setSelectedCommentVideoPath(recordingFiles[0]?.path ?? "");
  }, [recordingFiles, selectedCommentVideoPath]);

  useEffect(() => {
    setSelectedCommentLogPaths(current => {
      const availablePaths = new Set(commentLogFiles.map(file => file.path));
      const retained = current.filter(path => availablePaths.has(path));
      return retained.length > 0 ? retained : commentLogFiles.length > 0 ? [commentLogFiles[0].path] : [];
    });
  }, [commentLogFiles]);

  useEffect(() => {
    if (liveChannelCards.length === 0) return;
    setLiveClock(Date.now());
    const timer = window.setInterval(() => setLiveClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [liveChannelCards.length]);

  useEffect(() => {
    if (!isReady) return;
    const state: PersistedState = { channels, recordingOnlyChannels, settings };
    if (window.kickRecorder) {
      void window.kickRecorder.saveState(state).then(() => {
        setStorageError("");
      }).catch(() => {
        setStorageError("設定を保存できませんでした。アプリを再起動する前に確認してください。");
      });
      return;
    }

    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      setStorageError("");
    } catch {
      setStorageError("ブラウザー内に設定を保存できませんでした。");
    }
  }, [channels, recordingOnlyChannels, settings, isReady]);

  function addChannel() {
    const raw = newChannel.trim()
      .replace(/^https?:\/\/(www\.)?kick\.com\//i, "")
      .split(/[/?#]/)[0]
      .replace(/\/$/, "");
    if (!raw || !/^[a-zA-Z0-9_]{1,25}$/.test(raw) || [...channels, ...recordingOnlyChannels].some(c => c.name.toLowerCase() === raw.toLowerCase())) {
      if (raw) setRecordingMessage("このチャンネルはすでに別の一覧に登録されています。");
      return;
    }

    setChannels(prev => [...prev, {
      id: Date.now(),
      name: raw,
      url: `https://kick.com/${raw}`,
      mode: "auto",
      status: "待機中",
      recording: false
    }]);
    setNewChannel("");
  }

  function addRecordingOnlyChannel() {
    const raw = newRecordingOnlyChannel.trim()
      .replace(/^https?:\/\/(www\.)?kick\.com\//i, "")
      .split(/[/?#]/)[0]
      .replace(/\/$/, "");
    if (!raw || !/^[a-zA-Z0-9_]{1,25}$/.test(raw) ||
      [...channels, ...recordingOnlyChannels].some(channel => channel.name.toLowerCase() === raw.toLowerCase())) {
      if (raw) setRecordingMessage("このチャンネルはすでに別の一覧に登録されているか、名前が正しくありません。");
      return;
    }

    setRecordingOnlyChannels(previous => [...previous, {
      id: Date.now(),
      name: raw,
      url: `https://kick.com/${raw}`,
      mode: "manual",
      status: "待機中",
      recording: false
    }]);
    setNewRecordingOnlyChannel("");
    setRecordingMessage(`${raw} を録画専用一覧に追加しました。配信中に「録画開始」を押してください。`);
  }

  async function saveKickApiCredentials() {
    if (!window.kickRecorder) return;
    if (!kickClientId.trim() || !kickClientSecret) {
      setKickMessage("クライアントIDとクライアントシークレットを入力してください。");
      return;
    }
    try {
      const result = await window.kickRecorder.saveKickCredentials({
        clientId: kickClientId.trim(),
        clientSecret: kickClientSecret
      });
      setKickClientId(result.clientId);
      setKickClientSecret("");
      setKickCredentialsConfigured(true);
      setKickMessage("Kick APIの認証情報を暗号化して保存しました。");
    } catch (error) {
      setKickMessage(error instanceof Error ? error.message : "認証情報を保存できませんでした。");
    }
  }

  async function testKickApiConnection() {
    if (!window.kickRecorder) return;
    if (!kickCredentialsConfigured) {
      setKickMessage("先にClient IDとClient Secretを保存してください。");
      return;
    }

    setIsTestingKickConnection(true);
    setKickMessage("Kick APIの認証を確認しています...");
    try {
      const result = await window.kickRecorder.testKickConnection();
      setKickMessage(`接続成功：${result.message}`);
      setMonitorError("");
    } catch (error) {
      setKickMessage(error instanceof Error ? `接続失敗：${error.message}` : "接続に失敗しました。Client ID／Secretとネットワークを確認してください。");
    } finally {
      setIsTestingKickConnection(false);
    }
  }

  async function startChatReceiver() {
    if (!window.kickRecorder) return;
    const targets = [
      ...(settings.autoReceiveChat ? channels : []),
      ...(settings.autoReceiveChatForRecordingOnly ? recordingOnlyChannels : [])
    ];
    if (targets.length === 0) {
      if (channels.length === 0 && recordingOnlyChannels.length === 0) {
        setChatSetupMessage("先にチャンネル管理または録画専用へチャンネルを登録してください。");
        return;
      }
      setSettings(previous => ({
        ...previous,
        autoReceiveChat: previous.autoReceiveChat || channels.length > 0,
        autoReceiveChatForRecordingOnly: previous.autoReceiveChatForRecordingOnly || recordingOnlyChannels.length > 0
      }));
      setChatSetupMessage("登録済みのチャンネルでコメント自動取得を有効にしました。");
      return;
    }
    setIsStartingChat(true);
    setChatSetupMessage("自動取得対象のKickチャンネルへ接続し直しています...");
    try {
      const status = await window.kickRecorder.startChatReceiver([...new Set(targets.map(channel => channel.name.toLowerCase()))]);
      setChatStatus(status);
      setChatSetupMessage(status.connectedChannels + "チャンネルのコメントを受信しています。");
    } catch (error) {
      setChatSetupMessage(error instanceof Error ? error.message : "コメント受信を開始できませんでした。");
    } finally {
      setIsStartingChat(false);
    }
  }

  async function stopChatReceiver() {
    if (!window.kickRecorder) return;
    setSettings(previous => ({
      ...previous,
      autoReceiveChat: false,
      autoReceiveChatForRecordingOnly: false
    }));
    try {
      const status = await window.kickRecorder.stopChatReceiver();
      setChatStatus(status);
      setChatSetupMessage("すべてのチャット自動取得を停止しました。");
    } catch (error) {
      setChatSetupMessage(error instanceof Error ? error.message : "コメント受信を停止できませんでした。");
    }
  }

  async function clearKickApiCredentials() {
    if (!window.kickRecorder) return;
    try {
      await window.kickRecorder.clearKickCredentials();
      setKickClientId("");
      setKickClientSecret("");
      setKickCredentialsConfigured(false);
      setChannelChecks({});
      previousChecksRef.current = {};
      setKickMessage("Kick APIの認証情報を削除しました。");
    } catch {
      setKickMessage("認証情報を削除できませんでした。");
    }
  }

  async function refreshChannelStatuses() {
    if (!window.kickRecorder) {
      setKickMessage("Kick APIの確認にはWindowsデスクトップ版が必要です。");
      return;
    }
    if (monitorSlugs.length === 0) {
      setKickMessage("先にチャンネル管理または録画専用へチャンネルを登録してください。");
      return;
    }
    if (!kickCredentialsConfigured) {
      setKickMessage("設定画面でKick APIのClient IDとClient Secretを登録してください。");
      setTab("settings");
      return;
    }

    setIsCheckingChannels(true);
    setKickMessage("");
    try {
      const results = await window.kickRecorder.checkKickChannels(monitorSlugs);
      const nextChecks = Object.fromEntries(results.map(result => [result.slug.toLowerCase(), result]));
      previousChecksRef.current = nextChecks;
      setChannelChecks(nextChecks);
      setLastChannelCheck(new Date().toLocaleString("ja-JP"));
      setMonitorError("");
      setKickMessage("Kick公式APIから配信状態を更新しました。");
    } catch (error) {
      setKickMessage(error instanceof Error ? error.message : "配信状態を取得できませんでした。");
      setMonitorError(error instanceof Error ? error.message : "配信状態を取得できませんでした。");
    } finally {
      setIsCheckingChannels(false);
    }
  }


  async function toggleRecording(slug: string, isRecording: boolean) {
    if (!window.kickRecorder) {
      setRecordingMessage("録画はWindowsデスクトップ版で利用できます。");
      return;
    }
    setRecordingRequests(previous => ({ ...previous, [slug.toLowerCase()]: true }));
    setRecordingMessage("");
    try {
      if (isRecording) {
        await window.kickRecorder.stopRecording(slug);
      } else {
        const result = await window.kickRecorder.startRecording(slug);
        setRecordingMessage(`録画要求を送信しました。保存先：${result.outputDirectory}`);
      }
    } catch (error) {
      setRecordingRequests(previous => ({ ...previous, [slug.toLowerCase()]: false }));
      setRecordingMessage(error instanceof Error ? error.message : "録画操作に失敗しました。");
    }
  }

  async function toggleRecordingWithChat(slug: string, isRecording: boolean) {
    if (!window.kickRecorder) {
      setRecordingMessage("録画とコメント取得はWindowsデスクトップ版で利用できます。");
      return;
    }

    const key = slug.toLowerCase();
    setRecordingRequests(previous => ({ ...previous, [key]: true }));
    setRecordingMessage("");
    try {
      if (isRecording) {
        await window.kickRecorder.stopRecording(slug);
        setRecordingMessage(`${slug} の映像録画を停止しました。コメント自動取得は設定に従って継続します。`);
        return;
      }

      // 録画専用から同時開始した場合は、次回起動後もコメント取得を継続する。
      setSettings(previous => ({ ...previous, autoReceiveChatForRecordingOnly: true }));

      let chatWarning = "";
      if (settings.autoReceiveChatForRecordingOnly && !chatStatus.running && !isStartingChat) {
        const chatTargets = [
          ...(settings.autoReceiveChat ? channels : []),
          ...recordingOnlyChannels
        ];
        const slugs = [...new Set(chatTargets.map(channel => channel.name.toLowerCase()))];
        if (slugs.length > 0) {
          setIsStartingChat(true);
          try {
            const status = await window.kickRecorder.startChatReceiver(slugs);
            setChatStatus(status);
            setChatSetupMessage(status.connectedChannels + "チャンネルのコメントを受信しています。");
          } catch (error) {
            chatWarning = error instanceof Error ? error.message : "コメント受信の接続に失敗しました。";
            setChatSetupMessage(chatWarning);
          } finally {
            setIsStartingChat(false);
          }
        }
      }

      const result = await window.kickRecorder.startRecording(slug);
      setRecordingMessage(
        `${slug} の映像録画を開始しました。録画専用チャンネルのコメント自動取得も有効です。保存先：${result.outputDirectory}` +
        (chatWarning ? " コメント接続エラー：" + chatWarning : "")
      );
    } catch (error) {
      setRecordingMessage(error instanceof Error ? error.message : "録画・コメント取得の開始に失敗しました。");
    } finally {
      setRecordingRequests(previous => ({ ...previous, [key]: false }));
    }
  }

  async function downloadPastBroadcast() {
    if (!window.kickRecorder) { setVodDownloadStatus("Windowsデスクトップ版で利用できます。"); return; }
    const match = vodUrl.trim().match(/^https:\/\/(?:www\.)?kick\.com\/([a-zA-Z0-9_-]{1,40})\/videos\/[a-f0-9-]{20,40}\/?(?:[?#].*)?$/i);
    if (!match) { setVodDownloadStatus("Kickの過去配信URLを入力してください（https://kick.com/チャンネル/videos/動画ID）。"); return; }
    const slug = match[1].toLowerCase();
    vodSlugRef.current = slug; setVodSlug(slug); setVodDownloadActive(false); setVodDownloadStatus("過去配信のダウンロードを準備しています...");
    try {
      const result = await window.kickRecorder.startRecording(slug, vodUrl.trim());
      setVodDownloadActive(true); setVodDownloadStatus(`ダウンロードを開始しました。保存先：${result.outputDirectory}`);
    } catch (error) { setVodDownloadActive(false); setVodDownloadStatus(error instanceof Error ? error.message : "過去配信のダウンロードに失敗しました。"); }
  }

  async function stopPastBroadcastDownload() {
    if (!window.kickRecorder || !vodSlug) return;
    try { await window.kickRecorder.stopRecording(vodSlug, true); setVodDownloadStatus("停止要求を送信しました。"); }
    catch (error) { setVodDownloadStatus(error instanceof Error ? error.message : "停止できませんでした。"); }
  }

  async function downloadPastBroadcastChat() {
    if (!window.kickRecorder) { setVodChatStatus("Windowsデスクトップ版で利用できます。"); return; }
    if (!vodUrl.trim()) { setVodChatStatus("先にKickの過去配信URLを入力してください。"); return; }
    setVodChatActive(true);
    setVodChatStatus("過去コメントの取得を準備しています...");
    try {
      const result = await window.kickRecorder.startVodChatDownload(vodUrl.trim());
      setVodChatStatus("コメント取得を開始しました。保存先：" + result.outputDirectory);
    } catch (error) {
      setVodChatActive(false);
      setVodChatStatus(error instanceof Error ? error.message : "過去コメントを取得できませんでした。");
    }
  }

  async function stopPastBroadcastChat() {
    if (!window.kickRecorder) return;
    try {
      await window.kickRecorder.stopVodChatDownload();
      setVodChatStatus("コメント取得の停止要求を送信しました...");
    } catch (error) {
      setVodChatStatus(error instanceof Error ? error.message : "コメント取得を停止できませんでした。");
    }
  }
  async function openRecordingFile(filePath: string) {
    if (!window.kickRecorder) return;
    try {
      await window.kickRecorder.openRecording(filePath);
    } catch (error) {
      setRecordingMessage(error instanceof Error ? error.message : "録画ファイルを開けませんでした。");
    }
  }

  async function revealRecordingFile(filePath: string) {
    if (!window.kickRecorder) return;
    try {
      await window.kickRecorder.revealRecording(filePath);
    } catch (error) {
      setRecordingMessage(error instanceof Error ? error.message : "保存先を表示できませんでした。");
    }
  }

  async function deleteRecordingFromLibrary(filePath: string, fileName: string) {
    if (!window.kickRecorder || deletingRecordingPath) return;
    const confirmed = window.confirm(`「${fileName}」を完全に削除しますか？\n\n削除したファイルは元に戻せません。`);
    if (!confirmed) return;

    setDeletingRecordingPath(filePath);
    setRecordingMessage("");
    try {
      const result = await window.kickRecorder.deleteRecording(filePath);
      setRecordingFiles(current => current.filter(file => file.path !== filePath));
      setRecordingMessage(`「${result.name}」を削除しました。`);
    } catch (error) {
      setRecordingMessage(error instanceof Error ? error.message : "録画ファイルを削除できませんでした。");
    } finally {
      setDeletingRecordingPath(null);
    }
  }

  async function checkForAppUpdates() {
    if (!window.kickRecorder) {
      setUpdateStatus(prev => ({ ...prev, status: "error", message: "更新確認はWindowsデスクトップ版で利用できます。" }));
      return;
    }
    setIsCheckingUpdates(true);
    try {
      const status = await window.kickRecorder.checkForUpdates();
      setUpdateStatus(status);
    } catch (error) {
      setUpdateStatus(prev => ({
        ...prev,
        status: "error",
        message: error instanceof Error ? error.message : "更新を確認できませんでした。"
      }));
    } finally {
      setIsCheckingUpdates(false);
    }
  }

  async function startCommentVideoGeneration() {
    if (!window.kickRecorder) return;
    if (!selectedCommentVideoPath || selectedCommentLogPaths.length === 0) {
      setCommentVideoEvent({ status: "error", percent: 0, message: "元動画とコメントファイルの両方を選択してください。" });
      return;
    }
    setCommentVideoBusy(true);
    setCommentVideoOutputPath("");
    setCommentVideoEvent({ status: "starting", percent: 0, message: "コメント付き動画の生成を準備しています。" });
    try {
      const result = await window.kickRecorder.startCommentVideo({
        videoPath: selectedCommentVideoPath, chatPaths: selectedCommentLogPaths, delaySeconds: commentVideoDelay,
        position: commentVideoPosition,
        fontFamily: commentVideoFontFamily, fontSize: commentVideoFontSize, displaySeconds: commentVideoDuration,
        speedPercent: commentVideoSpeed, rowLimit: commentVideoRows, collisionGap: commentVideoGap,
        opacity: commentVideoOpacity, quality: commentVideoQuality, showUsername: commentVideoShowUsername
      });
      setCommentVideoOutputPath(result.outputPath);
    } catch (error) {
      setCommentVideoBusy(false);
      setCommentVideoEvent({ status: "error", percent: 0, message: error instanceof Error ? error.message : "コメント付き動画を開始できませんでした。" });
    }
  }

  async function stopCommentVideoGeneration() {
    if (!window.kickRecorder) return;
    try { await window.kickRecorder.stopCommentVideo(); }
    catch (error) {
      setCommentVideoBusy(false);
      setCommentVideoEvent({ status: "error", percent: 0, message: error instanceof Error ? error.message : "生成を停止できませんでした。" });
    }
  }

  async function installAppUpdate() {
    if (!window.kickRecorder) return;
    try {
      await window.kickRecorder.installUpdate();
    } catch (error) {
      setUpdateStatus(prev => ({
        ...prev,
        status: "error",
        message: error instanceof Error ? error.message : "更新を適用できませんでした。"
      }));
    }
  }

  async function saveAiArticleApiKey() {
    if (!window.kickRecorder || !aiArticleApiKey.trim()) return;
    setAiArticleBusy(true);
    setAiArticleMessage("");
    try {
      await window.kickRecorder.saveAiArticleKey(aiArticleApiKey.trim());
      setAiArticleApiKey("");
      const status = await window.kickRecorder.getAiArticleStatus();
      setAiArticleStatus(status);
      setAiArticleMessage("OpenAI APIキーをWindowsの暗号化ストレージへ保存しました。");
    } catch (error) {
      setAiArticleMessage(error instanceof Error ? error.message : "APIキーを保存できませんでした。");
    } finally { setAiArticleBusy(false); }
  }

  async function testAiArticleConnection() {
    if (!window.kickRecorder) return;
    setAiArticleBusy(true);
    setAiArticleMessage("");
    try {
      const result = await window.kickRecorder.testAiArticleConnection(settings.aiArticleModel);
      setAiArticleMessage(result.message);
    } catch (error) {
      setAiArticleMessage(error instanceof Error ? error.message : "OpenAI APIへ接続できませんでした。");
    } finally { setAiArticleBusy(false); }
  }

  async function clearAiArticleApiKey() {
    if (!window.kickRecorder) return;
    setAiArticleBusy(true);
    setAiArticleMessage("");
    try {
      await window.kickRecorder.clearAiArticleKey();
      setAiArticleStatus(previous => ({ ...previous, configured: false }));
      setAiArticleMessage("保存済みAPIキーを削除しました。AI記事の自動更新には新しいキーが必要です。");
    } catch (error) {
      setAiArticleMessage(error instanceof Error ? error.message : "APIキーを削除できませんでした。");
    } finally { setAiArticleBusy(false); }
  }

  async function startManualLiveArticle() {
    if (!window.kickRecorder || !manualLiveArticleInput.trim()) return;
    setManualLiveArticleBusy(true);
    setArticleMessage("");
    try {
      const result = await window.kickRecorder.startManualLiveArticle(manualLiveArticleInput.trim());
      setManualLiveArticleSlug(result.slug);
      setManualLiveArticleInput("");
      setArticleMessage(`未登録チャンネル「${result.slug}」の記事専用LIVEを開始しました。録画は行いません。`);
      setStreamArticles(await window.kickRecorder.listStreamArticles());
    } catch (error) {
      setArticleMessage(error instanceof Error ? error.message : "記事専用LIVEを開始できませんでした。");
    } finally {
      setManualLiveArticleBusy(false);
    }
  }

  async function stopManualLiveArticle() {
    if (!window.kickRecorder || !manualLiveArticleSlug) return;
    setManualLiveArticleBusy(true);
    setArticleMessage("");
    try {
      const result = await window.kickRecorder.stopManualLiveArticle();
      setManualLiveArticleSlug("");
      setArticleMessage(`「${result.slug}」の記事を保存し、記事専用LIVEを終了しました。`);
      setStreamArticles(await window.kickRecorder.listStreamArticles());
    } catch (error) {
      setArticleMessage(error instanceof Error ? error.message : "記事専用LIVEを停止できませんでした。");
    } finally {
      setManualLiveArticleBusy(false);
    }
  }

  async function createStreamArticle() {
    if (!window.kickRecorder || !articleVideoPath || !articleSlug) return;
    setArticleBusy(true);
    setArticleMessage("");
    try {
      const channel = [...channels, ...recordingOnlyChannels].find(item => item.name.toLowerCase() === articleSlug.toLowerCase());
      const logs = commentLogFiles.filter(file => file.channelSlug.toLowerCase() === articleSlug.toLowerCase()).map(file => file.path);
      const article = await window.kickRecorder.generateStreamArticle({
        videoPath: articleVideoPath,
        slug: articleSlug,
        displayName: channel?.name ?? articleSlug,
        headline: articleHeadline.trim() || undefined,
        chatPaths: logs
      });
      const updated = await window.kickRecorder.listStreamArticles();
      setStreamArticles(updated);
      setArticleMessage(article.aiGenerated
        ? `AI記事「${article.headline}」を保存しました。コメント${article.commentCount.toLocaleString("ja-JP")}件${article.videoAnalyzed ? `・映像フレーム${article.videoFrameCount ?? 0}枚` : ""}を分析しました。`
        : article.aiError ? `基本記事を保存しました。AI分析は未完了です：${article.aiError}`
        : `記事「${article.headline}」を保存しました。コメント${article.commentCount.toLocaleString("ja-JP")}件を集計しました。`);
      setArticleHeadline("");
    } catch (error) {
      setArticleMessage(error instanceof Error ? error.message : "記事の生成に失敗しました。");
    } finally {
      setArticleBusy(false);
    }
  }

  async function deleteStreamArticle(article: StreamArticle) {
    if (!window.kickRecorder || article.status === "live" || deletingArticleId) return;
    const confirmed = window.confirm(
      `「${article.headline}」を削除しますか？\\n\\n記事データのみ削除します。元動画とコメントログは削除されません。`
    );
    if (!confirmed) return;
    setDeletingArticleId(article.id);
    setArticleMessage("");
    try {
      await window.kickRecorder.deleteStreamArticle(article.slug, article.id);
      setStreamArticles(current => current.filter(item => item.id !== article.id || item.slug !== article.slug));
      setArticleMessage(`記事「${article.headline}」を削除しました。元動画とコメントログは保持されています。`);
    } catch (error) {
      setArticleMessage(error instanceof Error ? error.message : "記事を削除できませんでした。");
    } finally {
      setDeletingArticleId(null);
    }
  }

  async function chooseOutputDirectory() {
    if (!window.kickRecorder) return;
    try {
      const directory = await window.kickRecorder.selectOutputDirectory();
      if (directory) setSettings(prev => ({ ...prev, outputDirectory: directory }));
    } catch {
      setStorageError("保存先フォルダーを選択できませんでした。");
    }
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">K</div><div><strong>Kick Live Message Recorder</strong><small>配信映像・チャット記録</small></div></div>
      <div className="nav-label">メインメニュー</div>
      <button className={tab === "dashboard" ? "nav-item selected" : "nav-item"} onClick={() => setTab("dashboard")}>▦ <span>ダッシュボード</span></button>
      <button className={tab === "recording" ? "nav-item selected" : "nav-item"} onClick={() => setTab("recording")}>● <span>録画専用</span></button>
      <button className={tab === "library" ? "nav-item selected" : "nav-item"} onClick={() => setTab("library")}>▤ <span>録画ライブラリ</span></button>
      <button className={tab === "comment-video" ? "nav-item selected" : "nav-item"} onClick={() => setTab("comment-video")}>✦ <span>コメント付き動画</span></button>\n      <button className={tab === "articles" ? "nav-item selected" : "nav-item"} onClick={() => setTab("articles")}>▤ <span>配信記事</span></button>
      <div className="nav-label">アプリ</div>
      <button className={tab === "updates" ? "nav-item selected" : "nav-item"} onClick={() => setTab("updates")}>↻ <span>バージョン更新</span></button>
      <button className={tab === "settings" ? "nav-item selected" : "nav-item"} onClick={() => setTab("settings")}>⚙ <span>設定</span></button>
      <div className="sidebar-bottom"><span className="status-dot" /> β版・開発テスト中<small>現在のバージョン {appVersion}</small></div>
    </aside>

    <main className="main">
      <header className="topbar">
        <div><span className="eyebrow">Kick 配信管理ツール</span><h1>{tab === "dashboard" ? "ダッシュボード" : tab === "recording" ? "録画専用" : tab === "library" ? "録画ライブラリ" : tab === "comment-video" ? "コメント付き動画を生成" : tab === "articles" ? "配信記事" : tab === "updates" ? "バージョン更新" : "設定"}</h1></div>
        <div className="top-actions"><span className="connection"><i /> {isDesktop ? "Windows デスクトップ版" : "ブラウザー版プレビュー"}</span><span className="beta-tag">β版</span><div className="avatar">KR</div></div>
      </header>

      {storageError && <div className="storage-error" role="alert">{storageError}</div>}

      {tab === "dashboard" && <>
        <section className="stats">
          <div className="stat-card"><span>登録チャンネル</span><strong>{channels.length.toString().padStart(2,"0")}</strong><small>監視対象</small></div>
          <div className="stat-card"><span>録画中</span><strong>{activeCount.toString().padStart(2,"0")}</strong><small>現在のセッション</small></div>
          <div className="stat-card"><span>保存済み録画</span><strong>{recordingFiles.length.toString().padStart(2,"0")}</strong><small>このPC内</small></div>
          <div className="stat-card accent"><span>現在のバージョン</span><strong className="version-value">{appVersion}</strong><small>{isReady ? "インストール済み" : "起動情報を読み込み中"}</small></div>
        </section>

        {monitorSlugs.length > 0 && <section className="panel live-now-panel">
          <div className="panel-heading">
            <div><h2>LIVE中の配信者</h2><p>配信情報を自動更新し、各カードから手動で録画を開始・停止できます</p></div>
            <span className="live-status live">LIVE · {liveChannelCards.length}件</span>
          </div>
          {!kickCredentialsConfigured
            ? <div className="empty-inline">配信者のLIVE情報を表示するには、設定画面でKick APIのClient IDとClient Secretを登録してください。</div>
            : !settings.autoMonitorEnabled
              ? <div className="empty-inline">自動監視は停止中です。設定画面で自動監視を有効にすると、LIVE情報が更新されます。</div>
              : liveChannelCards.length === 0
                ? <div className="empty-inline">{monitorError ? "LIVE情報を取得できませんでした。ネットワークとKick APIの設定を確認してください。" : "現在LIVE中の登録配信者はいません。配信を検知すると、ここにタイトルや開始時刻などが表示されます。"}</div>
                : <div className="live-stream-grid">
                    {liveChannelCards.map(({ channel, live, isRecordingOnly }) => <article className="live-stream-card" key={channel.name.toLowerCase()}>
                      <div className="live-stream-header">
                        {live.profilePicture
                          ? <img className="live-stream-avatar" src={live.profilePicture} alt="" />
                          : <div className="live-stream-avatar live-stream-avatar-fallback">{channel.name.slice(0, 1).toUpperCase()}</div>}
                        <div className="live-stream-identity">
                          <strong>{live.displayName || channel.name}</strong>
                          <small>@{channel.name}</small>
                        </div>
                        <span className="live-status live"><i /> LIVE</span>
                      </div>
                      <div className="live-stream-title">{live.streamTitle || "配信タイトル未設定"}</div>
                      {live.categoryName && <div className="live-stream-category">{live.categoryName}</div>}
                      <div className="live-stream-meta">
                        <div><small>配信開始</small><strong>{formatLiveStartTime(live.startedAt)}</strong></div>
                        <div><small>配信時間</small><strong className="live-elapsed">{formatLiveElapsed(live.startedAt, liveClock)}</strong></div>
                        <div><small>視聴者数</small><strong>{live.viewerCount.toLocaleString("ja-JP")} 人</strong></div>
                      </div>
                      <div className="live-stream-actions">
                        <span className={channel.recording ? "live-recording-indicator is-recording" : "live-recording-indicator"}>
                          <i />{channel.recording ? "録画中" : "録画停止中"}
                        </span>
                        <button
                          className={channel.recording ? "live-recording-button is-recording" : "live-recording-button"}
                          onClick={() => void toggleRecording(channel.name, channel.recording)}
                          disabled={!isDesktop || Boolean(recordingRequests[channel.name.toLowerCase()])}
                        >
                          {recordingRequests[channel.name.toLowerCase()]
                            ? "処理中..."
                            : channel.recording ? "録画停止" : "手動で録画開始"}
                        </button>
                      </div>
                      <div className="live-stream-footer"><span>https://kick.com/{channel.name}</span><span>{isRecordingOnly ? "録画専用・監視中" : "監視中"}</span></div>
                    </article>)}
                  </div>}
          <div className="live-now-footer">
            <span>{lastChannelCheck ? "最終確認：" + lastChannelCheck : "配信状態を確認中..."}</span>
            {monitorError && <span className="monitor-error">{monitorError}</span>}
          </div>
        </section>}

        {settings.showRecordingPreview && activeRecordingChannels.length > 0 && <section className="panel live-preview-panel">
          <div className="panel-heading">
            <div><h2>録画中の映像プレビュー</h2><p>Kick公式プレーヤーで現在録画している配信を表示します</p></div>
            <span className="live-status live">● LIVE · {activeRecordingChannels.length}件</span>
          </div>
          <div className="live-preview-frame">
            <iframe
              key={previewChannel?.name.toLowerCase()}
              src={previewChannel ? `https://player.kick.com/${encodeURIComponent(previewChannel.name)}?autoplay=true&muted=true` : "about:blank"}
              title={previewChannel ? `${previewChannel.name} のライブ映像` : "録画中の映像"}
              allow="autoplay; fullscreen; picture-in-picture"
              allowFullScreen
              loading="eager"
            />
          </div>
          <div className="live-preview-footer">
            <strong>{previewChannel?.name}</strong>
            <span>音声はミュート状態で開始します。プレーヤー内の音量ボタンから変更できます。</span>
            {activeRecordingChannels.length > 1 && <label>表示チャンネル
              <select value={previewChannel?.name ?? ""} onChange={event => {
                const selected = activeRecordingChannels.find(channel => channel.name === event.target.value);
                if (selected) setPreviewSelection(selected.name);
              }}>
                {activeRecordingChannels.map(channel => <option key={channel.name} value={channel.name}>{channel.name}</option>)}
              </select>
            </label>}
          </div>
        </section>}

        <section className="panel">
          <div className="panel-heading"><div><h2>チャンネル管理</h2><p>録画・監視したいKickチャンネルを登録</p></div><div className="panel-heading-actions"><span className="count-pill">登録数：{channels.length}件</span><button className="small-action refresh-button" onClick={() => void refreshChannelStatuses()} disabled={!isDesktop || isCheckingChannels || monitorSlugs.length === 0}>{isCheckingChannels ? "確認中..." : "配信状態を更新"}</button></div></div>
          <div className="add-channel">
            <input value={newChannel} onChange={e => setNewChannel(e.target.value)} onKeyDown={e => e.key === "Enter" && addChannel()} placeholder="チャンネル名 または kick.com のURL" aria-label="Kickチャンネル名またはURL" />
            <button onClick={addChannel}>＋ 追加する</button>
          </div>
          <div className="channel-list">
            {channels.length === 0 && <div className="empty-inline">まだチャンネルが登録されていません。</div>}
            {channels.map(c => <div className="channel-row" key={c.id}>
              <div className="channel-icon">{c.name.slice(0,1).toUpperCase()}</div>
              <div className="channel-info"><strong>{c.name}</strong><small>{c.url}</small></div>
              <span className="mode-tag">{c.mode === "auto" ? "自動録画" : "手動録画"}</span>
              <span className={channelChecks[c.name.toLowerCase()]?.found
                ? (channelChecks[c.name.toLowerCase()].isLive ? "live-status live" : "live-status offline")
                : (channelChecks[c.name.toLowerCase()] ? "live-status missing" : "live-status unknown")}>
                {channelChecks[c.name.toLowerCase()]?.found
                  ? (channelChecks[c.name.toLowerCase()].isLive ? `配信中 · ${channelChecks[c.name.toLowerCase()].viewerCount.toLocaleString("ja-JP")}人` : "オフライン")
                  : (channelChecks[c.name.toLowerCase()] ? "チャンネル未検出" : "未確認")}
              </span>
              <button className="small-action" onClick={() => setChannels(prev => prev.map(x => x.id === c.id ? {...x, mode: x.mode === "auto" ? "manual" : "auto"} : x))}>方式：{c.mode === "auto" ? "自動" : "手動"}</button>
              <button className="primary-small recording-action" onClick={() => void toggleRecording(c.name, c.recording)} disabled={!isDesktop || Boolean(recordingRequests[c.name.toLowerCase()])}>
                {recordingRequests[c.name.toLowerCase()] ? "処理中..." : c.recording ? "録画停止" : "録画開始"}
              </button>
              <button className="remove" aria-label={`${c.name}を削除`} onClick={() => setChannels(prev => prev.filter(x => x.id !== c.id))}>×</button>
            </div>)}
          </div>
          <div className="notice">この一覧は配信監視・自動録画・チャット取得の対象です。録画だけ行いたいチャンネルは左メニューの「録画専用」に登録してください。{lastChannelCheck && ` 最終確認：${lastChannelCheck}`}</div>
          {recordingMessage && <div className="api-message" role="status">{recordingMessage}</div>}
        </section>

        <section className="panel lower-panel">
          <div className="panel-heading"><div><h2>最近の録画</h2><p>通常チャンネル・録画専用の録画ファイル</p></div><button className="text-button" onClick={() => setTab("library")}>すべて見る →</button></div>
          {isLoadingRecordings
            ? <div className="empty-state"><strong>最近の録画を読み込み中...</strong></div>
            : recordingFiles.length === 0
              ? <div className="empty-state"><div className="empty-icon">▣</div><strong>録画はまだありません</strong><span>チャンネル一覧から録画を開始すると、ここに表示されます。</span></div>
              : <div className="recording-library-list">
                  {recordingFiles.slice(0, 3).map(file => <div className="recording-file-row" key={file.path}>
                    <div className="recording-file-icon">▶</div>
                    <div className="recording-file-info">
                      <strong>{file.name}</strong>
                      <small>{new Date(file.modifiedAt).toLocaleString("ja-JP")} ・ {file.extension} ・ {(file.size / (1024 * 1024)).toFixed(1)} MB</small>
                    </div>
                    <button className="primary-small" onClick={() => void openRecordingFile(file.path)}>再生</button>
                    <button className="small-action" onClick={() => void revealRecordingFile(file.path)}>保存先を表示</button>
                  </div>)}
                </div>}
        </section>
      </>}

      {tab === "recording" && <section className="panel">
        <div className="panel-heading">
          <div><h2>録画専用チャンネル</h2><p>配信監視・自動録画は行わず、必要なときに録画を開始するチャンネルを登録します</p></div>
          <span className="count-pill">登録数：{recordingOnlyChannels.length}件</span>
        </div>
        {settings.showRecordingPreview && activeRecordingChannels.length > 0 && <section className="panel live-preview-panel">
          <div className="panel-heading">
            <div><h2>録画中の映像プレビュー</h2><p>Kick公式プレーヤーで現在録画している配信を表示します</p></div>
            <span className="live-status live">● LIVE · {activeRecordingChannels.length}件</span>
          </div>
          <div className="live-preview-frame">
            <iframe
              key={previewChannel?.name.toLowerCase()}
              src={previewChannel ? `https://player.kick.com/${encodeURIComponent(previewChannel.name)}?autoplay=true&muted=true` : "about:blank"}
              title={previewChannel ? `${previewChannel.name} のライブ映像` : "録画中の映像"}
              allow="autoplay; fullscreen; picture-in-picture"
              allowFullScreen
              loading="eager"
            />
          </div>
          <div className="live-preview-footer">
            <strong>{previewChannel?.name}</strong>
            <span>音声はミュート状態で開始します。プレーヤー内の音量ボタンから変更できます。</span>
            {activeRecordingChannels.length > 1 && <label>表示チャンネル
              <select value={previewChannel?.name ?? ""} onChange={event => {
                const selected = activeRecordingChannels.find(channel => channel.name === event.target.value);
                if (selected) setPreviewSelection(selected.name);
              }}>
                {activeRecordingChannels.map(channel => <option key={channel.name} value={channel.name}>{channel.name}</option>)}
              </select>
            </label>}
          </div>
        </section>}
                <section className="panel vod-download-panel">
          <div className="panel-heading"><div><h2>過去の配信（VOD）を録画・コメント取得</h2><p>KickのVideosページから過去配信のURLをコピーして貼り付けます</p></div></div>
          <div className="add-channel">
            <input value={vodUrl} onChange={event => setVodUrl(event.target.value)} placeholder="https://kick.com/channel/videos/動画ID" aria-label="Kick過去配信URL" />
            <button className="primary-small" onClick={() => void downloadPastBroadcast()} disabled={!isDesktop || vodDownloadActive}>過去配信をダウンロード</button>
            {vodDownloadActive && <button className="remove" onClick={() => void stopPastBroadcastDownload()}>動画停止</button>}
          </div>
          {vodDownloadStatus && <div className="api-message" role="status">{vodDownloadStatus}</div>}
          <div className="add-channel vod-chat-actions">
            <button className="primary-small" onClick={() => void downloadPastBroadcastChat()} disabled={!isDesktop || vodChatActive}>過去配信のコメントを取得（JSONL・TXT）</button>
            {vodChatActive && <button className="remove" onClick={() => void stopPastBroadcastChat()}>コメント取得を停止</button>}
          </div>
          {vodChatStatus && <div className="api-message" role="status">{vodChatStatus}</div>}
          <div className="notice">公開状態で取得可能なVODが対象です。コメントは配信開始からの経過時刻・投稿者名・本文を保持し、ChatフォルダーにJSONLとTXTで保存します。Kick側の非公開設定やアクセス制限、API仕様変更により取得できない場合があります。</div>
        </section>
        <div className="setting-row">
          <div><strong>録画専用チャンネルの録画・コメント取得</strong><small>チャンネル一覧の「録画＋コメント取得」から映像とコメントを同時に開始できます。ONならアプリ起動時もコメントへ自動接続します。</small></div>
          <label className="setting-control"><input type="checkbox" checked={settings.autoReceiveChatForRecordingOnly} onChange={event => setSettings(previous => ({ ...previous, autoReceiveChatForRecordingOnly: event.target.checked }))} /><span>{settings.autoReceiveChatForRecordingOnly ? "コメント自動接続：有効" : "コメント自動接続：無効"}</span></label>
        </div>
        <div className="add-channel">
          <input value={newRecordingOnlyChannel} onChange={event => setNewRecordingOnlyChannel(event.target.value)} onKeyDown={event => event.key === "Enter" && addRecordingOnlyChannel()} placeholder="録画したいKickチャンネル名 または URL" aria-label="録画専用Kickチャンネル名" />
          <button onClick={addRecordingOnlyChannel}>＋ 録画専用に追加</button>
        </div>
        <div className="channel-list">
          {recordingOnlyChannels.length === 0 && <div className="empty-inline">録画専用チャンネルはまだ登録されていません。チャンネルを追加すると、録画専用のコメント自動取得設定に従ってコメントを取得できます。</div>}
          {recordingOnlyChannels.map(channel => <div className="channel-row" key={channel.id}>
            <div className="channel-icon">{channel.name.slice(0,1).toUpperCase()}</div>
            <div className="channel-info"><strong>{channel.name}</strong><small>{channel.url}</small></div>
            <span className="mode-tag">{settings.autoReceiveChatForRecordingOnly ? "コメント自動取得ON" : "コメント取得OFF"}</span>
            <span className={channel.recording ? "live-status live" : "live-status unknown"}>{channel.recording ? "録画中" : "録画待機"}</span>
            <button className="primary-small recording-action combined-recording-action" onClick={() => void toggleRecordingWithChat(channel.name, channel.recording)} disabled={!isDesktop || Boolean(recordingRequests[channel.name.toLowerCase()])}>
              {recordingRequests[channel.name.toLowerCase()] ? "処理中..." : channel.recording ? "録画停止" : "録画＋コメント取得"}
            </button>
            <button className="remove" aria-label={`${channel.name}を録画専用一覧から削除`} onClick={() => setRecordingOnlyChannels(previous => previous.filter(item => item.id !== channel.id))}>×</button>
          </div>)}
        </div>
        {recordingMessage && <div className="api-message" role="status">{recordingMessage}</div>}
        <div className="notice">この一覧は手動開始専用です。各チャンネルの「録画＋コメント取得」を押すと映像録画とコメント受信を同時に開始し、コメント自動接続も有効になります。録画停止後もコメント取得は設定に従って継続します。</div>
        <div className="chat-preview">
          <div className="chat-preview-heading"><strong>録画専用チャンネルの最近のコメント</strong><span>{recordingOnlyMessages.length}件</span></div>
          {recordingOnlyMessages.length === 0
            ? <div className="empty-inline">{settings.autoReceiveChatForRecordingOnly ? "コメントを待っています。チャンネルの配信中にコメントが投稿されると、ここに表示されます。" : "コメント自動取得は停止中です。"}</div>
            : <div className="chat-preview-list">
                {recordingOnlyMessages.slice(0, 20).map(message => <div className="chat-preview-item" key={message.eventId}>
                  <div className="chat-preview-meta"><strong>{message.senderUsername}</strong><span>#{message.channelSlug}</span><time>{new Date(message.createdAt).toLocaleTimeString("ja-JP")}</time></div>
                  <div className="chat-preview-content">{message.content}</div>
                </div>)}
              </div>}
        </div>
        <p className="data-path-note">保存先：{settings.outputDirectory || "アプリ既定のビデオフォルダー"}</p>
        {!isDesktop && <div className="notice">録画機能はWindowsデスクトップ版で利用できます。</div>}
      </section>}

      {tab === "library" && <section className="panel">
        <div className="panel-heading">
          <div><h2>録画ライブラリ</h2><p>このPCに保存されたKick配信映像</p></div>
          <button className="small-action" onClick={() => setLibraryRefreshKey(value => value + 1)} disabled={!isDesktop || isLoadingRecordings || deletingRecordingPath !== null}>一覧を更新</button>
        </div>
        {recordingMessage && <div className="api-message" role="status">{recordingMessage}</div>}
        {!isDesktop
          ? <div className="empty-state"><div className="empty-icon">▤</div><strong>Windowsデスクトップ版で利用できます</strong><span>ブラウザープレビューではPC内の録画ファイルを読み取れません。</span></div>
          : isLoadingRecordings
            ? <div className="empty-state"><strong>録画一覧を読み込み中...</strong></div>
            : recordingFiles.length === 0
              ? <div className="empty-state"><div className="empty-icon">▤</div><strong>保存された録画はありません</strong><span>ダッシュボードで配信を録画すると、ここに表示されます。</span></div>
              : <div className="recording-library-list">
                  {recordingFiles.map(file => <div className="recording-file-row" key={file.path}>
                    <div className="recording-file-icon">▶</div>
                    <div className="recording-file-info">
                      <strong>{file.name}</strong>
                      <small>{new Date(file.modifiedAt).toLocaleString("ja-JP")} ・ {file.extension} ・ {(file.size / (1024 * 1024)).toFixed(1)} MB</small>
                    </div>
                    <button className="primary-small" onClick={() => void openRecordingFile(file.path)}>再生</button>
                    <button className="small-action" onClick={() => void revealRecordingFile(file.path)}>保存先を表示</button>
                    <button className="danger-small" onClick={() => void deleteRecordingFromLibrary(file.path, file.name)} disabled={deletingRecordingPath !== null}>
                      {deletingRecordingPath === file.path ? "削除中..." : "削除"}
                    </button>
                  </div>)}
                </div>}
        <div className="data-path-note">保存先：{settings.outputDirectory || "アプリ既定のビデオフォルダー"}</div>
      </section>}

      {tab === "comment-video" && <section className="panel comment-video-panel">
        <div className="panel-heading">
          <div><h2>コメント付き動画を生成</h2><p>NicoConvAssのコメント流し込みと、HandBrakeの画質設定を参考にした動画合成</p></div>
          <button className="small-action" onClick={() => setLibraryRefreshKey(value => value + 1)} disabled={!isDesktop || commentVideoBusy || isLoadingRecordings || isLoadingCommentLogs}>一覧を更新</button>
        </div>
        {!isDesktop
          ? <div className="empty-state"><div className="empty-icon">✦</div><strong>Windowsデスクトップ版で利用できます</strong><span>ブラウザープレビューでは動画ファイルの読み書きやエンコードを実行できません。</span></div>
          : <>
            <div className="comment-video-intro">ニコ生風の白文字・太い黒フチでコメントを右から左へ流します。長文も短文と同じ画面上の速度で移動し、同じ行ではコメント同士が追いつかないよう間隔を計算します。元動画は変更せず、CommentVideosフォルダーへ別ファイルとして保存します。</div>
            <div className="comment-video-form-grid">
              <label className="comment-video-field"><span>元動画</span>
                <select value={selectedCommentVideoPath} onChange={event => setSelectedCommentVideoPath(event.target.value)} disabled={commentVideoBusy || isLoadingRecordings}>
                  <option value="">動画を選択してください</option>
                  {recordingFiles.map(file => <option key={file.path} value={file.path}>{file.name} ・ {(file.size / (1024 * 1024)).toFixed(1)} MB</option>)}
                </select>
                {recordingFiles.length === 0 && <small>録画ライブラリに動画がありません。先に配信を録画してください。</small>}
              </label>
              <div className="comment-video-field comment-video-log-field"><span>コメントファイル（複数選択可）</span>
                <div className="comment-video-log-count">選択中：{selectedCommentLogPaths.length}／最大31ファイル</div>
                <div className="comment-video-log-list" role="group" aria-label="コメントファイルの複数選択">
                  {commentLogFiles.map(file => <label className="comment-video-log-option" key={file.path}>
                    <input type="checkbox" checked={selectedCommentLogPaths.includes(file.path)} onChange={event => setSelectedCommentLogPaths(previous => event.target.checked ? [...previous, file.path] : previous.filter(path => path !== file.path))} disabled={commentVideoBusy || isLoadingCommentLogs || (!selectedCommentLogPaths.includes(file.path) && selectedCommentLogPaths.length >= 31)} />
                    <span><strong>{file.channelSlug} ・ {file.kind}</strong><small>{file.name} ・ {(file.size / (1024 * 1024)).toFixed(2)} MB</small></span>
                  </label>)}
                  {isLoadingCommentLogs && <small>コメントファイルを読み込み中...</small>}
                  {!isLoadingCommentLogs && commentLogFiles.length === 0 && <small>ChatフォルダーにJSONLがありません。コメント保存を有効にして配信コメントを取得してください。</small>}
                </div>
                <small>LIVE配信が日付をまたいだ場合は、同じチャンネルの複数日分ログを選択してください。異なるチャンネルやLIVE／VODの混在はできません。VODログは1ファイルずつ生成します。</small>
              </div>
            </div>
            <div className="settings-subsection">
              <div className="settings-subheading"><h3>コメント表示設定</h3><span className="api-state connected">ASS字幕合成</span></div>
              <div className="comment-video-settings-grid">
                <label className="comment-video-field"><span>同期ずれ（秒）</span><input type="number" min="-300" max="300" step="0.1" value={commentVideoDelay} onChange={event => setCommentVideoDelay(Number(event.target.value))} disabled={commentVideoBusy} /><small>＋はコメントを遅らせ、－は早めます。</small></label>
                <label className="comment-video-field"><span>コメントの表示位置</span><select value={commentVideoPosition} onChange={event => setCommentVideoPosition(event.target.value as "scroll" | "top" | "bottom" | "command")} disabled={commentVideoBusy}><option value="scroll">すべて中央スクロール（naka）</option><option value="top">すべて上部固定（ue）</option><option value="bottom">すべて下部固定（shita）</option><option value="command">コメントごとの指定を優先（ue・naka・shita）</option></select><small>「コメントごとの指定」ではログのmail／commands／positionを読み取ります。本文先頭に @ue・/naka・[shita] を付けた場合も位置指定として扱い、表示時に指定文字を除去します。指定がないコメントは中央スクロールです。</small></label>
                <label className="comment-video-field"><span>フォント</span><select value={commentVideoFontFamily} onChange={event => setCommentVideoFontFamily(event.target.value as "ms-pgothic" | "meiryo" | "yu-gothic" | "arial")} disabled={commentVideoBusy}><option value="ms-pgothic">ＭＳ Ｐゴシック</option><option value="meiryo">メイリオ</option><option value="yu-gothic">游ゴシック</option><option value="arial">Arial</option></select><small>Windowsにインストールされているフォントを使用します。</small></label>
                <label className="comment-video-field"><span>文字サイズ</span><input type="number" min="16" max="80" value={commentVideoFontSize} onChange={event => setCommentVideoFontSize(Number(event.target.value))} disabled={commentVideoBusy} /><small>動画の解像度に合わせて調整します。</small></label>
                <label className="comment-video-field"><span>画面幅の横断時間（秒）</span><input type="number" min="2" max="15" value={commentVideoDuration} onChange={event => setCommentVideoDuration(Number(event.target.value))} disabled={commentVideoBusy} /><small>画面幅を横切る基準時間です。長いコメントは文字幅に応じて表示時間が長くなります。</small></label>
                <label className="comment-video-field"><span>流れる速度（%）</span><input type="number" min="50" max="200" step="5" value={commentVideoSpeed} onChange={event => setCommentVideoSpeed(Number(event.target.value))} disabled={commentVideoBusy} /><small>100%が標準。小さくするとゆっくり、大きくすると速く流れます。</small></label>
                <label className="comment-video-field"><span>最大表示行数</span><input type="number" min="1" max="20" value={commentVideoRows} onChange={event => setCommentVideoRows(Number(event.target.value))} disabled={commentVideoBusy} /><small>初期値14行。動画の高さと文字サイズに合わせて実際の表示可能行数は自動調整します。</small></label>
                <label className="comment-video-field"><span>コメント同士の最小間隔（px）</span><input type="number" min="0" max="200" step="4" value={commentVideoGap} onChange={event => setCommentVideoGap(Number(event.target.value))} disabled={commentVideoBusy} /><small>初期値24px。文字幅と移動速度から同じ行で重ならない間隔を確保します。</small></label>
                <label className="comment-video-field"><span>文字の不透明度（%）</span><input type="number" min="20" max="100" value={commentVideoOpacity} onChange={event => setCommentVideoOpacity(Number(event.target.value))} disabled={commentVideoBusy} /><small>100で不透明、低いほど透過します。</small></label>
                <label className="comment-video-field"><span>出力画質</span><select value={commentVideoQuality} onChange={event => setCommentVideoQuality(event.target.value as "high" | "standard" | "compact")} disabled={commentVideoBusy}><option value="high">高画質・大きめ</option><option value="standard">標準（おすすめ）</option><option value="compact">容量優先</option></select><small>利用可能なH.264エンコーダーを優先し、ない場合は互換形式へ切り替えます。</small></label>
              </div>
              <label className="comment-video-checkbox"><input type="checkbox" checked={commentVideoShowUsername} onChange={event => setCommentVideoShowUsername(event.target.checked)} disabled={commentVideoBusy} /><span>コメントに投稿者名も表示する</span></label>
            </div>
            <div
              className="comment-video-preview"
              key={[
                commentVideoFontFamily, commentVideoFontSize, commentVideoDuration,
                commentVideoSpeed, commentVideoRows, commentVideoGap, commentVideoOpacity,
                commentVideoShowUsername, commentVideoDelay, commentVideoPosition, selectedCommentVideoPath,
                selectedCommentLogPaths.join(","),
                commentVideoPreviewResult?.comments.map(comment => comment.content + comment.color).join("|")
              ].join(":")}
            >
              <div className="comment-video-preview-heading">
                <strong>コメント表示プレビュー</strong>
                <span className="comment-video-preview-live"><i />{commentVideoPreviewLoading ? "実際のログを解析中..." : commentVideoPreviewResult ? "実ログをプレビュー中" : "サンプル表示"}</span>
              </div>
              <div className="comment-video-preview-summary">
                {commentVideoPreviewLoading
                  ? "選択した動画とコメントログを確認しています..."
                  : commentVideoPreviewResult
                    ? "実コメント " + commentVideoPreviewResult.totalComments.toLocaleString("ja-JP") + "件中 " +
                      commentVideoPreviewResult.comments.length.toLocaleString("ja-JP") + "件をプレビュー ・ " +
                      commentVideoPreviewResult.width + "×" + commentVideoPreviewResult.height + " ・ " +
                      "動画内 " + Math.round(commentVideoPreviewResult.durationSeconds).toLocaleString("ja-JP") + "秒 ・ " +
                      "範囲外 " + commentVideoPreviewResult.outsideVideoCount.toLocaleString("ja-JP") + "件 ・ " +
                      "破損行 " + commentVideoPreviewResult.malformedLines.toLocaleString("ja-JP") + "件"
                    : commentVideoPreviewError
                      ? "実ログプレビューを利用できません：" + commentVideoPreviewError
                      : "動画とコメントログを選択すると、実際のコメント内容でプレビューします。"}
              </div>
              <div className="comment-video-preview-values">
                <span>{commentVideoFontFamily === "ms-pgothic" ? "ＭＳ Ｐゴシック" : commentVideoFontFamily === "yu-gothic" ? "游ゴシック" : commentVideoFontFamily === "arial" ? "Arial" : "メイリオ"}</span>
                <span>{Math.max(16, Math.min(80, commentVideoFontSize))}px</span>
                <span>{commentVideoPosition === "top" ? "全コメント上部固定" : commentVideoPosition === "bottom" ? "全コメント下部固定" : commentVideoPosition === "command" ? "コメント別位置指定" : "全コメント中央スクロール"}</span>
                <span>速度 {Math.max(50, Math.min(200, commentVideoSpeed))}%</span>
                <span>間隔 {Math.max(0, Math.min(200, commentVideoGap))}px</span>
                <span>表示 {Math.max(1, Math.min(20, commentVideoRows, Math.floor((1080 - 26 - Math.max(16, Math.min(80, commentVideoFontSize))) / Math.max(1, Math.max(commentVideoFontSize + 12, commentVideoFontSize * 1.55))) + 1))}行 / 上限 {Math.max(1, Math.min(20, commentVideoRows))}行</span>
              </div>
              <div className="comment-video-preview-screen" aria-label="設定をリアルタイム反映するコメント表示プレビュー">
                {(commentVideoPreviewResult?.comments.length
                  ? commentVideoPreviewResult.comments.map((comment, index) => {
                      const fontSize = Math.max(16, Math.min(80, commentVideoFontSize));
                      const lineHeight = Math.max(fontSize + 12, fontSize * 1.55);
                      const visibleRows = Math.max(1, Math.floor((1080 - 26 - fontSize) / lineHeight) + 1);
                      const gap = Math.max(0, Math.min(200, commentVideoGap));
                      const fixedRows = Math.max(1, Math.min(20, commentVideoRows, Math.floor((1080 * 0.28 + gap) / Math.max(1, lineHeight + gap))));
                      const position = commentVideoPosition === "command"
                        ? comment.position ?? "scroll"
                        : commentVideoPosition;
                      const laneCount = position === "scroll"
                        ? Math.max(1, Math.min(20, commentVideoRows, visibleRows))
                        : fixedRows;
                      return {
                        text: commentVideoShowUsername && comment.username ? comment.username + " : " + comment.content : comment.content,
                        color: "#ffffff",
                        position,
                        lane: index % laneCount,
                        delay: position === "scroll" ? Math.floor(index / laneCount) * 0.9 + (index % 4) * 0.16 : 0,
                        repeatLane: index >= laneCount
                      };
                    })
                  : COMMENT_VIDEO_PREVIEW_ITEMS)
                  .filter((item, index, items) => {
                    const fontSize = Math.max(16, Math.min(80, commentVideoFontSize));
                    const lineHeight = Math.max(fontSize + 12, fontSize * 1.55);
                    const visibleRows = Math.max(1, Math.floor((1080 - 26 - fontSize) / lineHeight) + 1);
                    const gap = Math.max(0, Math.min(200, commentVideoGap));
                    const fixedRows = Math.max(1, Math.min(20, commentVideoRows, Math.floor((1080 * 0.28 + gap) / Math.max(1, lineHeight + gap))));
                    const position = item.position ?? (commentVideoPosition === "command" ? "scroll" : commentVideoPosition);
                    const allowedRows = position === "scroll"
                      ? Math.max(1, Math.min(20, commentVideoRows, visibleRows))
                      : fixedRows;
                    const positionIndex = items.slice(0, index).filter(previous => {
                      const previousPosition = previous.position ?? (commentVideoPosition === "command" ? "scroll" : commentVideoPosition);
                      return previousPosition === position;
                    }).length;
                    return position === "scroll" ? item.lane < allowedRows : positionIndex < allowedRows;
                  })
                  .map((item, index) => {
                  const fontSize = Math.max(16, Math.min(80, commentVideoFontSize));
                  const lineHeight = Math.max(fontSize + 12, fontSize * 1.55);
                  const previewVisibleRows = Math.max(1, Math.floor((1080 - 26 - fontSize) / lineHeight) + 1);
                  const gap = Math.max(0, Math.min(200, commentVideoGap));
                  const fixedRows = Math.max(1, Math.min(20, commentVideoRows, Math.floor((1080 * 0.28 + gap) / Math.max(1, lineHeight + gap))));
                  const itemPosition = item.position ?? (commentVideoPosition === "command" ? "scroll" : commentVideoPosition);
                  const laneCount = itemPosition === "scroll"
                    ? Math.max(1, Math.min(20, commentVideoRows, previewVisibleRows))
                    : fixedRows;
                  const laneProgress = item.lane / Math.max(1, laneCount - 1);
                  const top = itemPosition === "top"
                    ? 5 + laneProgress * 27
                    : itemPosition === "bottom"
                      ? 88 - laneProgress * 23
                      : 5 + laneProgress * 90;
                  const duration = Math.max(2, Math.min(15, commentVideoDuration));
                  const speed = Math.max(50, Math.min(200, commentVideoSpeed));
                  const estimatedTextWidth = Array.from(item.text).reduce((total, character) => total + fontSize * ((character.codePointAt(0) ?? 0) <= 0xff ? 0.58 : 1), 0);
                  const baseScrollSeconds = duration * 100 / speed;
                  const estimatedPixelsPerSecond = 1280 / baseScrollSeconds;
                  const commentScrollSeconds = (1280 + estimatedTextWidth + 32) / estimatedPixelsPerSecond;
                  const gapDelay = gap / Math.max(1, estimatedPixelsPerSecond);
                  return <span
                    className="comment-video-preview-comment"
                    key={index}
                    style={{
                      top: top + "%",
                      left: itemPosition === "scroll" ? "100%" : "50%",
                      transform: itemPosition === "scroll" ? undefined : "translateX(-50%)",
                      animationName: itemPosition === "scroll" ? "comment-video-preview-scroll" : "none",
                      maxWidth: itemPosition === "scroll" ? "none" : "92%",
                      overflow: itemPosition === "scroll" ? "visible" : "hidden",
                      textOverflow: itemPosition === "scroll" ? "clip" : "ellipsis",
                      textAlign: "center",
                      color: item.color,
                      opacity: Math.max(0.2, Math.min(1, commentVideoOpacity / 100)),
                      fontSize: Math.max(8, Math.round(fontSize / 3)) + "px",
                      fontFamily: commentVideoFontFamily === "ms-pgothic" ? '"ＭＳ Ｐゴシック", sans-serif'
                        : commentVideoFontFamily === "yu-gothic" ? '"游ゴシック", sans-serif'
                        : commentVideoFontFamily === "arial" ? "Arial, sans-serif" : 'Meiryo, "メイリオ", sans-serif',
                      animationDuration: (itemPosition === "scroll" ? commentScrollSeconds : duration) + "s",
                      animationDelay: (item.delay + (item.repeatLane ? gapDelay : 0)).toFixed(3) + "s"
                    }}
                  >{commentVideoPreviewResult?.comments.length ? item.text : commentVideoShowUsername ? "@viewer : " + item.text : item.text}</span>;
                })}
              </div>
              <small>ニコ生風に本文は白文字・黒フチで統一します。文字の長さにかかわらず移動速度をそろえ、長文は画面を出切るまでの時間を長くします。設定を変更するとプレビューもすぐに描き直します。</small>
            </div>
            {commentVideoEvent && <div className={commentVideoEvent.status === "error" ? "comment-video-status error" : "comment-video-status"} role="status">
              <div className="comment-video-status-line"><strong>{commentVideoEvent.message}</strong>{commentVideoBusy && <span>{Math.round(commentVideoEvent.percent)}%</span>}</div>
              {commentVideoBusy && <div className="comment-video-progress"><div style={{ width: Math.max(0, Math.min(100, commentVideoEvent.percent)).toString() + "%" }} /></div>}
              {commentVideoEvent.status === "completed" && <small>合成コメント：{(commentVideoEvent.generatedComments ?? 0).toLocaleString("ja-JP")}件 ・ 省略：{(commentVideoEvent.skippedComments ?? 0).toLocaleString("ja-JP")}件</small>}
            </div>}
            <div className="comment-video-actions">
              <button className="primary-small" onClick={() => void startCommentVideoGeneration()} disabled={commentVideoBusy || !selectedCommentVideoPath || selectedCommentLogPaths.length === 0 || isLoadingRecordings || isLoadingCommentLogs}>コメント付き動画を生成</button>
              {commentVideoBusy && <button className="remove" onClick={() => void stopCommentVideoGeneration()}>生成を停止</button>}
              {!commentVideoBusy && commentVideoEvent?.status === "completed" && commentVideoOutputPath && <button className="small-action" onClick={() => void revealRecordingFile(commentVideoOutputPath)}>生成ファイルの保存先を表示</button>}
            </div>
            <div className="notice">生成には動画の再エンコードが必要なため、動画の長さ・解像度・PC性能によって時間がかかります。元動画とコメントJSONLは削除・変更しません。</div>
          </>}
      </section>}

      {tab === "articles" && <section className="panel stream-articles-panel">
        <div className="panel-heading">
          <div><h2>登録配信者の放送記事</h2><p>録画とコメントログから配信ごとの記事を作成し、配信者別・日付順に保存します</p></div>
          <button className="small-action" onClick={() => setLibraryRefreshKey(value => value + 1)} disabled={!isDesktop || articleBusy}>一覧を更新</button>
        </div>
        {!isDesktop ? <div className="empty-state"><strong>Windowsデスクトップ版で利用できます</strong><span>録画ファイルとコメントログを読み込む必要があります。</span></div> : <>
          <div className="comment-video-intro">配信映像・音声・コメントを別々に解析し、AIが根拠を照合して新聞記事風に統合します。映像は最大8枚の代表フレーム、音声は45秒ごとの文字起こし、コメントは話題や視聴者の反応として扱います。LIVE中も記事を段階的に更新し、終了後に全体を整理します。音声認識にない発言や、静止画だけでは確認できない動きは推測しません。登録不要のチャンネルも録画せずにLIVE記事を生成できます。</div>
          <div className="settings-subsection manual-live-article-panel">
            <div className="settings-subheading"><h3>登録不要：LIVE記事だけ生成</h3><span className="api-state connected">録画なし</span></div>
            <p className="manual-live-article-description">チャンネル管理に登録していない配信者でも利用できます。Kickのチャンネル名またはURLを入力すると、LIVE映像・音声・コメントを解析して記事を自動更新します。録画ファイルは作成せず、通常のチャンネル登録・自動録画設定も変更しません。</p>
            <div className="comment-video-form-grid">
              <label className="comment-video-field"><span>Kickチャンネル名／URL</span><input value={manualLiveArticleInput} onChange={event => setManualLiveArticleInput(event.target.value)} placeholder="例：streamer_name または https://kick.com/streamer_name" disabled={manualLiveArticleBusy || Boolean(manualLiveArticleSlug)} /></label>
            </div>
            <div className="comment-video-actions">
              <button className="primary-small" onClick={() => void startManualLiveArticle()} disabled={manualLiveArticleBusy || Boolean(manualLiveArticleSlug) || !manualLiveArticleInput.trim()}>{manualLiveArticleBusy ? "LIVE情報を確認中..." : "登録せずにLIVE記事を開始"}</button>
              {manualLiveArticleSlug && <button className="remove" onClick={() => void stopManualLiveArticle()} disabled={manualLiveArticleBusy}>記事を保存して終了</button>}
              {manualLiveArticleSlug && <span className="comment-video-log-count">生成中：{manualLiveArticleSlug}</span>}
            </div>
            {manualLiveArticleSlug && liveArticleCaptureStatus?.slug === manualLiveArticleSlug && <div className={liveArticleCaptureStatus.status === "error" ? "comment-video-status error" : "comment-video-status"} role="status"><strong>{liveArticleCaptureStatus.message}</strong></div>}
            <div className="notice">LIVE映像は25秒間隔で代表フレームを抽出し、音声は45秒単位でWAV化してローカルASRへ渡します。録画ファイルは作成しません。音声文字起こしにはOllamaとQwen3-ASRモデルが必要です。LIVE終了時は音声認識キューを処理して記事を最終化します。この機能にはKick API Client ID／Secretの設定が必要です。</div>
          </div>
          <div className="settings-subsection ai-article-settings">
            <div className="settings-subheading"><h3>LIVE中のリアルタイムAI記事</h3><span className={settings.aiArticleProvider === "ollama" ? "api-state connected" : aiArticleStatus.configured ? "api-state connected" : "api-state"}>{settings.aiArticleProvider === "ollama" ? "無料ローカルAI" : aiArticleStatus.configured ? "APIキー設定済み" : "APIキー未設定"}</span></div>
            <label className="comment-video-checkbox"><input type="checkbox" checked={settings.aiArticleEnabled} onChange={event => setSettings(previous => ({ ...previous, aiArticleEnabled: event.target.checked }))} disabled={settings.aiArticleProvider === "openai" && !aiArticleStatus.configured} /><span>登録配信者のLIVEを自動でAI記事化する</span></label>
            <div className="comment-video-form-grid ai-article-form-grid">
              <label className="comment-video-field"><span>AIエンジン</span><select value={settings.aiArticleProvider} onChange={event => setSettings(previous => ({ ...previous, aiArticleProvider: event.target.value as "ollama" | "openai", aiArticleModel: event.target.value === "ollama" ? "qwen2.5vl:3b" : "gpt-6-luna" }))} disabled={aiArticleBusy}><option value="ollama">Ollama（無料・ローカルAI）</option><option value="openai">OpenAI API（有料）</option></select></label>
              {settings.aiArticleProvider === "ollama" ? <>
                <label className="comment-video-field"><span>Ollama接続URL</span><input type="url" value={settings.aiArticleOllamaUrl} onChange={event => setSettings(previous => ({ ...previous, aiArticleOllamaUrl: event.target.value }))} placeholder="http://127.0.0.1:11434" disabled={aiArticleBusy} /><small>通常はこの初期値のままで利用できます。</small></label>
                <label className="comment-video-field"><span>記事生成・映像解析モデル</span><input value={settings.aiArticleModel} onChange={event => setSettings(previous => ({ ...previous, aiArticleModel: event.target.value }))} placeholder="qwen2.5vl:3b" disabled={aiArticleBusy} /><small>映像解析対応モデル：qwen2.5vl:3b（初回は ollama pull qwen2.5vl:3b）。対応するVisionモデルを指定してください。</small></label>
                <label className="comment-video-checkbox"><input type="checkbox" checked={settings.aiArticleAudioEnabled} onChange={event => setSettings(previous => ({ ...previous, aiArticleAudioEnabled: event.target.checked }))} disabled={aiArticleBusy} /><span>音声を文字起こしして記事へ反映する（無料・ローカル）</span></label>
                <label className="comment-video-field"><span>音声認識モデル（Qwen3-ASR）</span><input value={settings.aiArticleAudioModel} onChange={event => setSettings(previous => ({ ...previous, aiArticleAudioModel: event.target.value }))} placeholder="frozenlab/qwen3-asr:0.6b" disabled={aiArticleBusy || !settings.aiArticleAudioEnabled} /><small>初回のみ PowerShell で <code>ollama pull frozenlab/qwen3-asr:0.6b</code> を実行してください（約1GB）。日本語を含む音声を45秒単位で認識します。qwen3a音声入力に対応したOllamaが必要です。</small></label>
              </> : <>
              <label className="comment-video-field"><span>OpenAI APIキー</span><input type="password" value={aiArticleApiKey} onChange={event => setAiArticleApiKey(event.target.value)} placeholder={aiArticleStatus.configured ? "保存済み（変更するときだけ入力）" : "sk-..."} autoComplete="new-password" disabled={aiArticleBusy || !aiArticleStatus.encryptionAvailable} /><small>キー自体は画面や設定ファイルへ保存せず、Windowsの暗号化ストレージへ保存します。</small></label>
              <label className="comment-video-field"><span>AIモデル</span><select value={settings.aiArticleModel} onChange={event => setSettings(previous => ({ ...previous, aiArticleModel: event.target.value }))} disabled={aiArticleBusy}><option value="gpt-6-luna">GPT-6 Luna（低コスト・推奨）</option><option value="gpt-6.1-terra">GPT-6.1 Terra</option><option value="gpt-6.1-sol">GPT-6.1 Sol</option></select></label>
              </>}
              <label className="comment-video-field"><span>AI記事の更新間隔</span><select value={settings.aiArticleIntervalSeconds} onChange={event => setSettings(previous => ({ ...previous, aiArticleIntervalSeconds: Number(event.target.value) }))}><option value={30}>30秒</option><option value={60}>1分</option><option value={120}>2分（推奨）</option><option value={300}>5分</option><option value={600}>10分</option></select></label>
            </div>
            <div className="comment-video-actions">
              {settings.aiArticleProvider === "openai" && <><button className="primary-small" onClick={() => void saveAiArticleApiKey()} disabled={aiArticleBusy || !aiArticleApiKey.trim() || !aiArticleStatus.encryptionAvailable}>APIキーを保存</button><button className="small-action" onClick={() => void clearAiArticleApiKey()} disabled={aiArticleBusy || !aiArticleStatus.configured}>APIキーを削除</button></>}
              <button className="small-action" onClick={() => void testAiArticleConnection()} disabled={aiArticleBusy}>{settings.aiArticleProvider === "ollama" ? "Ollama接続テスト" : "接続テスト"}</button>
            </div>
            {aiArticleMessage && <div className="api-message" role="status">{aiArticleMessage}</div>}
            <div className="notice">AI記事の自動更新をONにすると、通常のコメント自動取得設定がOFFでも記事用コメントを受信します。録画済み動画の手動記事生成は、自動LIVE記事のON／OFFとは独立してAI分析します。{settings.aiArticleProvider === "ollama" ? "映像・音声・コメントのデータは設定したOllamaへ送信され、ローカルOllamaを使う場合は外部AIサービスへ送信されません。記事生成・映像解析モデルと音声認識モデルは別々に動作し、初回は各モデルのダウンロードが必要です。PCのメモリ・CPU/GPUを使用します。" : "記事生成モデルには映像フレーム・コメント・配信情報と、利用可能な場合は音声文字起こしテキストをOpenAI APIへ送信します。API利用料が発生し、映像フレームも外部へ送信されるため、送信してよい録画だけを対象にしてください。音声の新規文字起こし処理はOllama利用時のみです。"}</div>
          </div>
          <div className="comment-video-form-grid">
            <label className="comment-video-field"><span>登録配信者</span><select value={articleSlug} onChange={event => setArticleSlug(event.target.value)}>
              <option value="">配信者を選択</option>
              {[...channels, ...recordingOnlyChannels].filter((item, index, all) => all.findIndex(other => other.name.toLowerCase() === item.name.toLowerCase()) === index).map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
            </select></label>
            <label className="comment-video-field"><span>対象の録画動画</span><select value={articleVideoPath} onChange={event => setArticleVideoPath(event.target.value)}>
              <option value="">動画を選択してください</option>
              {recordingFiles.filter(file => file.name.toLowerCase().startsWith((articleSlug || "").toLowerCase() + "_")).map(file => <option key={file.path} value={file.path}>{file.name}</option>)}
            </select></label>
            <label className="comment-video-field"><span>記事見出し（任意）</span><input value={articleHeadline} onChange={event => setArticleHeadline(event.target.value)} maxLength={160} placeholder="空欄なら配信者名から自動作成" /></label>
          </div>
          <div className="comment-video-actions"><button className="primary-small" onClick={() => void createStreamArticle()} disabled={articleBusy || !articleSlug || !articleVideoPath}>{articleBusy ? "映像・音声・コメントをAI分析中..." : settings.aiArticleProvider === "ollama" || aiArticleStatus.configured ? "3つの情報源からAI記事を生成" : "この配信の記事を生成"}</button><span className="comment-video-log-count">同じ配信者のコメントログ {commentLogFiles.filter(file => file.channelSlug.toLowerCase() === articleSlug.toLowerCase()).length}件を自動で参照</span></div>
          {articleMessage && <div className="api-message" role="status">{articleMessage}</div>}
          <div className="article-news-masthead">
            <div className="article-news-title">
              <span className="article-news-kicker">KICK LIVE JOURNAL / AI BROADCAST EDITION</span>
              <h2>配信AI新聞</h2>
              <p>映像・音声・コメントから読み解く、生放送の記録</p>
            </div>
            <div className="article-news-issue">
              <strong>{new Date().toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "long" })}</strong>
              <span>保存記事 {streamArticles.length.toLocaleString("ja-JP")}本</span>
            </div>
          </div>
          <div className="article-list">
            <div className="settings-subheading article-list-heading"><h3>放送記事一覧</h3><span className="api-state connected">{filteredStreamArticles.length}件 / 全{streamArticles.length}件</span></div>
            <div className="article-list-toolbar">
              <div className="article-status-filters" role="group" aria-label="記事の種類">
                <button className={articleStatusFilter === "all" ? "selected" : ""} onClick={() => setArticleStatusFilter("all")}>すべて</button>
                <button className={articleStatusFilter === "live" ? "selected" : ""} onClick={() => setArticleStatusFilter("live")}>LIVE速報</button>
                <button className={articleStatusFilter === "archive" ? "selected" : ""} onClick={() => setArticleStatusFilter("archive")}>アーカイブ</button>
              </div>
              <span className="article-list-count">{filteredStreamArticles.length.toLocaleString("ja-JP")}記事</span>
            </div>
            <div className="article-search-row"><input className="article-search" value={articleSearch} onChange={event => setArticleSearch(event.target.value)} placeholder="記事を検索（配信者・見出し・本文・音声文字起こし・キーワード）" aria-label="配信記事を検索" /></div>
            {streamArticles.length === 0 ? <div className="empty-state"><strong>まだ記事がありません</strong><span>登録配信者の録画を選んで記事を生成してください。</span></div> : filteredStreamArticles.length === 0 ? <div className="empty-state"><strong>一致する記事がありません</strong><span>検索語を変更してください。</span></div> : articleDateGroups.map(([dateLabel, dayArticles]) => <section className="article-day-group" key={dateLabel}>
              <div className="article-day-heading"><h4>{dateLabel}</h4><span>{dayArticles.length.toLocaleString("ja-JP")}本</span></div>
              {dayArticles.map(article => <article className="article-card" key={article.slug + ":" + article.id}>
              <div className="article-meta"><span className="article-byline">配信者・{article.displayName}</span> ・ {new Date(article.startedAt).toLocaleString("ja-JP")} <span className={article.status === "live" ? "article-status-live" : "article-status-done"}>{article.status === "live" ? "LIVE・更新中" : article.status === "completed" ? "配信終了" : "アーカイブ"}</span>{article.aiGenerated && <span className="article-ai-label">AI記事</span>}</div>
              <h3>{article.headline}</h3>
              {article.category && <span className="live-stream-category">{article.category}</span>}
              {article.aiSummary && <p className="article-summary">{article.aiSummary}</p>}
              <div className="article-source-badges">
                <span className={article.videoAnalyzed ? "is-analyzed" : ""}>映像 {article.videoAnalyzed ? "分析済み" : "未解析"}</span>
                <span className={article.audioAnalyzed ? "is-analyzed" : ""}>音声 {article.audioAnalyzed ? `文字起こし ${(article.audioSegmentCount ?? article.audioTranscriptSegments?.length ?? 0).toLocaleString("ja-JP")}区間` : "未解析"}</span>
                <span className={article.commentCount > 0 ? "is-analyzed" : ""}>コメント {article.commentCount.toLocaleString("ja-JP")}件</span>
              </div>
              {article.videoAnalyzed && <div className="article-video-analysis"><strong>映像から確認した場面（代表フレーム {article.videoFrameCount ?? article.videoScenes?.length ?? 0}枚）</strong><p>{article.videoSummary}</p>{Boolean(article.videoScenes?.length) && <ul>{article.videoScenes?.map((scene, index) => <li key={index}>{scene}</li>)}</ul>}</div>}
              {article.audioAnalyzed && <div className="article-audio-analysis">
                <strong>音声から確認した内容</strong>
                <p>{article.audioSummary || "音声は文字起こし済みです。発言内容の要約はまだ生成されていません。"}</p>
                {article.audioTranscript && <details className="article-transcript-details">
                  <summary>音声文字起こしを表示（{(article.audioSegmentCount ?? article.audioTranscriptSegments?.length ?? 0).toLocaleString("ja-JP")}区間）</summary>
                  <pre>{article.audioTranscript}</pre>
                </details>}
              </div>}
              {article.audioError && <div className="storage-error article-error">音声認識エラー：{article.audioError}</div>}
              {article.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
              {Boolean(article.highlights?.length) && <div className="article-highlights"><strong>注目ポイント</strong><ul>{article.highlights?.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
              {article.aiError && <div className="storage-error article-error">AI更新エラー：{article.aiError}</div>}
              <div className="article-stats">配信時間 {Math.floor((article.durationSeconds ?? 0) / 60).toLocaleString("ja-JP")}分 ・ コメント {article.commentCount.toLocaleString("ja-JP")}件 ・ 投稿者 {article.uniqueCommenters.toLocaleString("ja-JP")}人 ・ 視聴者数 {article.viewerCount?.toLocaleString("ja-JP") ?? "—"}人（最大 {article.peakViewerCount?.toLocaleString("ja-JP") ?? "—"}人） ・ 分析キーワード {article.keywords.join("、") || "なし"}{article.lastAiUpdateAt ? ` ・ AI更新 ${new Date(article.lastAiUpdateAt).toLocaleTimeString("ja-JP")}` : ""}</div>
              {article.sourceVideo && <div className="comment-video-actions"><button className="small-action" onClick={() => void window.kickRecorder?.openRecording(article.sourceVideo)}>元動画を開く</button><button className="small-action" onClick={() => void window.kickRecorder?.revealRecording(article.sourceVideo)}>録画の保存先</button></div>}
              <div className="comment-video-actions article-card-actions">
                <button className="remove" onClick={() => void deleteStreamArticle(article)} disabled={article.status === "live" || deletingArticleId !== null}>
                  {article.status === "live" ? "LIVE更新中は削除不可" : deletingArticleId === article.id ? "削除中..." : "この記事を削除"}
                </button>
              </div>
              </article>)}
            </section>)}
          </div>
        </>}
      </section>}

      {tab === "updates" && <section className="panel version-update-panel">
        <div className="panel-heading">
          <div><h2>バージョン更新</h2><p>新しいβ版の確認・ダウンロード・更新履歴をここで管理できます</p></div>
          <a className="text-button" href="https://github.com/kanenao/Kick-Live-Message-Recorder/releases" target="_blank" rel="noreferrer">GitHub Releases ↗</a>
        </div>
        <div className="version-update-grid">
          <div className="version-current-card">
            <span className="version-card-label">現在インストール中</span>
            <strong>v{appVersion}</strong>
            <small>Kick Live Message Recorder</small>
            <div className="version-card-foot">Windows 64bit・β版</div>
          </div>
          <div className="version-check-card">
            <div className="version-check-heading">
              <div><span className="version-card-label">更新状態</span><strong>{updateStatus.availableVersion ? `v${updateStatus.availableVersion}` : "最新バージョン確認"}</strong></div>
              <span className={`update-state-pill update-state-${updateStatus.status}`}>{updateStatus.status === "checking" ? "確認中" : updateStatus.status === "available" ? "更新あり" : updateStatus.status === "downloading" ? "ダウンロード中" : updateStatus.status === "downloaded" ? "更新準備完了" : updateStatus.status === "not-available" ? "最新です" : updateStatus.status === "error" ? "エラー" : "待機中"}</span>
            </div>
            <p className="version-update-message">{updateStatus.message}</p>
            {(updateStatus.status === "downloading" || updateStatus.status === "downloaded") && <div className="version-progress-wrap">
              <div className="version-progress-label"><span>ダウンロード進捗</span><strong>{Math.round(updateStatus.percent ?? 0)}%</strong></div>
              <div className="version-progress"><div style={{ width: `${Math.max(0, Math.min(100, updateStatus.percent ?? 0))}%` }} /></div>
            </div>}
            <div className="version-update-actions">
              <button className="primary-small" onClick={() => void checkForAppUpdates()} disabled={isCheckingUpdates || updateStatus.status === "checking" || updateStatus.status === "downloading"}>{isCheckingUpdates || updateStatus.status === "checking" ? "確認中..." : "更新を確認"}</button>
              {updateStatus.status === "downloaded" && <button className="small-action" onClick={() => void installAppUpdate()}>再起動して更新</button>}
            </div>
            <small className="version-update-hint">起動時と約6時間ごとに自動確認します。Windowsインストーラー版では新しい更新を自動ダウンロードします。適用は再起動時に行われます。</small>
          </div>
        </div>
        {updateStatus.releaseNotes && <div className="release-notes-panel">
          <div className="settings-subheading"><h3>配信中のリリースノート</h3>{updateStatus.releaseDate && <span className="comment-video-log-count">{new Date(updateStatus.releaseDate).toLocaleDateString("ja-JP")}</span>}</div>
          <pre>{updateStatus.releaseNotes}</pre>
        </div>}
        <div className="version-history-section">
          <div className="settings-subheading"><h3>バージョン更新履歴</h3><span className="api-state connected">{VERSION_HISTORY.length}件</span></div>
          <div className="version-history-list">
            {VERSION_HISTORY.map((release, index) => <article className="version-history-item" key={release.version}>
              <div className="version-history-marker">{index === 0 ? "NEW" : "β"}</div>
              <div className="version-history-content">
                <div className="version-history-heading"><strong>v{release.version}</strong><span>{release.title}</span></div>
                <ul>{release.changes.map(change => <li key={change}>{change}</li>)}</ul>
              </div>
            </article>)}
          </div>
        </div>
        <div className="notice">自動更新はGitHub Releasesに公開されたWindowsインストーラー版が対象です。ブラウザー版プレビューやZIP版では、更新ファイルを手動で取得してください。</div>
      </section>}

      {tab === "settings" && <section className="panel">
        <div className="panel-heading"><div><h2>基本設定</h2><p>β版の録画動作・保存先の設定</p></div></div>
        <div className="setting-row">
          <div><strong>配信開始時に自動録画</strong><small>自動モードの登録チャンネルが配信を開始すると録画します</small></div>
          <label className="setting-control"><input type="checkbox" checked={settings.autoRecordOnStreamStart} onChange={e => setSettings(prev => ({ ...prev, autoRecordOnStreamStart: e.target.checked }))} /><span>{settings.autoRecordOnStreamStart ? "有効" : "無効"}</span></label>
        </div>
        <div className="setting-row">
          <div><strong>Kickチャットを自動取得</strong><small>アプリ起動時やチャンネル追加時に、通常のチャンネル管理へ自動接続します。録画専用一覧のON／OFFは録画専用画面で別に設定できます。</small></div>
          <label className="setting-control"><input type="checkbox" checked={settings.autoReceiveChat} onChange={event => setSettings(previous => ({ ...previous, autoReceiveChat: event.target.checked }))} /><span>{settings.autoReceiveChat ? "自動取得：有効" : "自動取得：無効"}</span></label>
        </div>
        <div className="setting-row">
          <div><strong>チャットを保存</strong><small>受信したコメントをJSONL形式で保存します。画面にもリアルタイム表示します。</small></div>
          <label className="setting-control"><input type="checkbox" checked={settings.saveChat} onChange={event => setSettings(previous => ({ ...previous, saveChat: event.target.checked }))} /><span>{settings.saveChat ? "有効" : "無効"}</span></label>
        </div>

        <div className="settings-subsection recording-retry-settings">
          <div className="settings-subheading">
            <h3>録画の自動再接続</h3>
            <span className="api-state connected">通信エラー対策</span>
          </div>
          <div className="setting-row">
            <div><strong>予期しない録画終了時に再接続</strong><small>通信切断などで録画が異常終了した場合だけ再試行します。手動停止・正常な配信終了では再接続しません。</small></div>
            <select className="setting-select" value={settings.recordingRetryCount} onChange={e => setSettings(prev => ({ ...prev, recordingRetryCount: Number(e.target.value) }))}>
              <option value={0}>再接続しない</option>
              <option value={1}>1回</option>
              <option value={3}>3回</option>
              <option value={5}>5回（推奨）</option>
              <option value={10}>10回</option>
            </select>
          </div>
          <div className="setting-row">
            <div><strong>再接続までの待ち時間</strong><small>再接続する前に待機する秒数です。再接続ごとの録画は別ファイルとして保存します。</small></div>
            <select className="setting-select" value={settings.recordingRetryDelaySeconds} onChange={e => setSettings(prev => ({ ...prev, recordingRetryDelaySeconds: Number(e.target.value) }))}>
              <option value={5}>5秒</option>
              <option value={10}>10秒</option>
              <option value={15}>15秒</option>
              <option value={30}>30秒</option>
              <option value={60}>60秒</option>
            </select>
          </div>
        </div>

        <div className="settings-subsection">
          <div className="settings-subheading"><h3>配信プレビュー</h3><span className={settings.showRecordingPreview ? "api-state connected" : "api-state"}>{settings.showRecordingPreview ? "表示：ON" : "表示：OFF"}</span></div>
          <div className="setting-row">
            <div><strong>録画中の映像プレビューを表示</strong><small>ダッシュボードと録画専用画面のプレーヤー表示を切り替えます。OFFにしても録画・コメント取得は継続します。</small></div>
            <label className="setting-control"><input type="checkbox" checked={settings.showRecordingPreview} onChange={e => setSettings(prev => ({ ...prev, showRecordingPreview: e.target.checked }))} /><span>{settings.showRecordingPreview ? "有効" : "無効"}</span></label>
          </div>
        </div>

        <div className="settings-subsection monitor-settings">
          <div className="settings-subheading">
            <h3>24時間バックグラウンド監視・自動録画</h3>
            <span className={backgroundMonitorStatus.running ? "api-state connected" : "api-state"}>{backgroundMonitorStatus.running ? "監視中" : "停止中"}</span>
          </div>
          <div className="setting-row">
            <div><strong>登録チャンネルを24時間監視</strong><small>メインプロセスで監視するため、ウィンドウを閉じて通知領域に常駐していても配信を検知します。</small></div>
            <label className="setting-control"><input type="checkbox" checked={settings.autoMonitorEnabled} onChange={e => setSettings(prev => ({ ...prev, autoMonitorEnabled: e.target.checked }))} /><span>{settings.autoMonitorEnabled ? "有効" : "無効"}</span></label>
          </div>
          <div className="setting-row">
            <div><strong>配信開始時に通常チャンネルを自動録画</strong><small>チャンネル管理で「自動録画」に設定したチャンネルが対象です。</small></div>
            <label className="setting-control"><input type="checkbox" checked={settings.autoRecordOnStreamStart} onChange={e => setSettings(prev => ({ ...prev, autoRecordOnStreamStart: e.target.checked }))} /><span>{settings.autoRecordOnStreamStart ? "有効" : "無効"}</span></label>
          </div>
          <div className="setting-row">
            <div><strong>録画専用チャンネルの配信開始時に自動録画</strong><small>通常チャンネルの自動録画設定とは独立してON／OFFできます。コメントは録画専用の自動取得設定が有効な場合に保存します。</small></div>
            <label className="setting-control"><input type="checkbox" checked={settings.autoRecordRecordingOnlyOnStreamStart} onChange={e => setSettings(prev => ({ ...prev, autoRecordRecordingOnlyOnStreamStart: e.target.checked }))} /><span>{settings.autoRecordRecordingOnlyOnStreamStart ? "有効" : "無効"}</span></label>
          </div>
          <div className="setting-row">
            <div><strong>監視間隔</strong><small>最短10秒。配信開始後、次の確認で録画を開始します。APIのアクセス制限時はRetry-Afterに従って待機します。</small></div>
            <select className="setting-select" value={settings.monitorIntervalSeconds} onChange={e => setSettings(prev => ({ ...prev, monitorIntervalSeconds: Number(e.target.value) }))}>
              <option value={10}>10秒（最速）</option><option value={15}>15秒</option><option value={20}>20秒</option><option value={30}>30秒</option>
              <option value={60}>1分</option><option value={120}>2分</option><option value={300}>5分</option><option value={600}>10分</option>
            </select>
          </div>
          <div className="setting-row">
            <div><strong>Windowsログイン時に自動起動</strong><small>PCへサインインするとアプリを通知領域で起動して監視を再開します（Windowsデスクトップ版）。</small></div>
            <label className="setting-control"><input type="checkbox" checked={settings.launchAtLogin} onChange={e => setSettings(prev => ({ ...prev, launchAtLogin: e.target.checked }))} /><span>{settings.launchAtLogin ? "有効" : "無効"}</span></label>
          </div>
          <div className="setting-row">
            <div><strong>監視中はPCのスリープを抑止</strong><small>Windowsのスリープとディスプレイ消灯を抑止します。画面が点灯したままになるため、不要な場合はOFFにしてください。</small></div>
            <label className="setting-control"><input type="checkbox" checked={settings.preventSystemSleep} onChange={e => setSettings(prev => ({ ...prev, preventSystemSleep: e.target.checked }))} /><span>{settings.preventSystemSleep ? "有効" : "無効"}</span></label>
          </div>
          <div className="setting-row">
            <div><strong>配信開始をWindows通知で知らせる</strong><small>LIVEを検知したとき、録画開始の結果とともに通知します。</small></div>
            <label className="setting-control"><input type="checkbox" checked={settings.notifyOnLive} onChange={e => setSettings(prev => ({ ...prev, notifyOnLive: e.target.checked }))} /><span>{settings.notifyOnLive ? "有効" : "無効"}</span></label>
          </div>
          <div className="monitor-status-line">
            {backgroundMonitorStatus.message}
            {backgroundMonitorStatus.lastCheckAt && ` · 最終確認：${new Date(backgroundMonitorStatus.lastCheckAt).toLocaleString("ja-JP")}`}
          </div>
          {backgroundMonitorStatus.lastError && <div className="storage-error monitor-error">監視・コメント取得エラー：{backgroundMonitorStatus.lastError} 自動再試行します。</div>}
          <div className="notice">注意：24時間監視には、アプリのプロセスが動作していること、PCの電源とネットワークが利用可能であることが必要です。ウィンドウ右上の×は終了ではなく通知領域へ最小化します。完全終了は通知領域アイコンのメニューから行います。自動録画・コメント取得には対応する各チャット自動取得設定も有効にしてください。</div>
        </div>
        <div className="setting-row">
          <div><strong>録画・データの保存先</strong><small>{settings.outputDirectory || "未指定（初期設定の保存場所を使用）"}</small></div>
          <div className="folder-picker">
            <button className="small-action" onClick={() => void chooseOutputDirectory()} disabled={!isDesktop}>フォルダーを選択</button>
          </div>
        </div>

        <div className="settings-subsection updater-panel">
          <div className="settings-subheading">
            <h3>アプリ情報・自動更新</h3>
            <span className="api-state connected">自動確認：有効</span>
          </div>
          <div className="version-row">
            <span>現在のバージョン</span>
            <strong>{appVersion}</strong>
          </div>
          <div className="update-description">{updateStatus.message}</div>
          {(updateStatus.status === "downloading" || updateStatus.status === "available") && <div className="update-progress"><div className="update-progress-fill" style={{ width: `${updateStatus.percent ?? 0}%` }} /></div>}
          {updateStatus.availableVersion && <div className="update-version">新しいバージョン：{updateStatus.availableVersion}</div>}
          <div className="update-actions">
            <button className="primary-small" onClick={() => void checkForAppUpdates()} disabled={!isDesktop || isCheckingUpdates || updateStatus.status === "downloading"}>{isCheckingUpdates || updateStatus.status === "checking" ? "確認中..." : "今すぐ更新を確認"}</button>
            {updateStatus.status === "downloaded" && <button className="primary-small" onClick={() => void installAppUpdate()}>再起動して更新</button>}
          </div>
          <p className="settings-help">起動時と6時間ごとに新しいバージョンを確認します。更新が見つかると自動でダウンロードし、アプリ終了時に適用します。更新の適用にはアプリの再起動が必要です。</p>
          {!isDesktop && <div className="notice">自動更新はWindowsデスクトップ版をインストールして利用してください。</div>}
        </div>

        <div className="settings-subsection">
          <div className="settings-subheading">
            <h3>Kick API接続</h3>
            <span className={kickCredentialsConfigured ? "api-state connected" : "api-state"}>{kickCredentialsConfigured ? "認証情報登録済み" : "未設定"}</span>
          </div>
          <p className="settings-help">Kick Developerで作成したアプリのClient IDとClient Secretを入力します。SecretはWindowsの暗号化機能で保護し、画面側やログには保存しません。保存後に「接続テスト」を押すと、Kickの認証サーバーからApp Access Tokenを取得できるか確認します。</p>
          <label className="credential-field">クライアントID
            <input value={kickClientId} onChange={event => setKickClientId(event.target.value)} placeholder="Kick DeveloperのクライアントID" autoComplete="off" disabled={!isDesktop} />
          </label>
          <label className="credential-field">クライアントシークレット
            <input type="password" value={kickClientSecret} onChange={event => setKickClientSecret(event.target.value)} placeholder={kickCredentialsConfigured ? "保存済み（変更する場合のみ入力）" : "Kick Developerのクライアントシークレット"} autoComplete="new-password" disabled={!isDesktop} />
          </label>
          <div className="credential-actions">
            <button className="primary-small" onClick={() => void saveKickApiCredentials()} disabled={!isDesktop || !kickEncryptionAvailable}>認証情報を保存</button>
            <button className="small-action" onClick={() => void testKickApiConnection()} disabled={!isDesktop || !kickCredentialsConfigured || isTestingKickConnection}>{isTestingKickConnection ? "接続確認中..." : "接続テスト"}</button>
            <button className="small-action" onClick={() => void clearKickApiCredentials()} disabled={!isDesktop || !kickCredentialsConfigured}>認証情報を削除</button>
          </div>
          {kickMessage && <div className="api-message" role="status">{kickMessage}</div>}
          <div className="notice">この認証はKick公式APIによる配信状態の自動監視に使用します。コメント受信は別方式のため、ここでのClient ID／Secret登録は不要です。</div>
          {!isDesktop && <div className="notice">Kick APIの認証情報登録はWindowsデスクトップ版で利用できます。</div>}
          {isDesktop && !kickEncryptionAvailable && <div className="storage-error">Windowsの暗号化ストレージが利用できないため、認証情報は保存できません。</div>}
        </div>
        <div className="settings-subsection chat-settings">
          <div className="settings-subheading">
            <h3>Kickチャット受信</h3>
            <span className={chatStatus.running ? "api-state connected" : "api-state"}>{chatStatus.running ? "受信中（" + chatStatus.connectedChannels + "チャンネル）" : "停止中"}</span>
          </div>
          <p className="settings-help">登録したKickチャンネルの公開チャットへアプリから直接接続します。同時に最大50チャンネルまで受信でき、自動取得が有効ならアプリ起動時とチャンネル追加時に自動で接続します。ngrok・Cloudflare Tunnel・Webhook URL登録は不要です。Kickの非公式リアルタイム接続を利用するため、Kick側の仕様変更で受信できなくなる場合があります。</p>
          <div className="chat-receiver-actions">
            <button className="primary-small" onClick={() => void startChatReceiver()} disabled={!isDesktop || isStartingChat || chatStatus.running || channels.length === 0}>
              {isStartingChat ? "接続中..." : "コメント受信を開始"}
            </button>
            <button className="small-action" onClick={() => void stopChatReceiver()} disabled={!isDesktop || !chatStatus.running}>受信を停止</button>
            <span className="chat-count">受信数：{chatStatus.messageCount.toLocaleString("ja-JP")}件</span>
            {chatStatus.lastMessageAt && <span className="chat-count">最終受信：{new Date(chatStatus.lastMessageAt).toLocaleTimeString("ja-JP")}</span>}
          </div>
          {chatSetupMessage && <div className="api-message" role="status">{chatSetupMessage}</div>}
          <div className="monitor-status-line">{chatStatus.message}</div>
          <div className="chat-preview">
            <div className="chat-preview-heading"><strong>最近受信したコメント</strong><span>{chatMessages.length}件を表示</span></div>
            {chatMessages.length === 0
              ? <div className="empty-inline">自動取得が有効なら、アプリ起動後に登録チャンネルのコメントが自動で表示されます。手動で開始することもできます。</div>
              : <div className="chat-preview-list">
                  {chatMessages.slice(0, 20).map(message => <div className="chat-preview-item" key={message.eventId}>
                    <div className="chat-preview-meta"><strong>{message.senderUsername}</strong><span>#{message.channelSlug}</span><time>{new Date(message.createdAt).toLocaleTimeString("ja-JP")}</time></div>
                    <div className="chat-preview-content">{message.content}</div>
                  </div>)}
                </div>}
          </div>
          <p className="settings-help">保存先：{settings.outputDirectory || "アプリ既定のビデオフォルダー"}/Chat/チャンネル名/YYYY-MM-DD.jsonl</p>
          {!isDesktop && <div className="notice">チャット受信はWindowsデスクトップ版で利用できます。</div>}
        </div>
        {appDataDirectory && <div className="data-path-note">アプリ設定データ: {appDataDirectory}</div>}
        {!isDesktop && <div className="notice">保存先フォルダーの選択はWindowsデスクトップ版で利用できます。ブラウザープレビューでは設定をブラウザー内に保存します。</div>}
      </section>}

      <footer>Kick Live Message Recorder <span>•</span> β版 {appVersion} <span>•</span> 日本語版</footer>
    </main>
  </div>;
}
