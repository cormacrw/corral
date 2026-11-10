import { EVIDENCE_MAX_BYTES, EVIDENCE_TOO_LARGE, evidenceInputSchema } from '@corral/contracts'
import { schema, type Database, type TaskRow } from '@corral/db'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { readProjectAttachment } from './attachments.ts'
import type { BlobStore } from './blob-store.ts'
import { DesignNotFound, readDesign } from './designs.ts'
import { ToolError } from './tool-error.ts'

// The files agents attach and read through their tools, for every role

const { acceptanceCriteria, evidence } = schema

type EvidenceInput = z.infer<typeof evidenceInputSchema>

export function parseEvidence(input: unknown): EvidenceInput {
  const parsed = evidenceInputSchema.safeParse(input)
  if (!parsed.success) throw new ToolError(`Not attached. ${parsed.error.issues.map(i => i.message).join('. ')}.`)
  return parsed.data
}

// The PM's attach_evidence also names the task, or none for its own chat
export function readEvidenceInput(input: unknown): { evidence: EvidenceInput, taskRef?: string | undefined, project?: string | undefined } {
  const { taskRef, project, ...fields } = z.looseObject({ taskRef: z.string().optional(), project: z.string().optional() }).parse(input)
  return { evidence: parseEvidence(fields), taskRef, project }
}

export async function attachEvidence(db: Database, blobs: BlobStore, to: { runId: string, task: TaskRow | null }, input: EvidenceInput): Promise<{ id: string, sha256?: string }> {
  const { task } = to
  if (input.criterionId) {
    const [criterion] = await db.select({ id: acceptanceCriteria.id }).from(acceptanceCriteria)
      .where(and(eq(acceptanceCriteria.id, input.criterionId), eq(acceptanceCriteria.taskId, task!.id)))
    if (!criterion) throw new ToolError(`${input.criterionId} isn't one of this task's acceptance criteria`)
  }
  const row = { taskId: task?.id ?? null, criterionId: input.criterionId, runId: to.runId, round: task?.reviewRounds ?? 0, kind: input.kind }
  if (input.kind === 'note') {
    // A note: no blob, the text is the evidence
    const [note] = await db.insert(evidence).values({ ...row, note: input.note.trim(), size: 0 }).returning()
    return { id: note!.id }
  }
  const data = Buffer.from(input.dataBase64, 'base64')
  if (data.length > EVIDENCE_MAX_BYTES) throw new ToolError(EVIDENCE_TOO_LARGE)
  const blob = await blobs.put(data)
  const [file] = await db.insert(evidence).values({
    ...row,
    note: input.note,
    blob,
    fileName: input.fileName,
    contentType: input.contentType,
    size: data.length
  }).returning()
  return { id: file!.id, sha256: blob }
}

// An image attached to the project's task text, as MCP image content
export async function getAttachment(db: Database, blobs: BlobStore, projectId: string, attachmentId: string) {
  const file = await readProjectAttachment(db, blobs, projectId, attachmentId)
  if (!file) throw new ToolError(`${attachmentId} isn't an attachment in this project`)
  const { data, ...meta } = file
  return { ...meta, images: [{ mimeType: meta.mimeType, dataBase64: Buffer.from(data).toString('base64') }] }
}

export async function getDesign(db: Database, blobs: BlobStore, project: { id: string, prefix: string }, ref: string, version?: number) {
  return readDesign(db, blobs, project, ref, version).catch((error: unknown) => {
    throw error instanceof DesignNotFound ? new ToolError(error.message) : error
  })
}
