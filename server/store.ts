import { DatabaseSync } from "node:sqlite";
import type { BaseDoc, DocType } from "../shared/protocol.ts";

/**
 * Durable document storage: one SQLite file per world, one row per document.
 * The World keeps every document in memory and writes through to this store.
 */
export class Store {
  #db: DatabaseSync;
  #put;
  #del;

  constructor(file: string) {
    this.#db = new DatabaseSync(file);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS docs (
        type   TEXT NOT NULL,
        id     TEXT NOT NULL,
        parent TEXT,
        data   TEXT NOT NULL,
        PRIMARY KEY (type, id)
      );
      CREATE INDEX IF NOT EXISTS docs_parent ON docs (type, parent);
    `);
    this.#put = this.#db.prepare("INSERT OR REPLACE INTO docs (type, id, parent, data) VALUES (?, ?, ?, ?)");
    this.#del = this.#db.prepare("DELETE FROM docs WHERE type = ? AND id = ?");
  }

  loadAll(): { type: DocType; doc: BaseDoc }[] {
    const rows = this.#db.prepare("SELECT type, data FROM docs").all() as { type: DocType; data: string }[];
    return rows.map(r => ({ type: r.type, doc: JSON.parse(r.data) }));
  }

  /** Apply puts and deletes atomically. */
  write(puts: { type: DocType; doc: BaseDoc }[], dels: { type: DocType; id: string }[] = []): void {
    this.#db.exec("BEGIN");
    try {
      for (const { type, doc } of puts) this.#put.run(type, doc._id, doc._parent ?? null, JSON.stringify(doc));
      for (const { type, id } of dels) this.#del.run(type, id);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.#db.close();
  }
}
