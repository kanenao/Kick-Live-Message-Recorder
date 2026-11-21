import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildTimedCommentSchedule, visibleTimedComments,
  type LivePreviewSettings, type TimedPreviewComment
} from "./comment-live-preview";

export type RealCommentPreviewResult = {
  width: number;
  height: number;
  durationSeconds: number;
  comments: TimedPreviewComment[];
};

/**
 * Nico-style true video + transparent comment overlay.
 * File selection is explicit: a browser-owned File object provides the local
 * blob URL, never an arbitrary renderer supplied filesystem URL.
 */
export function CommentVideoLivePreview({
  selectedVideoPath, previewResult, settings
}: {
  selectedVideoPath: string;
  previewResult: RealCommentPreviewResult | null;
  settings: LivePreviewSettings;
}) {
  const fileName = selectedVideoPath.split(/[\\/]/).pop() ?? "";
  const [file, setFile] = useState<File | null>(null);
  const [blobUrl, setBlobUrl] = useState("");
  const [videoError, setVideoError] = useState("");
  const [videoDimensions, setVideoDimensions] = useState({ width: 1280, height: 720 });
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    setFile(null);
    setVideoError("");
  }, [selectedVideoPath]);

  useEffect(() => {
    if (!file) {
      setBlobUrl("");
      return;
    }
    const url = URL.createObjectURL(file);
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const schedule = useMemo(() => buildTimedCommentSchedule(
    previewResult?.comments ?? [], videoDimensions.width, videoDimensions.height, settings
  ), [previewResult, videoDimensions.width, videoDimensions.height, settings]);

  const draw = useCallback((): void => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) return;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, width, height);
    context.textBaseline = "middle";
    context.lineJoin = "round";
    context.globalAlpha = Math.max(0.2, Math.min(1, settings.opacity / 100));
    for (const comment of visibleTimedComments(schedule, video.currentTime, width)) {
      context.font = `bold ${comment.fontSize}px ${settings.fontFamily}, sans-serif`;
      context.textAlign = comment.position === "scroll" ? "left" : "center";
      context.strokeStyle = "#000000";
      context.lineWidth = Math.max(2, comment.fontSize / 9);
      const textX = comment.x;
      context.strokeText(comment.text, textX, comment.y);
      context.fillStyle = comment.color;
      context.fillText(comment.text, textX, comment.y);
    }
    context.globalAlpha = 1;
  }, [schedule, settings.fontFamily, settings.opacity]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let handle = 0;
    const tick = (): void => {
      draw();
      if (!video.paused && !video.ended) handle = requestAnimationFrame(tick);
    };
    const start = (): void => {
      cancelAnimationFrame(handle);
      handle = requestAnimationFrame(tick);
    };
    video.addEventListener("play", start);
    video.addEventListener("timeupdate", draw);
    video.addEventListener("seeked", draw);
    video.addEventListener("pause", draw);
    video.addEventListener("loadedmetadata", draw);
    draw();
    if (!video.paused && !video.ended) start();
    return () => {
      cancelAnimationFrame(handle);
      video.removeEventListener("play", start);
      video.removeEventListener("timeupdate", draw);
      video.removeEventListener("seeked", draw);
      video.removeEventListener("pause", draw);
      video.removeEventListener("loadedmetadata", draw);
    };
  }, [draw, blobUrl]);

  return <section className="comment-video-live-panel" aria-label="コメント付き動画のリアルタイムプレビュー">
    <div className="comment-video-live-heading">
      <div><strong>リアルタイムプレビュー（動画＋コメント）</strong>
        <small>Nico版と同じく、動画の再生・一時停止・シークにコメントが同期。設定変更は再エンコードせずすぐ反映します。</small>
      </div>
      <span>{blobUrl ? "動画プレビュー中" : "映像を選択してください"}</span>
    </div>
    <div className="comment-video-live-file-row">
      <label>プレビュー用の動画を選択
        <input type="file" accept="video/*,.mp4,.mkv,.webm,.ts,.mov,.m4v"
          onChange={event => {
            const selected = event.target.files?.[0] ?? null;
            setVideoError("");
            if (selected && (!fileName || selected.name.toLowerCase() !== fileName.toLowerCase())) {
              setFile(null);
              setVideoError("上の「元動画」で選択した動画と同じファイルを選んでください。");
              return;
            }
            setFile(selected);
          }} />
      </label>
      <small>現在の対象：{fileName || "動画未選択"}。動画を二重に録画せず、PCのファイルを直接プレビューします。</small>
    </div>
    {videoError && <div className="comment-video-live-error" role="alert">{videoError}</div>}
    <div className="comment-video-live-stage"
      style={{ aspectRatio: `${videoDimensions.width} / ${videoDimensions.height}` }}>
      {blobUrl ? <>
        <video ref={videoRef} src={blobUrl} controls playsInline preload="metadata"
          onLoadedMetadata={event => {
            const video = event.currentTarget;
            if (video.videoWidth && video.videoHeight) {
              setVideoDimensions({ width: video.videoWidth, height: video.videoHeight });
            }
            setVideoError("");
          }}
          onError={() => setVideoError("動画を再生できません。Windows版のプレーヤーが対応するMP4／WebM形式を確認してください。")} />
        <canvas ref={canvasRef} aria-hidden="true" />
      </> : <div className="comment-video-live-empty">上で選択した元動画と同じファイルを指定すると、映像にコメントを重ねてプレビューします。</div>}
    </div>
    <small className="comment-video-live-note">
      {previewResult
        ? `実コメント ${schedule.length.toLocaleString("ja-JP")}件を時刻に沿って描画します（全${previewResult.comments.length.toLocaleString("ja-JP")}件のプレビュー候補）。コメントがない時間帯には表示されません。`
        : "動画とコメントログを選ぶと、実際のコメントを読み込んで動画時刻に重ねます。"}
      コメントは動画の全時間帯から抽出します。混雑時は表示しきれないサンプルを省略し、別の場面へ遅れて流れないようにします。動画プレビューはASS出力の近似表示です。元動画やログは変更しません。
    </small>
  </section>;
}
