export interface YouTubePlayer {
  playVideo(): void;
  pauseVideo(): void;
  unMute(): void;
  cueVideoById(options: { videoId: string; startSeconds: number }): void;
  loadVideoById(options: { videoId: string; startSeconds: number }): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlaybackRate(): number;
  getPlayerState(): number;
  destroy(): void;
}

type PlayerEvent = { target: YouTubePlayer };
type PlayerValueEvent = PlayerEvent & { data: number };

interface YouTubeApi {
  Player: new (element: HTMLIFrameElement, options: { events: {
    onReady(event: PlayerEvent): void;
    onStateChange(event: PlayerValueEvent): void;
    onAutoplayBlocked(event: PlayerEvent): void;
    onError(event: PlayerValueEvent): void;
  } }) => YouTubePlayer;
}

declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let loading: Promise<YouTubeApi> | undefined;

export function loadYouTubeApi(): Promise<YouTubeApi> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (loading) return loading;

  loading = new Promise<YouTubeApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    const previous = window.onYouTubeIframeAPIReady;

    function finish() {
      window.clearTimeout(timeout);
      script.onerror = null;
      if (window.onYouTubeIframeAPIReady === ready) {
        window.onYouTubeIframeAPIReady = previous;
      }
    }
    function failed() {
      finish();
      script.remove();
      loading = undefined;
      reject(new Error("YouTube IFrame API unavailable"));
    }
    function ready() {
      if (!window.YT?.Player) return failed();
      finish();
      resolve(window.YT);
      previous?.();
    }
    const timeout = window.setTimeout(failed, 15000);
    script.onerror = failed;
    window.onYouTubeIframeAPIReady = ready;
    document.head.append(script);
  });
  return loading;
}
