export interface MouseLookCallbacks {
  move: (x: number, y: number) => void;
  change: (locked: boolean) => void;
  lost: () => void;
  error: () => void;
}

/** Own only this surface's lock; late grants must never capture a menu or a disposed game. */
export class MouseLook {
  private readonly events = new AbortController();
  private wanted = false;
  private pending: number | null = null;
  private sequence = 0;
  private owned = false;
  private disposed = false;

  constructor(private readonly surface: HTMLElement, private readonly callbacks: MouseLookCallbacks) {
    const signal = this.events.signal;
    document.addEventListener("pointerlockchange", () => {
      const wasOwned = this.owned;
      this.owned = document.pointerLockElement === surface;
      if (this.owned) {
        this.pending = null;
        if (!this.wanted || this.disposed) {
          this.unlock();
          return;
        }
        this.callbacks.change(true);
      } else if (wasOwned) {
        const unexpected = this.wanted && !this.disposed;
        this.wanted = false;
        this.callbacks.change(false);
        if (unexpected) this.callbacks.lost();
      }
      this.finishDisposal();
    }, { signal });
    document.addEventListener("pointerlockerror", () => this.failed(this.pending), { signal });
    document.addEventListener("mousemove", (event) => {
      if (!this.locked || !this.wanted || this.disposed) return;
      if (!Number.isFinite(event.movementX) || !Number.isFinite(event.movementY)) return;
      if (event.movementX || event.movementY) this.callbacks.move(event.movementX, event.movementY);
    }, { signal });
  }

  get locked(): boolean {
    return document.pointerLockElement === this.surface;
  }

  get active(): boolean {
    return this.wanted && !this.disposed && this.locked;
  }

  request(): void {
    if (this.disposed || this.pending !== null || this.locked) return;
    this.wanted = true;
    const request = ++this.sequence;
    this.pending = request;
    if (typeof this.surface.requestPointerLock !== "function") {
      this.failed(request);
      return;
    }
    try {
      const result = this.surface.requestPointerLock();
      if (result) void result.then(() => {
        if (this.pending === request) this.pending = null;
        if (!this.wanted || this.disposed) this.unlock();
        this.finishDisposal();
      }, () => this.failed(request));
    } catch {
      this.failed(request);
    }
  }

  unlock(): void {
    this.wanted = false;
    if (this.locked) document.exitPointerLock();
  }

  private failed(request: number | null): void {
    if (request === null || this.pending !== request) return;
    this.pending = null;
    const report = this.wanted && !this.disposed;
    this.wanted = false;
    if (report) this.callbacks.error();
    this.finishDisposal();
  }

  private finishDisposal(): void {
    if (this.disposed && this.pending === null && !this.locked) this.events.abort();
  }

  dispose(): void {
    this.disposed = true;
    this.unlock();
    this.finishDisposal();
  }
}
