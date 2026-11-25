function roomServerOrigin(): string {
  const value = import.meta.env.VITE_ROOM_SERVER_ORIGIN?.trim()
  if (!value) return window.location.origin
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash ||
      (window.location.protocol === 'https:' && url.protocol !== 'https:')) {
    throw new Error('VITE_ROOM_SERVER_ORIGIN must be the HTTP(S) origin of the room server; HTTPS pages require HTTPS.')
  }
  return url.origin
}

export function roomApiUrl(): string {
  return new URL('/api/rooms', roomServerOrigin()).href
}

export function youtubeSearchUrl(query: string): string {
  const url = new URL('/api/youtube/search', roomServerOrigin())
  url.searchParams.set('q', query)
  return url.href
}

export function catalogUrl(query = '', youtubeId = ''): string {
  const url = new URL('/api/catalog', roomServerOrigin())
  if (query) url.searchParams.set('q', query)
  if (youtubeId) url.searchParams.set('youtubeId', youtubeId)
  return url.href
}

export function mediaFileUrl(roomId: string, fileId?: string): string {
  const resource = '/api/rooms/' + encodeURIComponent(roomId) + '/audio'
  return new URL(fileId ? resource + '/' + encodeURIComponent(fileId) : resource, roomServerOrigin()).href
}

export function roomSocketUrl(): string {
  const url = new URL('/ws', roomServerOrigin())
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}
