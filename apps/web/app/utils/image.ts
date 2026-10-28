// Profile pictures are cropped to a centred square and scaled to 256px in
// the browser, so uploads stay small whatever the camera produced
export async function squareImage(file: File, size = 256): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file')
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('This image can\'t be read; try a PNG or JPEG')
  })
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser can\'t resize images')
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size)
  bitmap.close()
  // WebP where the browser can encode it, PNG otherwise
  const encode = (type: string) => new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, 0.9))
  const webp = await encode('image/webp')
  const blob = webp?.type === 'image/webp' ? webp : await encode('image/png')
  if (!blob) throw new Error('The image couldn\'t be resized')
  return blob
}
