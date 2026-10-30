import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import { mount } from '@vue/test-utils'
import type { Component } from 'vue'

// A client for tests: no retries to wait out, and nothing left to collect
export const testQueryClient = () => new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: Infinity, networkMode: 'always' } }
})

// Mounts a component whose useQuery and useMutation calls reach `client`
export function mountWithQuery(component: Component, options: { client?: QueryClient, props?: Record<string, unknown> } = {}) {
  const client = options.client ?? testQueryClient()
  const wrapper = mount(component, { props: options.props, global: { plugins: [[VueQueryPlugin, { queryClient: client }]] } })
  return { wrapper, client }
}
