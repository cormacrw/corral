import Image from '@tiptap/extension-image'
import { NodeSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { attachmentIdFromSrc, attachmentUrl } from '@corral/core'

// The src an image node stores: attachment:<id> for an attachment, however
// it arrived (pasted from another description, copied as a host URL), so
// saved descriptions don't depend on where Corral is served from
export function storedImageSrc(src: string | null): string | null {
  if (!src) return src
  const id = attachmentIdFromSrc(src)
  return id ? `attachment:${id}` : src
}

// The src the browser loads
export function shownImageSrc(src: string | null): string | null {
  if (!src) return src
  const id = attachmentIdFromSrc(src)
  return id ? attachmentUrl(id) : src
}

// The editor's image node, reading and writing attachment references. Used
// in place of Nuxt UI's own in the description editor. Read-only descriptions
// resolve attachment sources with shownImageSrc directly.
export const AttachmentImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      src: {
        default: null,
        parseHTML: element => storedImageSrc(element.getAttribute('src')),
        renderHTML: attributes => ({ src: shownImageSrc(attributes.src as string | null) })
      }
    }
  }
})

// Image files among pasted or dropped data
export function imageFiles(data: DataTransfer | null): File[] {
  return [...data?.files ?? []].filter(file => file.type.startsWith('image/'))
}

// Uploads each image and inserts it at pos, or at the selection. Each goes
// in when its upload finishes; upload returns null for one that failed.
export function insertImages(view: EditorView, files: File[], upload: (file: File) => Promise<{ id: string } | null>, pos?: number) {
  for (const file of files) {
    void upload(file).then((attachment) => {
      if (!attachment || view.isDestroyed) return
      const node = view.state.schema.nodes.image!.create({ src: `attachment:${attachment.id}`, alt: file.name || null })
      const { tr, doc, selection } = view.state
      // A selected node (the editor opens with a trailing image selected)
      // keeps its place; the image goes after it rather than replacing it
      const at = pos ?? (selection instanceof NodeSelection ? selection.to : undefined)
      if (at === undefined) tr.replaceSelectionWith(node)
      else tr.replaceRangeWith(Math.min(at, doc.content.size), Math.min(at, doc.content.size), node)
      view.dispatch(tr)
    })
  }
}
