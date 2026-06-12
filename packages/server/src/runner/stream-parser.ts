/** Buffers a byte stream and emits complete lines. */
export class LineSplitter {
  private buffer = '';

  constructor(private onLine: (line: string) => void) {}

  push(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim()) this.onLine(line);
    }
  }

  flush(): void {
    if (this.buffer.trim()) this.onLine(this.buffer);
    this.buffer = '';
  }
}
