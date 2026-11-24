// One explicit local action. Values below are control thresholds, not a
// guarantee about the accuracy of the iframe clock or the speaker output.
const toleranceSec = 0.12;
const settleMs = 1000;
const maxCompensationSec = 1.5;

type Reading = { at: number; position: number; error: number };
type Step =
  | { kind: "wait" }
  | { kind: "seek"; position: number }
  | { kind: "finish"; message: string };

export class YouTubeResync {
  private samples: Reading[] = [];
  private seeks = 0;
  private settleUntil = 0;
  private readonly expires: number;

  constructor(readonly roomVersion: number, started: number) {
    this.expires = started + 12_000;
  }

  sample(at: number, target: number, position: number, playing: boolean, duration: number): Step {
    if (at >= this.expires) {
      return { kind: "finish", message: "პლეერის პოზიცია სტაბილურად ვერ გაიზომა. როცა სიმღერა შეუფერხებლად გაისმება, ისევ სცადე." };
    }
    if (!playing || !Number.isFinite(position) || at < this.settleUntil) {
      this.samples = [];
      return { kind: "wait" };
    }
    const error = position - target;
    this.samples.push({ at, position, error });
    if (this.samples.length > 4) this.samples.shift();
    if (this.samples.length < 4) return { kind: "wait" };
    const first = this.samples[0];
    const span = (at - first.at) / 1000;
    const errors = this.samples.map(s => s.error).sort((a, b) => a - b);
    if (span < 0.6 || span > 2 || Math.abs(position - first.position - span) > 0.16 ||
        errors[3] - errors[0] > 0.18) return { kind: "wait" };
    const residual = (errors[1] + errors[2]) / 2;
    const measured = "პლეერის შეფასებული აცდენა " + (residual > 0 ? "+" : "") + Math.round(residual * 1000) + " ms.";
    if (Math.abs(residual) <= toleranceSec) return { kind: "finish", message: measured + " კორექცია დასრულდა." };
    // First seek to the current target. Its *settled* residual tells us the
    // local seek bias. A second, signed feed-forward adjustment is the limit.
    if (this.seeks === 2 || (this.seeks === 1 && Math.abs(residual) > maxCompensationSec)) {
      return { kind: "finish", message: measured + " გასწორება სრულად ვერ მოხერხდა. განმეორებითი გადახვევები შეწყდა." };
    }
    const destination = Math.max(0, target - (this.seeks === 1 ? residual : 0));
    if (duration > 0 && destination >= duration) {
      return { kind: "finish", message: "ოთახის სამიზნე ვიდეოს ბოლოს გასცდა. მასპინძელს შეუძლია სიმღერის თავიდან დაწყება." };
    }
    this.seeks++;
    this.samples = [];
    this.settleUntil = at + settleMs;
    return { kind: "seek", position: destination };
  }
}
