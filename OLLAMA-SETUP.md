# Free local AI article generation for Kick live streams

All AI inference runs on the user's Windows PC. No OpenAI API key, cloud model account, or per-request AI fee is required. Internet access is needed only to download the installers and models and for Kick's own API/Webhook connectivity.

## 1. Install Ollama and models

Install Ollama from https://ollama.com/download, then run in PowerShell:

```powershell
ollama pull qwen2.5:3b
ollama pull qwen2.5vl:3b
```

- `qwen2.5:3b`: Japanese article writing and evidence synthesis.
- `qwen2.5vl:3b`: local visual descriptions for sampled video frames.

Keep Ollama running at its default local endpoint, `http://127.0.0.1:11434`.

## 2. Install the local media tools

- FFmpeg: obtain a Windows build from https://www.gyan.dev/ffmpeg/builds/ and select `ffmpeg.exe` in the app's Settings.
- Whisper.cpp: obtain a Windows x64 release from https://github.com/ggml-org/whisper.cpp/releases and select `whisper-cli.exe`.
- Japanese-capable Whisper model: download `ggml-base.bin` from https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin and select it in Settings.

The app remembers each selected path locally. The tools and model are not bundled in the installer.

## 3. Enable live multimodal articles

1. Register the Kick channel in the dashboard.
2. Start automatic or manual recording. Live audio/video analysis requires an active local recording.
3. Start chat receiving in Settings, register the displayed Webhook URL in Kick Developer, and subscribe to the channel's `chat.message.sent` event.
4. Enable "配信中の記事を自動生成".

While the stream is live and recording, the app samples one recent video frame and about 60 seconds of recent audio approximately every three minutes. Whisper.cpp transcribes the audio in Japanese. Ollama Vision summarizes what can be observed in the frame. The text model combines those observations with the saved Kick comments and stream metadata into a live article. A new article can be created even if no new chat message arrived during that cycle, as long as the recording remains active.

If recording is not active, the app can still make a comment-based article from saved chat messages, but it cannot analyze video or audio. If a tool or model is unavailable, the app reports a warning and can continue with whatever evidence is available.

## Privacy and accuracy

- Prompts and media samples are sent to the local Ollama server, not an OpenAI API.
- The temporary image/audio/transcript files used for a sampling cycle are removed after processing.
- Article JSON files retain the generated text, evidence-source labels, visual summary, and transcript sample so the article can be reviewed later.
- Speech recognition can mishear names, numbers, and overlapping speech. AI summaries may omit scene changes; review them against the original recording.
- The three-minute sampling design is a periodic snapshot, not a full-frame-by-frame video understanding or a perfect full-stream transcript.

## Performance

Models use local RAM and CPU/GPU resources. The 3B vision model and Whisper base model may be slow on older or low-memory PCs. The free design avoids cloud AI charges but does not remove local hardware requirements.

