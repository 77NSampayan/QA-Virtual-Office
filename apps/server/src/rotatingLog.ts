/**
 * Size-rotated log stream for pino: `<file>` -> `<file>.1` ... `<file>.<keep>`.
 * No file handle is held between writes, so rotation by rename always works on Windows.
 */
import fs from 'node:fs';
import path from 'node:path';

export class RotatingLog {
  private size = 0;

  constructor(
    private file: string,
    private maxBytes = 5 * 1024 * 1024,
    private keep = 5,
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.size = fs.statSync(file).size;
    } catch {
      this.size = 0;
    }
  }

  write(chunk: string): void {
    try {
      if (this.size + chunk.length > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, chunk, 'utf8');
      this.size += chunk.length;
    } catch {
      /* logging must never throw */
    }
  }

  private rotate(): void {
    try {
      fs.rmSync(`${this.file}.${this.keep}`, { force: true });
      for (let i = this.keep - 1; i >= 1; i--) {
        if (fs.existsSync(`${this.file}.${i}`)) fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
      }
      fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      /* keep appending to the current file if rotation fails */
    }
    this.size = 0;
  }
}
