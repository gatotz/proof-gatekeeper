import fs from "node:fs";
import path from "node:path";

// Disk-backed set of proof_tx references that were ACCEPTED (APPROVE) in a
// previous task. PROOF_REUSED detection reads this set; a restart must never
// cause a false APPROVE on a reused proof, so the set lives on disk (not in
// memory only) and is written atomically (temp file + rename) on every add.
//
// Safety: if the file exists but cannot be parsed, the service REFUSES to
// start — a lost/corrupt seen-set would blind reuse detection. A missing
// file simply means "first run" and starts empty.
export class SeenStore {
  private set = new Set<string>();
  private readonly filePath: string;

  private constructor(filePath: string) {
    this.filePath = filePath;
  }

  static load(filePath: string): SeenStore {
    const store = new SeenStore(filePath);
    if (fs.existsSync(filePath)) {
      let raw: string;
      try {
        raw = fs.readFileSync(filePath, "utf8");
      } catch (e) {
        throw new Error(`cannot read seen-set ${filePath}: ${e}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(
          `seen-set ${filePath} is corrupt JSON — refusing to start ` +
            `(a lost seen-set would blind PROOF_REUSED detection; ` +
            `inspect/repair the file or move it aside deliberately)`,
        );
      }
      if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
        throw new Error(
          `seen-set ${filePath} has unexpected shape (want a JSON array of strings) — refusing to start`,
        );
      }
      for (const entry of parsed as string[]) store.set.add(entry.toLowerCase());
    }
    return store;
  }

  has(proofTx: string): boolean {
    return this.set.has(proofTx.toLowerCase());
  }

  add(proofTx: string): void {
    const key = proofTx.toLowerCase();
    if (this.set.has(key)) return;
    this.set.add(key);
    this.persist();
  }

  remove(proofTx: string): void {
    const key = proofTx.toLowerCase();
    if (!this.set.has(key)) return;
    this.set.delete(key);
    this.persist();
  }

  size(): number {
    return this.set.size;
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify([...this.set].sort(), null, 2), "utf8");
    fs.renameSync(tmp, this.filePath);
  }
}
