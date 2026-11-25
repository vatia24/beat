import { useCallback, useEffect, useRef, useState } from "react";
import type { RoomSnapshot } from "./protocol";
import { loadYouTubeApi, type YouTubePlayer } from "./youtube-api";
import { YouTubeResync } from "./youtube-resync";
import { YouTubeAutoSync } from "./youtube-auto-sync";

export interface YouTubeTelemetry {
  position: number | null;
  state: string;
}

interface PanelProps {
  room: RoomSnapshot;
  serverNow: () => number | null;
  role: "host" | "guest";
  connected: boolean;
  onTelemetry: (value: YouTubeTelemetry) => void;
}

const labels: Record<number, string> = {
  [-1]: "UNSTARTED", 0: "ENDED", 1: "PLAYING", 2: "PAUSED", 3: "BUFFERING", 5: "CUED",
};
const errorHints: Record<number, string> = {
  2: "ვიდეოს ბმული არასწორია. მასპინძელმა სხვა ბმული უნდა აირჩიოს.",
  5: "ამ ბრაუზერში ვიდეო ვერ ჩაირთო. სცადე პლეერის ხელახლა გახსნა.",
  100: "ვიდეო წაშლილია ან დახურულია. მასპინძელმა სხვა ბმული უნდა აირჩიოს.",
  101: "ავტორი ამ ვიდეოს სხვა საიტზე დაკვრას არ უშვებს. აირჩიეთ სხვა ვიდეო.",
  150: "ავტორი ამ ვიდეოს სხვა საიტზე დაკვრას არ უშვებს. აირჩიეთ სხვა ვიდეო.",
  153: "YouTube ამ საიტს ვერ ცნობს. გადაამოწმე, რომ გვერდი საჯარო HTTPS ბმულითაა გახსნილი და Referer იგზავნება.",
};

function sufficientlyVisible(element: HTMLElement | null) {
  if (!element || document.hidden) return false;
  const r = element.getBoundingClientRect();
  const w = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
  const h = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
  return w * h > r.width * r.height / 2;
}

function ActivePlayer(props: PanelProps & {
  videoId: string;
  optedIn: boolean;
  optIn: () => void;
}) {
  const latest = useRef(props);
  latest.current = props;
  const stage = useRef<HTMLDivElement>(null);
  const player = useRef<YouTubePlayer | null>(null);
  const ready = useRef(false);
  const lastState = useRef("LOADING");
  const applied = useRef(-1);
  const prepared = useRef(-1);
  const held = useRef(false);
  const awaitingNativePlay = useRef(false);
  const pending = useRef<number | undefined>(undefined);
  const manual = useRef<YouTubeResync | null>(null);
  const automatic = useRef(new YouTubeAutoSync());
  const [autoSync, setAutoSync] = useState(true);
  const autoSyncEnabled = useRef(autoSync);
  autoSyncEnabled.current = autoSync;
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState("YouTube პლეერი იტვირთება.");
  const [fault, setFault] = useState("");
  const [generation, setGeneration] = useState(0);
  const [isReady, setIsReady] = useState(false);
  const cancel = useCallback(() => window.clearTimeout(pending.current), []);
  const finishManual = useCallback((message?: string) => {
    if (!manual.current) return;
    manual.current = null;
    setChecking(false);
    if (message) setNotice(message);
  }, []);

  const tickManual = useCallback(() => {
    const run = manual.current;
    const p = player.current;
    if (!run || !p) return;
    const { room, connected, serverNow } = latest.current;
    const now = serverNow();
    if (!connected || !room.playing || room.version !== run.roomVersion || now === null ||
        !sufficientlyVisible(stage.current) || held.current || awaitingNativePlay.current) {
      finishManual("ადგილობრივი კორექცია შეწყდა. დასაბრუნებლად გამოაჩინე ვიდეო და ხელახლა სცადე.");
      return;
    }
    const state = p.getPlayerState();
    if ((state !== 1 && state !== 3) || p.getPlaybackRate() !== 1) {
      finishManual("სინქრონიზაციისთვის ჩართე ძირითადი სიმღერა ჩვეულებრივ სიჩქარეზე (1×) და ხელახლა სცადე.");
      return;
    }
    const target = room.anchorMediaSec + (now - room.anchorServerMs) / 1000;
    const result = run.sample(performance.now(), target, p.getCurrentTime(), state === 1, p.getDuration());
    if (result.kind === "finish") finishManual(result.message);
    if (result.kind === "seek") {
      setNotice("ამ ტელეფონზე გადახვევა მოთხოვნილია. პლეერის პასუხი მოწმდება…");
      p.seekTo(result.position, true);
    }
  }, [finishManual]);

  const report = useCallback((state: string) => {
    lastState.current = state;
    const seconds = ready.current ? player.current?.getCurrentTime() : null;
    latest.current.onTelemetry({
      state,
      position: typeof seconds === "number" && Number.isFinite(seconds) ? seconds : null,
    });
  }, []);

  // Apply a room revision only once. The clock is sampled again at the deadline
  // because both the offset estimate and browser timer delivery can change.
  const reconcile = useCallback(function apply(localAction: "join" | null = null) {
    cancel();
    const { room, connected, optedIn, role, videoId, serverNow } = latest.current;
    const p = player.current;
    if (!connected || !ready.current || !p) return;
    if (localAction) {
      held.current = false;
      applied.current = -1;
    }
    if (applied.current === room.version && !localAction) return;

    if (!room.playing) {
      const state = p.getPlayerState();
      if (state === 1 || state === 3) p.pauseVideo();
      // Cueing also prepares a paused room for a newcomer, without starting sound.
      p.cueVideoById({ videoId, startSeconds: room.anchorMediaSec });
      applied.current = room.version;
      if (optedIn || role === "host" || localAction) setNotice("მზადაა. დაკვრა მასპინძლის საერთო ღილაკით დაიწყება.");
      else setNotice("ამ ტელეფონით მონაწილეობის მისაღებად ჩართე ხმა ქვემოთ.");
      return;
    }
    if ((!optedIn && role !== "host" && !localAction) || held.current) return;
    if (!sufficientlyVisible(stage.current) && (!localAction || document.hidden)) {
      setNotice("დასაწყებად ეკრანზე გამოაჩინე YouTube პლეერი.");
      return;
    }
    const now = serverNow();
    if (now === null) {
      setNotice("ტელეფონი ოთახის საათს ამოწმებს.");
      pending.current = window.setTimeout(() => apply(), 150);
      return;
    }
    const remaining = room.anchorServerMs - now;
    if (remaining > 0) {
      if (prepared.current !== room.version) {
        // A resumed room has a non-zero anchor. A cue never starts playback.
        if (room.anchorMediaSec > 0) p.cueVideoById({ videoId, startSeconds: room.anchorMediaSec });
        prepared.current = room.version;
        setNotice("საერთო სტარტი დანიშნულია.");
      }
      pending.current = window.setTimeout(() => apply(), Math.ceil(remaining));
      return;
    }

    applied.current = room.version;
    const target = room.anchorMediaSec - remaining / 1000;
    const state = p.getPlayerState();
    setNotice("დაკვრა მოთხოვნილია. თუ ხმა არ ისმის, ვიდეოში დააჭირე ▶.");
    if (prepared.current === room.version && -remaining < 200) {
      p.playVideo();
    } else if (state === 1 || state === 2 || state === 3) {
      p.seekTo(target, true);
      if (state === 2) p.playVideo();
    } else {
      p.loadVideoById({ videoId, startSeconds: target });
    }
  }, [cancel]);

  useEffect(() => {
    const node = stage.current;
    if (!node) return;
    let disposed = false;
    let instance: YouTubePlayer | null = null;
    const { videoId } = latest.current;
    automatic.current.reset();
    ready.current = false;
    held.current = false;
    awaitingNativePlay.current = false;
    applied.current = -1;
    prepared.current = -1;
    setIsReady(false);
    setFault("");
    setNotice("YouTube პლეერი იტვირთება.");
    report("LOADING");

    const iframe = document.createElement("iframe");
    const url = new URL("https://www.youtube.com/embed/" + videoId);
    url.search = new URLSearchParams({
      enablejsapi: "1", playsinline: "1", controls: "1", origin: location.origin,
    }).toString();
    iframe.src = url.href;
    iframe.className = "player-frame";
    iframe.title = "ოთახის YouTube ვიდეო";
    iframe.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    iframe.allowFullscreen = true;
    node.replaceChildren(iframe);

    function fail(message: string) {
      if (disposed) return;
      finishManual();
      ready.current = false;
      cancel();
      setIsReady(false);
      setFault(message);
      report("ERROR");
    }
    const watchdog = window.setTimeout(() => {
      if (!ready.current) fail("პლეერი ჯერ არ პასუხობს. შეამოწმე ინტერნეტკავშირი და კვლავ სცადე.");
    }, 20000);
    loadYouTubeApi().then(api => {
      if (disposed) return;
      instance = new api.Player(iframe, { events: {
        onReady({ target }) {
          if (disposed) return;
          player.current = target;
          ready.current = true;
          window.clearTimeout(watchdog);
          setFault("");
          setIsReady(true);
          report(labels[target.getPlayerState()] ?? "UNSTARTED");
          setNotice("ამ ტელეფონით მონაწილეობის მისაღებად ჩართე ხმა ქვემოთ.");
          reconcile();
        },
        onStateChange({ data }) {
          if (disposed || !ready.current) return;
          const previous = lastState.current;
          const state = labels[data] ?? "UNKNOWN";
          report(state);
          if (state === "BUFFERING") setNotice("ეს ტელეფონი ვიდეოს ტვირთავს.");
          if (state === "ENDED") { finishManual(); setNotice("ვიდეო დასრულდა."); }
          if (state === "PAUSED" || state === "CUED" || state === "UNSTARTED") {
            finishManual("პლეერი შეჩერდა. როცა სიმღერა გაისმება, ხელახლა სცადე.");
          }
          if (state === "PLAYING") {
            const afterBlock = awaitingNativePlay.current;
            awaitingNativePlay.current = false;
            if (held.current || applied.current !== latest.current.room.version) {
              // Native Play is a user gesture. Respect it; manual resync is
              // available once the main content is audible, including after ads.
              latest.current.optIn();
              applied.current = latest.current.room.version;
              held.current = false;
            }
            if (!manual.current) setNotice(afterBlock
              ? "როცა ძირითად სიმღერას გაიგონებ, დააჭირე „ხელახლა სინქრონიზაციას“, რომ ოთახის მიმდინარე პოზიციაზე გადახვიდე."
              : "თუ რიტმი აცდა, ძირითადი სიმღერის დროს დააჭირე „ხელახლა სინქრონიზაციას“.");
          }
          if (state === "PAUSED" && previous === "PLAYING" && latest.current.room.playing &&
              applied.current === latest.current.room.version) {
            held.current = true;
            setNotice("ამ ტელეფონზე დაკვრა შეჩერდა. დაბრუნებისთვის გამოიყენე ხელახლა სინქრონიზაცია.");
          }
        },
        onAutoplayBlocked() {
          if (disposed) return;
          held.current = true;
          awaitingNativePlay.current = true;
          finishManual();
          cancel();
          report("AUTOPLAY_BLOCKED");
          setNotice("ხმის ჩასართავად თავად YouTube ვიდეოში დააჭირე ▶. სიმღერის დაწყების შემდეგ შეგიძლია ხელახლა სინქრონიზაცია.");
        },
        onError({ data }) {
          window.clearTimeout(watchdog);
          fail(errorHints[data] ?? "YouTube ვიდეოს ვერ უკრავს. გადაამოწმე პლეერში ნაჩვენები შეტყობინება.");
        },
      } });
    }).catch(() => fail("YouTube პლეერის ჩატვირთვა ვერ მოხერხდა. შეამოწმე კავშირი და კვლავ სცადე."));

    // Correct stable large errors with a long cooldown; the visible iframe owns playback.
    const poll = window.setInterval(() => {
      if (ready.current) report(lastState.current);
      tickManual();
      const { room, connected, serverNow } = latest.current;
      const p = player.current;
      const now = serverNow();
      if (!autoSyncEnabled.current || manual.current || !p || !ready.current || !connected || !room.playing ||
          applied.current !== room.version || held.current || awaitingNativePlay.current ||
          !sufficientlyVisible(stage.current) || now === null || now < room.anchorServerMs ||
          p.getPlayerState() !== 1 || p.getPlaybackRate() !== 1) {
        automatic.current.reset();
        return;
      }
      const target = room.anchorMediaSec + (now - room.anchorServerMs) / 1000;
      const seek = automatic.current.sample(performance.now(), target, p.getCurrentTime(), p.getDuration());
      if (seek !== null) {
        p.seekTo(seek, true);
        setNotice('შესამჩნევი ჩამორჩენა გასწორდა. YouTube-ის სინქრონიზაცია მიახლოებითია.');
      }
    }, 350);
    const visible = new IntersectionObserver(() => reconcile(), { threshold: [0, 0.5, 0.51, 1] });
    visible.observe(node);
    function onVisibility() {
      if (!document.hidden) { reconcile(); return; }
      cancel();
      finishManual();
      if (ready.current && latest.current.room.playing && player.current) {
        held.current = true;
        player.current.pauseVideo();
        setNotice("გვერდზე დაბრუნების შემდეგ ოთახს ხელახლა შეუერთდი სინქრონიზაციის ღილაკით.");
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      finishManual();
      ready.current = false;
      cancel();
      window.clearTimeout(watchdog);
      window.clearInterval(poll);
      visible.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      instance?.destroy();
      player.current = null;
      node.replaceChildren();
    };
  }, [generation, cancel, finishManual, reconcile, report, tickManual]);

  useEffect(() => {
    automatic.current.reset();
    if (!props.connected || manual.current?.roomVersion !== props.room.version) finishManual();
    reconcile();
    return cancel;
  }, [props.room.version, props.connected, props.optedIn, props.role, reconcile, cancel, finishManual]);

  function enable() {
    props.optIn();
    player.current?.unMute();
    reconcile("join");
  }

  function resync() {
    const { room, serverNow } = latest.current;
    const p = player.current;
    const now = serverNow();
    if (!p || manual.current || now === null || now < room.anchorServerMs) {
      setNotice("დაელოდე ოთახის საათს და საერთო სტარტს.");
      return;
    }
    if (!sufficientlyVisible(stage.current)) {
      setNotice("სინქრონიზაციისთვის ეკრანზე გამოაჩინე YouTube პლეერი.");
      return;
    }
    if (awaitingNativePlay.current) {
      setNotice("თავად ვიდეოში დააჭირე ▶. როცა რეკლამა დასრულდება და სიმღერას გაიგონებ, ხელახლა დააჭირე სინქრონიზაციას.");
      return;
    }
    const state = p.getPlayerState();
    if (state !== 1) {
      setNotice("როცა ძირითადი სიმღერა გაისმება, ხელახლა დააჭირე სინქრონიზაციას. საჭიროებისას ვიდეოში დააჭირე ▶.");
      if (state === 2 || state === 5 || state === -1) {
        held.current = false;
        awaitingNativePlay.current = true;
        p.playVideo();
      }
      return;
    }
    held.current = false;
    applied.current = room.version;
    manual.current = new YouTubeResync(room.version, performance.now());
    setChecking(true);
    setNotice("ამ ტელეფონის პლეერის პოზიცია მოწმდება…");
    tickManual();
  }

  return <>
    <div className="player-stage" ref={stage} />
    <div className="player-controls">
      <label><input type="checkbox" checked={autoSync} onChange={e => setAutoSync(e.target.checked)} /> დიდი აცდენის ავტომატური გასწორება</label>
      {props.role !== "host" && !props.optedIn &&
        <button className="btn btn-primary" disabled={!isReady || !props.connected} onClick={enable}>ხმის ჩართვა ამ ტელეფონზე</button>}
      <button className="btn btn-secondary" disabled={checking || !isReady || !props.connected || !props.room.playing ||
        (!props.optedIn && props.role !== "host")} onClick={resync}>{checking ? "პოზიცია მოწმდება…" : "ხელახლა სინქრონიზაცია"}</button>
      {fault && <button className="btn btn-secondary" onClick={() => setGeneration(n => n + 1)}>პლეერის თავიდან ჩატვირთვა</button>}
    </div>
    <p className="status-note" role="status">{fault || notice}</p>
    <p className="status-note">YouTube-ის ხილული პლეერი. სინქრონიზაცია მიახლოებითია.</p>
  </>;
}

export function YouTubePanel(props: PanelProps) {
  const [armedRoom, setArmedRoom] = useState<string | null>(null);
  const { room } = props;
  const emit = useRef(props.onTelemetry);
  emit.current = props.onTelemetry;
  useEffect(() => {
    if (!room.videoId) emit.current({ position: null, state: "EMPTY" });
  }, [room.id, room.videoId]);

  return <section className="panel player-panel" aria-label="YouTube პლეერი">
    <div className="panel-heading"><h2 className="panel-title">YouTube პლეერი</h2></div>
    {room.videoId
      ? <ActivePlayer key={room.id + "/" + room.videoId} {...props} videoId={room.videoId}
          optedIn={armedRoom === room.id} optIn={() => setArmedRoom(room.id)} />
      : <><div className="player-stage player-empty"><p>{props.role === "host"
          ? "ვიდეოს დასამატებლად ჩასვი YouTube ბმული."
          : "მასპინძელი ჯერ ვიდეოს არჩევს."}</p></div>
          {props.role === "guest" && <div className="player-controls">
            <button className="btn btn-primary" disabled={armedRoom === room.id || !props.connected}
              onClick={() => setArmedRoom(room.id)}>{armedRoom === room.id
                ? "დაკვრისთვის მზადაა" : "ხმის ჩართვა ამ ტელეფონზე"}</button></div>}</>}
  </section>;
}

export default YouTubePanel;
