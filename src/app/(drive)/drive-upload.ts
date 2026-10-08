import { authFetch } from "@/lib/auth/client";

const PART_RETRIES = 3;

async function readError(response: Response): Promise<Error> {
	const data = await response.json().catch(() => null) as { error?: string } | null;
	return new Error(data?.error ?? `Upload failed (${response.status})`);
}

/**
 * Uploads a file in parts, each sent as a raw request body. Not multipart/form-data: the runtime treats every
 * multipart POST as a server action and rejects anything over 1 MB.
 *
 * The server remembers which parts arrived. Interrupted uploads (lost connection, closed tab) are not discarded:
 * picking the same file again, same name, size and modified time, into the same folder continues after the last stored part.
 */
export async function uploadDriveFile(file: File, parentId: string | null, onProgress: (percent: number, resumed: boolean) => void): Promise<void> {
	const start = await authFetch("/api/drive/upload", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type || "application/octet-stream", parentId, fingerprint: String(file.lastModified) }),
	});
	if (!start.ok) throw await readError(start);
	const session = await start.json() as { id?: string; partSize?: number; parts?: number; uploaded?: number[]; resumed?: boolean; complete?: boolean };
	if (session.complete) return;
	const { id, partSize, parts } = session as { id: string; partSize: number; parts: number };
	const stored = new Set(session.uploaded ?? []);
	const resumed = !!session.resumed;
	let finished = stored.size;
	onProgress(Math.round((finished / parts) * 100), resumed);
	for (let index = 0; index < parts; index += 1) {
		if (stored.has(index + 1)) continue;
		const chunk = file.slice(index * partSize, (index + 1) * partSize);
		for (let attempt = 1; ; attempt += 1) {
			try {
				const response = await authFetch(`/api/drive/upload/${id}?part=${index + 1}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: chunk });
				if (!response.ok) throw await readError(response);
				break;
			} catch (error) {
				if (attempt >= PART_RETRIES) throw error;
			}
		}
		finished += 1;
		onProgress(Math.round((finished / parts) * 100), resumed);
	}
	const finish = await authFetch(`/api/drive/upload/${id}`, { method: "POST" });
	if (!finish.ok) throw await readError(finish);
}
