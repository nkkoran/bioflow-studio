import Store from 'electron-store'

let store: Store | null = null

export function getSettingsStore(): Store {
  if (!store) {
    store = new Store({
      name: 'bioflow-settings',
      defaults: {
        connections: [],
        bookmarks: [],
        ui: {
          sidebarWidth: 280,
          bottomPanelHeight: 250,
          theme: 'dark'
        },
        recentPipelines: []
      }
    })
  }
  return store
}
