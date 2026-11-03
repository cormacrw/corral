// What a page tells MobilePageHeader to show (design/mobile.md),
// when the shell can't work it out from the route: the Inbox item's task
// and its place in the list. Null leaves the header to the route.
export interface MobileHeader {
  title: string
  eyebrow: string
}

export function useMobileHeader() {
  return useState<MobileHeader | null>('mobile.header', () => null)
}
