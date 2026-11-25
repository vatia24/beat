import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createRoot } from "react-dom/client";
import QRCode from "qrcode";
import "@fontsource-variable/noto-sans-georgian";
import "@fontsource/barlow-condensed/latin-700.css";
import "./style.css";
import YouTubePanel from "./YouTubePanel";
import FilePlayer from "./FilePlayer";
import HostSyncPanel from "./HostSyncPanel";
import FileUpload from "./FileUpload";
import { roomApiUrl, youtubeSearchUrl, catalogUrl } from "./endpoints";
import { parseYoutubeId } from "./links";
import { useRoom, type RoomSnapshot } from "./useRoom";

const credentials = new Map<string, string>();
function hostKey(id: string) {
  try {
    return credentials.get(id) ?? sessionStorage.getItem("beatroom-host-" + id);
  } catch {
    return credentials.get(id) ?? null;
  }
}
function rememberHost(id: string, token: string) {
  credentials.set(id, token);
  try {
    sessionStorage.setItem("beatroom-host-" + id, token);
  } catch {
    /* The current tab still owns the room. */
  }
}

function Brand() {
  return (
    <a href="/" className="brand" aria-label="Beatroom — მთავარი">
      <img src="/beatroom.svg" width="34" height="34" alt="" />
      <span>BEATROOM</span>
    </a>
  );
}
function Header({ room }: { room?: string }) {
  return (
    <header className="site-header">
      <div className="header-inner">
        <Brand />
        <span className="header-context">
          {room ? (
            <>
              ოთახი <b>{room.slice(0, 6).toUpperCase()}</b>
            </>
          ) : (
            "მოსასმენი ოთახები"
          )}
        </span>
      </div>
    </header>
  );
}
function Cover() {
  return (
    <div className="cover" aria-hidden="true">
      <div className="cover-grid" />
      <div className="sleeve">
        <div className="disc">
          <div className="disc-grooves" />
          <div className="disc-label">
            <i />
          </div>
        </div>
        <div className="jacket">
          <div className="jacket-graphic">
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
        </div>
      </div>
    </div>
  );
}
function Home({ enter }: { enter: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function createRoom() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(roomApiUrl(), { method: "POST" });
      if (!response.ok) throw new Error();
      const { roomId, hostToken } = await response.json();
      if (typeof hostToken !== "string" || !/^[a-f0-9]{12}$/.test(roomId))
        throw new Error();
      rememberHost(roomId, hostToken);
      enter(roomId);
    } catch {
      setError("ოთახი ვერ შეიქმნა. შეამოწმე კავშირი და ხელახლა სცადე.");
      setBusy(false);
    }
  }
  return (
    <>
      <Header />
      <main className="home">
        <section className="lobby-card">
          <div className="lobby-copy">
            <h1>
              საერთო
              <br />
              <span>მოსმენა</span>
            </h1>
            <p>
              დაუკარი ერთი ტრეკი რამდენიმე ტელეფონზე. ატვირთე აუდიოფაილი ან
              აირჩიე YouTube ვიდეო და მეგობრებს ოთახის ბმული გაუზიარე.
            </p>
            <button
              className="btn btn-primary create-button"
              onClick={createRoom}
              disabled={busy}
            >
              <span aria-hidden="true">＋</span>
              {busy ? "იქმნება…" : "ოთახის შექმნა"}
            </button>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </div>
          <Cover />
        </section>
        <div className="home-note">
          <span className="note-icon" aria-hidden="true">
            ♪
          </span>
          <p>
            სტუმარი ოთახში გაზიარებული ბმულით შედის და ხმას საკუთარ ტელეფონზე
            რთავს.
          </p>
        </div>
      </main>
    </>
  );
}

function Share({ id }: { id: string }) {
  const link = new URL("/r/" + id, location.origin).href;
  const [qr, setQr] = useState("");
  const [status, setStatus] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    QRCode.toDataURL(link, {
      margin: 4,
      width: 256,
      errorCorrectionLevel: "M",
      color: { dark: "#161916", light: "#ffffff" },
    })
      .then((url) => {
        if (active) setQr(url);
      })
      .catch(() => {
        if (active) setStatus("გამოიყენე ოთახის ბმული.");
      });
    return () => {
      active = false;
    };
  }, [link]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setStatus("ბმული დაკოპირდა.");
    } catch {
      input.current?.focus();
      input.current?.select();
      setStatus("მონიშნული ბმული დააკოპირე.");
    }
  }
  return (
    <section className="panel share-panel">
      <h2 className="panel-title">მოიწვიე მეგობარი</h2>
      <div className="share-content">
        {qr && (
          <img
            className="qr"
            src={qr}
            alt="ოთახში შესასვლელი QR კოდი"
            width="140"
            height="140"
          />
        )}
        <p>დაასკანერე QR ან გახსენი ოთახის ბმული მეორე ტელეფონზე.</p>
      </div>
      <div className="copy-line">
        <input
          ref={input}
          aria-label="ოთახის ბმული"
          readOnly
          value={link}
          dir="ltr"
        />
        <button className="btn btn-secondary" onClick={copy}>
          კოპირება
        </button>
      </div>
      {status && (
        <p role="status" className="status-note">
          {status}
        </p>
      )}
    </section>
  );
}
function TrackForm({ choose, chooseCatalog, disabled, current }: {
  choose: (id: string) => boolean;
  chooseCatalog: (id: string) => boolean;
  disabled: boolean;
  current: string | null;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [results, setResults] = useState<{ id: string; title: string; channel: string; thumbnail: string }[]>([]);
  const [catalog, setCatalog] = useState<{ id: string; name: string; youtubeId: string | null }[]>([]);
  const [matchedVideo, setMatchedVideo] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const query = value.trim();
    const videoId = parseYoutubeId(query);
    if (videoId) {
      controller.current?.abort();
      const request = new AbortController();
      controller.current = request;
      setSearching(true);
      setMatchedVideo(videoId);
      setResults([]);
      setCatalog([]);
      try {
        const response = await fetch(catalogUrl('', videoId), { signal: request.signal });
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (!request.signal.aborted) setCatalog(data.results ?? []);
      } catch {
        if (!request.signal.aborted) setError('კატალოგის შემოწმება ვერ მოხერხდა. YouTube-ის არჩევა შეგიძლიათ.');
      } finally {
        if (controller.current === request) { controller.current = null; setSearching(false); }
      }
      return;
    }
    if (query.length < 2) { setError("ჩაწერეთ სიმღერის სახელი ან YouTube ბმული."); return; }
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setSearching(true);
    setResults([]);
    setError("");
    try {
      const [own, youtube] = await Promise.allSettled([
        fetch(catalogUrl(query), { signal: request.signal }),
        fetch(youtubeSearchUrl(query), { signal: request.signal }),
      ]);
      if (request.signal.aborted) return;
      if (own.status === 'fulfilled' && own.value.ok) {
        const data = await own.value.json();
        setCatalog(Array.isArray(data.results) ? data.results : []);
      }
      if (youtube.status === 'fulfilled' && youtube.value.ok) {
        const data = await youtube.value.json();
        setResults(Array.isArray(data.results) ? data.results : []);
      } else if (own.status !== 'fulfilled' || !own.value.ok) {
        setError('ძიება ვერ შესრულდა. ჩასვით YouTube ბმული.');
      }
    } catch (reason) {
      if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : "ძიება ვერ შესრულდა.");
    } finally {
      if (controller.current === request) { controller.current = null; setSearching(false); }
    }
  }

  return <form onSubmit={submit} className="track-form">
    <label htmlFor="yt-link">{current ? "მოძებნეთ ან შეცვალეთ ვიდეო" : "სიმღერის ძიება ან YouTube ბმული"}</label>
    <div className="input-line">
      <input id="yt-link" type="text" autoCapitalize="none" spellCheck={false}
        placeholder="სიმღერის სახელი ან YouTube ბმული" value={value}
        onChange={e => { setValue(e.target.value); setError(""); setResults([]); setCatalog([]); setMatchedVideo(null); controller.current?.abort(); }} />
      <button type="submit" className="btn btn-secondary" disabled={disabled || searching || !value.trim()}>
        {searching ? "იძებნება…" : "არჩევა"}
      </button>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {catalog.length > 0 && <><p className="status-note">Beatroom-ის აუდიო · ზუსტი პლეერი</p>
      <ul className="youtube-results">{catalog.map(item => <li key={item.id}>
        <button type="button" className="youtube-result" disabled={disabled} onClick={() => {
          if (chooseCatalog(item.id)) { setCatalog([]); setResults([]); setMatchedVideo(null); setValue(''); }
        }}>{item.name} · Beatroom-ის პლეერით დაკვრა</button>
      </li>)}</ul></>}
    {matchedVideo && <button type="button" className="btn btn-secondary" disabled={disabled} onClick={() => {
      if (choose(matchedVideo)) { setCatalog([]); setMatchedVideo(null); setValue(''); }
    }}>YouTube-ის ხილული პლეერით დაკვრა</button>}
    {results.length > 0 && <p className="status-note">YouTube · მიახლოებითი სინქრონიზაცია</p>}
    {results.length > 0 && <ul className="youtube-results">{results.map(item => <li key={item.id}>
      <button type="button" className="youtube-result" disabled={disabled} onClick={() => {
        if (choose(item.id)) { setResults([]); setValue(""); }
      }}>
        {item.thumbnail && <img src={item.thumbnail} width="80" height="60" alt="" />}
        <span><strong>{item.title}</strong><br />{item.channel}</span>
      </button>
    </li>)}</ul>}
  </form>;
}

type Telemetry = { position: number | null; state: string; duration?: number };
const names: Record<string, string> = {
  PLAYING: "უკრავს",
  PAUSED: "პაუზა",
  CUED: "ვიდეო არჩეულია",
  BUFFERING: "იტვირთება",
  ENDED: "დასრულდა",
  UNSTARTED: "არ დაწყებულა",
  ERROR: "შეცდომა",
  WAITING: "მოლოდინი",
  AUTOPLAY_BLOCKED: "შეხებაა საჭირო",
  LOADING: "იტვირთება",
  EMPTY: "ტრეკი არ არის",
  READY: "მზადაა",
  SCHEDULED: "სტარტი დანიშნულია",
  SUSPENDED: "დაკვრა შეჩერებულია",
  DECODING: "აუდიო მზადდება",
  UNKNOWN: "უცნობია",
};
function target(room: RoomSnapshot | null, now: number | null) {
  if (!room || !(room.videoId || room.file) || now === null) return null;
  return (
    room.anchorMediaSec +
    (room.playing ? Math.max(0, (now - room.anchorServerMs) / 1000) : 0)
  );
}
function mediaTime(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "—";
  const n = Math.max(0, Math.floor(value * 10));
  return (
    Math.floor(n / 600) +
    ":" +
    String(Math.floor(n / 10) % 60).padStart(2, "0") +
    "." +
    (n % 10)
  );
}
function Room({ id }: { id: string }) {
  const token = hostKey(id);
  const session = useRoom(id, token);
  const { room, role, connected, serverNow, sendCommand, commandPending } =
    session;
  const latest = useRef({ room, serverNow });
  latest.current = { room, serverNow };
  const [sample, setSample] = useState<{
    v: number;
    data: Telemetry;
    target: number | null;
  }>({ v: -1, data: { position: null, state: "WAITING" }, target: null });
  const [now, setNow] = useState<number | null>(null);
  const [source, setSource] = useState<"file" | "youtube" | null>(null);
  const [uploading, setUploading] = useState(false);
  const [localReady, setLocalReady] = useState<string | null>(null);
  const onReadyChange = useCallback((fileId: string, ready: boolean) => {
    if (ready) setLocalReady(fileId);
    else setLocalReady(current => current === fileId ? null : current);
    session.reportFileReady(fileId, ready);
  }, [session.reportFileReady]);
  const endSentFor = useRef(-1);
  const onTelemetry = useCallback((data: Telemetry) => {
    const { room: r, serverNow: clock } = latest.current;
    setSample({ v: r?.version ?? -1, data, target: target(r, clock()) });
  }, []);
  const onPlaybackSample = session.reportPlaybackSample;
  useEffect(() => {
    const tick = () => setNow(serverNow());
    tick();
    const timer = window.setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [serverNow]);
  const isHost = role === "host";
  const sourceTab = source ?? (room?.videoId ? "youtube" : "file");
  const waiting = room?.playing && now !== null && now < room.anchorServerMs;
  const active = connected && session.clockReady && !commandPending;
  const matched = sample.v === room?.version;
  const d = matched ? sample.data : { position: null, state: "WAITING" };
  useEffect(() => {
    if (!room?.file) endSentFor.current = -1;
  }, [room?.file?.id]);
  useEffect(() => {
    if (!isHost || !active || !room?.file || !room.playing || !matched || d.state !== "ENDED") return;
    if (endSentFor.current === room.version) return;
    endSentFor.current = room.version;
    sendCommand("end", undefined, { version: room.version });
  }, [isHost, active, room, matched, d.state, sendCommand]);
  const drift =
    connected &&
    matched &&
    room?.playing &&
    !waiting &&
    d.state === "PLAYING" &&
    d.position !== null &&
    sample.target !== null
      ? Math.round((d.position - sample.target) * 1000)
      : null;
  const driftText =
    drift === null ? "—" : (drift > 0 ? "+" : "") + drift + " ms";
  return (
    <>
      <Header room={id} />
      <main className="room-main">
        <div className="room-head">
          <div>
            <p className="room-role">
              {isHost ? "მასპინძელი" : room ? "სტუმარი" : "დაკავშირება"}
            </p>
            <h1>მოსასმენი ოთახი</h1>
          </div>
          <span className={"presence " + (connected ? "online" : "")}>
            <i />
            {connected
              ? session.participants + " მონაწილე"
              : "კავშირი მყარდება"}
          </span>
        </div>
        {session.error && (
          <p className="error banner" role="alert">
            {session.error}
          </p>
        )}
        <div className="room-grid">
          <div className="room-left">
            {isHost && room && token && (
              <div className="panel track-panel">
                <div className="source-choice" role="group" aria-label="ტრეკის წყარო">
                  <button type="button" disabled={uploading} aria-pressed={sourceTab === "file"}
                    onClick={() => setSource("file")}>აუდიოფაილი</button>
                  <button type="button" disabled={uploading} aria-pressed={sourceTab === "youtube"}
                    onClick={() => setSource("youtube")}>YouTube</button>
                </div>
                {sourceTab === "file" ? (
                  <FileUpload room={room} token={token} busy={uploading} setBusy={setUploading}
                    disabled={!connected || commandPending} />
                ) : <TrackForm
                  current={room?.videoId ?? null}
                  choose={(v) => sendCommand("track", v)}
                  chooseCatalog={(id) => sendCommand("catalog", undefined, { catalogId: id })}
                  disabled={!connected || commandPending}
                />}
              </div>
            )}
            {room?.file ? (
              <FilePlayer key={room.file.id} room={room} connected={connected} clockReady={session.clockReady}
                serverNow={serverNow} onTelemetry={onTelemetry} onReadyChange={onReadyChange}
                onPlaybackSample={onPlaybackSample} />
            ) : room ? (
              <YouTubePanel
                room={room}
                role={role}
                connected={connected}
                serverNow={serverNow}
                onTelemetry={onTelemetry}
              />
            ) : (
              <div className="panel">
                <p>
                  {session.error
                    ? "ოთახის გახსნა ვერ მოხერხდა."
                    : "ოთახის მონაცემები იტვირთება…"}
                </p>
                {session.error && <a href="/">მთავარზე დაბრუნება</a>}
              </div>
            )}
            {isHost && room?.file && (
              <HostSyncPanel room={room} roster={session.roster} samples={session.participantSamples}
                nowMs={now} />
            )}
            {isHost && room && (
              <section className="panel transport">
                <div>
                  <h2 className="panel-title">ოთახის მართვა</h2>
                  <p className="status-note" aria-live="polite">
                    {waiting
                      ? "საერთო სტარტი დანიშნულია"
                      : room.playing
                        ? "ოთახში მუსიკა უკრავს"
                        : room.videoId || room.file
                          ? "ტრეკი შერჩეულია"
                          : "ჯერ აირჩიე ტრეკი"}
                  </p>
                  {room.file && <p className="status-note" aria-live="polite">
                    მზადაა {session.readyCount} / {session.participants} ტელეფონი
                  </p>}
                </div>
                <div className="transport-actions">
                  <button
                    className="btn btn-primary"
                    disabled={!(room.videoId || room.file) || !active || uploading ||
                      (!!room.file && !room.playing && (localReady !== room.file.id ||
                        session.readyCount < session.participants))}
                    onClick={() => sendCommand(room.playing ? "pause" : "play", undefined,
                      room.file && !room.playing ? { startPolicy: "together" } : undefined)}
                  >
                    <span aria-hidden="true">{room.playing ? "Ⅱ" : "▶"}</span>
                    {room.playing ? "ყველასთვის პაუზა" : "საერთო სტარტი (ყველა ტელეფონი)"}
                  </button>
                  {room.file && !room.playing && (
                    <button
                      className="btn btn-secondary"
                      disabled={!(room.file) || !active || uploading || session.readyCount < 1 ||
                        localReady !== room.file.id}
                      onClick={() => sendCommand("play", undefined, { startPolicy: "ready" })}
                    >
                      მზად ტელეფონებით დაკვრა
                    </button>
                  )}
                </div>
              </section>
            )}
          </div>
          <aside className="room-side">
            {room && <Share id={id} />}
            <section className="panel diagnostics">
              <h2 className="panel-title">დიაგნოსტიკა</h2>
              <dl>
                {[
                  [
                    "კავშირის RTT",
                    session.rtt === null
                      ? "—"
                      : Math.round(session.rtt) + " ms",
                  ],
                  ["სამიზნე პოზიცია", mediaTime(matched && d.position !== null ? sample.target : target(room, now))],
                  [room?.file ? "ფაილის პოზიცია" : "YouTube-ის პოზიცია", mediaTime(d.position)],
                  ["პლეერის მდგომარეობა", names[d.state] ?? d.state],
                  ["პლეერის შეფასებული აცდენა", driftText],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              <p className="status-note">
                აცდენა ითვლება პლეერის პოზიციით. დადებითი მნიშვნელობა ნიშნავს,
                რომ პლეერი სამიზნეს უსწრებს. დინამიკიდან ხმის გამოსვლის დრო
                ცალკე სიდიდეა.
              </p>
              {(room?.file || room?.videoId) && <p className="baseline">{room.file
                ? "ფაილის დაკვრისას ავტომატური კორექცია ჩართულია"
                : "YouTube-ზე კორექცია მხოლოდ ხელით სინქრონიზაციისას მუშაობს"}</p>}
            </section>
          </aside>
        </div>
      </main>
    </>
  );
}
function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const f = () => setPath(location.pathname);
    window.addEventListener("popstate", f);
    return () => window.removeEventListener("popstate", f);
  }, []);
  const id = path.match(/^\/r\/([a-f0-9]{12})\/?$/)?.[1];
  return id ? (
    <Room key={id} id={id} />
  ) : (
    <Home
      enter={(roomId) => {
        const url = "/r/" + roomId;
        history.pushState(null, "", url);
        setPath(url);
        window.scrollTo(0, 0);
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(<App />);
