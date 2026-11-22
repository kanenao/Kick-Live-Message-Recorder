import { useEffect, useMemo, useRef, useState } from "react";
import { getRecordingChannelSlug } from "../shared/recording-library";
import { getAvailableArticleChannels, selectAssociatedArticleLogs } from "../shared/article-sources";
import { computeNicoAssProfile } from "../../electron/nico-ass-auto";
import { CommentVideoLivePreview } from "./CommentVideoLivePreview";
import { parseReleaseNotes, splitReleaseNoteInline } from "../shared/release-notes";
import { formatArticleEvidenceTime, type ArticleEvidenceEvent } from "../../electron/article-evidence";
import { deduplicateArticleSentences, deduplicateArticleList } from "../../electron/article-text-dedupe";

function ReleaseNoteInlineText({ value }: { value: string }) {
  return <>{splitReleaseNoteInline(value).map((part, index) =>
    part.kind === "strong" ? <strong key={index}>{part.value}</strong> :
    part.kind === "code" ? <code key={index}>{part.value}</code> :
    <span key={index}>{part.value}</span>
  )}</>;
}

function ReleaseNotesContent({ value }: { value: string }) {
  const blocks = parseReleaseNotes(value);
  return <div className="release-notes-content">
    {blocks.map((block, index) =>
      block.kind === "heading" ?
        <h4 key={index} className={block.level === 1 ? "release-note-title" : "release-note-heading"}><ReleaseNoteInlineText value={block.text} /></h4> :
      block.kind === "list" ?
        <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}><ReleaseNoteInlineText value={item} /></li>)}</ul> :
        <p key={index}><ReleaseNoteInlineText value={block.text} /></p>
    )}
  </div>;
}

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
  removeEmotesFromAss: boolean;
  assAutoFlow: boolean;
  vodAssCrossingSeconds: number;
  vodAssSpeedPercent: number;
  vodAssEntryOffsetPx: number;
  vodAssRowLimit: number;
  vodAssCollisionGap: number;
  vodAssDelaySeconds: number;
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

type VodDownloadJob = {
  id: string;
  url: string;
  slug: string;
  videoId: string;
  status: "queued" | "downloading" | "completed" | "cancelled" | "error";
  progress: number | null;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  estimatedRemainingSeconds?: number;
  filePath?: string;
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
type LibraryCommentMessage = {
  eventId: string;
  senderUsername: string;
  content: string;
  createdAt: string;
  usernameColor: string | null;
};
type LibrarySession = {
  id: string; slug: string; kind: "LIVE" | "VOD"; startedAt: string; endedAt?: string;
  title: string; videos: RecordingFile[]; logs: CommentLogFile[]; article?: StreamArticle;
  status: "saved" | "interrupted" | "failed" | "unknown"; warnings: string[];
  commentAssociation: "exact" | "none";
};
type RecordingLibraryChannel = {
  slug: string;
  displayName: string;
  profilePicture: string | null;
  videos: RecordingFile[];
  logs: CommentLogFile[];
  sessions: LibrarySession[];
  latestAt: string;
};
type StreamArticle = {
  id: string; slug: string; displayName: string; headline: string; streamTitle?: string; category: string; startedAt: string;
  durationSeconds: number; commentCount: number; uniqueCommenters: number; keywords: string[];
  paragraphs: string[]; sourceVideo: string; sourceLogs: string[]; createdAt: string;
  commentEvidenceCount?: number;
  pendingAnalysisComments?: Array<{ at: string; text: string; timeInSeconds?: number }>;
  pendingAnalysisAudioSegments?: Array<{ startSeconds: number; endSeconds: number; text: string }>;
  evidenceTimeline?: ArticleEvidenceEvent[];
  status?: "live" | "completed"; aiGenerated?: boolean; aiSummary?: string; highlights?: string[];
  lastAiUpdateAt?: string | null; viewerCount?: number; peakViewerCount?: number; aiError?: string;
  videoAnalyzed?: boolean; videoFrameCount?: number; videoAnalyzedSampleCount?: number; videoSummary?: string; videoScenes?: string[]; videoAnalyzedAt?: string | null;
  videoPreviewAvailable?: boolean; videoPreviewTimeSeconds?: number; videoPreviewUpdatedAt?: string;
  audioAnalyzed?: boolean; audioSamplingMode?: "continuous" | "distributed"; audioSegmentCount?: number; audioSummary?: string; audioTranscript?: string;
  audioTranscriptSegments?: Array<{ startSeconds: number; endSeconds: number; text: string }>;
  audioAnalyzedAt?: string | null; audioError?: string;
};
type AiArticleStatus = {
  configured: boolean; encryptionAvailable: boolean;
  aiArticleEnabled: boolean; aiArticleProvider: "ollama" | "openai"; aiArticleOllamaUrl: string; aiArticleModel: string; aiArticleIntervalSeconds: number;
};
type AiModelPullStatus = {
  model: string; status: string; percent: number | null; completed?: number; total?: number; done: boolean; error?: string;
};
type CommentVideoEvent = { status: "starting" | "encoding" | "completed" | "cancelled" | "error"; percent: number; message: string; outputPath?: string; generatedComments?: number; skippedComments?: number };
type CommentVideoPreviewData = {
  width: number;
  height: number;
  durationSeconds: number;
  totalComments: number;
  malformedLines: number;
  outsideVideoCount: number;
  syncSource: "recording-metadata" | "filename" | "file-mtime";
  estimatedVideoStartAt: string;
  comments: Array<{ seconds: number; content: string; username: string; color: string; position?: "scroll" | "top" | "bottom" }>;
};

const APP_VERSION = "0.8.0-alpha.86";
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
    version: "0.8.0-alpha.86",
    title: "LIVE配信AI新聞の映像解析を全時間帯サンプリングへ改善",
    changes: [
      "LIVE映像の直近8枚だけでなく、配信全体から均等に選んだ最大7枚＋最新フレームをAI解析へ送信",
      "映像キャプチャの一時切断・再接続をまたいでサンプリング履歴を保持",
      "AIに実際に送った代表フレーム数と取得累計を分けて表示",
      "長時間配信でも冒頭・中盤・終盤の場面が記事へ反映されるよう改善"
    ]
  },
  {
    version: "0.7.5-alpha.85",
    title: "正式アイコンのアプリ内表示をWindowsインストール版で修正",
    changes: [
      "新しいK／LIVE／RECアイコンのElectron file://環境での相対パスを修正",
      "サイドバー・ヘッダー・faviconの画像がインストール版でも表示されるよう改善",
      "Windows EXE・スタートメニュー・通知領域は正式アイコンを維持",
      "アセットパス・Windows ICO形式・画像データの検証を追加"
    ]
  },
  {
    version: "0.7.4-alpha.84",
    title: "Kick版の正式アプリアイコンを追加",
    changes: [
      "新しい緑・黒のK／LIVE／RECアイコンをWindowsアプリとショートカットに採用",
      "通知領域・ウィンドウ・アプリ左上のアイコンを統一",
      "元のアイコン画像からWindows用ICOと画面用PNGを自動生成",
      "生成画像の破損をSHA-256で検出するビルドテストを追加"
    ]
  },
  {
    version: "0.7.3-alpha.83",
    title: "リアルタイムコメントプレビューの長時間配信・時刻同期を改善",
    changes: [
      "大量のチャットを動画時刻ごとの区間から均等に抽出し、配信後半の少数コメントを保護",
      "同時投稿で表示行が埋まった場合、古いコメントが後の別場面に遅延し続ける問題を修正",
      "シーク・コメント速度・長時間VODの自動回帰テストを強化",
      "録画動画・JSONL・ASS・記事データは変更せずプレビュー描画のみ改善"
    ]
  },
  {
    version: "0.7.2-alpha.82",
    title: "録画ライブラリの配信者別フォルダー保存",
    changes: [
      "LIVE録画と過去配信動画を Recordings/配信者ID ごとに自動整理",
      "コメント付き動画は CommentVideos/配信者ID へ保存。コメントJSONLは従来の Chat/配信者ID に保持",
      "旧保存先の動画・セッション・記事も移動せず引き続き録画ライブラリで表示",
      "配信者ごとに保存先の案内とエクスプローラーで開くボタンを追加"
    ]
  },
  {
    version: "0.7.1-alpha.81",
    title: "ニコ生風・コメント付き動画の実映像リアルタイムプレビュー",
    changes: [
      "元動画を再生しながらCanvasでコメントを時刻同期して重ねるプレビューを追加",
      "停止・シーク・フォント・文字サイズ・速度・透明度・行数・位置の変更をすぐ反映",
      "コメントログの確認用サンプルを全時間帯で最大1200件に拡張し、従来の見本も維持",
      "動画・元コメントを変更せず、動画ファイルのプレビュー用URLを適切に解放"
    ]
  },
  {
    version: "0.7.0-alpha.80",
    title: "録画ライブラリ・AI新聞：時刻別の動画サムネイルギャラリー",
    changes: [
      "録画サムネイルから大きな代表画像と時刻付き場面一覧を表示",
      "配信AI新聞からも元動画の同じ場面プレビューを開けるように改善",
      "長時間配信の開始・中盤・終盤から最大30場面を安全に抽出",
      "FFmpeg画像をキャッシュし、元動画・既存記事・コメントを変更しない"
    ]
  },
  {
    version: "0.6.1-alpha.79",
    title: "配信AI新聞の映像要約・場面一覧・本文の繰り返し表示を修正",
    changes: [
      "同じ映画説明を複数回並べるAI記事の重複表示を改善",
      "映像要約と場面一覧の重複を除き、異なる場面・時刻は残す",
      "過去に保存した記事も元データを変更せず表示時に重複を抑制",
      "文章の重複を再現する自動回帰テストを追加"
    ]
  },
  {
    version: "0.6.0-alpha.78",
    title: "配信AI新聞：映像・音声・コメントの時刻別根拠を表示",
    changes: [
      "LIVEと保存済み配信の記事に時刻付き根拠タイムラインを追加",
      "コメント、音声文字起こし、映像代表フレームを情報源別に区別して表示",
      "時刻不明のコメントに架空の時刻を付けず、録画全体から均等に根拠を抽出",
      "記事の再解析時は古い情報源の根拠を引き継がない",
      "AIの分割JSONと構造化段落の読み取り改善を統合"
    ]
  },
  {
    version: "0.5.1-alpha.77",
    title: "配信AI新聞のOllama応答復旧と記事保護",
    changes: [
      "Ollamaの空・不完全な記事応答時に映像を除いた根拠で1回再試行",
      "記事の再生成時に同一日時の既存記事を上書きせず別版保存",
      "AIが参照できたVODコメント件数を分けて表示",
      "LIVEコメント集中時のAI解析待ちキューを2000件まで拡大"
    ]
  },
  {
    version: "0.5.0-alpha.76",
    title: "配信AI新聞のアーカイブ解析・再解析を大幅強化",
    changes: [
      "未登録配信者でも録画ライブラリからAI新聞を生成できるよう対応",
      "コメントログを放送ごとに自動対応付けし、手動でログを追加・除外可能に",
      "過去記事の再解析ボタンを追加し、映像・音声・コメントで再解析可能に",
      "映像要約が空でも利用可能な本文を失わず、必要なVisionモデルを案内",
      "アーカイブ記事の配信時間が再解析で誤って延びる問題と録画中生成時の残骸を修正"
    ]
  },
  {
    version: "0.4.2-alpha.75",
    title: "保存済みVODコメントのオフラインASS再生成",
    changes: [
      "過去配信のJSONLから、ネット接続なしでASSを再生成できる操作を追加",
      "ニコ生風自動調整・手動速度・emote設定を再利用し、生成結果のコメント件数を表示",
      "元のJSONL・TXT・既存ASSを一切上書きせず、別名保存する",
      "保存先の検証・不正ファイルの拒否・上限値・重複実行防止を追加"
    ]
  },
  {
    version: "0.4.1-alpha.74",
    title: "ニコ生風ASSのコメント速度・入り方を自動調整",
    changes: [
      "過去配信ASSとコメント付き動画のASSに自動調整ON/OFFを追加（初期値ON）",
      "コメントの長さと直近の投稿密度で速度・画面右端からの進入距離を計算",
      "前後コメントの速度差を考慮して追い越しを防ぎ、必要なら最大1.2秒入場時刻を調整",
      "手動モードを維持し、元のJSONL・TXT・動画・記事は変更しない"
    ]
  },
  {
    version: "0.4.0-alpha.73",
    title: "過去配信ASSのニコ生風コメント調整",
    changes: [
      "過去配信のASS出力で画面横断時間・速度・画面右端からの進入余白・コメント同期を調整可能",
      "最大行数とコメント間隔を設定でき、混雑時に同じ行へ強制的に重ねない",
      "おすすめ設定への戻し操作と設定保存に対応",
      "JSONL・TXTの元コメントや録画・記事は変更しない"
    ]
  },
  {
    version: "0.3.9-alpha.72",
    title: "配信記事メニューの不要な改行文字を除去",
    changes: [
      "「配信記事」の直前に表示されていた余分な改行文字を修正",
      "画面に誤った文字列が再表示されないよう回帰テストを追加",
      "録画・コメント・保存済み記事・AI解析データは変更しない"
    ]
  },
  {
    version: "0.3.8-alpha.71",
    title: "ASS字幕出力のemote削除オプション",
    changes: [
      "コメント付き動画のASS字幕出力でemote削除のON/OFFを選択可能（初期値ON）",
      "Kick emote [emote:ID:name] のみ除去し、文章部分は保持。emoteのみのコメントは字幕を生成しない",
      "過去配信のコメント取得（JSONL・TXT・ASS）のASSにも設定を反映",
      "コメント表示プレビューにも設定を反映し、設定をアプリに保存",
      "元のJSONL・TXT、録画動画、AI記事は変更しない"
    ]
  },
  {
    version: "0.3.7-alpha.70",
    title: "録画ライブラリのコメントログを個別にごみ箱へ移動",
    changes: [
      "配信別のコメントJSONLに削除ボタンを追加し、ファイル名を確認してからWindowsのごみ箱へ移動",
      "削除後は動画ライブラリのコメント数・配信カード・コメントプレビューをすぐ更新",
      "削除したファイルをコメント付き動画生成の選択からも自動解除",
      "録画中のLIVEコメントとVODコメント取得中の削除を保護",
      "録画動画・AI記事・別のログ・TXT/ASSなどは同時削除せず、元データを保護"
    ]
  },
  {
    version: "0.3.6-alpha.69",
    title: "録画ライブラリのアイコン・配信者名からKickページへ移動",
    changes: [
      "録画ライブラリで配信者のプロフィール画像をクリックするとKick公式ユーザーページを開く",
      "配信者名のクリック・タッチでも同じプロフィールページへ移動できるよう改善",
      "Kickのチャンネル名から正しいURLを生成し、Windows既定のブラウザーで開く",
      "タッチ・キーボード操作の対応とクリック可能な表示、URLの安全性チェックを追加",
      "録画・コメント・AI記事と動画サムネイルの保存処理は変更しない"
    ]
  },
  {
    version: "0.3.5-alpha.68",
    title: "録画ライブラリをコンパクト化・動画フレームのサムネイルに対応",
    changes: [
      "大きな配信カードを約75pxのコンパクトな行に変更し一度に多くの配信を表示",
      "保存済み動画の映像からFFmpegで320x180のサムネイルを生成・キャッシュ",
      "動画プレビューをクリックすると保存した録画の再生を開始",
      "動画・コメント・AI記事の詳細は必要な配信だけ展開できるよう整理",
      "配信者一覧の二重スクロールをなくして画面全体でスクロール",
      "壊れた動画や録画中はサムネイル取得をスキップし従来表示に戻す"
    ]
  },
  {
    version: "0.3.4-alpha.67",
    title: "録画・コメントのファイル名を配信者名と配信日時に統一",
    changes: [
      "Kickの配信者表示名・チャンネル名・配信開始日時を動画とコメントのファイル名に反映",
      "LIVE映像とJSONLコメントは同じ配信日時を使い、配信ごとに整理",
      "VOD動画とJSONL・TXT・ASSも過去配信の実際の開始日時で命名",
      "取得できないVOD配信日時は日時未取得と明示し、ダウンロード時刻と区別",
      "旧ファイル名も録画ライブラリで引き続き閲覧可能。既存ファイルは自動改名しない"
    ]
  },
  {
    version: "0.3.3-alpha.66",
    title: "Kickアイコンと番組別コメント表示で録画ライブラリ改善",
    changes: [
      "Kickのプロフィールアイコンと表示名を配信者別カードへ自動取得（未登録の過去録画も対象）",
      "Nico版風の丸いアイコンと配信者・録画・コメント情報の配置を調整",
      "録画に付属するJSONLコメントをファイル単位で閲覧・開く・保存場所を表示",
      "AI記事付き録画の件数と絞り込みを追加",
      "削除済みの動画・コメントがライブラリに残らない同期処理を維持"
    ]
  },
  {
    version: "0.3.2-alpha.65",
    title: "録画ライブラリに残る削除済み動画・コメントの表示を修正",
    changes: [
      "保存先から動画・コメントを削除した場合、実ファイルがない配信カードを一覧から除外",
      "履歴JSONやAI記事だけで空の録画を再表示しない（AI記事は記事一覧に保持）",
      "ライブラリ表示中は10秒ごと、およびアプリに戻った際にディスクを再読み込み",
      "アプリ内で動画削除した直後も配信別一覧を更新",
      "ファイル削除後のコメント表示を整理し、録画ファイルを消さずにコメントのみ残る場合は表示を維持"
    ]
  },
  {
    version: "0.3.1-alpha.64",
    title: "旧β版を含む自動更新チャンネルの互換性を改善",
    changes: [
      "旧β版のbeta.yml、従来版のlatest.yml、α版のalpha.ymlを同じ最新インストーラーに統一",
      "旧版が更新を見つけられない場合の手動ダウンロード案内を追加",
      "録画・VODダウンロード中は更新のために再起動せずデータを保護",
      "毎回のα版公開で更新マニフェストのバージョン・ハッシュ一致を検証"
    ]
  },
  {
    version: "0.3.0-alpha.63",
    title: "録画途中切断の自動復旧と録画ライブラリの強化",
    changes: [
      "LIVE録画が配信終了前に切れた場合は配信状態を確認して再接続",
      "録画ファイルの書き込み停止・無応答を検知し、保存済み分割動画を保護",
      "登録配信者の録画が停止しても、LIVE継続中なら監視機能で復旧",
      "複数VODの同時ダウンロード、番組ごとの進捗・経過時間・停止操作を追加",
      "録画ライブラリで動画・コメント・AI記事を配信単位に表示",
      "α版自動更新用のalpha.ymlと旧版向けlatest.ymlを配布"
    ]
  },
  {
    version: "0.2.6-alpha.61",
    title: "リリースノートを読みやすく表示",
    changes: [
      "リリースノートのHTMLタグをそのまま表示せず、見出し・本文・箇条書きを整形",
      "強調文字・コード表記・文字実体参照を安全なテキストとして描画",
      "HTML・Markdown表示の回帰テストを追加"
    ]
  },
  {
    version: "0.2.5-alpha.60",
    title: "録画ライブラリの一覧表示・スクロールを改善",
    changes: [
      "録画ライブラリの横幅を広げ、配信者一覧の680px高さ制限を解除",
      "配信者ごとの録画一覧に独立した縦スクロールとキーボード操作を追加",
      "動画のファイル名と再生・場所表示・削除ボタンを広いレイアウトで表示し、小さい画面では自動折り返し"
    ]
  },
  {
    version: "0.2.4-alpha.59",
    title: "記事削除・放送画面の旧データ互換性を改善",
    changes: [
      "大文字・小文字の違うフォルダーが共存する場合、記事IDで正しい保存先を特定",
      "同じ記事IDが複数の場所にある場合は削除を中止して、ほかの記事を守る",
      "旧記事の放送画面表示と一覧取得を同じ保存先判定へ統一し、削除の自動テストを拡充"
    ]
  },
  {
    version: "0.2.3-alpha.58",
    title: "配信AI新聞の記事削除を復旧",
    changes: [
      "記事の古いLIVE表示では削除を止めず、実際に稼働中の配信セッションだけを削除不可に",
      "大文字・小文字が異なる旧記事フォルダーや、過去形式の記事IDも安全に照合",
      "記事JSONの削除と放送画面プレビューの後片付けを改善し、元動画・コメントログは保持"
    ]
  },
  {
    version: "0.2.2-alpha.57",
    title: "LIVE音声の停止・無反応を自動検出",
    changes: [
      "FFmpegの出力メディア時刻を監視し、90秒以上進捗がない音声プロセスを検出",
      "音声だけを停止・再接続し、LIVE映像の代表フレーム取得と記事更新は継続",
      "音声再接続の無進捗判定とタイムアウト境界を自動テストに追加"
    ]
  },
  {
    version: "0.2.1-alpha.56",
    title: "LIVE音声ストリームの自動再接続を強化",
    changes: [
      "LIVE音声のFFmpeg取得プロセスが通信切断・異常終了した場合、配信映像の取得を止めずに音声だけを再接続",
      "yt-dlpで音声ストリームURLを取り直し、5秒・10秒・20秒・40秒・最大60秒の待機時間で自動復旧",
      "再接続ごとに音声区間の時刻基準を再計算し、45秒WAV区間を配信経過時間へ合わせて保存",
      "音声再接続タイマー・URL解決プロセス・FFmpeg・一時WAVファイルを停止時に後片付け"
    ]
  },
  {
    version: "0.2.0-alpha.55",
    title: "LIVE配信記事・映像／音声の復旧機能を拡張",
    changes: [
      "配信AI新聞の記事カードに放送画面を掲載し、LIVE中は約25秒ごとに代表フレームを更新。録画済み配信も動画から代表画像を抽出",
      "LIVE映像のFFmpeg異常終了を検出し、古い接続を安全に解除して、配信状態の再確認後に段階的な自動再接続",
      "Ollamaの一時的な接続切れ・タイムアウト・HTTP 429／5xxでは音声区間を保持し、5秒から最大60秒の間隔で自動再試行",
      "映像・音声・コメントを利用するLIVE配信記事の取得継続性と復旧処理を強化"
    ]
  },
  {
    version: "0.1.2-alpha.54",
    title: "LIVE音声認識の自動復旧を改善",
    changes: [
      "Ollamaの一時的な接続切れ・タイムアウト・HTTP 429／5xxで、失敗した音声区間を保持して自動再試行",
      "再試行間隔を5秒・10秒・20秒・40秒・最大60秒へ段階的に延長し、再接続時に未処理区間から処理を再開",
      "モデル未導入・非対応形式などの恒久エラーは再試行せず、原因を記事に表示"
    ]
  },
  {
    version: "0.1.1-alpha.53",
    title: "LIVE映像キャプチャの自動復旧を改善",
    changes: [
      "LIVE映像解析のFFmpegが途中終了した場合、取得済みフレームがあっても異常終了として検出",
      "古いキャプチャ接続だけを安全に解除し、音声側プロセスと再接続タイマーを後処理",
      "未登録チャンネルの記事専用LIVEでもLIVE状態を再確認し、10・20・40・60秒の段階的な待機時間で再接続"
    ]
  },
  {
    version: "0.1.0-alpha.52",
    title: "配信AI新聞に放送画面を掲載",
    changes: [
      "LIVE配信の代表フレームを約25秒ごとに保存し、新聞記事カードの放送画面を自動更新",
      "録画済み配信の記事生成では、動画の中央付近から代表画面を抽出して掲載",
      "放送画面を記事JSONと分離したJPEGで保存し、記事一覧では表示直前に必要な画像だけを取得",
      "16:9の映像と記事見出し・要約を横並びにし、狭い画面では縦並びへ切り替え"
    ]
  },
  {
    version: "0.1.0-alpha.51",
    title: "LIVE AI映像解析とコメント同期を改善",
    changes: [
      "AI記事の解析中に新しい映像フレームが届いても、未解析フレームを解析済みとして数えないよう修正",
      "AI応答の完了後、解析待ちの映像フレームが残っている場合は設定した更新間隔に沿って次の解析を予約",
      "映像フレーム到着時のAI解析も設定した更新間隔を守り、短時間にAI処理が連続起動しないよう改善",
      "配信終了時の最終解析と通常のLIVE更新予約が競合しないよう、終了時に予約タイマーを解除",
      "新しいLIVE録画は録画プロセス起動時刻をRecordingMetadataへ保存し、コメント付き動画生成時の同期基準に利用",
      "実ログプレビューに同期方式と推定動画開始時刻を表示。メタデータのない過去動画はファイル名・更新時刻方式へ自動フォールバック",
      "OpenAI Responses／Chat Completions／Ollamaの応答形式を共通解析し、空のoutput_textだけで本文なしと誤判定する問題を修正",
      "Markdownコードフェンス付きJSONに対応し、拒否・出力上限・空応答の原因を診断しやすく改善"
    ]
  },
  {
    version: "0.1.0-beta.50",
    title: "無料Ollamaモデルをアプリ内から導入",
    changes: [
      "映像・記事生成用VisionモデルとQwen3-ASR音声認識モデルを、設定画面からワンクリックでダウンロード",
      "Ollamaのダウンロード進捗・取得容量・完了状態を表示し、途中キャンセルにも対応",
      "モデル名を変更して別モデルを導入可能。PowerShellでollama pullを手入力する初期設定を削減",
      "LIVE・録画済み配信の映像／音声／コメント統合記事と新聞ジャーナル表示はbeta49から継続"
    ]
  },
  {
    version: "0.1.0-beta.49",
    title: "映像・音声・コメントを統合した配信記事",
    changes: [
      "録画済み動画とLIVE配信から音声を45秒単位で抽出し、OllamaのQwen3-ASRで日本語文字起こし",
      "映像フレーム・時刻付き音声文字起こし・視聴者コメントを別々に分析し、AIが相互に照合して新聞記事風に統合",
      "記事カードに音声の要約・文字起こし・分析エラーを表示。LIVE終了時は音声認識キューを処理してから記事を最終化",
      "無料ローカル音声認識のON／OFFとモデル名を設定可能に",
      "元の配信タイトルとAI記事見出しを別々に保存し、録画済み動画の実再生時間も記事統計へ反映",
      "長時間録画の音声は全文を保存しつつ、AIには配信全体から均等に選んだ区間を渡して話題を偏らせない",
      "記事一覧を新聞ジャーナル風に再構成。LIVE速報・アーカイブの切替、日付別表示、本文・文字起こし検索に対応"
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
  removeEmotesFromAss: true,
  assAutoFlow: true,
  vodAssCrossingSeconds: 6,
  vodAssSpeedPercent: 100,
  vodAssEntryOffsetPx: 16,
  vodAssRowLimit: 16,
  vodAssCollisionGap: 40,
  vodAssDelaySeconds: 0,
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
      removeEmotesFromAss: settings.removeEmotesFromAss !== false,
      assAutoFlow: settings.assAutoFlow !== false,
      vodAssCrossingSeconds: typeof settings.vodAssCrossingSeconds === "number" && Number.isFinite(settings.vodAssCrossingSeconds)
        ? Math.max(2, Math.min(15, settings.vodAssCrossingSeconds)) : 6,
      vodAssSpeedPercent: typeof settings.vodAssSpeedPercent === "number" && Number.isFinite(settings.vodAssSpeedPercent)
        ? Math.max(50, Math.min(200, settings.vodAssSpeedPercent)) : 100,
      vodAssEntryOffsetPx: typeof settings.vodAssEntryOffsetPx === "number" && Number.isFinite(settings.vodAssEntryOffsetPx)
        ? Math.round(Math.max(0, Math.min(300, settings.vodAssEntryOffsetPx))) : 16,
      vodAssRowLimit: typeof settings.vodAssRowLimit === "number" && Number.isFinite(settings.vodAssRowLimit)
        ? Math.round(Math.max(1, Math.min(18, settings.vodAssRowLimit))) : 16,
      vodAssCollisionGap: typeof settings.vodAssCollisionGap === "number" && Number.isFinite(settings.vodAssCollisionGap)
        ? Math.round(Math.max(0, Math.min(200, settings.vodAssCollisionGap))) : 40,
      vodAssDelaySeconds: typeof settings.vodAssDelaySeconds === "number" && Number.isFinite(settings.vodAssDelaySeconds)
        ? Math.max(-10, Math.min(10, settings.vodAssDelaySeconds)) : 0,
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

function formatArticlePreviewTime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainingSeconds = total % 60;
  return hours > 0
    ? String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0") + ":" + String(remainingSeconds).padStart(2, "0")
    : String(minutes).padStart(2, "0") + ":" + String(remainingSeconds).padStart(2, "0");
}

function ArticleBroadcastFrame({ article, onOpenStoryboard }: { article: StreamArticle; onOpenStoryboard: (filePath: string, title: string) => void }) {
  const frameRef = useRef<HTMLElementTagNameMap["figure"] | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let observer: IntersectionObserver | null = null;
    setPreviewUrl(null);
    if (!article.videoPreviewAvailable || !window.kickRecorder) return;

    const loadPreview = (): void => {
      void window.kickRecorder?.getStreamArticlePreview(article.slug, article.id)
        .then(url => { if (!cancelled) setPreviewUrl(url); })
        .catch(() => { if (!cancelled) setPreviewUrl(null); });
    };

    if (typeof IntersectionObserver !== "undefined" && frameRef.current) {
      observer = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          observer?.disconnect();
          loadPreview();
        }
      }, { rootMargin: "280px" });
      observer.observe(frameRef.current);
    } else {
      loadPreview();
    }

    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, [article.slug, article.id, article.videoPreviewAvailable, article.videoPreviewUpdatedAt]);

  return <figure ref={frameRef} className={previewUrl ? "article-broadcast-frame has-image" : "article-broadcast-frame is-empty"}>
    {previewUrl
      ? <img src={previewUrl} alt={article.displayName + "の配信画面"} loading="lazy" />
      : <div className="article-broadcast-placeholder">
          <span className="article-broadcast-placeholder-mark" aria-hidden="true">▶</span>
          <strong>放送画面は未取得です</strong>
          <small>{article.videoPreviewAvailable
            ? "放送画面を読み込み中、または画像が見つかりません"
            : article.status === "live"
              ? "LIVE映像の代表フレームを待っています"
              : article.sourceVideo
                ? "録画から画像を取得するには記事を再生成してください"
                : "この記録には保存済みの映像がありません"}</small>
        </div>}
    <figcaption>
      <span>放送画面</span>
      <span>{typeof article.videoPreviewTimeSeconds === "number"
        ? "開始から " + formatArticlePreviewTime(article.videoPreviewTimeSeconds)
        : article.status === "live" ? "LIVEフレーム" : "代表フレーム"}</span>
    </figcaption>
    {article.status === "live" && <span className="article-broadcast-live-pill"><i /> LIVE</span>}
    {article.sourceVideo && <button className="article-broadcast-gallery-button" type="button"
      onClick={() => onOpenStoryboard(article.sourceVideo, article.headline)}
      title="録画から時刻別の場面一覧を表示">場面プレビュー</button>}
  </figure>;
}

function LibraryChannelAvatar({ displayName, picture, onOpenProfile }: {
  displayName: string; picture: string | null; onOpenProfile: () => void
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [picture]);
  const safePicture = typeof picture === "string" && /^https:\/\//i.test(picture) ? picture : null;
  return <button type="button" className="recording-channel-avatar" onClick={onOpenProfile}
    title={displayName + "のKickユーザーページを開く"}
    aria-label={displayName + "のKickユーザーページを開く"}>
    <span aria-hidden="true">{displayName.slice(0, 1).toUpperCase()}</span>
    {safePicture && !failed && <img src={safePicture} alt="" loading="lazy" referrerPolicy="no-referrer"
      onError={() => setFailed(true)} />}
  </button>;
}

function LibraryRecordingThumbnail({ filePath, onPreview }: { filePath: string | null; onPreview: () => void }) {
  const elementRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [thumbnail, setThumbnail] = useState<string | null>(null);

  useEffect(() => {
    setVisible(false);
    setThumbnail(null);
    if (!filePath) return;
    const node = elementRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    // Off-screen broadcasts must not start hundreds of FFmpeg extractions at once.
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "140px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [filePath]);

  useEffect(() => {
    if (!visible || !filePath || !window.kickRecorder?.getRecordingThumbnail) return;
    let active = true;
    void window.kickRecorder.getRecordingThumbnail(filePath).then(data => {
      if (active && data?.startsWith("data:image/jpeg;base64,")) setThumbnail(data);
    }).catch(() => {
      // Video and its actions remain visible if FFmpeg cannot extract a frame.
    });
    return () => { active = false; };
  }, [visible, filePath]);

  return <button ref={elementRef} type="button" className="recording-session-thumbnail"
    onClick={onPreview} disabled={!filePath}
    title={filePath ? "録画の時刻別場面プレビューを開く" : "録画動画がありません"}
    aria-label={filePath ? "録画の時刻別場面プレビューを開く" : "録画動画なし"}>
    {thumbnail ? <img src={thumbnail} alt="録画動画から抽出したサムネイル" loading="lazy"
      onError={() => setThumbnail(null)} /> : <span aria-hidden="true">{filePath ? "▶" : "☷"}</span>}
  </button>;
}

function RecordingStoryboardDialog({ filePath, title, onClose }: {
  filePath: string | null; title: string; onClose: () => void
}) {
  const [data, setData] = useState<{
    durationSeconds: number; frames: Array<{ timeSeconds: number; imageDataUrl: string }>
  } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!filePath) return;
    let active = true;
    setData(null);
    setError("");
    setSelectedIndex(0);
    setLoading(true);
    closeButtonRef.current?.focus();
    if (!window.kickRecorder?.getRecordingStoryboard) {
      setLoading(false);
      setError("この機能には最新のWindows版が必要です。");
      return;
    }
    void window.kickRecorder.getRecordingStoryboard(filePath)
      .then(result => { if (active) { setData(result); setLoading(false); } })
      .catch(problem => {
        if (active) {
          setError(problem instanceof Error ? problem.message : String(problem));
          setLoading(false);
        }
      });
    return () => { active = false; };
  }, [filePath]);

  useEffect(() => {
    if (!filePath) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [filePath, onClose]);

  if (!filePath) return null;
  const selected = data?.frames[selectedIndex] ?? data?.frames[0];
  return <div className="storyboard-overlay" onMouseDown={event => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="storyboard-dialog" role="dialog" aria-modal="true" aria-label="録画の時刻別場面プレビュー">
      <header className="storyboard-header">
        <div><span className="storyboard-kicker">録画の場面一覧</span><h3 title={title}>{title}</h3>
          <small>元動画から抽出した静止画です。画像を選ぶと左側の代表画面が切り替わります。</small>
        </div>
        <button ref={closeButtonRef} type="button" className="small-action" onClick={onClose}>閉じる ✕</button>
      </header>
      {loading && <div className="storyboard-status" role="status">動画を確認して時刻別のサムネイルを作成しています。長い配信では少し時間がかかります…</div>}
      {error && <div className="storyboard-status storyboard-error" role="alert">{error}</div>}
      {data && data.frames.length > 0 && <div className="storyboard-layout">
        <div className="storyboard-featured">
          {selected && <><img src={selected.imageDataUrl} alt={"録画の開始から" + formatArticlePreviewTime(selected.timeSeconds) + "の場面"} />
            <span className="storyboard-featured-time">{formatArticlePreviewTime(selected.timeSeconds)}</span></>}
          <div className="storyboard-meta"><strong>{data.frames.length}場面を抽出</strong>
            <span>動画の長さ {formatArticlePreviewTime(data.durationSeconds)}</span></div>
          <div className="storyboard-actions">
            <button type="button" className="primary-small" onClick={() => void window.kickRecorder?.openRecording(filePath)}>元動画を再生</button>
            <button type="button" className="small-action" onClick={() => void window.kickRecorder?.revealRecording(filePath)}>保存先を開く</button>
          </div>
          <small className="storyboard-note">プレビューは動画の一部です。選択した時刻からの再生ではなく、元動画を既定のプレーヤーで開きます。</small>
        </div>
        <div className="storyboard-gallery" role="group" aria-label="時刻別の放送場面一覧">
          {data.frames.map((frame, index) => <button type="button"
            key={frame.timeSeconds + ":" + index}
            className={"storyboard-tile" + (selectedIndex === index ? " is-selected" : "")}
            aria-label={"開始から " + formatArticlePreviewTime(frame.timeSeconds) + " の場面"}
            aria-pressed={selectedIndex === index} onClick={() => setSelectedIndex(index)}>
            <img src={frame.imageDataUrl} loading="lazy" alt="" />
            <time>{formatArticlePreviewTime(frame.timeSeconds)}</time>
          </button>)}
        </div>
      </div>}
    </section>
  </div>;
}

export default function App() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [recordingOnlyChannels, setRecordingOnlyChannels] = useState<Channel[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [newChannel, setNewChannel] = useState("");
  const [newRecordingOnlyChannel, setNewRecordingOnlyChannel] = useState("");
  const [vodUrl, setVodUrl] = useState("");
  const [vodDownloadStatus, setVodDownloadStatus] = useState("");
  const [vodJobs, setVodJobs] = useState<VodDownloadJob[]>([]);
  const [vodClock, setVodClock] = useState(Date.now());
  const [vodChatStatus, setVodChatStatus] = useState("");
  const [vodChatActive, setVodChatActive] = useState(false);
  const [savedVodAssPath, setSavedVodAssPath] = useState("");
  const [savedVodAssBusy, setSavedVodAssBusy] = useState(false);
  const [savedVodAssStatus, setSavedVodAssStatus] = useState("");
  useEffect(() => {
    const ticker = window.setInterval(() => setVodClock(Date.now()), 1000);
    return () => window.clearInterval(ticker);
  }, []);
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
  const [libraryProfiles, setLibraryProfiles] = useState<Record<string, ChannelCheck>>({});
  const libraryProfileLastFetchRef = useRef<Map<string, number>>(new Map());
  const [libraryProfileRefreshKey, setLibraryProfileRefreshKey] = useState(0);
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
  const [storyboardTarget, setStoryboardTarget] = useState<{ path: string; title: string } | null>(null);
  const [recordingSessions, setRecordingSessions] = useState<LibrarySession[]>([]);
  const [isLoadingRecordings, setIsLoadingRecordings] = useState(false);
  const [deletingRecordingPath, setDeletingRecordingPath] = useState<string | null>(null);
  const [deletingCommentLogPath, setDeletingCommentLogPath] = useState<string | null>(null);
  const [recordingMessage, setRecordingMessage] = useState("");
  const [libraryRefreshKey, setLibraryRefreshKey] = useState(0);
  const libraryLoadedOnceRef = useRef(false);
  const [librarySearch, setLibrarySearch] = useState("");
  const [libraryTypeFilter, setLibraryTypeFilter] = useState<"all" | "videos" | "comments" | "articles">("all");
  const [isLoadingLibraryLogs, setIsLoadingLibraryLogs] = useState(false);
  const [expandedLibraryVideosChannel, setExpandedLibraryVideosChannel] = useState<string | null>(null);
  const [expandedLibrarySessions, setExpandedLibrarySessions] = useState<Record<string, boolean>>({});
  const [libraryCommentsChannel, setLibraryCommentsChannel] = useState<string | null>(null);
  const [libraryComments, setLibraryComments] = useState<LibraryCommentMessage[]>([]);
  const [isLoadingLibraryComments, setIsLoadingLibraryComments] = useState(false);
  const [libraryCommentsError, setLibraryCommentsError] = useState("");
  const [librarySelectedLogPath, setLibrarySelectedLogPath] = useState<string | null>(null);
  const [libraryLogMessages, setLibraryLogMessages] = useState<LibraryCommentMessage[]>([]);
  const [libraryLogLoading, setLibraryLogLoading] = useState(false);
  const [libraryLogError, setLibraryLogError] = useState("");
  const libraryLogRequestRef = useRef(0);
  const libraryCommentRequestRef = useRef(0);
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
  const [articleSelectedLogPaths, setArticleSelectedLogPaths] = useState<string[]>([]);
  const [reanalyzingArticleId, setReanalyzingArticleId] = useState<string | null>(null);
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
  const [aiModelPullBusy, setAiModelPullBusy] = useState(false);
  const [aiModelPullStatus, setAiModelPullStatus] = useState<AiModelPullStatus | null>(null);

  const filteredStreamArticles = useMemo(() => {
    const query = articleSearch.trim().toLocaleLowerCase("ja-JP");
    return streamArticles.filter(article => {
      const isLive = article.status === "live";
      if (articleStatusFilter === "live" && !isLive) return false;
      if (articleStatusFilter === "archive" && isLive) return false;
      if (!query) return true;
      return [
        article.displayName, article.slug, article.headline, article.streamTitle ?? "", article.category, article.aiSummary ?? "",
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
  const recordingLibraryChannels = useMemo<RecordingLibraryChannel[]>(() => {
    const groups = new Map<string, RecordingLibraryChannel>();
    const ensure = (raw: string) => {
      const slug = raw.toLowerCase();
      if (!/^[a-zA-Z0-9_-]{1,40}$/.test(slug)) return null;
      let group = groups.get(slug);
      if (!group) {
        const registered = [...channels, ...recordingOnlyChannels].find(ch => ch.name.toLowerCase() === slug);
        const profile = libraryProfiles[slug];
        const monitored = channelChecks[slug];
        group = {
          slug,
          displayName: profile?.found && profile.displayName ? profile.displayName
            : monitored?.displayName || registered?.name || slug,
          profilePicture: profile?.profilePicture || monitored?.profilePicture || null,
          videos: [], logs: [], sessions: [], latestAt: ""
        };
        groups.set(slug, group);
      }
      return group;
    };
    for (const session of recordingSessions) ensure(session.slug)?.sessions.push(session);
    for (const file of recordingFiles) {
      const slug = getRecordingChannelSlug(file.name);
      if (slug) ensure(slug)?.videos.push(file);
    }
    for (const log of commentLogFiles) ensure(log.channelSlug)?.logs.push(log);
    return [...groups.values()].map(group => {
      const timestamps = [...group.videos, ...group.logs].map(f => Date.parse(f.modifiedAt))
        .concat(group.sessions.map(x => Date.parse(x.startedAt)))
        .filter(Number.isFinite);
      return {
        ...group,
        latestAt: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : "",
        sessions: [...group.sessions].sort((a,b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)),
        videos: [...group.videos].sort((a,b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt)),
        logs: [...group.logs].sort((a,b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))
      };
    }).sort((a,b) => Date.parse(b.latestAt) - Date.parse(a.latestAt));
  }, [recordingSessions, recordingFiles, commentLogFiles, channels, recordingOnlyChannels, channelChecks, libraryProfiles]);

  const libraryProfileSlugs = recordingLibraryChannels.map(group => group.slug)
    .filter(slug => /^[a-zA-Z0-9_]{1,25}$/.test(slug)).join("|");

  useEffect(() => {
    if (tab !== "library" || !isDesktop || !window.kickRecorder || !libraryProfileSlugs) return;
    const now = Date.now();
    const slugs = libraryProfileSlugs.split("|").filter(slug =>
      (libraryProfileLastFetchRef.current.get(slug) ?? 0) <= now);
    if (!slugs.length) return;
    let cancelled = false;
    // Fetch historically recorded broadcasters as well as watched ones. Do not
    // call Kick every 10s when the filesystem scanner refreshes the list.
    void (async () => {
      for (let i = 0; i < slugs.length && !cancelled; i += 50) {
        const batch = slugs.slice(i, i + 50);
        try {
          const profiles = await window.kickRecorder!.checkKickChannels(batch);
          if (cancelled) return;
          const fetchedAt = Date.now();
          for (const slug of batch) libraryProfileLastFetchRef.current.set(slug, fetchedAt + 6 * 60 * 60 * 1000);
          setLibraryProfiles(previous => ({
            ...previous,
            ...Object.fromEntries(profiles.filter(profile => profile.found).map(profile => [profile.slug, profile]))
          }));
        } catch {
          if (cancelled) return;
          // Credentials, rate limits or connection errors must not block the
          // library: keep text avatars and allow a retry after 2 minutes.
          for (const slug of batch) libraryProfileLastFetchRef.current.set(slug, Date.now() + 2 * 60 * 1000);
          return;
        }
      }
    })();
    return () => { cancelled = true; };
  }, [tab, isDesktop, libraryProfileSlugs, libraryProfileRefreshKey]);

  const filteredRecordingLibraryChannels = useMemo(() => {
    const query = librarySearch.trim().toLocaleLowerCase("ja-JP");
    return recordingLibraryChannels.filter(group => {
      if (libraryTypeFilter === "videos" && group.sessions.every(item => item.videos.length === 0)) return false;
      if (libraryTypeFilter === "comments" && group.sessions.every(item => item.logs.length === 0)) return false;
      if (libraryTypeFilter === "articles" && group.sessions.every(item => !item.article)) return false;
      if (!query) return true;
      const searchable = [
        group.slug, group.displayName,
        ...group.videos.map(file => file.name),
        ...group.logs.map(file => file.name),
        ...group.sessions.flatMap(session => [session.title, session.article?.headline ?? "", session.article?.aiSummary ?? ""])
      ].join(" ").toLocaleLowerCase("ja-JP");
      return searchable.includes(query);
    });
  }, [recordingLibraryChannels, librarySearch, libraryTypeFilter]);

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
    let unsubscribeVodDownload: (() => void) | undefined;
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
      unsubscribeVodDownload = window.kickRecorder.onVodDownloadStatus((job: VodDownloadJob) => {
        if (!active) return;
        setVodJobs(previous => previous.some(item => item.id === job.id)
          ? previous.map(item => item.id === job.id ? job : item)
          : [job, ...previous]);
        if (job.status === "completed") setLibraryRefreshKey(value => value + 1);
      });
      void window.kickRecorder.listVodDownloads().then(jobs => {
        if (active) setVodJobs(previous => {
          const latest = new Map(jobs.map(job => [job.id, job]));
          for (const job of previous) latest.set(job.id, job);
          return [...latest.values()].reverse();
        });
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
      unsubscribeVodDownload?.();
      unsubscribeCommentVideo?.();
      unsubscribeBackgroundMonitor?.();
    };
  }, []);

  // Keep the saved VOD log selector available on the recording page, not only in the video composer.
  useEffect(() => {
    if (tab !== "recording" || !isDesktop || !window.kickRecorder) return;
    let active = true;
    void window.kickRecorder.listCommentLogFiles().then(logs => {
      if (active) setCommentLogFiles(logs);
    }).catch(error => {
      if (active) setSavedVodAssStatus(error instanceof Error ? error.message : "保存済みVODログを読み込めませんでした。");
    });
    return () => { active = false; };
  }, [tab, isDesktop, libraryRefreshKey, settings.outputDirectory]);

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
    // Load all three lists together. Separate requests can temporarily display
    // deleted files from an older snapshot alongside newly refreshed sessions.
    if (!libraryLoadedOnceRef.current) {
      setIsLoadingRecordings(true);
      setIsLoadingLibraryLogs(true);
    }
    void Promise.all([
      window.kickRecorder.listRecordings(),
      window.kickRecorder.listLibrarySessions(),
      window.kickRecorder.listCommentLogFiles()
    ]).then(([files, sessions, logs]) => {
      if (!active) return;
      setRecordingFiles(files);
      setRecordingSessions(sessions.filter(session => session.videos.length > 0 || session.logs.length > 0));
      setCommentLogFiles(logs);
      libraryLoadedOnceRef.current = true;
    }).catch(error => {
      if (active) setRecordingMessage(error instanceof Error ? error.message : "録画・コメント一覧を取得できませんでした。");
    }).finally(() => {
      if (active) {
        setIsLoadingRecordings(false);
        setIsLoadingLibraryLogs(false);
      }
    });
    return () => { active = false; };
  }, [tab, isDesktop, libraryRefreshKey, settings.outputDirectory]);

  useEffect(() => {
    if (tab !== "library" || !isDesktop || !window.kickRecorder) return;
    // Explorer deletions are not routed through Electron IPC. Re-scan while
    // the library is visible, and again when the user focuses the app.
    const refreshIfVisible = () => {
      if (document.visibilityState !== "hidden") setLibraryRefreshKey(value => value + 1);
    };
    const timer = window.setInterval(refreshIfVisible, 10_000);
    window.addEventListener("focus", refreshIfVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshIfVisible);
    };
  }, [tab, isDesktop]);

  useEffect(() => {
    if (tab !== "library" || !libraryCommentsChannel || !libraryLoadedOnceRef.current) return;
    // A visible comment viewer must not keep displaying old JSONL rows after
    // the last log was removed in Explorer.
    if (commentLogFiles.some(log => log.channelSlug.toLowerCase() === libraryCommentsChannel.toLowerCase())) return;
    setLibraryCommentsChannel(null);
    setLibraryComments([]);
    setLibraryCommentsError("");
  }, [tab, libraryCommentsChannel, commentLogFiles]);

  useEffect(() => {
    if (librarySelectedLogPath && !commentLogFiles.some(log => log.path === librarySelectedLogPath)) {
      libraryLogRequestRef.current += 1;
      setLibrarySelectedLogPath(null);
      setLibraryLogMessages([]);
      setLibraryLogError("");
      setLibraryLogLoading(false);
    }
  }, [commentLogFiles, librarySelectedLogPath]);

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
    const unsubscribePull = window.kickRecorder.onAiArticleModelPullStatus(status => {
      if (!active) return;
      setAiModelPullStatus(status);
      if (status.done) {
        setAiModelPullBusy(false);
        setAiArticleMessage(status.error || `モデル「${status.model}」のインストールが完了しました。`);
      }
    });
    return () => { active = false; unsubscribe(); unsubscribePull(); };
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
      delaySeconds: commentVideoDelay,
      removeEmotes: settings.removeEmotesFromAss,
      position: commentVideoPosition
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
  }, [tab, isDesktop, selectedCommentVideoPath, selectedCommentLogPaths, commentVideoDelay, commentVideoPosition, libraryRefreshKey, settings.outputDirectory, settings.removeEmotesFromAss]);

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

  async function openRecordingFolder() {
    if (!window.kickRecorder) return;
    try {
      await window.kickRecorder.openRecordingFolder();
      setRecordingMessage("");
    } catch (error) {
      setRecordingMessage(error instanceof Error ? error.message : "保存場所を開けませんでした。");
    }
  }

  async function toggleLibraryLog(log: CommentLogFile) {
    if (!window.kickRecorder) return;
    if (librarySelectedLogPath === log.path) {
      libraryLogRequestRef.current += 1;
      setLibrarySelectedLogPath(null);
      setLibraryLogMessages([]);
      setLibraryLogError("");
      setLibraryLogLoading(false);
      return;
    }
    const id = ++libraryLogRequestRef.current;
    setLibrarySelectedLogPath(log.path);
    setLibraryLogMessages([]);
    setLibraryLogError("");
    setLibraryLogLoading(true);
    try {
      const messages = await window.kickRecorder.listCommentFileMessages(log.channelSlug, log.name, 100);
      if (id === libraryLogRequestRef.current) setLibraryLogMessages(messages);
    } catch (error) {
      if (id === libraryLogRequestRef.current) {
        setLibraryLogError(error instanceof Error ? error.message : "コメントログを表示できませんでした。");
      }
    } finally {
      if (id === libraryLogRequestRef.current) setLibraryLogLoading(false);
    }
  }

  async function toggleLibraryComments(channelSlug: string) {
    if (!window.kickRecorder) return;
    if (libraryCommentsChannel === channelSlug) {
      libraryCommentRequestRef.current += 1;
      setLibraryCommentsChannel(null);
      setLibraryComments([]);
      setLibraryCommentsError("");
      setIsLoadingLibraryComments(false);
      return;
    }
    const requestId = ++libraryCommentRequestRef.current;
    setLibraryCommentsChannel(channelSlug);
    setLibraryComments([]);
    setLibraryCommentsError("");
    setIsLoadingLibraryComments(true);
    try {
      const messages = await window.kickRecorder.listRecentCommentMessages(channelSlug, 100);
      if (requestId === libraryCommentRequestRef.current) setLibraryComments(messages);
    } catch (error) {
      if (requestId === libraryCommentRequestRef.current) {
        setLibraryCommentsError(error instanceof Error ? error.message : "コメントを読み込めませんでした。");
      }
    } finally {
      if (requestId === libraryCommentRequestRef.current) setIsLoadingLibraryComments(false);
    }
  }

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
    const urls = vodUrl.trim().split(/\s+/).filter(Boolean);
    if (urls.length < 1 || urls.length > 20) {
      setVodDownloadStatus("Kick過去番組のURLを1行ずつ、1〜20件入力してください。");
      return;
    }
    setVodDownloadStatus("番組をダウンロード一覧に登録しています...");
    try {
      const jobs = await window.kickRecorder.enqueueVodDownloads(urls);
      setVodJobs(previous => {
        const ids = new Set(previous.map(item => item.id));
        return [...jobs.filter(job => !ids.has(job.id)).reverse(), ...previous];
      });
      setVodDownloadStatus(`${jobs.length}件を追加しました。同時ダウンロードは最大3件です。`);
    } catch (error) {
      setVodDownloadStatus(error instanceof Error ? error.message : "過去配信を登録できませんでした。");
    }
  }

  async function stopPastBroadcastDownload(id: string) {
    if (!window.kickRecorder) return;
    try {
      await window.kickRecorder.cancelVodDownload(id);
    } catch (error) {
      setVodDownloadStatus(error instanceof Error ? error.message : "停止できませんでした。");
    }
  }

  async function downloadPastBroadcastChat() {
    if (!window.kickRecorder) { setVodChatStatus("Windowsデスクトップ版で利用できます。"); return; }
    if (!vodUrl.trim()) { setVodChatStatus("先にKickの過去配信URLを入力してください。"); return; }
    setVodChatActive(true);
    setVodChatStatus("過去コメントの取得を準備しています...");
    try {
      const result = await window.kickRecorder.startVodChatDownload(vodUrl.trim().split(/\s+/)[0], settings.removeEmotesFromAss, {
        crossingSeconds: settings.vodAssCrossingSeconds,
        speedPercent: settings.vodAssSpeedPercent,
        entryOffsetPx: settings.vodAssEntryOffsetPx,
        rowLimit: settings.vodAssRowLimit,
        collisionGap: settings.vodAssCollisionGap,
        delaySeconds: settings.vodAssDelaySeconds,
        autoFlow: settings.assAutoFlow
      });
      setVodChatStatus("コメント取得を開始しました。保存先：" + result.outputDirectory);
    } catch (error) {
      setVodChatActive(false);
      setVodChatStatus(error instanceof Error ? error.message : "過去コメントを取得できませんでした。");
    }
  }

  async function regenerateSavedVodAssFromLog() {
    if (!window.kickRecorder || !savedVodAssPath || savedVodAssBusy) return;
    setSavedVodAssBusy(true);
    setSavedVodAssStatus("保存済みJSONLからASS字幕を再生成しています...");
    try {
      const result = await window.kickRecorder.regenerateSavedVodAss(savedVodAssPath, settings.removeEmotesFromAss, {
        autoFlow: settings.assAutoFlow,
        crossingSeconds: settings.vodAssCrossingSeconds,
        speedPercent: settings.vodAssSpeedPercent,
        entryOffsetPx: settings.vodAssEntryOffsetPx,
        rowLimit: settings.vodAssRowLimit,
        collisionGap: settings.vodAssCollisionGap,
        delaySeconds: settings.vodAssDelaySeconds
      });
      setSavedVodAssStatus("ASS再生成完了：" + result.generatedComments.toLocaleString("ja-JP") + "件（省略：" + result.skippedComments.toLocaleString("ja-JP") + "件）。保存先：" + result.outputPath);
      setLibraryRefreshKey(value => value + 1);
    } catch (error) {
      setSavedVodAssStatus(error instanceof Error ? error.message : "ASS再生成に失敗しました。");
    } finally {
      setSavedVodAssBusy(false);
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
  async function openKickProfile(channelSlug: string) {
    if (!window.kickRecorder?.openKickProfile) {
      setRecordingMessage("Kickユーザーページを開くにはWindowsデスクトップ版を利用してください。");
      return;
    }
    try {
      await window.kickRecorder.openKickProfile(channelSlug);
    } catch (error) {
      setRecordingMessage(error instanceof Error ? error.message : "Kickのユーザーページを開けませんでした。");
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

  async function deleteCommentLogFromLibrary(log: CommentLogFile) {
    if (!window.kickRecorder || deletingCommentLogPath) return;
    const confirmed = window.confirm(
      "コメントログ「" + log.name + "」をWindowsのごみ箱へ移動しますか？\n\n" +
      "動画・AI記事など、他のファイルは削除しません。"
    );
    if (!confirmed) return;

    setDeletingCommentLogPath(log.path);
    setRecordingMessage("");
    try {
      const result = await window.kickRecorder.deleteCommentLog(log.path);
      setCommentLogFiles(current => current.filter(file => file.path !== log.path));
      setRecordingSessions(current => current.map(session => ({
        ...session, logs: session.logs.filter(file => file.path !== log.path)
      })).filter(session => session.videos.length > 0 || session.logs.length > 0));
      setSelectedCommentLogPaths(current => current.filter(path => path !== log.path));
      // Discard previews and prevent in-flight reads from restoring deleted data.
      libraryLogRequestRef.current += 1;
      setLibrarySelectedLogPath(null);
      setLibraryLogMessages([]);
      setLibraryLogError("");
      setLibraryLogLoading(false);
      if (libraryCommentsChannel === log.channelSlug) {
        libraryCommentRequestRef.current += 1;
        setLibraryCommentsChannel(null);
        setLibraryComments([]);
        setLibraryCommentsError("");
        setIsLoadingLibraryComments(false);
      }
      setLibraryRefreshKey(value => value + 1);
      setRecordingMessage("コメントログ「" + result.name + "」をごみ箱へ移動しました。");
    } catch (error) {
      setRecordingMessage(error instanceof Error ? error.message : "コメントログを削除できませんでした。");
    } finally {
      setDeletingCommentLogPath(null);
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
      setRecordingSessions(current => current.map(session => ({
        ...session, videos: session.videos.filter(file => file.path !== filePath)
      })).filter(session => session.videos.length > 0 || session.logs.length > 0));
      // Also refresh the disk-backed index (including linked comments and AI article).
      setLibraryRefreshKey(value => value + 1);
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
        opacity: commentVideoOpacity, quality: commentVideoQuality, showUsername: commentVideoShowUsername,
        removeEmotes: settings.removeEmotesFromAss,
        autoFlow: settings.assAutoFlow
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

  async function pullAiArticleModel(model: string) {
    if (!window.kickRecorder || settings.aiArticleProvider !== "ollama" || aiModelPullBusy || !model.trim()) return;
    setAiModelPullBusy(true);
    setAiModelPullStatus({ model: model.trim(), status: "準備中", percent: 0, done: false });
    setAiArticleMessage("");
    try {
      const result = await window.kickRecorder.pullAiArticleModel(model.trim());
      setAiArticleMessage(`モデル「${result.model}」をOllamaへインストールしました。接続テストを実行して利用を確認してください。`);
    } catch (error) {
      setAiArticleMessage(error instanceof Error ? error.message : "Ollamaモデルをインストールできませんでした。");
    } finally {
      setAiModelPullBusy(false);
    }
  }

  async function cancelAiArticleModelPull() {
    if (!window.kickRecorder || !aiModelPullBusy) return;
    try {
      await window.kickRecorder.cancelAiArticleModelPull();
    } catch (error) {
      setAiArticleMessage(error instanceof Error ? error.message : "モデル取得をキャンセルできませんでした。");
    }
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
      const logs = articleSelectedLogPaths.slice(0, 31);
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
        ? `AI記事「${article.headline}」を保存しました。コメント${article.commentCount.toLocaleString("ja-JP")}件${article.videoAnalyzed ? `・映像フレーム${article.videoFrameCount ?? 0}枚` : ""}${article.audioAnalyzed ? `・音声${(article.audioSegmentCount ?? article.audioTranscriptSegments?.length ?? 0).toLocaleString("ja-JP")}区間` : ""}を分析しました。`
        : article.aiError ? `基本記事を保存しました。AI分析は未完了です：${article.aiError}`
        : `記事「${article.headline}」を保存しました。コメント${article.commentCount.toLocaleString("ja-JP")}件を集計しました。`);
      setArticleHeadline("");
    } catch (error) {
      setArticleMessage(error instanceof Error ? error.message : "記事の生成に失敗しました。");
    } finally {
      setArticleBusy(false);
    }
  }

  async function reanalyzeStreamArticle(article: StreamArticle) {
    if (!window.kickRecorder || reanalyzingArticleId) return;
    setReanalyzingArticleId(article.id);
    setArticleMessage("AI記事を再解析しています：" + article.headline);
    try {
      const refreshed = await window.kickRecorder.reanalyzeStreamArticle(article.slug, article.id);
      setStreamArticles(await window.kickRecorder.listStreamArticles());
      setArticleMessage(refreshed.aiError
        ? "再解析後も確認が必要です：" + refreshed.aiError
        : refreshed.aiGenerated ? "映像・音声・コメントのAI再解析が完了しました。" : "AI分析できるデータを確認してください。");
    } catch (error) {
      setArticleMessage(error instanceof Error ? error.message : "記事の再解析に失敗しました。");
    } finally {
      setReanalyzingArticleId(null);
    }
  }

  async function deleteStreamArticle(article: StreamArticle) {
    if (!window.kickRecorder || deletingArticleId) return;
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
      <div className="brand"><img className="brand-mark brand-icon" src="./app-icon.png" alt="" aria-hidden="true" /><div><strong>Kick Live Message Recorder</strong><small>配信映像・チャット記録</small></div></div>
      <div className="nav-label">メインメニュー</div>
      <button className={tab === "dashboard" ? "nav-item selected" : "nav-item"} onClick={() => setTab("dashboard")}>▦ <span>ダッシュボード</span></button>
      <button className={tab === "recording" ? "nav-item selected" : "nav-item"} onClick={() => setTab("recording")}>● <span>録画専用</span></button>
      <button className={tab === "library" ? "nav-item selected" : "nav-item"} onClick={() => setTab("library")}>▤ <span>録画ライブラリ</span></button>
      <button className={tab === "comment-video" ? "nav-item selected" : "nav-item"} onClick={() => setTab("comment-video")}>✦ <span>コメント付き動画</span></button>
      <button className={tab === "articles" ? "nav-item selected" : "nav-item"} onClick={() => setTab("articles")}>▤ <span>配信記事</span></button>
      <div className="nav-label">アプリ</div>
      <button className={tab === "updates" ? "nav-item selected" : "nav-item"} onClick={() => setTab("updates")}>↻ <span>バージョン更新</span></button>
      <button className={tab === "settings" ? "nav-item selected" : "nav-item"} onClick={() => setTab("settings")}>⚙ <span>設定</span></button>
      <div className="sidebar-bottom"><span className="status-dot" /> α版・開発テスト中<small>現在のバージョン {appVersion}</small></div>
    </aside>

    <main className={tab === "library" ? "main main-library" : "main"}>
      <header className="topbar">
        <div><span className="eyebrow">Kick 配信管理ツール</span><h1>{tab === "dashboard" ? "ダッシュボード" : tab === "recording" ? "録画専用" : tab === "library" ? "録画ライブラリ" : tab === "comment-video" ? "コメント付き動画を生成" : tab === "articles" ? "配信記事" : tab === "updates" ? "バージョン更新" : "設定"}</h1></div>
        <div className="top-actions"><span className="connection"><i /> {isDesktop ? "Windows デスクトップ版" : "ブラウザー版プレビュー"}</span><span className="alpha-tag">α版</span><img className="avatar avatar-brand" src="./app-icon.png" alt="Kick Live Message Recorder アイコン" /></div>
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

        {activeRecordingChannels.length > 0 && <section className="panel live-preview-panel">
          <div className="panel-heading">
            <div><h2>録画中の映像プレビュー</h2><p>Kick公式プレーヤーで現在録画している配信を表示します</p></div>
            <div className="panel-heading-actions">
              <span className="live-status live">● LIVE · {activeRecordingChannels.length}件</span>
              <button className="small-action" onClick={() => setSettings(previous => ({ ...previous, showRecordingPreview: !previous.showRecordingPreview }))}>
                プレビュー{settings.showRecordingPreview ? "OFF" : "ON"}
              </button>
            </div>
          </div>
          <div className="live-preview-frame">
            {settings.showRecordingPreview
              ? <iframe
              key={previewChannel?.name.toLowerCase()}
              src={previewChannel ? `https://player.kick.com/${encodeURIComponent(previewChannel.name)}?autoplay=true&muted=true` : "about:blank"}
              title={previewChannel ? `${previewChannel.name} のライブ映像` : "録画中の映像"}
              allow="autoplay; fullscreen; picture-in-picture"
              allowFullScreen
              loading="eager" />
              : <div className="preview-disabled-note">プレビューはOFFです。録画とコメント取得は継続しています。</div>}
          </div>
          <div className="live-preview-footer">
            <strong>{previewChannel?.name}</strong>
            <span>{settings.showRecordingPreview
              ? "音声はミュート状態で開始します。プレーヤー内の音量ボタンから変更できます。"
              : "プレビューOFFです。録画とコメント取得は継続しています。"}</span>
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
        {activeRecordingChannels.length > 0 && <section className="panel live-preview-panel">
          <div className="panel-heading">
            <div><h2>録画中の映像プレビュー</h2><p>Kick公式プレーヤーで現在録画している配信を表示します</p></div>
            <div className="panel-heading-actions">
              <span className="live-status live">● LIVE · {activeRecordingChannels.length}件</span>
              <button className="small-action" onClick={() => setSettings(previous => ({ ...previous, showRecordingPreview: !previous.showRecordingPreview }))}>
                プレビュー{settings.showRecordingPreview ? "OFF" : "ON"}
              </button>
            </div>
          </div>
          <div className="live-preview-frame">
            {settings.showRecordingPreview
              ? <iframe
              key={previewChannel?.name.toLowerCase()}
              src={previewChannel ? `https://player.kick.com/${encodeURIComponent(previewChannel.name)}?autoplay=true&muted=true` : "about:blank"}
              title={previewChannel ? `${previewChannel.name} のライブ映像` : "録画中の映像"}
              allow="autoplay; fullscreen; picture-in-picture"
              allowFullScreen
              loading="eager" />
              : <div className="preview-disabled-note">プレビューはOFFです。録画とコメント取得は継続しています。</div>}
          </div>
          <div className="live-preview-footer">
            <strong>{previewChannel?.name}</strong>
            <span>{settings.showRecordingPreview
              ? "音声はミュート状態で開始します。プレーヤー内の音量ボタンから変更できます。"
              : "プレビューOFFです。録画とコメント取得は継続しています。"}</span>
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
          <div className="vod-batch-form">
            <label htmlFor="vod-batch-urls">番組URL（1行につき1件、最大20件）</label>
            <textarea id="vod-batch-urls" value={vodUrl} onChange={event => setVodUrl(event.target.value)}
              rows={3} placeholder={"https://kick.com/channel/videos/動画ID\nhttps://kick.com/channel/videos/別の動画ID"}
              aria-label="Kick過去配信URL（複数入力）" />
            <button className="primary-small" onClick={() => void downloadPastBroadcast()} disabled={!isDesktop || !vodUrl.trim()}>まとめてダウンロード</button>
          </div>
          {vodDownloadStatus && <div className="api-message" role="status">{vodDownloadStatus}</div>}
          <div className="vod-job-list" aria-label="過去番組のダウンロード一覧">
            {vodJobs.length === 0 && <div className="empty-inline">ダウンロード待ちの番組はありません。</div>}
            {vodJobs.map(job => {
              const active = job.status === "queued" || job.status === "downloading";
              const elapsed = job.durationMs ?? (job.startedAt ? Math.max(0, vodClock - Date.parse(job.startedAt)) : 0);
              const formatTime = (seconds: number) => {
                const total = Math.max(0, Math.floor(seconds));
                return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].map(x => String(x).padStart(2, "0")).join(":");
              };
              const label = job.status === "queued" ? "待機中"
                : job.status === "downloading" ? "ダウンロード中"
                : job.status === "completed" ? "完了"
                : job.status === "cancelled" ? "停止" : "エラー";
              return <div className="vod-job" key={job.id}>
                <div className="vod-job-top">
                  <div className="vod-job-description"><strong>{job.slug} · {job.videoId}</strong><small title={job.url}>{job.url}</small></div>
                  <span className={`vod-job-badge ${job.status}`}>{label}</span>
                </div>
                <div className="vod-job-progress" role="progressbar" aria-label={`${job.slug}のダウンロード進捗`}
                  aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.progress ?? 0}>
                  <div style={{ width: `${job.progress ?? 0}%` }} />
                </div>
                <div className="vod-job-details">
                  <span>進捗：{job.progress == null ? "取得中" : `${job.progress.toFixed(1)}%`}</span>
                  <span>経過時間：{job.startedAt ? formatTime(elapsed / 1000) : "--:--:--"}</span>
                  {job.status === "downloading" && job.estimatedRemainingSeconds != null && <span>残り目安：{formatTime(job.estimatedRemainingSeconds)}</span>}
                  {job.startedAt && <span>開始：{new Date(job.startedAt).toLocaleTimeString("ja-JP")}</span>}
                  {job.finishedAt && <span>終了：{new Date(job.finishedAt).toLocaleTimeString("ja-JP")}</span>}
                </div>
                <div className="vod-job-bottom">
                  <small>{job.message}</small>
                  {active && <button className="small-action" onClick={() => void stopPastBroadcastDownload(job.id)}>この番組を停止</button>}
                </div>
              </div>;
            })}
          </div>
          <p className="settings-help">コメント取得は現在1番組ずつの処理です。複数URLを貼り付けた場合は先頭のURLが対象になります。ダウンロード一覧はアプリ再起動でリセットされますが、完成した動画は録画ライブラリに残ります。</p>
          <label className="comment-video-checkbox"><input type="checkbox" checked={settings.removeEmotesFromAss} onChange={event => setSettings(previous => ({ ...previous, removeEmotesFromAss: event.target.checked }))} disabled={vodChatActive} /><span>ASS出力時にemoteを削除する（JSONL・TXTの原文は保持）</span></label>
          <div className="settings-subsection">
            <div className="settings-subheading"><h3>過去配信ASSの流れ方（ニコ生風）</h3><span className="api-state connected">ASS専用</span></div>
            <label className="comment-video-checkbox"><input type="checkbox" checked={settings.assAutoFlow} onChange={event => setSettings(previous => ({ ...previous, assAutoFlow: event.target.checked }))} disabled={vodChatActive} /><span>コメントの速度・画面右端からの入り方を自動調整する（おすすめ）</span></label>
            <p className="settings-help">自動ONではコメントの長さ・直近の投稿密度から速度、進入位置、行を決め、必要なら最大1.2秒ずらして重なりを防ぎます。OFFで手動設定を使えます。</p>
            <div className="comment-video-settings-grid">
              <label className="comment-video-field"><span>画面横断の基準時間（秒）</span><input type="number" min="2" max="15" step="0.5" value={settings.vodAssCrossingSeconds} onChange={event => setSettings(previous => ({ ...previous, vodAssCrossingSeconds: Math.max(2, Math.min(15, Number(event.target.value) || 6)) }))} disabled={vodChatActive || settings.assAutoFlow} /><small>初期値6秒。小さいほど速く横切ります。</small></label>
              <label className="comment-video-field"><span>流れる速度（%）</span><input type="number" min="50" max="200" step="5" value={settings.vodAssSpeedPercent} onChange={event => setSettings(previous => ({ ...previous, vodAssSpeedPercent: Math.max(50, Math.min(200, Number(event.target.value) || 100)) }))} disabled={vodChatActive || settings.assAutoFlow} /><small>100%が標準、200%で2倍速。</small></label>
              <label className="comment-video-field"><span>右端から入る余白（px）</span><input type="number" min="0" max="300" step="8" value={settings.vodAssEntryOffsetPx} onChange={event => setSettings(previous => ({ ...previous, vodAssEntryOffsetPx: Math.max(0, Math.min(300, Number(event.target.value) || 0)) }))} disabled={vodChatActive || settings.assAutoFlow} /><small>0なら画面右端から、数値を大きくすると画面外から少し遅れて入ります。</small></label>
              <label className="comment-video-field"><span>投稿時刻との同期ずれ（秒）</span><input type="number" min="-10" max="10" step="0.1" value={settings.vodAssDelaySeconds} onChange={event => setSettings(previous => ({ ...previous, vodAssDelaySeconds: Math.max(-10, Math.min(10, Number(event.target.value) || 0)) }))} disabled={vodChatActive} /><small>＋は遅らせ、－は早めに出します。</small></label>
              <label className="comment-video-field"><span>最大コメント行数</span><input type="number" min="1" max="18" step="1" value={settings.vodAssRowLimit} onChange={event => setSettings(previous => ({ ...previous, vodAssRowLimit: Math.round(Math.max(1, Math.min(18, Number(event.target.value) || 1))) }))} disabled={vodChatActive || settings.assAutoFlow} /><small>同時コメントが集中しても同じ行に無理に重ねません。</small></label>
              <label className="comment-video-field"><span>同じ行の最小間隔（px）</span><input type="number" min="0" max="200" step="4" value={settings.vodAssCollisionGap} onChange={event => setSettings(previous => ({ ...previous, vodAssCollisionGap: Math.round(Math.max(0, Math.min(200, Number(event.target.value) || 0))) }))} disabled={vodChatActive || settings.assAutoFlow} /><small>コメントの後端と次のコメントの先頭の距離です。</small></label>
            </div>
            <div className="comment-video-actions"><button className="small-action" type="button" disabled={vodChatActive || settings.assAutoFlow} onClick={() => setSettings(previous => ({ ...previous, vodAssCrossingSeconds: 6, vodAssSpeedPercent: 100, vodAssEntryOffsetPx: 16, vodAssDelaySeconds: 0, vodAssRowLimit: 16, vodAssCollisionGap: 40 }))}>ニコ生風おすすめ設定に戻す</button></div>
            <p className="settings-help">ONの間は同期ずれだけ手動調整できます。ほかの数値設定はOFFで使用します。これらの設定はASSファイルだけに適用されます。JSONL・TXTは元のコメントと投稿時刻を保持します。コメント付き動画側の速度・文字サイズ設定は別項目です。</p>
          </div>
          <div className="add-channel vod-chat-actions">
            <button className="primary-small" onClick={() => void downloadPastBroadcastChat()} disabled={!isDesktop || vodChatActive}>過去配信のコメントを取得（JSONL・TXT・ASS）</button>
            {vodChatActive && <button className="remove" onClick={() => void stopPastBroadcastChat()}>コメント取得を停止</button>}
          </div>
          {vodChatStatus && <div className="api-message" role="status">{vodChatStatus}</div>}
          <div className="settings-subsection">
            <div className="settings-subheading"><h3>保存済みVODコメントからASSを再生成</h3><span className="api-state connected">オフライン変換</span></div>
            <p className="settings-help">ダウンロード済みのJSONLを再利用します。上で選んだニコ生風の自動／手動調整やemote設定が反映され、Kickへの再接続は不要です。元のJSONL・TXT・既存ASSは上書きしません。</p>
            <div className="add-channel vod-chat-actions">
              <select aria-label="保存済みVODコメントJSONLを選択" value={savedVodAssPath}
                onChange={event => setSavedVodAssPath(event.target.value)} disabled={!isDesktop || savedVodAssBusy || vodChatActive}>
                <option value="">保存済みVODコメントを選択</option>
                {commentLogFiles.filter(file => file.kind === "VOD").map(file =>
                  <option key={file.path} value={file.path}>{file.channelSlug} / {file.name}</option>)}
              </select>
              <button className="primary-small" onClick={() => void regenerateSavedVodAssFromLog()}
                disabled={!isDesktop || !savedVodAssPath || savedVodAssBusy || vodChatActive}>選択したJSONLからASSを再生成</button>
            </div>
            {commentLogFiles.every(file => file.kind !== "VOD") && <p className="settings-help">VODの保存済みJSONLはまだありません。まず過去配信のコメントを取得してください。</p>}
            {savedVodAssStatus && <div className="api-message" role="status">{savedVodAssStatus}</div>}
          </div>
          <div className="notice">公開状態で取得可能なVODが対象です。コメントは配信開始からの経過時刻・投稿者名・本文を保持し、ChatフォルダーにJSONL・TXT・ASSで保存します。ASSは画面右から左へ流れるニコ生風字幕で、上の速度・進入位置・行数・間隔・同期タイミングを変更できます。Kick側の非公開設定やアクセス制限、API仕様変更により取得できない場合があります。</div>
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

      {tab === "library" && <section className="recording-library-page">
        <div className="recording-library-page-header">
          <div>
            <span className="eyebrow">RECORDING LIBRARY</span>
            <h2>録画ライブラリ</h2>
            <p>配信者別に保存された動画とコメントログをまとめて管理します。保存先の変更は一覧表示中に自動反映します。</p>
          </div>
          <div className="recording-library-page-actions">
            <button className="small-action" onClick={() => void openRecordingFolder()} disabled={!isDesktop}>保存場所を開く</button>
            <button className="primary-small" onClick={() => { libraryProfileLastFetchRef.current.clear(); setLibraryProfileRefreshKey(value => value + 1); setLibraryRefreshKey(value => value + 1); }} disabled={!isDesktop || isLoadingRecordings || isLoadingLibraryLogs || deletingRecordingPath !== null}>一覧を更新</button>
          </div>
        </div>

        <div className="recording-library-stats">
          <div className="recording-library-stat"><span>登録ファイル</span><strong>{(recordingFiles.length + commentLogFiles.length).toLocaleString("ja-JP")}</strong></div>
          <div className="recording-library-stat"><span>録画動画</span><strong>{recordingFiles.length.toLocaleString("ja-JP")}</strong></div>
          <div className="recording-library-stat"><span>コメントログ</span><strong>{commentLogFiles.length.toLocaleString("ja-JP")}</strong></div>
          <div className="recording-library-stat"><span>AI記事付きの配信</span><strong>{recordingSessions.filter(session => Boolean(session.article)).length.toLocaleString("ja-JP")}</strong></div>
        </div>

        <div className="recording-library-filter-row">
          <label>
            <span>検索</span>
            <input value={librarySearch} onChange={event => setLibrarySearch(event.target.value)} placeholder="配信者名・チャンネル名・動画名・ログ名で検索" />
          </label>
          <label>
            <span>表示する種類</span>
            <select value={libraryTypeFilter} onChange={event => setLibraryTypeFilter(event.target.value as "all" | "videos" | "comments" | "articles")}>
              <option value="all">すべて</option>
              <option value="videos">録画動画あり</option>
              <option value="comments">コメントログあり</option>
              <option value="articles">AI記事付きの録画</option>
            </select>
          </label>
        </div>

        {recordingMessage && <div className="api-message" role="status">{recordingMessage}</div>}
        {!isDesktop
          ? <div className="empty-state"><div className="empty-icon">▤</div><strong>Windowsデスクトップ版で利用できます</strong><span>ブラウザープレビューではPC内の動画・コメントログを読み取れません。</span></div>
          : isLoadingRecordings || isLoadingLibraryLogs
            ? <div className="empty-state"><strong>録画・コメント一覧を読み込み中...</strong></div>
            : recordingLibraryChannels.length === 0
              ? <div className="empty-state"><div className="empty-icon">▤</div><strong>保存された録画・コメントはありません</strong><span>Kick配信の録画またはコメント取得を行うと、配信者別にここへ表示されます。</span></div>
              : filteredRecordingLibraryChannels.length === 0
                ? <div className="empty-state"><strong>一致する配信者がありません</strong><span>検索語または表示する種類を変更してください。</span></div>
                : <div className="recording-channel-list">
                    {filteredRecordingLibraryChannels.map(group => <article className="recording-channel-card" key={group.slug}>
                      <div className="recording-channel-summary">
                        <LibraryChannelAvatar displayName={group.displayName} picture={group.profilePicture}
                          onOpenProfile={() => void openKickProfile(group.slug)} />
                        <div className="recording-channel-info">
                          <button type="button" className="recording-channel-profile-link"
                            onClick={() => void openKickProfile(group.slug)}
                            title={group.displayName + "のKickユーザーページを開く"}>
                            {group.displayName}
                          </button>
                          <small>@{group.slug}</small>
                          <small title="新規保存は配信者別フォルダー。以前の場所にある録画も引き続き表示します。">動画：Recordings/{group.slug} ・ コメント：Chat/{group.slug}</small>
                          <small>配信 {group.sessions.length}件 ・ 録画動画 {group.videos.length}件 ・ コメントログ {group.logs.length}件{group.latestAt ? " ・ 最終保存 " + new Date(group.latestAt).toLocaleString("ja-JP") : ""}</small>
                        </div>
                        <div className="recording-channel-actions">
                          <button className="primary-small" onClick={() => setExpandedLibraryVideosChannel(current => current === group.slug ? null : group.slug)} disabled={group.sessions.length === 0}>
                            {expandedLibraryVideosChannel === group.slug ? "配信一覧を閉じる" : "配信一覧を見る"}
                          </button>
                          <button className="small-action" onClick={() => void toggleLibraryComments(group.slug)} disabled={group.logs.length === 0 || isLoadingLibraryComments}>
                            {libraryCommentsChannel === group.slug ? "コメントを閉じる" : "コメントを見る"}
                          </button>
                          <button className="small-action" onClick={() => {
                            const path = group.videos[0]?.path ?? group.logs[0]?.path;
                            if (path) void revealRecordingFile(path);
                          }} disabled={!group.videos.length && !group.logs.length}
                            title="エクスプローラーでこの配信者の動画またはコメントの保存先を開く">
                            保存先を開く
                          </button>
                        </div>
                      </div>

                      {expandedLibraryVideosChannel === group.slug && <div className="recording-library-expanded">
                        <div className="recording-library-expanded-title">
                          <strong>配信別：動画・コメント・AI記事</strong>
                          <span>{group.sessions.length}件の配信</span>
                        </div>
                        <div className="recording-session-list" role="region" tabIndex={0} aria-label={group.displayName + "の配信別録画"}>
                          {group.sessions.map(session => <article className="recording-session-card" key={session.id}>
                            <div className="recording-session-head">
                              <LibraryRecordingThumbnail filePath={session.videos[0]?.path ?? null}
                                onPreview={() => { if (session.videos[0]) setStoryboardTarget({ path: session.videos[0].path, title: session.title || group.displayName }); }} />
                              <div className="recording-session-heading">
                                <div className="recording-session-tags">
                                  <span className={session.kind === "LIVE" ? "session-kind-live" : "session-kind-vod"}>{session.kind}</span>
                                  <span className={session.status === "saved" ? "session-status-ok" : session.status === "failed" || session.status === "interrupted" ? "session-status-warning" : "session-status-unknown"}>
                                    {session.status === "saved" ? "動画保存済み" : session.status === "interrupted" ? "途中停止" : session.status === "failed" ? "保存エラー" : "状況未確認"}
                                  </span>
                                </div>
                                <strong>{session.title || (group.displayName + " の" + (session.kind === "LIVE" ? "生放送" : "過去配信"))}</strong>
                                <small>{Number.isFinite(Date.parse(session.startedAt)) ? new Date(session.startedAt).toLocaleString("ja-JP") : "日時未取得"}</small>
                                <small>動画 {session.videos.length}件 ・ コメント {session.logs.length}件 ・ AI記事 {session.article ? "あり" : "なし"}</small>
                              </div>
                              <div className="recording-session-quick-actions">
                                {session.videos.length > 0 && <button className="primary-small" onClick={() => void openRecordingFile(session.videos[0].path)}>再生</button>}
                                <button className="small-action" aria-expanded={Boolean(expandedLibrarySessions[session.id])}
                                  onClick={() => setExpandedLibrarySessions(current => ({
                                    ...current, [session.id]: !current[session.id]
                                  }))}>{expandedLibrarySessions[session.id] ? "詳細を閉じる" : "ファイル・コメント"}</button>
                              </div>
                            </div>
                            {expandedLibrarySessions[session.id] && <>
                            {session.article && <div className="recording-session-article">
                              <strong>AI配信記事：{session.article.headline}</strong>
                              <p>{session.article.aiSummary || session.article.paragraphs?.[0] || "記事を見ると内容を確認できます。"}</p>
                              <button className="small-action" onClick={() => {
                                setArticleSearch(session.article?.headline ?? "");
                                setArticleStatusFilter("all");
                                setTab("articles");
                              }}>記事を見る</button>
                            </div>}
                            {session.warnings.length > 0 && <div className="recording-session-warnings">
                              {session.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
                            </div>}
                            {session.videos.map(file => <div className="recording-session-file" key={file.path}>
                              <span className="recording-session-file-type">映像・{file.extension}</span>
                              <div className="recording-file-info"><strong title={file.name}>{file.name}</strong>
                                <small>{new Date(file.modifiedAt).toLocaleString("ja-JP")} ・ {(file.size / 1048576).toFixed(1)} MB</small>
                              </div>
                              <div className="recording-library-video-actions">
                                <button className="primary-small" onClick={() => void openRecordingFile(file.path)}>再生</button>
                                <button className="small-action" onClick={() => setStoryboardTarget({ path: file.path, title: session.title || file.name })}>場面一覧</button>
                                <button className="small-action" onClick={() => void revealRecordingFile(file.path)}>場所</button>
                                <button className="danger-small" onClick={() => void deleteRecordingFromLibrary(file.path, file.name)} disabled={deletingRecordingPath !== null}>
                                  {deletingRecordingPath === file.path ? "削除中..." : "削除"}
                                </button>
                              </div>
                            </div>)}
                            {session.logs.map(log => <div className="recording-session-log" key={log.path}>
                              <div className="recording-session-file">
                                <span className="recording-session-file-type log">コメント・JSONL</span>
                                <div className="recording-file-info"><strong title={log.name}>{log.name}</strong>
                                  <small>{new Date(log.modifiedAt).toLocaleString("ja-JP")} ・ {(log.size / 1024).toFixed(1)} KB
                                    {session.commentAssociation !== "exact" && " ・ 対応する配信は未確認"}
                                  </small>
                                </div>
                                <div className="recording-library-video-actions">
                                  <button className="primary-small" onClick={() => void toggleLibraryLog(log)}>
                                    {librarySelectedLogPath === log.path ? "コメントを閉じる" : "コメントを見る"}
                                  </button>
                                  <button className="small-action" onClick={() => void openRecordingFile(log.path)}>開く</button>
                                  <button className="small-action" onClick={() => void revealRecordingFile(log.path)}>場所</button>
                                  <button className="danger-small" onClick={() => void deleteCommentLogFromLibrary(log)}
                                    disabled={deletingCommentLogPath !== null}>
                                    {deletingCommentLogPath === log.path ? "削除中..." : "削除"}
                                  </button>
                                </div>
                              </div>
                              {librarySelectedLogPath === log.path && <div className="recording-session-log-preview" role="region" aria-label={log.name + "の保存済みコメント"}>
                                <div className="recording-library-expanded-title">
                                  <strong>保存済みコメント</strong><span>{libraryLogLoading ? "読込中" : "直近 " + libraryLogMessages.length + "件"}</span>
                                </div>
                                {libraryLogError
                                  ? <div className="empty-inline">{libraryLogError}</div>
                                  : libraryLogLoading
                                    ? <div className="empty-inline">コメントを読み込んでいます...</div>
                                    : libraryLogMessages.length === 0
                                      ? <div className="empty-inline">このファイルに表示できるコメントはありません。</div>
                                      : <div className="recording-library-comment-list">
                                          {libraryLogMessages.map((message, index) => <article className="recording-library-comment-row" key={message.eventId || message.createdAt + ":" + index}>
                                            <div className="recording-library-comment-meta">
                                              <strong style={message.usernameColor ? { color: message.usernameColor } : undefined}>{message.senderUsername}</strong>
                                              <time>{new Date(message.createdAt).toLocaleString("ja-JP")}</time>
                                            </div>
                                            <p>{message.content}</p>
                                          </article>)}
                                        </div>}
                              </div>}
                            </div>)}
                            {!session.article && session.videos.length > 0 && <div className="recording-session-actions">
                              <button className="small-action" onClick={() => {
                                setArticleSlug(session.slug);
                                setArticleVideoPath(session.videos[0].path);
                                setArticleHeadline("");
                                setTab("articles");
                              }}>この録画から記事を生成</button>
                            </div>}
                            </>}
                          </article>)}
                        </div>
                      </div>}

                      {libraryCommentsChannel === group.slug && <div className="recording-library-comments">
                        <div className="recording-library-expanded-title">保存済みコメント <span>{isLoadingLibraryComments ? "読み込み中..." : "直近 " + libraryComments.length + "件"}</span></div>
                        {libraryCommentsError
                          ? <div className="empty-inline">{libraryCommentsError}</div>
                          : isLoadingLibraryComments
                            ? <div className="empty-inline">コメントログを読み込んでいます...</div>
                            : libraryComments.length === 0
                              ? <div className="empty-inline">このチャンネルのコメントログに表示できるコメントがありません。</div>
                              : <div className="recording-library-comment-list">
                                  {libraryComments.map((message, index) => <article className="recording-library-comment-row" key={message.eventId || message.createdAt + ":" + index}>
                                    <div className="recording-library-comment-meta">
                                      <strong style={message.usernameColor ? { color: message.usernameColor } : undefined}>{message.senderUsername}</strong>
                                      <time>{new Date(message.createdAt).toLocaleString("ja-JP")}</time>
                                    </div>
                                    <p>{message.content}</p>
                                  </article>)}
                                </div>}
                      </div>}
                    </article>)}
                  </div>}
        <div className="data-path-note">保存先：{settings.outputDirectory || "アプリ既定のビデオフォルダー"} ・ コメントログ：Chat／チャンネル名</div>
      </section>}

      {tab === "comment-video" && <section className="panel comment-video-panel">
        <div className="panel-heading">
          <div><h2>コメント付き動画を生成</h2><p>NicoConvAssのコメント流し込みと、HandBrakeの画質設定を参考にした動画合成</p></div>
          <button className="small-action" onClick={() => setLibraryRefreshKey(value => value + 1)} disabled={!isDesktop || commentVideoBusy || isLoadingRecordings || isLoadingCommentLogs}>一覧を更新</button>
        </div>
        {!isDesktop
          ? <div className="empty-state"><div className="empty-icon">✦</div><strong>Windowsデスクトップ版で利用できます</strong><span>ブラウザープレビューでは動画ファイルの読み書きやエンコードを実行できません。</span></div>
          : <>
            <div className="comment-video-intro">ニコ生風の白文字・太い黒フチでコメントを右から左へ流します。自動調整ONでは長文・短文・投稿密度に応じて速度、入場タイミング、行配置を自動計算します。OFFで従来の手動設定を使えます。元動画は変更しません。</div>
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
              <label className="comment-video-checkbox"><input type="checkbox" checked={settings.assAutoFlow} onChange={event => setSettings(previous => ({ ...previous, assAutoFlow: event.target.checked }))} disabled={commentVideoBusy} /><span>コメント速度・入り方・重なりを自動調整する（おすすめ）</span></label>
              <small>自動ONではコメントごとに速度・画面への進入位置・行の間隔を計算します。OFFで横断時間・速度・行数・間隔を手動調整できます。</small>
              <div className="comment-video-settings-grid">
                <label className="comment-video-field"><span>同期ずれ（秒）</span><input type="number" min="-300" max="300" step="0.1" value={commentVideoDelay} onChange={event => setCommentVideoDelay(Number(event.target.value))} disabled={commentVideoBusy} /><small>＋はコメントを遅らせ、－は早めます。</small></label>
                <label className="comment-video-field"><span>コメントの表示位置</span><select value={commentVideoPosition} onChange={event => setCommentVideoPosition(event.target.value as "scroll" | "top" | "bottom" | "command")} disabled={commentVideoBusy}><option value="scroll">すべて中央スクロール（naka）</option><option value="top">すべて上部固定（ue）</option><option value="bottom">すべて下部固定（shita）</option><option value="command">コメントごとの指定を優先（ue・naka・shita）</option></select><small>「コメントごとの指定」ではログのmail／commands／positionを読み取ります。本文先頭に @ue・/naka・[shita] を付けた場合も位置指定として扱い、表示時に指定文字を除去します。指定がないコメントは中央スクロールです。</small></label>
                <label className="comment-video-field"><span>フォント</span><select value={commentVideoFontFamily} onChange={event => setCommentVideoFontFamily(event.target.value as "ms-pgothic" | "meiryo" | "yu-gothic" | "arial")} disabled={commentVideoBusy}><option value="ms-pgothic">ＭＳ Ｐゴシック</option><option value="meiryo">メイリオ</option><option value="yu-gothic">游ゴシック</option><option value="arial">Arial</option></select><small>Windowsにインストールされているフォントを使用します。</small></label>
                <label className="comment-video-field"><span>文字サイズ</span><input type="number" min="16" max="80" value={commentVideoFontSize} onChange={event => setCommentVideoFontSize(Number(event.target.value))} disabled={commentVideoBusy} /><small>動画の解像度に合わせて調整します。</small></label>
                <label className="comment-video-field"><span>画面幅の横断時間（秒）</span><input type="number" min="2" max="15" value={commentVideoDuration} onChange={event => setCommentVideoDuration(Number(event.target.value))} disabled={commentVideoBusy || settings.assAutoFlow} /><small>画面幅を横切る基準時間です。長いコメントは文字幅に応じて表示時間が長くなります。</small></label>
                <label className="comment-video-field"><span>流れる速度（%）</span><input type="number" min="50" max="200" step="5" value={commentVideoSpeed} onChange={event => setCommentVideoSpeed(Number(event.target.value))} disabled={commentVideoBusy || settings.assAutoFlow} /><small>100%が標準。小さくするとゆっくり、大きくすると速く流れます。</small></label>
                <label className="comment-video-field"><span>最大表示行数</span><input type="number" min="1" max="20" value={commentVideoRows} onChange={event => setCommentVideoRows(Number(event.target.value))} disabled={commentVideoBusy || settings.assAutoFlow} /><small>初期値14行。動画の高さと文字サイズに合わせて実際の表示可能行数は自動調整します。</small></label>
                <label className="comment-video-field"><span>コメント同士の最小間隔（px）</span><input type="number" min="0" max="200" step="4" value={commentVideoGap} onChange={event => setCommentVideoGap(Number(event.target.value))} disabled={commentVideoBusy || settings.assAutoFlow} /><small>初期値24px。文字幅と移動速度から同じ行で重ならない間隔を確保します。</small></label>
                <label className="comment-video-field"><span>文字の不透明度（%）</span><input type="number" min="20" max="100" value={commentVideoOpacity} onChange={event => setCommentVideoOpacity(Number(event.target.value))} disabled={commentVideoBusy} /><small>100で不透明、低いほど透過します。</small></label>
                <label className="comment-video-field"><span>出力画質</span><select value={commentVideoQuality} onChange={event => setCommentVideoQuality(event.target.value as "high" | "standard" | "compact")} disabled={commentVideoBusy}><option value="high">高画質・大きめ</option><option value="standard">標準（おすすめ）</option><option value="compact">容量優先</option></select><small>利用可能なH.264エンコーダーを優先し、ない場合は互換形式へ切り替えます。</small></label>
              </div>
              <label className="comment-video-checkbox"><input type="checkbox" checked={commentVideoShowUsername} onChange={event => setCommentVideoShowUsername(event.target.checked)} disabled={commentVideoBusy} /><span>コメントに投稿者名も表示する</span></label>
              <label className="comment-video-checkbox"><input type="checkbox" checked={settings.removeEmotesFromAss} onChange={event => setSettings(previous => ({ ...previous, removeEmotesFromAss: event.target.checked }))} disabled={commentVideoBusy} /><span>ASS出力時にemoteを削除する（emoteだけのコメントは出力しない）</span></label>
            </div>
            <CommentVideoLivePreview selectedVideoPath={selectedCommentVideoPath}
              previewResult={commentVideoPreviewResult}
              settings={{
                fontFamily: commentVideoFontFamily === "ms-pgothic" ? '"ＭＳ Ｐゴシック"' :
                  commentVideoFontFamily === "yu-gothic" ? '"游ゴシック"' :
                  commentVideoFontFamily === "arial" ? "Arial" : '"メイリオ"',
                fontSize: commentVideoFontSize,
                durationSeconds: commentVideoDuration,
                speedPercent: commentVideoSpeed,
                rowLimit: commentVideoRows,
                collisionGap: commentVideoGap,
                opacity: commentVideoOpacity,
                position: commentVideoPosition,
                autoFlow: settings.assAutoFlow,
                showUsername: commentVideoShowUsername
              }} />
            <div
              className="comment-video-preview"
              key={[
                commentVideoFontFamily, commentVideoFontSize, commentVideoDuration,
                commentVideoSpeed, commentVideoRows, commentVideoGap, commentVideoOpacity,
                commentVideoShowUsername, commentVideoDelay, commentVideoPosition, settings.removeEmotesFromAss, settings.assAutoFlow, selectedCommentVideoPath,
                selectedCommentLogPaths.join(","),
                commentVideoPreviewResult?.comments.slice(0, 24).map(comment => comment.content + comment.color).join("|")
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
                      "破損行 " + commentVideoPreviewResult.malformedLines.toLocaleString("ja-JP") + "件 ・ " +
                      "同期基準 " + (commentVideoPreviewResult.syncSource === "recording-metadata"
                        ? "録画プロセス開始メタデータ"
                        : commentVideoPreviewResult.syncSource === "filename" ? "ファイル名の時刻" : "ファイル更新時刻から推定") +
                      "（" + new Date(commentVideoPreviewResult.estimatedVideoStartAt).toLocaleString("ja-JP") + "）"
                    : commentVideoPreviewError
                      ? "実ログプレビューを利用できません：" + commentVideoPreviewError
                      : "動画とコメントログを選択すると、実際のコメント内容でプレビューします。"}
              </div>
              <div className="comment-video-preview-values">
                <span>{commentVideoFontFamily === "ms-pgothic" ? "ＭＳ Ｐゴシック" : commentVideoFontFamily === "yu-gothic" ? "游ゴシック" : commentVideoFontFamily === "arial" ? "Arial" : "メイリオ"}</span>
                <span>{Math.max(16, Math.min(80, commentVideoFontSize))}px</span>
                <span>{commentVideoPosition === "top" ? "全コメント上部固定" : commentVideoPosition === "bottom" ? "全コメント下部固定" : commentVideoPosition === "command" ? "コメント別位置指定" : "全コメント中央スクロール"}</span>
                <span>{settings.assAutoFlow ? "流れる速度：自動" : "速度 " + Math.max(50, Math.min(200, commentVideoSpeed)) + "%"}</span>
                <span>{settings.assAutoFlow ? "コメント間隔：自動" : "間隔 " + Math.max(0, Math.min(200, commentVideoGap)) + "px"}</span>
                <span>最大表示行：{settings.assAutoFlow ? "自動" : Math.max(1, Math.min(20, commentVideoRows)) + "行"}</span>
              </div>
              <div className="comment-video-preview-screen" aria-label="設定をリアルタイム反映するコメント表示プレビュー">
                {(commentVideoPreviewResult?.comments.length
                  ? commentVideoPreviewResult.comments.slice(0, 24).map((comment, index) => {
                      const fontSize = Math.max(16, Math.min(80, commentVideoFontSize));
                      const lineHeight = Math.max(fontSize + 12, fontSize * 1.55);
                      const visibleRows = Math.max(1, Math.floor((1080 - 26 - fontSize) / lineHeight) + 1);
                      const gap = Math.max(0, Math.min(200, commentVideoGap));
                      const fixedRows = Math.max(1, Math.min(20, commentVideoRows, Math.floor((1080 * 0.28 + gap) / Math.max(1, lineHeight + gap))));
                      const position = commentVideoPosition === "command"
                        ? comment.position ?? "scroll"
                        : commentVideoPosition;
                      const laneCount = position === "scroll"
                        ? (settings.assAutoFlow ? Math.min(20, visibleRows) : Math.max(1, Math.min(20, commentVideoRows, visibleRows)))
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
                      ? (settings.assAutoFlow ? Math.min(20, visibleRows) : Math.max(1, Math.min(20, commentVideoRows, visibleRows)))
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
                    ? (settings.assAutoFlow ? Math.min(20, previewVisibleRows) : Math.max(1, Math.min(20, commentVideoRows, previewVisibleRows)))
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
                  const autoProfile = settings.assAutoFlow && itemPosition === "scroll"
                    ? computeNicoAssProfile(1280, estimatedTextWidth + 32, fontSize, Math.min(40, 1 + index))
                    : null;
                  const commentScrollSeconds = autoProfile?.moveSeconds ?? (1280 + estimatedTextWidth + 32) / estimatedPixelsPerSecond;
                  const gapDelay = (autoProfile?.gapPx ?? gap) / Math.max(1, autoProfile?.speed ?? estimatedPixelsPerSecond);
                  return <span
                    className="comment-video-preview-comment"
                    key={index}
                    style={{
                      top: top + "%",
                      left: itemPosition === "scroll" ? (settings.assAutoFlow ? "103%" : "100%") : "50%",
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
              <small>こちらは従来の簡易アニメーション見本です。上の「リアルタイムプレビュー」では実動画を再生し、動画の時刻にコメントを重ねて確認できます。</small>
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
                <div className="ai-model-install-field">
                  <label className="comment-video-field"><span>記事生成・映像解析モデル</span><input value={settings.aiArticleModel} onChange={event => setSettings(previous => ({ ...previous, aiArticleModel: event.target.value }))} placeholder="qwen2.5vl:3b" disabled={aiArticleBusy || aiModelPullBusy} /><small>初期値は qwen2.5vl:3b。画像入力に対応したOllama Visionモデルを指定してください。</small></label>
                  <button className="small-action" onClick={() => void pullAiArticleModel(settings.aiArticleModel)} disabled={aiArticleBusy || aiModelPullBusy || !settings.aiArticleModel.trim()}>記事・映像モデルをインストール</button>
                </div>
                <label className="comment-video-checkbox"><input type="checkbox" checked={settings.aiArticleAudioEnabled} onChange={event => setSettings(previous => ({ ...previous, aiArticleAudioEnabled: event.target.checked }))} disabled={aiArticleBusy} /><span>音声を文字起こしして記事へ反映する（無料・ローカル）</span></label>
                <div className="ai-model-install-field">
                  <label className="comment-video-field"><span>音声認識モデル（Qwen3-ASR）</span><input value={settings.aiArticleAudioModel} onChange={event => setSettings(previous => ({ ...previous, aiArticleAudioModel: event.target.value }))} placeholder="frozenlab/qwen3-asr:0.6b" disabled={aiArticleBusy || aiModelPullBusy || !settings.aiArticleAudioEnabled} /><small>初期値は frozenlab/qwen3-asr:0.6b（約1GB）。日本語を含む音声を45秒単位で認識します。Qwen3-ASR対応の新しいOllamaが必要です。</small></label>
                  <button className="small-action" onClick={() => void pullAiArticleModel(settings.aiArticleAudioModel)} disabled={aiArticleBusy || aiModelPullBusy || !settings.aiArticleAudioEnabled || !settings.aiArticleAudioModel.trim()}>音声認識モデルをインストール</button>
                </div>
              </> : <>
              <label className="comment-video-field"><span>OpenAI APIキー</span><input type="password" value={aiArticleApiKey} onChange={event => setAiArticleApiKey(event.target.value)} placeholder={aiArticleStatus.configured ? "保存済み（変更するときだけ入力）" : "sk-..."} autoComplete="new-password" disabled={aiArticleBusy || !aiArticleStatus.encryptionAvailable} /><small>キー自体は画面や設定ファイルへ保存せず、Windowsの暗号化ストレージへ保存します。</small></label>
              <label className="comment-video-field"><span>AIモデル</span><select value={settings.aiArticleModel} onChange={event => setSettings(previous => ({ ...previous, aiArticleModel: event.target.value }))} disabled={aiArticleBusy}><option value="gpt-6-luna">GPT-6 Luna（低コスト・推奨）</option><option value="gpt-6.1-terra">GPT-6.1 Terra</option><option value="gpt-6.1-sol">GPT-6.1 Sol</option></select></label>
              </>}
              <label className="comment-video-field"><span>AI記事の更新間隔</span><select value={settings.aiArticleIntervalSeconds} onChange={event => setSettings(previous => ({ ...previous, aiArticleIntervalSeconds: Number(event.target.value) }))}><option value={30}>30秒</option><option value={60}>1分</option><option value={120}>2分（推奨）</option><option value={300}>5分</option><option value={600}>10分</option></select></label>
            </div>
            <div className="comment-video-actions">
              {settings.aiArticleProvider === "openai" && <><button className="primary-small" onClick={() => void saveAiArticleApiKey()} disabled={aiArticleBusy || !aiArticleApiKey.trim() || !aiArticleStatus.encryptionAvailable}>APIキーを保存</button><button className="small-action" onClick={() => void clearAiArticleApiKey()} disabled={aiArticleBusy || !aiArticleStatus.configured}>APIキーを削除</button></>}
              <button className="small-action" onClick={() => void testAiArticleConnection()} disabled={aiArticleBusy || aiModelPullBusy}>{settings.aiArticleProvider === "ollama" ? "Ollama接続テスト" : "接続テスト"}</button>
            </div>
            {aiModelPullStatus && <div className="ai-model-pull-status" role="status">
              <div className="ai-model-pull-heading"><strong>{aiModelPullStatus.model}</strong><span>{aiModelPullStatus.done ? "完了" : aiModelPullStatus.status}{aiModelPullStatus.percent !== null ? ` ・ ${aiModelPullStatus.percent}%` : ""}</span></div>
              {aiModelPullStatus.percent !== null && <div className="version-progress"><div style={{ width: `${aiModelPullStatus.percent}%` }} /></div>}
              {typeof aiModelPullStatus.completed === "number" && typeof aiModelPullStatus.total === "number" && <small>{(aiModelPullStatus.completed / 1_000_000).toFixed(1)} MB / {(aiModelPullStatus.total / 1_000_000).toFixed(1)} MB</small>}
              {!aiModelPullStatus.done && <button className="remove" onClick={() => void cancelAiArticleModelPull()}>ダウンロードをキャンセル</button>}
              {aiModelPullStatus.error && <small>{aiModelPullStatus.error}</small>}
            </div>}
            {aiArticleMessage && <div className="api-message" role="status">{aiArticleMessage}</div>}
            <div className="notice">AI記事の自動更新をONにすると、通常のコメント自動取得設定がOFFでも記事用コメントを受信します。録画済み動画の手動記事生成は、自動LIVE記事のON／OFFとは独立してAI分析します。{settings.aiArticleProvider === "ollama" ? "映像・音声・コメントのデータは設定したOllamaへ送信され、ローカルOllamaを使う場合は外部AIサービスへ送信されません。記事生成用Visionモデルと音声認識モデルは設定画面の「インストール」ボタンから取得できます。ダウンロードには初回のみ通信が必要です。PCのメモリ・CPU/GPUを使用します。" : "記事生成モデルには映像フレーム・コメント・配信情報と、利用可能な場合は音声文字起こしテキストをOpenAI APIへ送信します。API利用料が発生し、映像フレームも外部へ送信されるため、送信してよい録画だけを対象にしてください。音声の新規文字起こし処理はOllama利用時のみです。"}</div>
          </div>
          <div className="comment-video-form-grid">
            <label className="comment-video-field"><span>配信者（未登録の録画にも対応）</span><select value={articleSlug}
              onChange={event => { setArticleSlug(event.target.value); setArticleVideoPath(""); setArticleSelectedLogPaths([]); }}>
              <option value="">配信者を選択</option>
              {getAvailableArticleChannels([...channels, ...recordingOnlyChannels].map(item => item.name), recordingFiles.map(file => file.name))
                .map(slug => <option key={slug} value={slug}>{slug}</option>)}
            </select><small>録画ライブラリにある配信者は、監視登録していなくても表示されます。</small></label>
            <label className="comment-video-field"><span>対象の録画動画</span><select value={articleVideoPath}
              onChange={event => {
                const selected = recordingFiles.find(file => file.path === event.target.value);
                setArticleVideoPath(event.target.value);
                setArticleSelectedLogPaths(selected ? selectAssociatedArticleLogs(selected.name, articleSlug, commentLogFiles) : []);
              }}>
              <option value="">動画を選択してください</option>
              {recordingFiles.filter(file => getRecordingChannelSlug(file.name) === articleSlug)
                .map(file => <option key={file.path} value={file.path}>{file.name}</option>)}
            </select><small>同じ放送に属するコメントログだけを自動選択します。</small></label>
            <label className="comment-video-field"><span>記事見出し（任意）</span><input value={articleHeadline} onChange={event => setArticleHeadline(event.target.value)} maxLength={160} placeholder="空欄なら配信者名から自動作成" /></label>
          </div>
          <div className="settings-subsection">
            <div className="settings-subheading"><h3>記事に使用するコメントログ</h3><span className="api-state connected">{articleSelectedLogPaths.length}件選択</span></div>
            <p className="settings-help">同じ配信のコメントログを自動選択します。ファイル名が異なる古いログは、下から手動で選択できます。別の放送のログを選ぶと記事が不正確になるため注意してください。</p>
            <div className="comment-video-log-list" role="group" aria-label="記事生成に使用するコメントログ">
              {commentLogFiles.filter(file => file.channelSlug.toLowerCase() === articleSlug.toLowerCase() && articleSlug)
                .map(file => <label className="comment-video-log-option" key={file.path}>
                  <input type="checkbox" checked={articleSelectedLogPaths.includes(file.path)}
                    disabled={articleBusy || (!articleSelectedLogPaths.includes(file.path) && articleSelectedLogPaths.length >= 31)}
                    onChange={event => setArticleSelectedLogPaths(previous =>
                      event.target.checked ? [...previous, file.path] : previous.filter(path => path !== file.path))} />
                  <span><strong>{file.kind}</strong><small>{file.name}</small></span>
                </label>)}
            </div>
          </div>
          <div className="comment-video-actions"><button className="primary-small" onClick={() => void createStreamArticle()} disabled={articleBusy || !articleSlug || !articleVideoPath}>{articleBusy ? "映像・音声・コメントをAI分析中..." : settings.aiArticleProvider === "ollama" || aiArticleStatus.configured ? "3つの情報源からAI記事を生成" : "この配信の記事を生成"}</button><span className="comment-video-log-count">同じ放送に対応するログ {articleSelectedLogPaths.length}件を使用</span></div>
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
            {streamArticles.length === 0 ? <div className="empty-state"><strong>まだ記事がありません</strong><span>録画ライブラリから動画を選んで記事を生成してください。未登録の配信者にも対応しています。</span></div> : filteredStreamArticles.length === 0 ? <div className="empty-state"><strong>一致する記事がありません</strong><span>検索語を変更してください。</span></div> : articleDateGroups.map(([dateLabel, dayArticles]) => <section className="article-day-group" key={dateLabel}>
              <div className="article-day-heading"><h4>{dateLabel}</h4><span>{dayArticles.length.toLocaleString("ja-JP")}本</span></div>
              {dayArticles.map(article => <article className="article-card" key={article.slug + ":" + article.id}>
              <div className="article-meta"><span className="article-byline">配信者・{article.displayName}</span> ・ {new Date(article.startedAt).toLocaleString("ja-JP")} <span className={article.status === "live" ? "article-status-live" : "article-status-done"}>{article.status === "live" ? "LIVE・更新中" : article.status === "completed" ? "配信終了" : "アーカイブ"}</span>{article.aiGenerated && <span className="article-ai-label">AI記事</span>}</div>
              <div className="article-broadcast-layout">
<ArticleBroadcastFrame article={article} onOpenStoryboard={(path, title) => setStoryboardTarget({ path, title })} />
                <div className="article-broadcast-copy">
                  <h3>{article.headline}</h3>
                  {article.streamTitle && article.streamTitle !== article.headline && <p className="article-original-stream-title"><strong>元配信タイトル</strong> {article.streamTitle}</p>}
                  {article.category && <span className="live-stream-category">{article.category}</span>}
                  {article.aiSummary && <p className="article-summary">{deduplicateArticleSentences(article.aiSummary, 500)}</p>}
                </div>
              </div>
              <div className="article-source-badges">
                <span className={article.videoAnalyzed ? "is-analyzed" : ""}>映像 {article.videoAnalyzed ? "分析済み" : "未解析"}</span>
                <span className={article.audioAnalyzed ? "is-analyzed" : ""}>音声 {article.audioAnalyzed ? `文字起こし ${(article.audioSegmentCount ?? article.audioTranscriptSegments?.length ?? 0).toLocaleString("ja-JP")}区間` : "未解析"}</span>
                <span className={article.commentCount > 0 ? "is-analyzed" : ""}>コメント {article.commentCount.toLocaleString("ja-JP")}件</span>
                {typeof article.commentEvidenceCount === "number" && <span className={article.commentEvidenceCount > 0 ? "is-analyzed" : ""}>AI参照候補 {article.commentEvidenceCount.toLocaleString("ja-JP")}件</span>}
                {((article.pendingAnalysisComments?.length ?? 0) + (article.pendingAnalysisAudioSegments?.length ?? 0)) > 0 &&
                  <span>AI未解析 {article.pendingAnalysisComments?.length ?? 0}コメント・{article.pendingAnalysisAudioSegments?.length ?? 0}音声区間</span>}
              </div>
              {Boolean(article.evidenceTimeline?.length) && <details className="article-evidence-details">
                <summary>解析に使った時刻付きの情報源（{article.evidenceTimeline?.length ?? 0}件・抜粋）</summary>
                <p className="article-evidence-note">録画から取得した静止画、受信コメント、音声の文字起こしを時刻順に表示します。AIが内容を検証したことを保証するものではありません。</p>
                <ol className="article-evidence-list">
                  {article.evidenceTimeline?.map((event, index) => <li key={event.source + ":" + event.timeSeconds + ":" + index}>
                    <time>{formatArticleEvidenceTime(event.timeSeconds)}</time>
                    <span className="article-evidence-source">{event.source === "chat" ? "視聴者コメント" : event.source === "audio" ? "音声文字起こし" : "映像フレーム"}</span>
                    <span>{event.detail}</span>
                  </li>)}
                </ol>
              </details>}
              {article.videoAnalyzed && <div className="article-video-analysis"><strong>映像から確認した場面（AI解析した代表フレーム {article.videoAnalyzedSampleCount ?? article.videoScenes?.length ?? 0}枚／取得累計 {article.videoFrameCount ?? 0}枚）</strong>{deduplicateArticleSentences(article.videoSummary, 1000) && <p>{deduplicateArticleSentences(article.videoSummary, 1000)}</p>}{deduplicateArticleList(article.videoScenes ?? [], 8, 300, article.videoSummary ?? "").length > 0 && <ul>{deduplicateArticleList(article.videoScenes ?? [], 8, 300, article.videoSummary ?? "").map((scene, index) => <li key={index}>{scene}</li>)}</ul>}</div>}
              {article.audioAnalyzed && <div className="article-audio-analysis">
                <strong>音声から確認した内容</strong>
                {article.audioSamplingMode === "distributed" && <p className="article-audio-coverage-note">長時間配信のため、全時間帯から一部の音声区間を抜き出して文字起こししています。配信全体の発言を網羅したものではありません。</p>}
                <p>{deduplicateArticleSentences(article.audioSummary, 1200) || "音声は文字起こし済みです。発言内容の要約はまだ生成されていません。"}</p>
                {article.audioTranscript && <details className="article-transcript-details">
                  <summary>音声文字起こしを表示（{(article.audioSegmentCount ?? article.audioTranscriptSegments?.length ?? 0).toLocaleString("ja-JP")}区間）</summary>
                  <pre>{article.audioTranscript}</pre>
                </details>}
              </div>}
              {article.audioError && <div className="storage-error article-error">音声認識エラー：{article.audioError}</div>}
              {deduplicateArticleList(article.paragraphs, 5, 1000).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
              {Boolean(article.highlights?.length) && <div className="article-highlights"><strong>注目ポイント</strong><ul>{deduplicateArticleList(article.highlights ?? [], 5, 240).map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
              {article.aiError && <div className="storage-error article-error">{article.aiGenerated ? "一部情報源の解析状況：" : "AI更新エラー："}{article.aiError}</div>}
              <div className="article-stats">配信時間 {Math.floor((article.durationSeconds ?? 0) / 60).toLocaleString("ja-JP")}分 ・ コメント {article.commentCount.toLocaleString("ja-JP")}件 ・ 投稿者 {article.uniqueCommenters.toLocaleString("ja-JP")}人 ・ 視聴者数 {article.viewerCount?.toLocaleString("ja-JP") ?? "—"}人（最大 {article.peakViewerCount?.toLocaleString("ja-JP") ?? "—"}人） ・ 分析キーワード {article.keywords.join("、") || "なし"}{article.lastAiUpdateAt ? ` ・ AI更新 ${new Date(article.lastAiUpdateAt).toLocaleTimeString("ja-JP")}` : ""}</div>
              {article.sourceVideo && <div className="comment-video-actions"><button className="small-action" onClick={() => void window.kickRecorder?.openRecording(article.sourceVideo)}>元動画を開く</button><button className="small-action" onClick={() => setStoryboardTarget({ path: article.sourceVideo, title: article.headline })}>時刻別の場面一覧</button><button className="small-action" onClick={() => void window.kickRecorder?.revealRecording(article.sourceVideo)}>録画の保存先</button></div>}
              <div className="comment-video-actions article-card-actions">
                <button className="small-action" onClick={() => void reanalyzeStreamArticle(article)}
                  disabled={reanalyzingArticleId !== null || articleBusy}>
                  {reanalyzingArticleId === article.id ? "AIで再解析中..." : article.status === "live" ? "LIVE終了後の記事を復旧・再解析" : ((article.pendingAnalysisComments?.length ?? 0) + (article.pendingAnalysisAudioSegments?.length ?? 0)) > 0 ? "保存済み未解析データを含めてAI再解析" : "映像・音声・コメントでAI再解析"}
                </button>
                <button className="remove" onClick={() => void deleteStreamArticle(article)} disabled={deletingArticleId !== null}>
                  {deletingArticleId === article.id ? "削除中..." : "この記事を削除"}
                </button>
              </div>
              </article>)}
            </section>)}
          </div>
        </>}
      </section>}

      {tab === "updates" && <section className="panel version-update-panel">
        <div className="panel-heading">
          <div><h2>バージョン更新</h2><p>新しいα版の確認・ダウンロード・更新履歴をここで管理できます</p></div>
          <a className="text-button" href="https://github.com/kanenao/Kick-Live-Message-Recorder/releases" target="_blank" rel="noreferrer">GitHub Releases ↗</a>
        </div>
        <div className="version-update-grid">
          <div className="version-current-card">
            <span className="version-card-label">現在インストール中</span>
            <strong>v{appVersion}</strong>
            <small>Kick Live Message Recorder</small>
            <div className="version-card-foot">Windows 64bit・α版</div>
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
            <small className="version-update-hint">起動時と約6時間ごとに最新α版を自動確認・ダウンロードします。旧β版からの移行にも互換配信を用意しています。更新は録画・VOD保存の完了後、アプリを再起動して適用してください。</small>
          </div>
        </div>
        {updateStatus.releaseNotes && <div className="release-notes-panel">
          <div className="settings-subheading"><h3>公開中のリリースノート</h3>{updateStatus.releaseDate && <span className="comment-video-log-count">{new Date(updateStatus.releaseDate).toLocaleDateString("ja-JP")}</span>}</div>
          <ReleaseNotesContent value={updateStatus.releaseNotes} />
        </div>}
        <div className="version-history-section">
          <div className="settings-subheading"><h3>バージョン更新履歴</h3><span className="api-state connected">{VERSION_HISTORY.length}件</span></div>
          <div className="version-history-list">
            {VERSION_HISTORY.map((release, index) => <article className="version-history-item" key={release.version}>
              <div className="version-history-marker">{index === 0 ? "NEW" : release.version.includes("-alpha.") ? "α" : "β"}</div>
              <div className="version-history-content">
                <div className="version-history-heading"><strong>v{release.version}</strong><span>{release.title}</span></div>
                <ul>{release.changes.map(change => <li key={change}>{change}</li>)}</ul>
              </div>
            </article>)}
          </div>
        </div>
        <div className="notice">Windowsインストーラー版の更新に対応します。旧β版や更新機能のない古い版では自動更新に失敗する場合があります。その場合は <a href="https://github.com/kanenao/Kick-Live-Message-Recorder/releases" target="_blank" rel="noreferrer">GitHub Releasesから最新α版を手動インストール</a> してください。ZIP版・ブラウザープレビューでは自動更新できません。安定版への自動切り替えは行いません。</div>
      </section>}

      {tab === "settings" && <section className="panel">
        <div className="panel-heading"><div><h2>基本設定</h2><p>α版の録画動作・保存先の設定</p></div></div>
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
            <div><strong>録画中の映像プレビューを表示</strong><small>設定画面に加えて、ダッシュボードと録画専用画面からも即時切替できます。OFF時はプレーヤーを停止し、録画・コメント取得は継続します。</small></div>
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

      <footer>Kick Live Message Recorder <span>•</span> α版 {appVersion} <span>•</span> 日本語版</footer>
    </main>
    <RecordingStoryboardDialog filePath={storyboardTarget?.path ?? null}
      title={storyboardTarget?.title ?? ""} onClose={() => setStoryboardTarget(null)} />
  </div>;
}
