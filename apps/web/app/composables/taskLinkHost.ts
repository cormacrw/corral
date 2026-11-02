import { ref } from 'vue'

// TaskFlyout can be a sibling of the rendered text, so provide/inject alone
// cannot tell a link whether the current page has a docked detail host.
export const taskFlyoutHosts = ref(0)
