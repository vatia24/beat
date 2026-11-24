import { useEffect, useRef, useState, type FormEvent } from "react";
import { mediaFileUrl } from "./endpoints";
import type { RoomSnapshot } from "./protocol";

const maxBytes = 32 * 1024 * 1024;
const errors: Record<number, string> = {
  401: "ატვირთვა მასპინძლის ჩანართიდან სცადე.",
  403: "ატვირთვის უფლება ვერ დადასტურდა. გადაამოწმე ოთახი და საიტის მისამართი.",
  404: "ოთახი ვეღარ მოიძებნა. შექმენი ახალი ოთახი.",
  409: "ატვირთვისას ოთახის მდგომარეობა შეიცვალა. ფაილი ისევ შეგიძლია ატვირთო.",
  413: "ფაილი დიდია. აირჩიე მაქსიმუმ 32 MiB ზომის ფაილი.",
  415: "ეს ფორმატი ვერ ამოვიცანით. აირჩიე MP3, WAV ან M4A.",
  503: "სერვერის დროებითი საცავი დაკავებულია. მოგვიანებით სცადე ან აირჩიე პატარა ფაილი.",
};

export default function FileUpload({ room, token, disabled, busy, setBusy }: {
  room: RoomSnapshot;
  token: string;
  disabled: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file || disabled || request.current) return;
    if (!file.size || file.size > maxBytes) {
      setError(file.size ? errors[413] : "ფაილი ცარიელია.");
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    try {
      const url = new URL(mediaFileUrl(room.id));
      url.searchParams.set("version", String(room.version));
      url.searchParams.set("name", file.name);
      const response = await fetch(url, {
        method: "PUT",
        headers: { Authorization: "Bearer " + token, "Content-Type": file.type || "application/octet-stream" },
        body: file,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(errors[response.status] ?? "ატვირთვა ვერ დასრულდა. ხელახლა სცადე.");
      setFile(null);
      if (input.current) input.current.value = "";
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof TypeError
        ? "სერვერთან კავშირი ვერ დამყარდა. შეამოწმე ინტერნეტი და ოთახის სერვერის მისამართი."
        : reason instanceof Error ? reason.message : "ატვირთვა ვერ დასრულდა.");
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <form onSubmit={upload} className="track-form">
      <label htmlFor="audio-file">აუდიოფაილი</label>
      <p className="status-note" id="file-help">MP3, WAV ან M4A · მაქსიმუმ 32 MiB. ფაილი დროებით ინახება ოთახში.</p>
      <div className="input-line">
        <input ref={input} id="audio-file" type="file" accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4"
          aria-describedby="file-help" disabled={busy} onChange={e => { setFile(e.target.files?.[0] ?? null); setError(""); }} />
        <button type="submit" className="btn btn-secondary" disabled={busy || disabled || !file}>
          {busy ? "იტვირთება…" : "ატვირთვა"}
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
  );
}
