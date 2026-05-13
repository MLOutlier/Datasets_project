import { useEffect, useRef, useState } from "react";
import "video.js/dist/video-js.css";

type PlayerState = {
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
};

type VideoJsPlayerProps = {
  src?: string;
  poster?: string;
  initialTime?: number;
  className?: string;
  onReady?: (player: any) => void;
  onStateChange?: (state: PlayerState) => void;
  onError?: (message: string) => void;
};

function guessType(src: string): string {
  if (src.endsWith(".m3u8")) return "application/x-mpegURL";
  if (src.endsWith(".mpd")) return "application/dash+xml";
  if (src.endsWith(".webm")) return "video/webm";
  return "video/mp4";
}

export function VideoJsPlayer({
  src,
  poster,
  initialTime = 0,
  className = "",
  onReady,
  onStateChange,
  onError,
}: VideoJsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<any | null>(null);
  const onReadyRef = useRef(onReady);
  const onStateChangeRef = useRef(onStateChange);
  const onErrorRef = useRef(onError);
  const [loading, setLoading] = useState(true);
  const [moduleError, setModuleError] = useState<string | null>(null);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    let cancelled = false;
    let cleanupListeners: (() => void) | null = null;

    async function mountPlayer() {
      if (!videoRef.current || !src) {
        setLoading(false);
        return;
      }

      setLoading(true);
      setModuleError(null);

      try {
        const mod = await import("video.js");
        if (cancelled || !videoRef.current) return;

        const videojs = mod.default;
        const player =
          playerRef.current ||
          videojs(videoRef.current, {
            controls: true,
            fluid: true,
            responsive: true,
            fill: true,
            autoplay: false,
            preload: "metadata",
            playsinline: true,
            poster,
            sources: [{ src, type: guessType(src) }],
            controlBar: {
              pictureInPictureToggle: false,
            },
          });

        playerRef.current = player;

        if (player.src) {
          player.src([{ src, type: guessType(src) }]);
        }
        if (poster) {
          player.poster?.(poster);
        }

        const syncState = () => {
          onStateChangeRef.current?.({
            currentTime: Number(player.currentTime?.() || 0),
            duration: Number(player.duration?.() || 0),
            paused: Boolean(player.paused?.()),
            ended: Boolean(player.ended?.()),
          });
        };

        const handleReady = () => {
          if (cancelled) return;
          if (Number.isFinite(initialTime)) {
            player.currentTime?.(Math.max(0, initialTime));
          }
          setLoading(false);
          syncState();
          onReadyRef.current?.(player);
        };

        const handleError = () => {
          const message = player.error?.()?.message || "Не удалось загрузить видеоплеер";
          setModuleError(message);
          setLoading(false);
          onErrorRef.current?.(message);
        };

        cleanupListeners = () => {
          player.off?.("timeupdate", syncState);
          player.off?.("loadedmetadata", handleReady);
          player.off?.("play", syncState);
          player.off?.("pause", syncState);
          player.off?.("ended", syncState);
          player.off?.("error", handleError);
        };

        player.on?.("timeupdate", syncState);
        player.on?.("loadedmetadata", handleReady);
        player.on?.("play", syncState);
        player.on?.("pause", syncState);
        player.on?.("ended", syncState);
        player.on?.("error", handleError);

        player.ready?.(handleReady);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Не удалось загрузить video.js";
        if (!cancelled) {
          setModuleError(message);
          setLoading(false);
          onErrorRef.current?.(message);
        }
      }
    }

    mountPlayer();

    return () => {
      cancelled = true;
      cleanupListeners?.();
    };
  }, [initialTime, poster, src]);

  useEffect(() => {
    return () => {
      if (playerRef.current?.dispose) {
        playerRef.current.dispose();
        playerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!playerRef.current || !src) return;
    playerRef.current.src([{ src, type: guessType(src) }]);
    if (poster) {
      playerRef.current.poster?.(poster);
    }
  }, [poster, src]);

  return (
    <div className={className}>
      <div className="relative overflow-hidden rounded-xl border border-gray-200 bg-black dark:border-gray-800">
        <div data-vjs-player className="relative aspect-video w-full">
          <video ref={videoRef} className="video-js vjs-big-play-centered h-full w-full" />
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/80 text-sm text-white">
              Загрузка плеера...
            </div>
          ) : null}
          {moduleError ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/80 p-4 text-center text-sm text-red-200">
              {moduleError}
            </div>
          ) : null}
          {!src ? (
            <div className="absolute inset-0 flex items-center justify-center bg-black/70 p-4 text-center text-sm text-white">
              Медиафайл не выбран
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
