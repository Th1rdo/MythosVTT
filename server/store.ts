import { DatabaseSync } from "node:sqlite";
import type { BaseDoc, DocType, PackEntry, PackIndexEntry } from "../shared/protocol.ts";

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
      CREATE TABLE IF NOT EXISTS pack_entries (
        pack    TEXT NOT NULL,
        id      TEXT NOT NULL,
        name    TEXT NOT NULL,
        img     TEXT,
        subtype TEXT,
        folder  TEXT,
        sort    INTEGER NOT NULL DEFAULT 0,
        data    TEXT NOT NULL,
        PRIMARY KEY (pack, id)
      );
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

  // -------------------------------------------------------------------------
  // Compendium packs: entries live in their own table and are read on demand.

  packIndex(pack: string): PackIndexEntry[] {
    return (this.#db.prepare("SELECT id, name, img, subtype, folder, sort FROM pack_entries WHERE pack = ? ORDER BY sort, name").all(pack) as Record<string, unknown>[])
      .map(r => ({ _id: r.id as string, name: r.name as string, img: (r.img as string) ?? null, subtype: (r.subtype as string) ?? null, folder: (r.folder as string) ?? null, sort: Number(r.sort) }));
  }

  packCount(pack: string): number {
    return Number((this.#db.prepare("SELECT COUNT(*) AS n FROM pack_entries WHERE pack = ?").get(pack) as { n: number }).n);
  }

  packEntry(pack: string, id: string): PackEntry | undefined {
    const row = this.#db.prepare("SELECT data FROM pack_entries WHERE pack = ? AND id = ?").get(pack, id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  putPackEntries(pack: string, entries: PackEntry[]): void {
    const put = this.#db.prepare("INSERT OR REPLACE INTO pack_entries (pack, id, name, img, subtype, folder, sort, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    this.#db.exec("BEGIN");
    try {
      for (const e of entries) put.run(pack, e._id, e.name, e.img, e.subtype, e.folder, Math.round(e.sort || 0), JSON.stringify(e));
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  deletePackEntries(pack: string, ids?: string[]): void {
    if (!ids) {
      this.#db.prepare("DELETE FROM pack_entries WHERE pack = ?").run(pack);
      return;
    }
    const del = this.#db.prepare("DELETE FROM pack_entries WHERE pack = ? AND id = ?");
    for (const id of ids) del.run(pack, id);
  }

  close(): void {
    this.#db.close();
  }
}
