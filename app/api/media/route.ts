import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import { getCurrentWorkspaceContext, managerOnly } from "@/lib/workspace-access";
import { checkUpload, cleanFileName, mediaUrl, newPublicId, writeMediaFile } from "@/lib/media/store";

export const runtime = "nodejs";

function present(asset: {
  id: string; publicId: string; kind: string; mimeType: string; extension: string; fileName: string; sizeBytes: number; createdAt: Date;
}) {
  return {
    id: asset.id,
    kind: asset.kind,
    mimeType: asset.mimeType,
    fileName: asset.fileName,
    sizeBytes: asset.sizeBytes,
    createdAt: asset.createdAt,
    url: mediaUrl(asset),
  };
}

export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const assets = await prisma.mediaAsset.findMany({
    where: { workspaceId: context.workspaceId },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return NextResponse.json({ assets: assets.map(present) });
}

/** The largest file Instagram takes (25 MB) plus the multipart wrapping. */
const MAX_REQUEST_BYTES = 26 * 1024 * 1024;

/** All files one workspace may keep, in MB (MEDIA_QUOTA_MB, default 1000). */
function quotaBytes(): number {
  const mb = Number(process.env.MEDIA_QUOTA_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 1000) * 1024 * 1024;
}

/** The request body, or null as soon as it passes `max` bytes (the rest is never read). */
async function readCapped(request: NextRequest, max: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    // Stop here. The rest is never read; the connection is closed with the response.
    if (total > max) return null;
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return all;
}

/** multipart/form-data with one `file` field. */
export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = managerOnly(context);
  if (denied) return denied;

  const tooLarge = () => NextResponse.json({ error: "Videos, audio and files can be at most 25 MB." }, { status: 413 });
  const overQuota = () => NextResponse.json({ error: "Your uploaded files take too much space. Delete some first." }, { status: 413 });
  const used = (await prisma.mediaAsset.aggregate({ where: { workspaceId: context.workspaceId }, _sum: { sizeBytes: true } }))._sum.sizeBytes ?? 0;

  // Judged from the declared size first, so a huge upload is refused before a
  // byte is read; then the body is read with a hard cap, because the header
  // can be missing or wrong. Reading it with formData() directly would let one
  // request use as much memory as it likes.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) return tooLarge();
  if (Number.isFinite(declared) && used + declared > quotaBytes()) return overQuota();
  const body = await readCapped(request, MAX_REQUEST_BYTES);
  if (!body) return tooLarge();
  if (used + body.length > quotaBytes()) return overQuota();

  let file: File | null = null;
  try {
    const form = await new Response(body as BodyInit, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData();
    const value = form.get("file");
    file = value instanceof File ? value : null;
  } catch {
    file = null;
  }
  if (!file) return NextResponse.json({ error: "Choose a file to upload." }, { status: 400 });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const checked = checkUpload(bytes);
  if ("problem" in checked) return NextResponse.json({ error: checked.problem }, { status: 400 });

  const publicId = newPublicId();
  await writeMediaFile(publicId, checked.format.extension, bytes);
  const asset = await prisma.mediaAsset.create({
    data: {
      workspaceId: context.workspaceId,
      publicId,
      kind: checked.format.kind,
      mimeType: checked.format.mimeType,
      extension: checked.format.extension,
      fileName: cleanFileName(file.name),
      sizeBytes: bytes.length,
    },
  });
  return NextResponse.json({ asset: present(asset) }, { status: 201 });
}
