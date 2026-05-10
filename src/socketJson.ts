import { existsSync } from "node:fs";
import { connect } from "node:net";

// Send one JSON request as a single line, await one JSON line back. Returns
// null on timeout, parse error, or socket error.
export function sendJsonLine<T>(
	sockPath: string,
	req: unknown,
	timeoutMs: number,
): Promise<T | null> {
	return new Promise((resolve) => {
		if (!existsSync(sockPath)) return resolve(null);
		const sock = connect(sockPath);
		let buf = "";
		let done = false;
		const finish = (v: T | null) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				sock.end();
			} catch {}
			resolve(v);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);
		sock.on("data", (d) => {
			buf += d.toString();
			const idx = buf.indexOf("\n");
			if (idx >= 0) {
				try {
					finish(JSON.parse(buf.slice(0, idx)) as T);
				} catch {
					finish(null);
				}
			}
		});
		sock.on("error", () => finish(null));
		sock.write(`${JSON.stringify(req)}\n`);
	});
}
